/**
 * Invites — the only way an account comes into existence.
 *
 * There is no open signup and no "create user" endpoint. An admin issues a code, the code
 * is redeemed once, and the row records who used it. The very first admin comes from
 * `BOOTSTRAP_INVITE_CODE`, which is materialised into a real invite row on first boot so
 * that path is the same code path as every other registration.
 *
 * Only the SHA-256 of a code is stored. An admin who loses a code re-issues it; nobody,
 * including someone holding the database, can read one back.
 */

import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { uuidv7, type CreateInviteBody, type InviteSummary, type Role } from '@networth/shared';
import type { AppContext } from '../context.js';
import { invites, users, type InviteRow } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { inviteEmail, nomineeInviteEmail } from '../lib/mailTemplates.js';
import { isoIn, isoNow } from '../lib/time.js';
import { recordAudit } from './audit.service.js';
import { queueEmail } from './mail.service.js';

/** Crockford-ish: no `I`, `L`, `O`, `U` — these are read aloud and typed by hand. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const GROUPS = 4;
const GROUP_LENGTH = 5;

/**
 * Normalise before hashing or comparing.
 *
 * Codes get read over the phone and retyped, so case and grouping dashes are irrelevant;
 * what matters is that the same normalisation runs on both the issue and the redeem side.
 * `BOOTSTRAP_INVITE_CODE` from the environment goes through it too.
 */
export function normaliseInviteCode(code: string): string {
  return code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function hashInviteCode(code: string): string {
  return createHash('sha256').update(normaliseInviteCode(code)).digest('base64url');
}

/** A fresh code in `ABCDE-FGHJK-MNPQR-STVWX` form. ~98 bits of entropy. */
export function generateInviteCode(): string {
  const bytes = new Uint8Array(GROUPS * GROUP_LENGTH);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]);
  return Array.from({ length: GROUPS }, (_, group) =>
    chars.slice(group * GROUP_LENGTH, (group + 1) * GROUP_LENGTH).join(''),
  ).join('-');
}

export interface CreatedInvite {
  invite: InviteSummary;
  /** Plaintext, returned exactly once. It is not stored and cannot be shown again. */
  code: string;
  /**
   * Whether the code was also mailed to the invitee.
   *
   * False when the invite is unbound, when the admin unticked it, or when this instance has
   * no mail transport. The admin screen shows the code either way and says which happened —
   * an invite that was silently not delivered is how somebody ends up waiting a week for an
   * email that was never going to arrive.
   */
  emailQueued: boolean;
}

/** How an invite is worded when it is mailed. Nominee invites need to explain themselves. */
export interface InviteMailContext {
  kind: 'admin' | 'nominee';
  /** The person issuing it, for an admin invite. */
  invitedBy?: string | null;
  /** The owner and the heir's own name, for a nominee invite. */
  ownerName?: string;
  nomineeName?: string;
  accessLevel?: string;
}

export function createInvite(
  ctx: AppContext,
  actorUserId: string,
  body: CreateInviteBody,
  mail: InviteMailContext = { kind: 'admin' },
): CreatedInvite {
  const now = ctx.now();
  const code = generateInviteCode();

  if (body.email) {
    const taken = ctx.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, body.email))
      .get();
    if (taken) throw conflict('An account already exists for that email address');
  }

  const row: typeof invites.$inferInsert = {
    id: uuidv7(now.getTime()),
    codeHash: hashInviteCode(code),
    email: body.email ?? null,
    role: body.role,
    note: body.note ?? null,
    createdByUserId: actorUserId,
    expiresAt: isoIn(body.expiresInDays * 86400, now),
    createdAt: isoNow(now),
  };

  ctx.db.insert(invites).values(row).run();

  recordAudit(ctx, {
    actorUserId,
    action: 'invite.created',
    entityType: 'invite',
    entityId: row.id,
    meta: { role: body.role, boundToEmail: Boolean(body.email) },
  });

  const emailQueued =
    body.email !== undefined && body.sendEmail
      ? queueEmail(ctx, body.email, renderInvite(ctx, mail, code, body, row.expiresAt), {
          userId: null,
        }) !== null
      : false;

  if (emailQueued) {
    recordAudit(ctx, {
      actorUserId,
      action: 'invite.emailed',
      entityType: 'invite',
      entityId: row.id,
      meta: { kind: mail.kind },
    });
  }

  return {
    invite: toSummary({ ...row, consumedAt: null, consumedByUserId: null } as InviteRow),
    code,
    emailQueued,
  };
}

function renderInvite(
  ctx: AppContext,
  mail: InviteMailContext,
  code: string,
  body: CreateInviteBody,
  expiresAt: string,
) {
  const base = { baseUrl: ctx.config.appBaseUrl };

  if (mail.kind === 'nominee') {
    return nomineeInviteEmail(base, {
      code,
      ownerName: mail.ownerName ?? 'Somebody',
      nomineeName: mail.nomineeName ?? 'Hello',
      expiresAt,
      accessLevel: mail.accessLevel ?? 'summary',
    });
  }

  return inviteEmail(base, {
    code,
    role: body.role,
    expiresAt,
    invitedBy: mail.invitedBy ?? null,
    note: body.note ?? null,
  });
}

