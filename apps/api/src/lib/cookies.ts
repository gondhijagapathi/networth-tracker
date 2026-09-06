/**
 * Session cookies.
 *
 * All three are `SameSite=Strict`: this app is never embedded in another site and has no
 * cross-origin flows, so the strictest setting costs nothing and removes CSRF as a class
 * of problem before the double-submit token is even consulted.
 *
 *   nt_access   httpOnly. The short-lived JWT. JavaScript must never read it.
 *   nt_refresh  httpOnly, scoped to `/api/auth` so it is not attached to ordinary requests.
 *   nt_csrf     readable by JavaScript by design — the client echoes it in a header, and
 *               the server checks the two match (see middleware/csrf.ts).
 */

import type { CookieOptions, Response } from 'express';

export const ACCESS_COOKIE = 'nt_access';
export const REFRESH_COOKIE = 'nt_refresh';
export const CSRF_COOKIE = 'nt_csrf';

/** The refresh cookie travels only to the routes that can spend it. */
export const REFRESH_COOKIE_PATH = '/api/auth';

function base(secure: boolean): CookieOptions {
  return { httpOnly: true, sameSite: 'strict', secure, path: '/' };
}

export interface SessionCookies {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
}

export function setSessionCookies(
  res: Response,
  { accessToken, refreshToken, csrfToken }: SessionCookies,
  options: { secure: boolean; accessTtlSeconds: number; refreshTtlSeconds: number },
): void {
  const { secure, accessTtlSeconds, refreshTtlSeconds } = options;

  res.cookie(ACCESS_COOKIE, accessToken, {
    ...base(secure),
    maxAge: accessTtlSeconds * 1000,
  });

  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...base(secure),
    path: REFRESH_COOKIE_PATH,
    maxAge: refreshTtlSeconds * 1000,
  });

  // Not httpOnly: the client reads this one and sends it back in `x-csrf-token`.
  res.cookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: refreshTtlSeconds * 1000,
  });
}

/**
 * Clear all three.
 *
 * The options must match those the cookies were set with — a `path` mismatch leaves the
 * refresh cookie in place and silently un-does the logout.
 */
export function clearSessionCookies(res: Response, options: { secure: boolean }): void {
  const { secure } = options;
  res.clearCookie(ACCESS_COOKIE, base(secure));
  res.clearCookie(REFRESH_COOKIE, { ...base(secure), path: REFRESH_COOKIE_PATH });
  res.clearCookie(CSRF_COOKIE, { httpOnly: false, sameSite: 'strict', secure, path: '/' });
}
