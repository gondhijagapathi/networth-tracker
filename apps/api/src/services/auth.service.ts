/**
 * Registration, sign-in and second factors.
 *
 * Two properties are load-bearing throughout this file:
 *
 *   Nothing here reveals whether an account exists. Wrong email and wrong password give
 *   the same message *and* take the same time — see `fakeVerifyDelay`. An unauthenticated
 *   endpoint that distinguishes the two is an account-enumeration oracle, and this app's
 *   user list is a list of people worth targeting.
 *
 *   Every credential change ends every session. Changing a password because it may have
 *   leaked is pointless if the attacker's existing refresh token keeps working.
 */

import { and, eq, isNull } from 'drizzle-orm';
import {
  uuidv7,
  type ChangePasswordBody,
  type LoginBody,
  type PublicUser,
  type RegisterBody,
  type Role,
  type UserStatus,
} from '@networth/shared';
import type { AppContext } from '../context.js';
import { recoveryCodes, users, type UserRow } from '../db/schema.js';
import { ApiError, badRequest, conflict, forbidden, invalidCredentials } from '../lib/errors.js';
import { fakeVerifyDelay, hashPassword, verifyPassword } from '../lib/passwords.js';
import { openSecret, sealSecret } from '../lib/secretbox.js';
import { isoNow } from '../lib/time.js';
import {
  currentTotpCode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  recoveryCodeMatches,
  totpUri,
  verifyTotp,
} from '../lib/totp.js';
import { passwordChangedEmail, twoFactorChangedEmail, welcomeEmail } from '../lib/mailTemplates.js';
import { recordAudit } from './audit.service.js';
import { findRedeemableInvite, markInviteConsumed } from './invite.service.js';
import { queueEmail } from './mail.service.js';
import { linkNomineeAccounts } from './nominee.service.js';
import { invalidateOutstanding } from './passwordReset.service.js';
import { issueSession, revokeAllSessions, type IssuedSession } from './session.service.js';

export interface AuthResult {
  user: PublicUser;
  session: IssuedSession;
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

export async function register(
  ctx: AppContext,
  body: RegisterBody,
  ip: string | null,
): Promise<AuthResult> {
  // Rate limited on the invite code, not the email: guessing codes is the attack, and an
  // attacker choosing a fresh email each time must not get a fresh budget.
  ctx.inviteLimiter.assertAllowed(ip ?? 'unknown');

  let invite;
  try {
    invite = findRedeemableInvite(ctx, body.inviteCode, body.email);
  } catch (error) {
    ctx.inviteLimiter.recordFailure(ip ?? 'unknown');
    recordAudit(ctx, { action: 'invite.rejected', ip, meta: { email: body.email } });
    throw error;
  }

  const existing = ctx.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, body.email))
    .get();
  if (existing) throw conflict('An account already exists for that email address');

  const now = ctx.now();
  const passwordHash = await hashPassword(body.password);

  const user: typeof users.$inferInsert = {
    id: uuidv7(now.getTime()),
    email: body.email,
    name: body.name,
    passwordHash,
    role: invite.role,
    status: 'active',
    lastActiveAt: isoNow(now),
    createdAt: isoNow(now),
    updatedAt: isoNow(now),
  };

  // The insert and the invite consumption are one unit: a crash between them would either
  // burn a code with no account, or leave a code that could be redeemed twice.
  ctx.db.transaction((tx) => {
    tx.insert(users).values(user).run();
    markInviteConsumed(tx, invite.id, user.id, isoNow(now));
  });

  ctx.inviteLimiter.reset(ip ?? 'unknown');

  // An heir who registers becomes a live nomination here, not at the invite. A nomination
  // can be recorded for somebody who never signs up, and somebody can sign up from an
  // invite issued for a different reason entirely; matching on the address covers both.
  linkNomineeAccounts(ctx, { id: user.id, email: user.email }, ip);

  recordAudit(ctx, {
    actorUserId: user.id,
    action: 'user.registered',
    entityType: 'user',
    entityId: user.id,
    ip,
    meta: { role: invite.role },
  });
  recordAudit(ctx, {
    actorUserId: user.id,
    action: 'invite.consumed',
    entityType: 'invite',
    entityId: invite.id,
    ip,
  });

  // Queued after the transaction, not inside it. A welcome message for an account that
  // then failed to commit would be the one email this application must never send.
  queueEmail(
    ctx,
    user.email,
    welcomeEmail(
      { baseUrl: ctx.config.appBaseUrl },
      { name: user.name, email: user.email, role: invite.role },
    ),
    { userId: user.id },
  );

  const session = await issueSession(
    ctx,
    { id: user.id, role: invite.role },
    { deviceLabel: body.deviceLabel },
  );

  return {
    user: toPublicUser(ctx.db.select().from(users).where(eq(users.id, user.id)).get()!),
    session,
  };
}

