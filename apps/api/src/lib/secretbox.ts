/**
 * Server-side encryption for secrets that must be readable by the server but must not be
 * usable from a stolen database file — today the TOTP shared secret, later the SMTP
 * password and provider API keys.
 *
 * This is *not* the zero-knowledge vault. Vault items are encrypted in the browser and the
 * server holds no key that can open them (docs/SECURITY-MODEL.md). What follows protects
 * against a leaked `networth.db`, not against a compromised host: the key sits in the
 * environment of the process that reads the file.
 *
 *   key = HKDF-SHA256(SECRET_ENCRYPTION_KEY, salt = "networth/secretbox/v1", info = purpose)
 *   out = v1.<base64url iv>.<base64url ciphertext+tag>
 *
 * Deriving per-purpose keys means a TOTP secret and an SMTP password never share key
 * material, so one misuse cannot decrypt the other.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const HKDF_SALT = 'networth/secretbox/v1';

/**
 * `totp`  the shared secret behind a second factor.
 * `email` a rendered outbound message, which while queued holds whatever the message says —
 *         a live reset link, an unredeemed invite code.
 */
export type SecretPurpose = 'totp' | 'email';

function deriveKey(masterKey: string, purpose: SecretPurpose): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, HKDF_SALT, purpose, KEY_BYTES));
}

/** Encrypt a UTF-8 secret. The result is safe to store in a TEXT column. */
export function sealSecret(plaintext: string, masterKey: string, purpose: SecretPurpose): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(masterKey, purpose), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const payload = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return `${VERSION}.${iv.toString('base64url')}.${payload.toString('base64url')}`;
}

/**
 * Decrypt a value produced by {@link sealSecret}.
 *
 * Throws on a bad key, a tampered ciphertext or an unknown version. Callers treat a throw
 * as "this secret is unusable" rather than trying to recover — GCM's authentication tag
 * failing means the bytes are not what we wrote.
 */
export function openSecret(sealed: string, masterKey: string, purpose: SecretPurpose): string {
  const parts = sealed.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new Error('Sealed secret is not in a recognised format');
  }

  const iv = Buffer.from(parts[1]!, 'base64url');
  const payload = Buffer.from(parts[2]!, 'base64url');
  if (iv.length !== IV_BYTES || payload.length <= 16) {
    throw new Error('Sealed secret is malformed');
  }

  const ciphertext = payload.subarray(0, payload.length - 16);
  const tag = payload.subarray(payload.length - 16);

  const decipher = createDecipheriv('aes-256-gcm', deriveKey(masterKey, purpose), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
