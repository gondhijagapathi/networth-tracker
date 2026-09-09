/**
 * The SMTP transport — the only part of this application that opens a socket to something
 * a user did not ask it to.
 *
 * It is deliberately thin. Everything about *what* to send and *when to give up* lives in
 * `services/mail.service.ts`; this file knows how to hand one message to one server and how
 * to describe the failure if it cannot. That split is what lets a test run the entire
 * notification story — queue, retry, give up — against an in-memory transport with no
 * network and no mocking of nodemailer's internals.
 *
 * On Gmail specifically, because it is what most people self-hosting this will use:
 *
 *   - `smtp.gmail.com`, port 587 (STARTTLS) or 465 (implicit TLS). Both work; 587 is the
 *     default here because it is the one that survives more networks.
 *   - The password must be a 16-character **App Password**, not the account password.
 *     Google stopped accepting the latter over SMTP in May 2022, and the error it returns
 *     for it ("Username and Password not accepted") does not say so — which is why
 *     `config.ts` checks the shape at boot and why {@link describeSmtpError} translates it.
 *   - App Passwords require 2-Step Verification to be on for the Google account.
 *   - The `From` address must be the authenticated account or an alias verified on it.
 *     Gmail silently rewrites anything else, which looks like the setting being ignored.
 *   - There is a send quota — on the order of 500 recipients a day for a personal account.
 *     A household tracker sends a handful of messages a month, so this matters only if
 *     something has gone wrong; the outbox's retry ceiling is what stops that becoming a
 *     loop that gets an account suspended.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import type { MailConfig } from '../config.js';

/** One message, as the transport sees it. */
export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Anything that can send.
 *
 * An interface rather than a concrete class so the context can hold a memory transport in
 * tests and a null transport on an installation with no SMTP configured, and so no code
 * path anywhere else has to ask which one it has.
 */
export interface Mailer {
  /** True when this transport can actually deliver. False means every send is suppressed. */
  readonly enabled: boolean;
  /** Resolves on acceptance by the server; rejects with a human-readable message. */
  send(message: OutgoingMail): Promise<void>;
  /** Release any pooled connections. Called on shutdown. */
  close(): void;
}

/* -------------------------------------------------------------------------- */
/* SMTP                                                                       */
/* -------------------------------------------------------------------------- */

class SmtpMailer implements Mailer {
  readonly enabled = true;
  private transporter: Transporter | null = null;

  constructor(private readonly config: MailConfig) {}

  /**
   * Built on first use, not in the constructor.
   *
   * Nodemailer's pooled transport starts timers as soon as it exists, and a process that
   * boots, sends nothing and is asked to exit should not be held open by a connection pool
   * it never used.
   */
  private get transport(): Transporter {
    this.transporter ??= nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: this.config.auth ?? undefined,
      // One connection, reused. The alternative is a fresh TLS handshake and a fresh
      // authentication per message, which providers rate-limit far more aggressively than
      // they rate-limit messages.
      pool: true,
      maxConnections: 1,
      // Generous but finite. A hung socket must not pin a delivery slot forever; the outbox
      // will simply try again on the next pass.
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
      // STARTTLS is required, not merely attempted, whenever the connection did not start
      // encrypted. Falling back to plaintext would put an SMTP password and a password-reset
      // link on the wire in the clear, which is not a trade worth making for a server that
      // happens to be misconfigured.
      requireTLS: !this.config.secure,
      tls: { minVersion: 'TLSv1.2' },
    });
    return this.transporter;
  }

  async send(message: OutgoingMail): Promise<void> {
    try {
      await this.transport.sendMail({
        from: this.config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        // This application never wants a reply and never wants an out-of-office storm.
        headers: { 'Auto-Submitted': 'auto-generated' },
      });
    } catch (error) {
      throw new Error(describeSmtpError(error), { cause: error });
    }
  }

  close(): void {
    this.transporter?.close();
    this.transporter = null;
  }
}

/**
 * Turn a nodemailer failure into something an operator can act on.
 *
 * The raw errors are accurate and nearly useless — "Invalid login: 535-5.7.8 Username and
 * Password not accepted" is the message Gmail returns both for a wrong password and for the
 * far more likely case of a *right* password that is simply not an App Password. Every
 * translation here keeps the original text after it, so nothing is hidden; it only puts the
 * probable cause first.
 */
export function describeSmtpError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code ?? '';

  if (/535|Username and Password not accepted|Invalid login/i.test(raw)) {
    return (
      'The mail server rejected the username or password. For Gmail this is almost always ' +
      'because SMTP_PASS is an account password rather than a 16-character App Password ' +
      '(myaccount.google.com → Security → App passwords, with 2-Step Verification on). ' +
      `Server said: ${raw}`
    );
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(code + raw)) {
    return `Could not resolve the mail server host. Check SMTP_HOST. Server said: ${raw}`;
  }
  if (/ECONNREFUSED/i.test(code + raw)) {
    return `The mail server refused the connection. Check SMTP_PORT. Server said: ${raw}`;
  }
  if (/ETIMEDOUT|ESOCKET|Greeting never received/i.test(code + raw)) {
    return (
      'Timed out reaching the mail server. A common cause is SMTP_SECURE not matching the ' +
      'port — 465 needs it true, 587 needs it false. Some hosts also block outbound SMTP ' +
      `entirely. Server said: ${raw}`
    );
  }
  if (/self.signed|unable to verify|certificate/i.test(raw)) {
    return `The mail server's TLS certificate could not be verified. Server said: ${raw}`;
  }
  if (/5\.7\.\d+|not allowed|sender/i.test(raw) && /from/i.test(raw)) {
    return (
      'The mail server refused the sender address. Gmail requires SMTP_FROM to be the ' +
      `authenticated account or an alias verified on it. Server said: ${raw}`
    );
  }
  return raw;
}

/* -------------------------------------------------------------------------- */
/* The other two                                                              */
/* -------------------------------------------------------------------------- */

/**
 * No transport at all.
 *
 * Used when `SMTP_HOST` is unset — which is a perfectly reasonable way to run this thing,
 * and the state a fresh install is in. It throws rather than silently succeeding so that
 * `enabled === false` is the only way to discover it, and callers mark such messages
 * `suppressed` rather than pretending they went out.
 */
class NullMailer implements Mailer {
  readonly enabled = false;
  send(): Promise<void> {
    return Promise.reject(new Error('No mail transport is configured on this instance'));
  }
  close(): void {}
}

/**
 * A transport that keeps everything.
 *
 * Exported rather than hidden in the test folder because it is also the honest way to run
 * this application in development: set no SMTP variables and mail is suppressed, or wire
 * this in and read what would have been sent without needing a Gmail account to develop
 * against.
 */
export class MemoryMailer implements Mailer {
  readonly enabled = true;
  readonly sent: OutgoingMail[] = [];
  /** Set to make the next sends fail, for exercising retry and give-up behaviour. */
  failWith: string | null = null;

  send(message: OutgoingMail): Promise<void> {
    if (this.failWith !== null) return Promise.reject(new Error(this.failWith));
    this.sent.push(message);
    return Promise.resolve();
  }

  /** Every message sent to an address, oldest first. */
  to(email: string): OutgoingMail[] {
    return this.sent.filter((message) => message.to.toLowerCase().includes(email.toLowerCase()));
  }

  reset(): void {
    this.sent.length = 0;
    this.failWith = null;
  }

  close(): void {}
}

/** The transport this configuration implies. Null config means mail is off. */
export function createMailer(config: MailConfig | null): Mailer {
  return config === null ? new NullMailer() : new SmtpMailer(config);
}
