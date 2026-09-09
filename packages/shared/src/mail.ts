/**
 * Notification contracts shared by the API and the web client.
 *
 * Mail is the one thing this application does that leaves the machine, so the vocabulary
 * for it is defined here in one place: what kinds of message exist, what state a queued
 * message can be in, and what the admin screen is allowed to see about it.
 *
 * Note what is *not* in these types. An outbox row crossing the wire carries the subject
 * and the recipient, never the body — a rendered password-reset mail contains a live
 * credential, and an admin screen listing recent mail has no business showing one.
 *
 * The credential side of the reset flow lives in `auth.ts` with the other credentials;
 * what is here is the transport that carries it.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Enumerations                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every message this application can send.
 *
 * Kept as a closed list rather than free-form subjects so the outbox can be filtered, the
 * audit log can say which template went out, and a new message type is a deliberate
 * addition rather than a string typed at a call site.
 */
export const EMAIL_KINDS = [
  'invite',
  'nominee_invite',
  'household_invite',
  'welcome',
  'password_reset',
  'password_changed',
  'two_factor_changed',
  'deadman_warning',
  'deadman_grace',
  'deadman_fired',
  'estate_released',
  'test',
] as const;
export const emailKindSchema = z.enum(EMAIL_KINDS);
export type EmailKind = z.infer<typeof emailKindSchema>;

/**
 * `pending`    queued, waiting for its next attempt.
 * `sent`       accepted by the SMTP server. Not the same as "read", and not a guarantee
 *              of delivery — the server may still bounce it later, silently.
 * `failed`     every attempt used up. Terminal; an admin may retry it by hand.
 * `suppressed` never attempted, because this instance has no mail transport configured.
 *              A distinct state from `failed` so "you never set SMTP up" does not read as
 *              "your Gmail password is wrong".
 */
export const EMAIL_STATUSES = ['pending', 'sent', 'failed', 'suppressed'] as const;
export const emailStatusSchema = z.enum(EMAIL_STATUSES);
export type EmailStatus = z.infer<typeof emailStatusSchema>;

/* -------------------------------------------------------------------------- */
/* Response shapes                                                            */
/* -------------------------------------------------------------------------- */

/** One row in the admin mail log. Subject and recipient only — never the body. */
export interface EmailRecord {
  id: string;
  kind: EmailKind;
  to: string;
  subject: string;
  status: EmailStatus;
  attempts: number;
  /** The transport's own words on the last failure, verbatim. Null while things are fine. */
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  sentAt: string | null;
}

/**
 * What the admin screen shows about mail.
 *
 * `configured` is the question an operator actually has — "will anything I do here send an
 * email?" — and the rest explains the answer. `from` and `host` are echoed back because
 * the commonest Gmail mistake is authenticating as one address and sending as another.
 */
export interface MailStatus {
  configured: boolean;
  host: string | null;
  from: string | null;
  /** The public base URL that links in outgoing mail are built from. */
  appBaseUrl: string;
  pending: number;
  failed: number;
  recent: EmailRecord[];
}

/** The result of the admin's "send a test message" button. */
export interface MailTestResult {
  ok: boolean;
  to: string;
  /** The transport's error, unedited, so a misconfiguration can be fixed from it. */
  error: string | null;
}
