/**
 * Refresh-token sessions.
 *
 * One login opens a *family*. Each refresh spends the current token and issues its
 * successor in the same family, so a stolen token is only useful until the real client
 * next refreshes.
 *
 * That is the point of rotation, and it is why replay is treated so harshly: if a token
 * that has already been rotated comes back, either an attacker copied it or the database
 * leaked. We cannot tell which, and both are answered the same way — revoke the entire
 * family, which signs that device chain out and forces a fresh password login.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7, type SessionSummary } from '@networth/shared';
import type { AppContext } from '../context.js';
import { refreshTokens, users, type UserRow } from '../db/schema.js';
import { unauthenticated } from '../lib/errors.js';
import { isoIn, isoNow } from '../lib/time.js';
import {
  hashRefreshToken,
  mintCsrfToken,
  mintRefreshToken,
  signAccessToken,
} from '../lib/tokens.js';
import { recordAudit } from './audit.service.js';

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  familyId: string;
  tokenId: string;
  userId: string;
}

/** Open a new session family. Called on register and on login, never on refresh. */
export async function issueSession(
  ctx: AppContext,
  user: Pick<UserRow, 'id' | 'role'>,
  options: { deviceLabel?: string | undefined; familyId?: string } = {},
): Promise<IssuedSession> {
  const now = ctx.now();
  // Read rather than remembered: a password change immediately before this bumped the
  // epoch, and the token being minted now must carry the new one or it would be rejected
  // by the very next request it makes.
  const epoch = currentEpoch(ctx, user.id);
  const familyId = options.familyId ?? uuidv7(now.getTime());
  const tokenId = uuidv7(now.getTime());
  const refreshToken = mintRefreshToken();

  ctx.db
    .insert(refreshTokens)
    .values({
      id: tokenId,
      userId: user.id,
      familyId,
      tokenHash: hashRefreshToken(refreshToken, ctx.config.JWT_REFRESH_SECRET),
      deviceLabel: options.deviceLabel ?? null,
      createdAt: isoNow(now),
      lastUsedAt: isoNow(now),
      expiresAt: isoIn(ctx.config.refreshTokenTtlSeconds, now),
    })
    .run();

  const accessToken = await signAccessToken(
    { sub: user.id, role: user.role, sid: familyId, ep: epoch },
    ctx.config.JWT_ACCESS_SECRET,
    ctx.config.accessTokenTtlSeconds,
    now,
  );

  return {
    accessToken,
    refreshToken,
    csrfToken: mintCsrfToken(),
    familyId,
    tokenId,
    userId: user.id,
  };
}

/**
 * Spend a refresh token and issue its successor.
 *
 * Every rejection path throws the same 401. A caller holding a bad token learns that it
 * does not work, not whether it was expired, revoked, replayed or never existed.
 */
