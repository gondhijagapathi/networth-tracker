/**
 * The outbox.
 *
 * Every message this application sends goes through `queueEmail`, and nothing sends on the
 * request thread. That single rule is what makes the rest of the notification story
 * tractable:
 *
 *   - **A slow mail server cannot slow the app down.** Registering an account writes a row;
 *     it does not wait on a TLS handshake to Gmail.
 *   - **A failed send is not a failed request.** An invite whose email bounced is still a
 *     valid invite, and an admin should see the code on screen either way. Nothing in this
 *     file ever throws into a caller — a queue that can break the thing it was notifying
 *     about is worse than no queue.
 *   - **A dead-man warning gets retried.** It is the one message with no human waiting on
 *     it, sent to somebody who by definition is not watching, and it is the one that would
 *     be quietly lost by a fire-and-forget `sendMail` on a bad afternoon.
 *
 * Delivery is a loop: `deliverDueEmails` takes whatever is due, tries each once, and
 * reschedules the failures with exponential backoff. `index.ts` runs it on a timer, and
 * `queueEmail` nudges it so an ordinary reset link arrives in seconds rather than at the
 * top of the next minute.
 */

import { and, asc, desc, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  uuidv7,
  type EmailKind,
  type EmailRecord,
  type EmailStatus,
  type MailStatus,
  type MailTestResult,
} from '@networth/shared';
import type { AppContext } from '../context.js';
import { emailOutbox, users, type EmailOutboxRow } from '../db/schema.js';
import type { RenderedEmail } from '../lib/mailTemplates.js';
import { openSecret, sealSecret } from '../lib/secretbox.js';
import { isoIn, isoNow } from '../lib/time.js';
import { recordAudit } from './audit.service.js';

/**
 * How many times a message is tried before it is given up on.
 *
 * Six attempts on the schedule below spans a little over two hours, which covers the
 * failure this is actually for — a provider being briefly unreachable, or a laptop that
 * was closed — without turning a genuinely wrong password into hundreds of authentication
 * failures against a Gmail account that will eventually lock itself.
 */
const MAX_ATTEMPTS = 6;

/** Backoff before attempt *n*, in seconds: one minute, then doubling to about an hour. */
const RETRY_DELAYS = [60, 300, 900, 1800, 3600];

/** Rows shown on the admin mail screen. Enough to see a pattern, not a mailbox. */
const RECENT_LIMIT = 25;

/**
 * Delivered rows older than this lose nothing but their place in the list; they are pruned
 * so the outbox does not become an unbounded log of who was emailed what, forever.
 */
const SENT_RETENTION_DAYS = 30;

/**
 * Contexts with a delivery pass in flight.
 *
 * Two overlapping passes would try to send the same row twice — SQLite gives no row-level
 * lock to lean on, and this is a single process by design. A `WeakSet` rather than a module
 * flag so that tests running several instances in parallel do not block each other, and so
 * a closed instance is not held in memory by its own bookkeeping.
 */
const draining = new WeakSet<AppContext>();

/* -------------------------------------------------------------------------- */
/* Queueing                                                                   */
/* -------------------------------------------------------------------------- */

export interface QueueOptions {
  /** The account this concerns, when there is one. Invitees have no user row yet. */
  userId?: string | null;
  /**
   * Send this attempt now rather than waiting for the next pass. On by default: the common
   * case is a person staring at their inbox waiting for a link.
   */
  immediate?: boolean;
}

/**
 * Write a message to the outbox.
 *
 * Synchronous, and a single insert, so it composes with the transactions around it — a
 * registration that rolls back does not leave a welcome email promising an account that
 * does not exist.
 *
 * @returns the queued row's id, or null when the message was suppressed.
 */
export function queueEmail(
  ctx: AppContext,
  to: string,
  message: RenderedEmail,
  options: QueueOptions = {},
): string | null {
  const now = ctx.now();
  const id = uuidv7(now.getTime());

  // Suppressed rather than pending, and recorded rather than dropped. An operator who
  // never configured SMTP should be able to see, later, exactly which notifications their
  // household did not get — particularly the dead-man warnings.
  const suppressed = !ctx.mailer.enabled;

  ctx.db
    .insert(emailOutbox)
    .values({
      id,
      kind: message.kind,
      toEmail: to,
      userId: options.userId ?? null,
      subject: message.subject,
      // The body is the only part of a queued message that can contain a secret, and it is
      // sealed under a purpose-derived key exactly as a TOTP seed is. See `secretbox.ts`.
      bodyEncrypted: suppressed
        ? null
        : sealSecret(
            JSON.stringify({ text: message.text, html: message.html }),
            ctx.config.SECRET_ENCRYPTION_KEY,
            'email',
          ),
      status: suppressed ? 'suppressed' : 'pending',
      attempts: 0,
      nextAttemptAt: suppressed ? null : isoNow(now),
      lastError: suppressed ? 'No mail transport is configured on this instance' : null,
      createdAt: isoNow(now),
      sentAt: null,
    })
    .run();

  if (suppressed) return null;

  if (options.immediate !== false) {
    // Fire and forget on purpose. The caller is answering a request; the worst outcome of
    // this promise rejecting is a row that the next timed pass picks up anyway.
    void deliverDueEmails(ctx).catch(() => undefined);
  }

  return id;
}

