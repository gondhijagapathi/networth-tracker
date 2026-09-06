/**
 * Token minting and verification.
 *
 * Two very different credentials, deliberately built differently:
 *
 *   Access token   A short-lived signed JWT (HS256). Stateless, so the hot path — every
 *                  authenticated request — costs one signature check and no database read.
 *
 *   Refresh token  An opaque 256-bit random string. *Not* a JWT: it must be revocable, and
 *                  a self-validating token cannot be taken back. Only its HMAC lives in
 *                  the database, so a leaked `networth.db` yields no usable session.
 *
 * The refresh hash is an HMAC under `JWT_REFRESH_SECRET` rather than a plain SHA-256, so
 * an attacker holding the database still cannot test candidate tokens offline without
 * also holding the environment secret.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { Role } from '@networth/shared';
import { unauthenticated } from './errors.js';

const ISSUER = 'networth-tracker';
const AUDIENCE = 'networth-tracker/api';

export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  role: Role;
  /** Refresh-token family: lets us invalidate a device chain, not just one token. */
  sid: string;
}

export function accessSecretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * @param now - Injectable clock. Expiry is stamped against it rather than the wall clock so
 *   a test can age a token out by moving time instead of waiting fifteen minutes.
 */
export async function signAccessToken(
  claims: AccessTokenClaims,
  secret: string,
  ttlSeconds: number,
  now: Date = new Date(),
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  return new SignJWT({ role: claims.role, sid: claims.sid })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds)
    .sign(accessSecretKey(secret));
}

/**
 * Verify an access token.
 *
 * Every failure — expired, wrong signature, wrong issuer, missing claim — becomes the same
 * 401. The caller is told to sign in again, never *why* the token was rejected.
 */
export async function verifyAccessToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): Promise<AccessTokenClaims> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, accessSecretKey(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
      currentDate: now,
    }));
  } catch {
    throw unauthenticated('Your session has expired');
  }

  const { sub, role, sid } = payload as JWTPayload & { role?: unknown; sid?: unknown };
  if (typeof sub !== 'string' || typeof role !== 'string' || typeof sid !== 'string') {
    throw unauthenticated('Your session has expired');
  }

  return { sub, role: role as Role, sid };
}

/** A fresh opaque refresh token. 256 bits of entropy; never stored in this form. */
export function mintRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The value stored in `refresh_tokens.token_hash`. */
export function hashRefreshToken(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('base64url');
}

/** A CSRF token for the double-submit cookie. Readable by JavaScript by design. */
export function mintCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Constant-time string comparison.
 *
 * Used for the CSRF double-submit check and for recovery codes, where a byte-by-byte
 * early exit would leak the correct prefix over enough attempts.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself be a timing signal;
  // compare each against a fixed-size digest so every call does the same work.
  const leftDigest = createHmac('sha256', 'length-invariant').update(left).digest();
  const rightDigest = createHmac('sha256', 'length-invariant').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