/* -------------------------------------------------------------------------- */
/* Login                                                                      */
/* -------------------------------------------------------------------------- */

export async function login(
  ctx: AppContext,
  body: LoginBody,
  ip: string | null,
): Promise<AuthResult> {
  // Two independent budgets. The email key stops one account being ground down from many
  // addresses; the address key stops one host spraying many accounts.
  const emailKey = `email:${body.email}`;
  const ipKey = `ip:${ip ?? 'unknown'}`;
  ctx.loginLimiter.assertAllowed(emailKey);
  ctx.loginLimiter.assertAllowed(ipKey);

  const user = ctx.db.select().from(users).where(eq(users.email, body.email)).get();

  if (!user) {
    // Hash anyway so a missing account takes as long as a wrong password.
    await fakeVerifyDelay();
    return failLogin(ctx, emailKey, ipKey, ip, body.email, 'no_such_user');
  }

  const passwordOk = await verifyPassword(body.password, user.passwordHash);
  if (!passwordOk) {
    return failLogin(ctx, emailKey, ipKey, ip, body.email, 'bad_password', user.id);
  }

  // Checked after the password so a suspended account is not distinguishable from an
  // active one to someone who does not already hold the password.
  if (user.status !== 'active') {
    recordAudit(ctx, {
      actorUserId: user.id,
      action: 'user.login_failed',
      ip,
      meta: { reason: 'suspended' },
    });
    throw forbidden('This account has been suspended. Contact your administrator.');
  }

  if (user.totpEnabled) {
    if (!body.totp) {
      // A distinct code, not a failure: the client uses it to show the second-factor field.
      throw new ApiError('totp_required', 'Enter the code from your authenticator app');
    }
    const accepted = verifySecondFactor(ctx, user, body.totp, ip);
    if (!accepted) {
      return failLogin(ctx, emailKey, ipKey, ip, body.email, 'bad_totp', user.id);
    }
  }

  ctx.loginLimiter.reset(emailKey);
  ctx.loginLimiter.reset(ipKey);

  const now = ctx.now();
  ctx.db
    .update(users)
    .set({ lastActiveAt: isoNow(now), updatedAt: isoNow(now) })
    .where(eq(users.id, user.id))
    .run();

  recordAudit(ctx, {
    actorUserId: user.id,
    action: 'user.login',
    entityType: 'user',
    entityId: user.id,
    ip,
    meta: { totp: user.totpEnabled },
  });

  const session = await issueSession(
    ctx,
    { id: user.id, role: user.role },
    { deviceLabel: body.deviceLabel },
  );

  return { user: toPublicUser({ ...user, lastActiveAt: isoNow(now) }), session };
}

function failLogin(
  ctx: AppContext,
  emailKey: string,
  ipKey: string,
  ip: string | null,
  email: string,
  reason: string,
  userId?: string,
): never {
  ctx.loginLimiter.recordFailure(emailKey);
  ctx.loginLimiter.recordFailure(ipKey);
  recordAudit(ctx, {
    actorUserId: userId ?? null,
    action: 'user.login_failed',
    ip,
    meta: { email, reason },
  });
  throw invalidCredentials();
}

/**
 * Accept either a live TOTP code or an unused recovery code.
 *
 * Recovery codes are marked used the moment they match, inside the same statement that
 * finds them, so the same printed code cannot be replayed.
 *
 * Exported because a password reset needs exactly this check and must not reimplement it.
 * An account with a second factor has to present one there too — otherwise control of a
 * mailbox would walk straight past 2FA, and enrolling in it would protect nothing.
 */