/* -------------------------------------------------------------------------- */
/* Delivery                                                                   */
/* -------------------------------------------------------------------------- */

export interface DeliveryResult {
  sent: number;
  failed: number;
  /** Rows that used up their last attempt on this pass. */
  abandoned: number;
}

/**
 * Try every message that is due.
 *
 * Rows are claimed one at a time and re-read inside the pass, so a message queued while
 * this is running is picked up by the next one rather than by this one halfway through.
 * Failure is per-message: one address that no longer exists does not stop the rest of the
 * queue moving.
 */
export async function deliverDueEmails(ctx: AppContext): Promise<DeliveryResult> {
  const result: DeliveryResult = { sent: 0, failed: 0, abandoned: 0 };
  if (!ctx.mailer.enabled || draining.has(ctx)) return result;

  draining.add(ctx);
  try {
    const due = ctx.db
      .select()
      .from(emailOutbox)
      .where(
        and(
          eq(emailOutbox.status, 'pending'),
          or(isNull(emailOutbox.nextAttemptAt), lte(emailOutbox.nextAttemptAt, isoNow(ctx.now()))),
        ),
      )
      .orderBy(asc(emailOutbox.createdAt))
      // A ceiling per pass so a backlog is worked through steadily rather than in one burst
      // that trips a provider's rate limit.
      .limit(20)
      .all();

    for (const row of due) {
      const outcome = await attemptDelivery(ctx, row);
      if (outcome === 'sent') result.sent += 1;
      else if (outcome === 'abandoned') result.abandoned += 1;
      else result.failed += 1;
    }
  } finally {
    draining.delete(ctx);
  }

  return result;
}

