/**
 * "I forgot my password."
 *
 * The whole flow, and every decision in it, is downstream of one observation: for a
 * self-hosted tracker there is no support desk. If this does not work, the account is gone
 * — along with the record of what a household owns, at the moment somebody needs it most.
 * So it exists, and it is built to be safe rather than convenient.
 *
 * What that means concretely:
 *
 *   - **It reveals nothing.** `requestReset` behaves identically for an address with an
 *     account, an address without one, and a suspended account. `auth.service.ts` goes to
 *     some trouble to keep the login form from enumerating users; a reset form that says
 *     "no account with that email" would give the whole thing away.
 *   - **A second factor stays a second factor.** An account with TOTP enabled must present
 *     it here too. Otherwise control of a mailbox is control of the account, and enrolling
 *     in 2FA would have bought nothing against the attacker it is actually for.
 *   - **The vault is not touched.** The vault passphrase is a separate secret derived in
 *     the browser, and this server has never held anything that could recover it. Resetting
 *     a login password leaves the vault exactly as sealed as it was — which is why the
 *     email says so, in as many words.
 *   - **Everything else is revoked.** A reset ends every session and invalidates every
 *     other outstanding link, because the reason people reset passwords is that they think
 *     somebody else has one.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { uuidv7, type ResetPasswordBody, type ResetTokenCheck } from '@networth/shared';
import type { AppContext } from '../context.js';
import { passwordResets, users, type PasswordResetRow, type UserRow } from '../db/schema.js';
import { ApiError, badRequest } from '../lib/errors.js';
import { hashPassword } from '../lib/passwords.js';
import { passwordChangedEmail, passwordResetEmail } from '../lib/mailTemplates.js';
import { isoIn, isoNow } from '../lib/time.js';
import { recordAudit } from './audit.service.js';
import { verifySecondFactor } from './auth.service.js';
import { queueEmail } from './mail.service.js';
import { revokeAllSessions } from './session.service.js';

/**
 * How long a link lives.
 *
 * An hour. Long enough to survive a mail server's queue and somebody finishing what they
 * were doing; short enough that a link sitting in a mailbox that is later compromised is
 * almost always already dead.
 */
const TOKEN_TTL_SECONDS = 3600;

/* -------------------------------------------------------------------------- */
/* Requesting                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Ask for a reset link.
 *
 * Returns nothing, ever — not whether an account was found, not whether mail went out.
 * The caller answers the same 204 in every case. That is not politeness; it is the entire
 * security property of this endpoint.
 */
export function requestReset(ctx: AppContext, email: string, ip: string | null): void {
  const emailKey = `email:${email}`;
  const ipKey = `ip:${ip ?? 'unknown'}`;
  ctx.resetLimiter.assertAllowed(emailKey);
  ctx.resetLimiter.assertAllowed(ipKey);
  ctx.resetLimiter.recordFailure(emailKey);
  ctx.resetLimiter.recordFailure(ipKey);

  const user = ctx.db.select().from(users).where(eq(users.email, email)).get();

  if (!user || user.status !== 'active') {
    // Audited even so. A run of requests against addresses that do not exist is somebody
    // probing the instance, and that is worth being able to see afterwards.
    recordAudit(ctx, {
      actorUserId: null,
      action: 'user.reset_requested',
      ip,
      meta: { email, delivered: false },
    });
    return;
  }

  const now = ctx.now();

  // Any earlier link stops working the moment a new one is asked for. Two live links is one
  // more than anybody needs, and the older one is the likelier to have leaked.
  invalidateOutstanding(ctx, user.id);

  const token = mintResetToken();

  ctx.db
    .insert(passwordResets)
    .values({
      id: uuidv7(now.getTime()),
      userId: user.id,
      tokenHash: hashResetToken(token, ctx.config.SECRET_ENCRYPTION_KEY),
      requestedIp: ip,
      expiresAt: isoIn(TOKEN_TTL_SECONDS, now),
      usedAt: null,
      invalidatedAt: null,
      createdAt: isoNow(now),
    })
    .run();

  queueEmail(
    ctx,
    user.email,
    passwordResetEmail(
      { baseUrl: ctx.config.appBaseUrl },
      {
        name: user.name,
        token,
        expiresAt: isoIn(TOKEN_TTL_SECONDS, now),
        requestedIp: ip,
        totpEnabled: user.totpEnabled,
      },
    ),
    { userId: user.id },
  );

  recordAudit(ctx, {
    actorUserId: user.id,
    action: 'user.reset_requested',
    entityType: 'user',
    entityId: user.id,
    ip,
    meta: { email, delivered: true },
  });
}

/* -------------------------------------------------------------------------- */
/* Checking                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What the reset page asks before it draws a form.
 *
 * Only so that somebody who followed a stale link is told so before choosing and typing a
 * new password twice, and so the second-factor field is present from the start rather than
 * appearing after a failed submission. The answer carries nothing but those two booleans.
 */