export function verifySecondFactor(
  ctx: AppContext,
  user: UserRow,
  presented: string,
  ip: string | null,
): boolean {
  if (/^\d{6}$/.test(presented)) {
    if (!user.totpSecretEncrypted) return false;
    let secret: string;
    try {
      secret = openSecret(user.totpSecretEncrypted, ctx.config.SECRET_ENCRYPTION_KEY, 'totp');
    } catch {
      // Wrong SECRET_ENCRYPTION_KEY or a corrupted row: the factor is unusable, and the
      // user must recover with a recovery code rather than be silently let through.
      return false;
    }
    return verifyTotp(presented, secret, user.email, ctx.now()) !== null;
  }

  const candidateHash = hashRecoveryCode(presented, ctx.config.SECRET_ENCRYPTION_KEY);
  const unused = ctx.db
    .select()
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, user.id), isNull(recoveryCodes.usedAt)))
    .all();

  const match = unused.find((row) => recoveryCodeMatches(candidateHash, row.codeHash));
  if (!match) return false;

  ctx.db
    .update(recoveryCodes)
    .set({ usedAt: isoNow(ctx.now()) })
    .where(eq(recoveryCodes.id, match.id))
    .run();

  recordAudit(ctx, {
    actorUserId: user.id,
    action: 'totp.recovery_code_used',
    entityType: 'user',
    entityId: user.id,
    ip,
    meta: { remaining: unused.length - 1 },
  });

  return true;
}

/* -------------------------------------------------------------------------- */
/* Password change                                                            */
/* -------------------------------------------------------------------------- */

export async function changePassword(
  ctx: AppContext,
  userId: string,
  body: ChangePasswordBody,
  ip: string | null,
): Promise<void> {
  const user = ctx.db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw invalidCredentials();

  if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
    throw badRequest('Current password is incorrect', {
      currentPassword: ['Current password is incorrect'],
    });
  }

  const passwordHash = await hashPassword(body.newPassword);
  const now = isoNow(ctx.now());

  ctx.db.update(users).set({ passwordHash, updatedAt: now }).where(eq(users.id, userId)).run();

  // Including the caller's own session. A password change is the response to "someone may
  // have my credentials", so every device is signed out and must prove the new one.
  revokeAllSessions(ctx, userId);
  // And any reset link asked for before this moment. Somebody changing their password
  // because they are worried is closing exactly that window.
  invalidateOutstanding(ctx, userId);

  recordAudit(ctx, {
    actorUserId: userId,
    action: 'user.password_changed',
    entityType: 'user',
    entityId: userId,
    ip,
  });

  queueEmail(
    ctx,
    user.email,
    passwordChangedEmail(
      { baseUrl: ctx.config.appBaseUrl },
      { name: user.name, at: now, ip, viaReset: false },
    ),
    { userId },
  );
}

/* -------------------------------------------------------------------------- */
/* TOTP enrolment                                                             */
/* -------------------------------------------------------------------------- */

export interface TotpEnrolment {
  /** Base32, for manual entry when a camera is unavailable. */
  secret: string;
  /** `otpauth://` URI the client renders as a QR code. */
  uri: string;
}

/**
 * Begin enrolment.
 *
 * The secret is stored immediately but `totp_enabled` stays false: an enrolment that is
 * started and abandoned must not lock the user out of their own account. Only a confirmed
 * live code flips the flag.
 */
export function beginTotpEnrolment(ctx: AppContext, userId: string): TotpEnrolment {
  const user = ctx.db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw invalidCredentials();
  if (user.totpEnabled) throw conflict('Two-factor authentication is already enabled');

  const secret = generateTotpSecret();

  ctx.db
    .update(users)
    .set({
      totpSecretEncrypted: sealSecret(secret, ctx.config.SECRET_ENCRYPTION_KEY, 'totp'),
      updatedAt: isoNow(ctx.now()),
    })
    .where(eq(users.id, userId))
    .run();

  return { secret, uri: totpUri(secret, user.email) };
}

/**
 * Confirm enrolment with a live code and hand back the recovery codes.
 *
 * The plaintext codes are returned exactly once — only their hashes are kept — so the UI
 * must make the user save them before moving on.
 */
