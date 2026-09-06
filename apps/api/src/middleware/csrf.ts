/**
 * CSRF protection, double-submit cookie pattern.
 *
 * The session cookies are already `SameSite=Strict`, which stops the classic cross-site
 * form post on its own. This is the second layer: a request that mutates state must carry
 * the CSRF token in a header *and* in the cookie, and they must match. An attacker on
 * another origin can cause the cookie to be sent but cannot read it to set the header.
 *
 * Safe methods are exempt — they change nothing, and requiring a token on `GET` would
 * break the first page load of a session that has not seen a cookie yet.
 */

import type { RequestHandler } from 'express';
import { CSRF_COOKIE } from '../lib/cookies.js';
import { forbidden } from '../lib/errors.js';
import { safeEqual } from '../lib/tokens.js';

export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfProtection(): RequestHandler {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();

    const cookieToken = req.cookies?.[CSRF_COOKIE] as string | undefined;
    const headerToken = req.get(CSRF_HEADER);

    // No cookie means no session to forge against — let the route's own auth check answer,
    // so an unauthenticated caller gets a 401 rather than a confusing 403.
    if (!cookieToken) return next();

    if (!headerToken || !safeEqual(cookieToken, headerToken)) {
      return next(forbidden('Missing or invalid CSRF token'));
    }

    return next();
  };
}