async function attemptDelivery(
  ctx: AppContext,
  row: EmailOutboxRow,
): Promise<'sent' | 'retry' | 'abandoned'> {
  const attempts = row.attempts + 1;
  const now = ctx.now();

  let body: { text: string; html: string };
  try {
    body = readBody(ctx, row);
  } catch {
    // The body cannot be opened — a rotated `SECRET_ENCRYPTION_KEY`, or a row restored from
    // a backup taken under a different one. Retrying cannot help, so this is terminal.
    abandon(ctx, row, attempts, 'The stored message could not be decrypted and was discarded');
    return 'abandoned';
  }

  try {
    await ctx.mailer.send({
      to: row.toEmail,
      subject: row.subject,
      text: body.text,
      html: body.html,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (attempts >= MAX_ATTEMPTS) {
      abandon(ctx, row, attempts, message);
      // Worth an audit row: a notification that never arrived is a security-relevant
      // non-event, and this is the only place it is recorded as such.
      recordAudit(ctx, {
        actorUserId: null,
        action: 'email.failed',
        entityType: 'email',
        entityId: row.id,
        meta: { kind: row.kind, attempts, error: message },
      });
      return 'abandoned';
    }

    ctx.db
      .update(emailOutbox)
      .set({
        attempts,
        lastError: message,
        nextAttemptAt: isoIn(RETRY_DELAYS[attempts - 1] ?? 3600, now),
      })
      .where(eq(emailOutbox.id, row.id))
      .run();

    return 'retry';
  }

  ctx.db
    .update(emailOutbox)
    .set({
      status: 'sent',
      attempts,
      // Cleared on success. A delivered row keeps its envelope — who, what about, when —
      // and forgets the reset link it carried.
      bodyEncrypted: null,
      nextAttemptAt: null,
      lastError: null,
      sentAt: isoNow(now),
    })
    .where(eq(emailOutbox.id, row.id))
    .run();

  return 'sent';
}

/** Give up on a message. The body goes too: whatever it held has expired or soon will. */
function abandon(ctx: AppContext, row: EmailOutboxRow, attempts: number, error: string): void {
  ctx.db
    .update(emailOutbox)
    .set({
      status: 'failed',
      attempts,
      bodyEncrypted: null,
      nextAttemptAt: null,
      lastError: error,
    })
    .where(eq(emailOutbox.id, row.id))
    .run();
}

function readBody(ctx: AppContext, row: EmailOutboxRow): { text: string; html: string } {
  if (row.bodyEncrypted === null) throw new Error('This message has no stored body');
  const parsed: unknown = JSON.parse(
    openSecret(row.bodyEncrypted, ctx.config.SECRET_ENCRYPTION_KEY, 'email'),
  );
  const body = parsed as { text?: unknown; html?: unknown };
  if (typeof body.text !== 'string' || typeof body.html !== 'string') {
    throw new Error('This message is not in a recognised format');
  }
  return { text: body.text, html: body.html };
}

/* -------------------------------------------------------------------------- */
/* Housekeeping                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Forget delivered mail after a month.
 *
 * The outbox is a delivery mechanism, not an archive. What is worth keeping about "a
 * password reset was emailed to this person" is the audit row, which says so without also
 * being a standing list of every address this installation has ever written to.
 *
 * Failed rows are never pruned: they are the ones somebody still has to do something about.
 */
export function pruneSentEmails(ctx: AppContext): number {
  const cutoff = isoIn(-SENT_RETENTION_DAYS * 86_400, ctx.now());
  const result = ctx.db
    .delete(emailOutbox)
    .where(and(eq(emailOutbox.status, 'sent'), lt(emailOutbox.createdAt, cutoff)))
    .run();
  return result.changes;
}

/* -------------------------------------------------------------------------- */
/* Admin views                                                                */
/* -------------------------------------------------------------------------- */

export function mailStatus(ctx: AppContext): MailStatus {
  const counts = ctx.db
    .select({ status: emailOutbox.status, count: sql<number>`count(*)` })
    .from(emailOutbox)
    .groupBy(emailOutbox.status)
    .all();

  const of = (status: EmailStatus): number =>
    counts.find((row) => row.status === status)?.count ?? 0;

  return {
    configured: ctx.mailer.enabled,
    host: ctx.config.mail?.host ?? null,
    from: ctx.config.mail?.from ?? null,
    appBaseUrl: ctx.config.appBaseUrl,
    pending: of('pending'),
    // Suppressed messages are counted with the failures on purpose. From the admin screen's
    // point of view they are the same problem — somebody was not told something — and
    // splitting them into a number nobody looks at would bury the commonest case of all.
    failed: of('failed') + of('suppressed'),
    recent: ctx.db
      .select()
      .from(emailOutbox)
      .orderBy(desc(emailOutbox.createdAt))
      .limit(RECENT_LIMIT)
      .all()
      .map(toRecord),
  };
}

/**
 * Send a message right now, past the queue, and report what happened.
 *
 * The one place in this file that sends inline, and the reason is the whole point of the
 * button: an operator fixing their SMTP settings needs the server's actual complaint in
 * front of them, not a row that will fail again in a minute somewhere they are not looking.
 */
export async function sendTestEmail(
  ctx: AppContext,
  userId: string,
  message: RenderedEmail,
  ip: string | null,
): Promise<MailTestResult> {
  const user = ctx.db.select().from(users).where(eq(users.id, userId)).get();
  const to = user?.email ?? '';

  const now = ctx.now();
  const id = uuidv7(now.getTime());
  let error: string | null = null;

  try {
    if (!ctx.mailer.enabled) {
      throw new Error(
        'No mail transport is configured. Set SMTP_HOST (and SMTP_USER/SMTP_PASS) and restart.',
      );
    }
    await ctx.mailer.send({ to, subject: message.subject, text: message.text, html: message.html });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  // Recorded in the outbox either way, so the attempt and its error are visible in the same
  // list as everything else rather than only in whatever the admin's browser did with it.
  ctx.db
    .insert(emailOutbox)
    .values({
      id,
      kind: message.kind,
      toEmail: to,
      userId,
      subject: message.subject,
      bodyEncrypted: null,
      status: error === null ? 'sent' : 'failed',
      attempts: 1,
      nextAttemptAt: null,
      lastError: error,
      createdAt: isoNow(now),
      sentAt: error === null ? isoNow(now) : null,
    })
    .run();

  recordAudit(ctx, {
    actorUserId: userId,
    action: 'email.test',
    entityType: 'email',
    entityId: id,
    ip,
    meta: { ok: error === null },
  });

  return { ok: error === null, to, error };
}

/**
 * Put a failed message back in the queue.
 *
 * Only messages that still have a body can go back — once a row is abandoned its body is
 * discarded, and a reset link from three days ago would be useless even if it were kept.
 * Those are reported as not retryable so the admin knows to reissue rather than wait.
 */
export function retryEmail(ctx: AppContext, id: string): boolean {
  const row = ctx.db.select().from(emailOutbox).where(eq(emailOutbox.id, id)).get();
  if (!row || row.status === 'sent' || row.bodyEncrypted === null) return false;

  ctx.db
    .update(emailOutbox)
    .set({ status: 'pending', attempts: 0, nextAttemptAt: isoNow(ctx.now()), lastError: null })
    .where(eq(emailOutbox.id, id))
    .run();

  void deliverDueEmails(ctx).catch(() => undefined);
  return true;
}

function toRecord(row: EmailOutboxRow): EmailRecord {
  return {
    id: row.id,
    kind: row.kind as EmailKind,
    to: row.toEmail,
    subject: row.subject,
    status: row.status as EmailStatus,
    attempts: row.attempts,
    lastError: row.lastError,
    nextAttemptAt: row.nextAttemptAt,
    createdAt: row.createdAt,
    sentAt: row.sentAt,
  };
}