export function confirmTotpEnrolment(
  ctx: AppContext,
  userId: string,
  code: string,
  ip: string | null,
): string[] {
  const user = ctx.db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw invalidCredentials();
  if (user.totpEnabled) throw conflict('Two-factor authentication is already enabled');
  if (!user.totpSecretEncrypted) throw badRequest('Start enrolment before confirming a code');

  const secret = openSecret(user.totpSecretEncrypted, ctx.config.SECRET_ENCRYPTION_KEY, 'totp');
  if (verifyTotp(code, secret, user.email, ctx.now()) === null) {
    throw badRequest('That code is not valid. Check your device clock and try again.', {
      code: ['That code is not valid'],
    });
  }

  const codes = generateRecoveryCodes();
  const now = isoNow(ctx.now());

  ctx.db.transaction((tx) => {
    tx.update(users).set({ totpEnabled: true, updatedAt: now }).where(eq(users.id, userId)).run();
    // Replace any codes left over from a previous enrolment.
    tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
    for (const plain of codes) {
      tx.insert(recoveryCodes)
        .values({
          id: uuidv7(ctx.now().getTime()),
          userId,
          codeHash: hashRecoveryCode(plain, ctx.config.SECRET_ENCRYPTION_KEY),
          createdAt: now,
        })
        .run();
    }
  });

  recordAudit(ctx, {
    actorUserId: userId,
    action: 'totp.enabled',
    entityType: 'user',
    entityId: userId,
    ip,
  });

  queueEmail(
    ctx,
    user.email,
    twoFactorChangedEmail(
      { baseUrl: ctx.config.appBaseUrl },
      { name: user.name, enabled: true, at: now, ip },
    ),
    { userId },
  );

  return codes;
}

/** Turning 2FA off requires both factors — otherwise a stolen session could strip it. */
export async function disableTotp(
  ctx: AppContext,
  userId: string,
  password: string,
  code: string,
  ip: string | null,
): Promise<void> {
  const user = ctx.db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw invalidCredentials();
  if (!user.totpEnabled) throw conflict('Two-factor authentication is not enabled');

  if (!(await verifyPassword(password, user.passwordHash))) {
    throw badRequest('Password is incorrect', { password: ['Password is incorrect'] });
  }
  if (!verifySecondFactor(ctx, user, code, ip)) {
    throw badRequest('That code is not valid', { code: ['That code is not valid'] });
  }

  ctx.db.transaction((tx) => {
    tx.update(users)
      .set({ totpEnabled: false, totpSecretEncrypted: null, updatedAt: isoNow(ctx.now()) })
      .where(eq(users.id, userId))
      .run();
    tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
  });

  recordAudit(ctx, {
    actorUserId: userId,
    action: 'totp.disabled',
    entityType: 'user',
    entityId: userId,
    ip,
  });

  // The message this pair of templates exists for. Somebody who did not do this needs to
  // hear about it, because stripping the second factor is step one of taking an account.
  queueEmail(
    ctx,
    user.email,
    twoFactorChangedEmail(
      { baseUrl: ctx.config.appBaseUrl },
      { name: user.name, enabled: false, at: isoNow(ctx.now()), ip },
    ),
    { userId },
  );
}

/** How many single-use recovery codes the user has left. Surfaced in account settings. */
export function remainingRecoveryCodes(ctx: AppContext, userId: string): number {
  return ctx.db
    .select({ id: recoveryCodes.id })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
    .all().length;
}

/** Exposed for tests, which need a valid code without a phone in the loop. */
export function totpCodeForUser(ctx: AppContext, userId: string, at?: Date): string {
  const user = ctx.db.select().from(users).where(eq(users.id, userId)).get();
  if (!user?.totpSecretEncrypted) throw badRequest('No enrolment in progress');
  const secret = openSecret(user.totpSecretEncrypted, ctx.config.SECRET_ENCRYPTION_KEY, 'totp');
  return currentTotpCode(secret, user.email, at ?? ctx.now());
}

/* -------------------------------------------------------------------------- */

export function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as Role,
    status: user.status as UserStatus,
    totpEnabled: user.totpEnabled,
    createdAt: user.createdAt,
    lastActiveAt: user.lastActiveAt,
  };
}
