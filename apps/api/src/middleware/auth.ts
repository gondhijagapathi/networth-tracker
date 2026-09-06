/**
 * Authentication and role gates.
 *
 * `requireAuth` answers *who is calling*. It verifies the access JWT and then re-reads the
 * user row: a token stays valid for its full lifetime, so without that read a suspended
 * account would keep working for up to fifteen minutes after an admin locked it. One
 * indexed primary-key lookup is a fair price for suspension taking effect immediately.
 *
 * `requireRole` answers *may they do this*. It never answers *whose data is this* — that is
 * the scoped repository layer's job in P2, and mixing the two is how a forgotten filter
 * leaks another household's assets.
 */

import type { RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import type { Role } from '@networth/shared';
import type { AppContext } from '../context.js';
import { users } from '../db/schema.js';
import { ACCESS_COOKIE } from '../lib/cookies.js';
import { forbidden, unauthenticated } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/tokens.js';

export interface AuthContext {
  userId: string;
  role: Role;
  /** Refresh-token family this access token was minted under. */
  sessionId: string;
  email: string;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * Read the bearer credential.
 *
 * The cookie is the real mechanism. The `Authorization` header is accepted too so that
 * `curl` and the test suite can drive the API without a cookie jar; it is not a second
 * authentication scheme, just a second place to find the same token.
 */
function readAccessToken(header: string | undefined, cookie: string | undefined): string | null {
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim() || null;
  return cookie ?? null;
}

export function requireAuth(ctx: AppContext): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      try {
        const token = readAccessToken(req.get('authorization'), req.cookies?.[ACCESS_COOKIE]);
        if (!token) throw unauthenticated();

        const claims = await verifyAccessToken(token, ctx.config.JWT_ACCESS_SECRET, ctx.now());

        const user = ctx.db
          .select({
            id: users.id,
            email: users.email,
            name: users.name,
            role: users.role,
            status: users.status,
          })
          .from(users)
          .where(eq(users.id, claims.sub))
          .get();

        if (!user) throw unauthenticated('Your session has expired');
        if (user.status !== 'active') {
          throw forbidden('This account has been suspended. Contact your administrator.');
        }

        req.auth = {
          userId: user.id,
          // The database is authoritative, not the token: a role changed after the token
          // was minted takes effect on the next request, not the next login.
          role: user.role,
          sessionId: claims.sid,
          email: user.email,
          name: user.name,
        };

        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

/** Restrict a route to the listed roles. Mount after `requireAuth`. */
export function requireRole(...allowed: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(unauthenticated());
    if (!allowed.includes(req.auth.role)) {
      return next(forbidden('You do not have permission to do this'));
    }
    return next();
  };
}

/** The authenticated caller, or a thrown 401. Saves every handler an existence check. */
export function requireAuthContext(req: Express.Request): AuthContext {
  if (!req.auth) throw unauthenticated();
  return req.auth;
}
