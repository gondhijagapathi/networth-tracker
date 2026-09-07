/**
 * Password hashing.
 *
 * Argon2id with the parameters named in docs/SECURITY-MODEL.md: 64 MiB of memory, three
 * passes, four lanes. Memory-hardness is the point — it is what makes a leaked database
 * expensive to attack on GPUs, where a SHA-family hash would fall in hours.
 *
 * The cost is roughly 100 ms per verification on ordinary hardware. That is intentional,
 * and it is why login is rate limited rather than left to absorb the load.
 */

import { hash, verify, type Algorithm } from '@node-rs/argon2';

/** Shared by the login password here and, in the browser, by the vault's key derivation. */
export const ARGON2_OPTIONS = {
  // `Algorithm` is an ambient const enum, which `verbatimModuleSyntax` cannot read at
  // runtime; 2 is `Algorithm.Argon2id` (0 is Argon2d, 1 is Argon2i).
  algorithm: 2 as Algorithm,
  /** 64 MiB, expressed in KiB as the library expects. */
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
} as const;

/** Hash a password. The result is a PHC string carrying its own salt and parameters. */
export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/**
 * Check a password against a stored hash.
 *
 * A malformed or truncated hash — a corrupted row, a bad restore — is a failed match, not
 * an exception that would surface as a 500 and tell the caller something is wrong with
 * *that particular account*.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    return await verify(storedHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * Burn roughly the same time a real verification would.
 *
 * Called when the email does not exist, so that "no such user" and "wrong password" take
 * the same wall-clock time. Without it, response latency is an account-enumeration oracle
 * that no amount of identical error messaging can close.
 */
export async function fakeVerifyDelay(): Promise<void> {
  await hash('argon2id-timing-equaliser', ARGON2_OPTIONS);
}
