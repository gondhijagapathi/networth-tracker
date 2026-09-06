/**
 * Authentication endpoints.
 *
 * Handlers stay thin — parse with a shared schema, delegate to a service, set cookies.
 * Every decision about credentials lives in `services/auth.service.ts` so there is one
 * place to audit rather than a rule spread across route bodies.
 */

import { Router, type Response } from 'express';
import {
  changePasswordSchema,
  disableTotpSchema,
  enrolTotpSchema,
  loginSchema,
  registerSchema,
} from '@networth/shared';
import type { AppContext } from '../context.js';
import { REFRESH_COOKIE, clearSessionCookies, setSessionCookies } from '../lib/cookies.js';
import { notFound, unauthenticated } from '../lib/errors.js';
import { clientIp, pathParam } from '../lib/request.js';
import { requireAuth, requireAuthContext } from '../middleware/auth.js';
import {
  beginTotpEnrolment,
  changePassword,
  confirmTotpEnrolment,
  disableTotp,
  login,
  register,
  remainingRecoveryCodes,
  toPublicUser,
} from '../services/auth.service.js';
import { recordAudit } from '../services/audit.service.js';
import { ensureBootstrapInvite } from '../services/invite.service.js';
import {
  listSessions,
  revokeFamily,
  rotateSession,
  type IssuedSession,
} from '../services/session.service.js';
import { and, eq } from 'drizzle-orm';
import { refreshTokens, users } from '../db/schema.js';
import { hashRefreshToken } from '../lib/tokens.js';