export async function rotateSession(
  ctx: AppContext,
  presentedToken: string,
  ip: string | null,
): Promise<IssuedSession> {
  const now = ctx.now();
  const tokenHash = hashRefreshToken(presentedToken, ctx.config.JWT_REFRESH_SECRET);

  const existing = ctx.db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .get();

  if (!existing) throw unauthenticated('Your session has expired');

  // Already rotated or explicitly revoked, yet presented again: assume compromise.
  if (existing.revokedAt !== null) {
    revokeFamily(ctx, existing.familyId, 'reuse_detected');
    recordAudit(ctx, {
      actorUserId: existing.userId,
      action: 'session.reuse_detected',
      entityType: 'refresh_token_family',
      entityId: existing.familyId,
      ip,
    });
    throw unauthenticated('Your session has expired');
  }

  if (Date.parse(existing.expiresAt) <= now.getTime()) {
    throw unauthenticated('Your session has expired');
  }

  const user = ctx.db.select().from(users).where(eq(users.id, existing.userId)).get();
  if (!user || user.status !== 'active') {
    revokeFamily(ctx, existing.familyId, 'user_inactive');
    throw unauthenticated('Your session has expired');
  }

  const successorId = uuidv7(now.getTime());
  const refreshToken = mintRefreshToken();

  ctx.db.transaction((tx) => {
    tx.update(refreshTokens)
      .set({ revokedAt: isoNow(now), replacedByTokenId: successorId, lastUsedAt: isoNow(now) })
      .where(eq(refreshTokens.id, existing.id))
      .run();

    tx.insert(refreshTokens)
      .values({
        id: successorId,
        userId: existing.userId,
        familyId: existing.familyId,
        tokenHash: hashRefreshToken(refreshToken, ctx.config.JWT_REFRESH_SECRET),
        deviceLabel: existing.deviceLabel,
        createdAt: isoNow(now),
        lastUsedAt: isoNow(now),
        // The family does not outlive the original grant: refreshing forever would make
        // REFRESH_TOKEN_TTL meaningless.
        expiresAt: existing.expiresAt,
      })
      .run();

    tx.update(users)
      .set({ lastActiveAt: isoNow(now) })
      .where(eq(users.id, user.id))
      .run();
  });

  const accessToken = await signAccessToken(
    { sub: user.id, role: user.role, sid: existing.familyId, ep: currentEpoch(ctx, user.id) },
    ctx.config.JWT_ACCESS_SECRET,
    ctx.config.accessTokenTtlSeconds,
    now,
  );

  return {
    accessToken,
    refreshToken,
    csrfToken: mintCsrfToken(),
    familyId: existing.familyId,
    tokenId: successorId,
    userId: user.id,
  };
}

/** Revoke every live token in a family. Used by logout, by replay detection and by admins. */
export function revokeFamily(ctx: AppContext, familyId: string, _reason: string): void {
  ctx.db
    .update(refreshTokens)
    .set({ revokedAt: isoNow(ctx.now()) })
    .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)))
    .run();
}

/** Sign a user out of every device. Used on password change and on suspension. */
/** The account's current session epoch. Zero for a row that has never been revoked. */
function currentEpoch(ctx: AppContext, userId: string): number {
  return (
    ctx.db.select({ epoch: users.sessionEpoch }).from(users).where(eq(users.id, userId)).get()
      ?.epoch ?? 0
  );
}

export function revokeAllSessions(ctx: AppContext, userId: string): number {
  const now = isoNow(ctx.now());

  const result = ctx.db
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
    .run();

  // The refresh rows above stop this account getting a *new* access token. Bumping the
  // epoch is what stops the one it already holds: every issued token names the epoch it was
  // minted under, and `requireAuth` rejects any that no longer matches. Done
  // unconditionally — an account with no live refresh rows may still have a valid access
  // token in somebody's hands, and that is precisely the case this is for.
  ctx.db
    .update(users)
    .set({ sessionEpoch: sql`${users.sessionEpoch} + 1` })
    .where(eq(users.id, userId))
    .run();

  return result.changes;
}

/**
 * The "signed-in devices" list: one row per live family, not per token.
 *
 * Rotation means a month-old session has produced hundreds of token rows; showing them
 * all would be noise. Users think in devices, so we collapse to the newest live token in
 * each family.
 */
export function listSessions(
  ctx: AppContext,
  userId: string,
  currentFamilyId: string | null,
): SessionSummary[] {
  const live = ctx.db
    .select()
    .from(refreshTokens)
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
    .orderBy(desc(refreshTokens.lastUsedAt))
    .all();

  const newestByFamily = new Map<string, (typeof live)[number]>();
  for (const token of live) {
    if (!newestByFamily.has(token.familyId)) newestByFamily.set(token.familyId, token);
  }

  const now = ctx.now().getTime();

  return [...newestByFamily.values()]
    .filter((token) => Date.parse(token.expiresAt) > now)
    .map((token) => ({
      // The family is the session, so it is the id the client revokes by.
      id: token.familyId,
      deviceLabel: token.deviceLabel,
      createdAt: token.createdAt,
      lastUsedAt: token.lastUsedAt,
      expiresAt: token.expiresAt,
      current: token.familyId === currentFamilyId,
    }));
}
