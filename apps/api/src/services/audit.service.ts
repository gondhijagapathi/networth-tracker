/**
 * Audit trail.
 *
 * Append-only by convention and by use: nothing in the codebase updates or deletes an
 * `audit_log` row. Security-relevant events are written here even when they fail — a run
 * of `login.failed` rows from one address is exactly the signal an operator needs.
 *
 * Writing the log must never break the operation it describes, so a failure here is
 * swallowed with a warning rather than turned into a 500 that hides a successful login.
 */

import { uuidv7 } from '@networth/shared';
import type { AppContext } from '../context.js';
import { auditLog } from '../db/schema.js';
import { isoNow } from '../lib/time.js';

export type AuditAction =
  | 'user.registered'
  | 'user.login'
  | 'user.login_failed'
  | 'user.logout'
  | 'user.password_changed'
  // A reset is a password change by somebody who could not sign in, so it gets its own
  // vocabulary: the request, the failures, and the completion are three different events,
  // and the first of them is written even for an address with no account behind it.
  | 'user.reset_requested'
  | 'user.reset_failed'
  | 'user.password_reset'
  | 'user.suspended'
  | 'user.reactivated'
  | 'user.role_changed'
  | 'session.refreshed'
  | 'session.reuse_detected'
  | 'session.revoked'
  | 'invite.created'
  | 'invite.consumed'
  | 'invite.revoked'
  | 'invite.rejected'
  | 'invite.emailed'
  | 'totp.enabled'
  | 'totp.disabled'
  | 'totp.recovery_code_used'
  // Asset events are recorded where they cannot be reconstructed from the data itself: a
  // created or archived asset leaves a row behind, a deleted transaction leaves nothing.
  | 'asset.created'
  | 'asset.archived'
  | 'transaction.deleted'
  | 'instrument.created'
  | 'prices.refreshed'
  // Household grants flow both ways between two independent people, so every step that
  // changes what one of them shares gets a row — a partner narrowing their own share mode
  // is the one event neither side can see happen inside the other's account otherwise.
  | 'household.created'
  | 'household.invited'
  | 'household.joined'
  | 'household.share_updated'
  | 'household.left'
  // The vault and the estate are where the audit log stops being a nicety. A released
  // escrow hands somebody the keys to a household; "when, and what opened it" has to be
  // answerable months later, by which time nobody remembers.
  | 'vault.created'
  | 'vault.rekeyed'
  | 'vault.unlock_requested'
  | 'vault.unlocked'
  | 'vault.item_created'
  | 'vault.item_updated'
  | 'vault.item_deleted'
  | 'vault.document_uploaded'
  | 'vault.document_downloaded'
  | 'vault.document_deleted'
  | 'nominee.created'
  | 'nominee.updated'
  | 'nominee.invited'
  | 'nominee.accepted'
  | 'nominee.revoked'
  | 'escrow.sealed'
  | 'escrow.released'
  | 'escrow.revoked'
  | 'escrow.read'
  | 'deadman.configured'
  | 'deadman.checkin'
  | 'deadman.checkin_emailed'
  | 'deadman.warned'
  | 'deadman.grace_started'
  | 'deadman.cancelled'
  | 'deadman.fired'
  | 'claimkit.generated'
  // A backup is a copy of the entire installation and an export is a copy of one person's
  // finances, both leaving the machine in a form nothing here can take back. Who made one,
  // and when, is the least an audit log owes the household.
  | 'backup.created'
  | 'backup.deleted'
  | 'backup.restored'
  | 'export.generated'
  // Mail is the only thing this application sends outside the machine. A message it gave up
  // on is somebody who was not told something — a dead-man warning, a released escrow — and
  // that non-event deserves a row as much as any of the events above.
  | 'email.failed'
  | 'email.test';

export interface AuditEntry {
  actorUserId?: string | null;
  action: AuditAction;
  entityType?: string;
  entityId?: string;
  ip?: string | null;
  /** Event-specific detail. Must never contain a credential, token or hash. */
  meta?: Record<string, unknown>;
}

export function recordAudit(ctx: AppContext, entry: AuditEntry): void {
  try {
    ctx.db
      .insert(auditLog)
      .values({
        id: uuidv7(ctx.now().getTime()),
        actorUserId: entry.actorUserId ?? null,
        action: entry.action,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        ip: entry.ip ?? null,
        meta: entry.meta ? JSON.stringify(entry.meta) : null,
        at: isoNow(ctx.now()),
      })
      .run();
  } catch (error) {
    console.warn('Failed to write audit entry', entry.action, error);
  }
}