export function authRouter(ctx: AppContext): Router {
  const router = Router();
  const authed = requireAuth(ctx);

  const sendSession = (res: Response, session: IssuedSession): void => {
    setSessionCookies(
      res,
      {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        csrfToken: session.csrfToken,
      },
      {
        secure: ctx.config.COOKIE_SECURE,
        accessTtlSeconds: ctx.config.accessTokenTtlSeconds,
        refreshTtlSeconds: ctx.config.refreshTokenTtlSeconds,
      },
    );
  };

  /**
   * Whether this instance still has no accounts.
   *
   * Public and intentionally uninformative: it says only "a bootstrap invite is waiting",
   * which is already obvious to anyone who can reach a brand-new install, and it lets the
   * sign-in page point the operator at registration instead of a login form nobody can use.
   */
  router.get('/bootstrap', (_req, res) => {
    const pending = ensureBootstrapInvite(ctx);
    res.json({ bootstrapRequired: pending });
  });

  router.post('/register', async (req, res) => {
    const body = registerSchema.parse(req.body);
    const { user, session } = await register(ctx, body, clientIp(req));
    sendSession(res, session);
    res.status(201).json({ user, csrfToken: session.csrfToken });
  });

  router.post('/login', async (req, res) => {
    const body = loginSchema.parse(req.body);
    const { user, session } = await login(ctx, body, clientIp(req));
    sendSession(res, session);
    res.json({ user, csrfToken: session.csrfToken });
  });

  /**
   * Exchange the refresh cookie for a new pair.
   *
   * Not behind `requireAuth`: the whole point is to be callable once the access token has
   * expired. The refresh cookie is the credential.
   */
  router.post('/refresh', async (req, res) => {
    const presented = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!presented) throw unauthenticated('Your session has expired');

    const session = await rotateSession(ctx, presented, clientIp(req));
    const user = ctx.db.select().from(users).where(eq(users.id, session.userId)).get();

    sendSession(res, session);
    recordAudit(ctx, {
      actorUserId: user?.id ?? null,
      action: 'session.refreshed',
      entityType: 'refresh_token_family',
      entityId: session.familyId,
      ip: clientIp(req),
    });

    res.json({ user: user ? toPublicUser(user) : null, csrfToken: session.csrfToken });
  });

  router.post('/logout', (req, res) => {
    const ip = clientIp(req);
    const presented = req.cookies?.[REFRESH_COOKIE] as string | undefined;

    if (presented) {
      const row = ctx.db
        .select({ familyId: refreshTokens.familyId, userId: refreshTokens.userId })
        .from(refreshTokens)
        .where(
          eq(refreshTokens.tokenHash, hashRefreshToken(presented, ctx.config.JWT_REFRESH_SECRET)),
        )
        .get();

      if (row) {
        revokeFamily(ctx, row.familyId, 'logout');
        recordAudit(ctx, {
          actorUserId: row.userId,
          action: 'user.logout',
          entityType: 'refresh_token_family',
          entityId: row.familyId,
          ip,
        });
      }
    }

    // Cookies are cleared even when no token matched, so a client holding a stale or
    // already-revoked cookie still ends up signed out rather than stuck.
    clearSessionCookies(res, { secure: ctx.config.COOKIE_SECURE });
    res.status(204).end();
  });

  router.get('/me', authed, (req, res) => {
    const auth = requireAuthContext(req);
    const user = ctx.db.select().from(users).where(eq(users.id, auth.userId)).get();
    if (!user) throw unauthenticated();
    res.json({
      user: toPublicUser(user),
      recoveryCodesRemaining: user.totpEnabled ? remainingRecoveryCodes(ctx, user.id) : 0,
    });
  });

  router.post('/password', authed, async (req, res) => {
    const auth = requireAuthContext(req);
    const body = changePasswordSchema.parse(req.body);
    await changePassword(ctx, auth.userId, body, clientIp(req));
    // Every session including this one is gone; the client must sign in again.
    clearSessionCookies(res, { secure: ctx.config.COOKIE_SECURE });
    res.status(204).end();
  });

  router.get('/sessions', authed, (req, res) => {
    const auth = requireAuthContext(req);
    res.json({ sessions: listSessions(ctx, auth.userId, auth.sessionId) });
  });

  /** Sign out one device. Scoped to the caller's own sessions — no cross-user revocation. */
  router.delete('/sessions/:familyId', authed, (req, res) => {
    const auth = requireAuthContext(req);
    const familyId = pathParam(req, 'familyId');

    // Scoped by user id in the query itself: a family belonging to someone else simply
    // does not match, and the caller is told it does not exist rather than that it is
    // someone else's.
    const owned = ctx.db
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(and(eq(refreshTokens.familyId, familyId), eq(refreshTokens.userId, auth.userId)))
      .get();

    if (!owned) throw notFound('No such session');

    revokeFamily(ctx, familyId, 'user_revoked');
    recordAudit(ctx, {
      actorUserId: auth.userId,
      action: 'session.revoked',
      entityType: 'refresh_token_family',
      entityId: familyId,
      ip: clientIp(req),
    });

    if (familyId === auth.sessionId) {
      clearSessionCookies(res, { secure: ctx.config.COOKIE_SECURE });
    }
    res.status(204).end();
  });

  /* ---------------------------------------------------------------------- */
  /* Two-factor authentication                                              */
  /* ---------------------------------------------------------------------- */

  router.post('/2fa/enrol', authed, (req, res) => {
    const auth = requireAuthContext(req);
    res.json(beginTotpEnrolment(ctx, auth.userId));
  });

  router.post('/2fa/enrol/confirm', authed, (req, res) => {
    const auth = requireAuthContext(req);
    const { code } = enrolTotpSchema.parse(req.body);
    const recoveryCodes = confirmTotpEnrolment(ctx, auth.userId, code, clientIp(req));
    // Shown once. There is no endpoint that can return these again.
    res.json({ recoveryCodes });
  });

  router.post('/2fa/disable', authed, async (req, res) => {
    const auth = requireAuthContext(req);
    const body = disableTotpSchema.parse(req.body);
    await disableTotp(ctx, auth.userId, body.password, body.code, clientIp(req));
    res.status(204).end();
  });

  return router;
}