export function checkResetToken(ctx: AppContext, token: string): ResetTokenCheck {
  const found = liveReset(ctx, token);
  if (!found) return { valid: false, totpRequired: false };
  return { valid: true, totpRequired: found.user.totpEnabled };
}

/* -------------------------------------------------------------------------- */
/* Completing                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Set the new password.
 *
 * Rate-limited on the client address rather than on the token: the token is 256 random
 * bits and is not going to be guessed, but a caller who has one and is grinding TOTP codes
 * against it is exactly the attacker the second factor is there to stop.
 */
export async function completeReset(
  ctx: AppContext,
  body: ResetPasswordBody,
  ip: string | null,
): Promise<void> {
  const ipKey = `reset-ip:${ip ?? 'unknown'}`;
  ctx.loginLimiter.assertAllowed(ipKey);

  const found = liveReset(ctx, body.token);
  if (!found) {
    ctx.loginLimiter.recordFailure(ipKey);
    recordAudit(ctx, {
      actorUserId: null,
      action: 'user.reset_failed',
      ip,
      meta: { reason: 'token' },
    });
    throw badRequest(
      'That reset link is no longer valid. Ask for a new one — links expire after an hour and can only be used once.',
    );
  }

  const { row, user } = found;

  if (user.totpEnabled) {
    if (!body.totp) {
      // The same code the login form already handles, so the client shows the same field.
      throw new ApiError('totp_required', 'Enter the code from your authenticator app');
    }
    if (!verifySecondFactor(ctx, user, body.totp, ip)) {
      ctx.loginLimiter.recordFailure(ipKey);
      recordAudit(ctx, {
        actorUserId: user.id,
        action: 'user.reset_failed',
        entityType: 'user',
        entityId: user.id,
        ip,
        meta: { reason: 'totp' },
      });
      throw badRequest('That code is not valid', { totp: ['That code is not valid'] });
    }
  }

  const passwordHash = await hashPassword(body.password);
  const now = isoNow(ctx.now());

  ctx.db.transaction((tx) => {
    tx.update(users).set({ passwordHash, updatedAt: now }).where(eq(users.id, user.id)).run();
    tx.update(passwordResets).set({ usedAt: now }).where(eq(passwordResets.id, row.id)).run();
  });

  // Any other link this account had is now moot, and the sessions go with them: whoever
  // prompted the reset may be holding one.
  invalidateOutstanding(ctx, user.id);
  revokeAllSessions(ctx, user.id);
  ctx.loginLimiter.reset(ipKey);

  recordAudit(ctx, {
    actorUserId: user.id,
    action: 'user.password_reset',
    entityType: 'user',
    entityId: user.id,
    ip,
  });

  // To the address on the account, which is the same address that asked. That is not
  // redundant: if an attacker requested the reset from a mailbox the owner still reads,
  // this is the message that tells them it happened.
  queueEmail(
    ctx,
    user.email,
    passwordChangedEmail(
      { baseUrl: ctx.config.appBaseUrl },
      { name: user.name, at: now, ip, viaReset: true },
    ),
    { userId: user.id },
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Retire every outstanding link for an account.
 *
 * Called on a new request, on a completed reset, and by `auth.service.ts` when a password
 * is changed from a signed-in session — in that last case because a link requested before
 * the change would otherwise still work afterwards, which is precisely the window somebody
 * changing their password in a hurry is trying to close.
 */
export function invalidateOutstanding(ctx: AppContext, userId: string): void {
  ctx.db
    .update(passwordResets)
    .set({ invalidatedAt: isoNow(ctx.now()) })
    .where(
      and(
        eq(passwordResets.userId, userId),
        isNull(passwordResets.usedAt),
        isNull(passwordResets.invalidatedAt),
      ),
    )
    .run();
}

/** The row and its user, if this token is real, unused, uninvalidated and unexpired. */
function liveReset(
  ctx: AppContext,
  token: string,
): { row: PasswordResetRow; user: UserRow } | null {
  const row = ctx.db
    .select()
    .from(passwordResets)
    .where(eq(passwordResets.tokenHash, hashResetToken(token, ctx.config.SECRET_ENCRYPTION_KEY)))
    .get();

  if (!row) return null;
  if (row.usedAt !== null || row.invalidatedAt !== null) return null;
  if (Date.parse(row.expiresAt) <= ctx.now().getTime()) return null;

  const user = ctx.db.select().from(users).where(eq(users.id, row.userId)).get();
  // A suspended account cannot be reset into. The link was valid when it was sent; the
  // account stopped being usable in between, and that decision outranks this one.
  if (!user || user.status !== 'active') return null;

  return { row, user };
}

/** 256 bits, base64url, never stored in this form. */
function mintResetToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The value stored in `password_resets.token_hash`.
 *
 * An HMAC under `SECRET_ENCRYPTION_KEY` rather than a bare SHA-256, for the same reason
 * refresh tokens are: somebody holding a copy of `networth.db` should not be able to test
 * candidate tokens offline without also holding the environment.
 */
export function hashResetToken(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('base64url');
}
