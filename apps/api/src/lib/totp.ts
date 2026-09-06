/**
 * Time-based one-time passwords (RFC 6238) and their recovery codes.
 *
 * 2FA is optional here. The threat it answers is a password reused elsewhere and exposed
 * in someone else's breach — a realistic way for a self-hosted instance to be reached by
 * someone who never touched the host.
 */

import { createHmac, randomInt } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import { safeEqual } from './tokens.js';

const ISSUER = 'Net Worth Tracker';
const DIGITS = 6;
const PERIOD_SECONDS = 30;

/**
 * Accept the adjacent steps as well as the current one.
 *
 * A window of 1 tolerates roughly ±30 s of clock skew between the phone and the server.
 * Wider would be friendlier and meaningfully weaker: every extra step multiplies the codes
 * a guess could land on.
 */
const VALIDATION_WINDOW = 1;

/** A base32 secret for a new enrolment. */
export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

function totp(secret: string, accountEmail: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label: accountEmail,
    algorithm: 'SHA1',
    digits: DIGITS,
    period: PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}

/** The `otpauth://` URI an authenticator app scans. Rendered as a QR code by the client. */
export function totpUri(secret: string, accountEmail: string): string {
  return totp(secret, accountEmail).toString();
}

/**
 * Check a six-digit code.
 *
 * @returns the matched time-step delta, or `null` when no step in the window matches.
 *   The delta is returned rather than a boolean so the caller can reject replay of a code
 *   that was already spent.
 */
export function verifyTotp(
  code: string,
  secret: string,
  accountEmail: string,
  at: Date = new Date(),
): number | null {
  const delta = totp(secret, accountEmail).validate({
    token: code,
    window: VALIDATION_WINDOW,
    timestamp: at.getTime(),
  });
  return delta ?? null;
}

/** Generate a code for the current step. Used only by tests and by enrolment previews. */
export function currentTotpCode(
  secret: string,
  accountEmail: string,
  at: Date = new Date(),
): string {
  return totp(secret, accountEmail).generate({ timestamp: at.getTime() });
}

/* -------------------------------------------------------------------------- */
/* Recovery codes                                                             */
/* -------------------------------------------------------------------------- */

/** No `0/o`, `1/l/i`: these get read off a printout and typed by hand. */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const GROUP_LENGTH = 5;
const RECOVERY_CODE_COUNT = 10;

/**
 * Ten single-use codes, shown once at enrolment and never again.
 *
 * Each carries ~50 bits of entropy, which is why they are HMAC'd rather than run through
 * Argon2id: an attacker cannot brute-force the space without the server secret, and
 * checking ten candidates per login attempt must stay cheap.
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => `${randomGroup()}-${randomGroup()}`);
}

function randomGroup(): string {
  let group = '';
  for (let i = 0; i < GROUP_LENGTH; i += 1) {
    group += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return group;
}

/** The value stored in `recovery_codes.code_hash`. Normalises case and stray whitespace. */
export function hashRecoveryCode(code: string, secret: string): string {
  return createHmac('sha256', secret).update(code.trim().toLowerCase()).digest('base64url');
}

/** Constant-time match of a candidate hash against a stored one. */
export function recoveryCodeMatches(candidateHash: string, storedHash: string): boolean {
  return safeEqual(candidateHash, storedHash);
}