/**
 * Newest first, ordered by id rather than `created_at`.
 *
 * Ids are UUIDv7, so they carry the same creation order but are unique — two invites
 * issued in the same millisecond would tie on the timestamp and come back in arbitrary
 * order.
 */
export function listInvites(ctx: AppContext): InviteSummary[] {
  return ctx.db.select().from(invites).orderBy(desc(invites.id)).all().map(toSummary);
}

/**
 * Withdraw an unused invite by expiring it.
 *
 * The row is not deleted: "this code was issued to that address and then withdrawn" is
 * exactly the history an audit is for.
 */
export function revokeInvite(ctx: AppContext, actorUserId: string, inviteId: string): void {
  const invite = ctx.db.select().from(invites).where(eq(invites.id, inviteId)).get();
  if (!invite) throw notFound('No such invite');
  if (invite.consumedAt) throw conflict('That invite has already been used');

  ctx.db
    .update(invites)
    .set({ expiresAt: isoNow(ctx.now()) })
    .where(eq(invites.id, inviteId))
    .run();

  recordAudit(ctx, {
    actorUserId,
    action: 'invite.revoked',
    entityType: 'invite',
    entityId: inviteId,
  });
}

/**
 * Find the invite a code refers to and check it may be redeemed by `email`.
 *
 * Every failure is the same message. A distinct "this code expired" would confirm to
 * someone guessing codes that they had found a real one.
 */
export function findRedeemableInvite(ctx: AppContext, code: string, email: string): InviteRow {
  const invite = ctx.db
    .select()
    .from(invites)
    .where(eq(invites.codeHash, hashInviteCode(code)))
    .get();

  const rejection = badRequest('That invite code is not valid');

  if (!invite) throw rejection;
  if (invite.consumedAt !== null) throw rejection;
  if (Date.parse(invite.expiresAt) <= ctx.now().getTime()) throw rejection;
  // A code bound to an address may only create that account.
  if (invite.email !== null && invite.email !== email) throw rejection;

  return invite;
}

/** Mark an invite spent. Runs inside the registration transaction, never on its own. */
export function markInviteConsumed(
  tx: Pick<AppContext['db'], 'update'>,
  inviteId: string,
  userId: string,
  at: string,
): void {
  tx.update(invites)
    .set({ consumedAt: at, consumedByUserId: userId })
    .where(eq(invites.id, inviteId))
    .run();
}

/**
 * Materialise `BOOTSTRAP_INVITE_CODE` into a real invite row, once, on an empty instance.
 *
 * Doing it this way rather than creating an admin user directly means first-run has no
 * special case: the operator registers through the ordinary form, chooses their own
 * password, and the audit log shows an invite consumed like any other.
 *
 * @returns whether a bootstrap invite exists and is still waiting to be used.
 */
export function ensureBootstrapInvite(ctx: AppContext): boolean {
  const anyUser = ctx.db.select({ id: users.id }).from(users).limit(1).get();
  if (anyUser) return false;

  const code = ctx.config.BOOTSTRAP_INVITE_CODE;
  if (!code) return false;

  const now = ctx.now();
  const codeHash = hashInviteCode(code);

  const existing = ctx.db.select().from(invites).where(eq(invites.codeHash, codeHash)).get();
  if (existing) {
    // Already present but timed out while the instance sat unused: extend rather than
    // stranding the operator with a code their .env still says is current.
    if (existing.consumedAt === null && Date.parse(existing.expiresAt) <= now.getTime()) {
      ctx.db
        .update(invites)
        .set({ expiresAt: isoIn(30 * 86400, now) })
        .where(eq(invites.id, existing.id))
        .run();
      return true;
    }
    return existing.consumedAt === null;
  }

  ctx.db
    .insert(invites)
    .values({
      id: uuidv7(now.getTime()),
      codeHash,
      email: null,
      role: 'admin',
      note: 'Bootstrap invite created from BOOTSTRAP_INVITE_CODE',
      createdByUserId: null,
      expiresAt: isoIn(30 * 86400, now),
      createdAt: isoNow(now),
    })
    .run();

  return true;
}

/** Invites that are neither consumed nor expired, for the admin list's "active" filter. */
export function activeInvites(ctx: AppContext): InviteSummary[] {
  return ctx.db
    .select()
    .from(invites)
    .where(
      and(isNull(invites.consumedAt), or(eq(invites.role, 'admin'), eq(invites.role, 'member'))),
    )
    .all()
    .filter((invite) => Date.parse(invite.expiresAt) > ctx.now().getTime())
    .map(toSummary);
}

function toSummary(invite: InviteRow): InviteSummary {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role as Role,
    note: invite.note,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    consumedAt: invite.consumedAt,
    consumedByUserId: invite.consumedByUserId,
  };
}
