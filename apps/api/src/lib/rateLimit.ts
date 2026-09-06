/**
 * Failure-driven rate limiting with exponential backoff.
 *
 * This does not cap request volume — it makes *guessing* expensive. Successful requests
 * cost nothing; each failure against the same key pushes the next allowed attempt further
 * out, so an online password or TOTP guessing run dies after a handful of tries while a
 * user who fat-fingers their password once notices nothing.
 *
 * State is in-process and deliberately so: this is a single-process self-hosted app, and a
 * Redis dependency to survive restarts would buy little. An attacker cannot restart the
 * server, and an operator who does has bigger levers than clearing a lockout table.
 */

import { rateLimited } from './errors.js';

export interface RateLimitPolicy {
  /** Failures tolerated before any delay is imposed. */
  freeAttempts: number;
  /** Delay after the first failure past `freeAttempts`; doubles with each further one. */
  baseDelaySeconds: number;
  /** Ceiling on that doubling, so a key is never locked out permanently. */
  maxDelaySeconds: number;
  /** A key with no failures for this long is forgotten entirely. */
  windowSeconds: number;
  /** Shown to the user when the limit bites. */
  message: string;
}

/** Login: five tries, then the fifth failure starts 2s, 4s, 8s … capped at 15 minutes. */
export const LOGIN_POLICY: RateLimitPolicy = {
  freeAttempts: 5,
  baseDelaySeconds: 2,
  maxDelaySeconds: 900,
  windowSeconds: 3600,
  message: 'Too many failed sign-in attempts. Wait a moment and try again.',
};

/**
 * Registration: an invite code is the one guessable secret that creates an account, so
 * this is tighter than login and gives no free tries beyond a genuine typo.
 */
export const INVITE_POLICY: RateLimitPolicy = {
  freeAttempts: 3,
  baseDelaySeconds: 5,
  maxDelaySeconds: 3600,
  windowSeconds: 86400,
  message: 'Too many invalid invite codes from this address.',
};

interface Entry {
  failures: number;
  /** Epoch ms before which no attempt is allowed. */
  blockedUntil: number;
  /** Epoch ms of the most recent failure, for window expiry. */
  lastFailureAt: number;
}

export class RateLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly policy: RateLimitPolicy,
    /** Injectable clock so tests can advance time instead of sleeping. */
    private readonly now: () => number = Date.now,
  ) {}

  /** Throw a 429 if `key` is currently backing off. Call before doing any real work. */
  assertAllowed(key: string): void {
    const entry = this.current(key);
    if (!entry) return;

    const now = this.now();
    if (entry.blockedUntil > now) {
      const retryAfterSeconds = Math.ceil((entry.blockedUntil - now) / 1000);
      throw rateLimited(this.policy.message, retryAfterSeconds);
    }
  }

  /** Record a failed attempt and extend the backoff. */
  recordFailure(key: string): void {
    const now = this.now();
    const entry = this.current(key) ?? { failures: 0, blockedUntil: 0, lastFailureAt: now };

    entry.failures += 1;
    entry.lastFailureAt = now;

    // `freeAttempts` counts attempts that are allowed to fail without penalty, so the
    // block starts on the failure that reaches the limit, not the one after it.
    const over = entry.failures - this.policy.freeAttempts + 1;
    if (over > 0) {
      const delay = Math.min(
        this.policy.baseDelaySeconds * 2 ** (over - 1),
        this.policy.maxDelaySeconds,
      );
      entry.blockedUntil = now + delay * 1000;
    }

    this.entries.set(key, entry);
    this.prune();
  }

  /** Clear the record for `key`. Called on success, so a legitimate sign-in resets it. */
  reset(key: string): void {
    this.entries.delete(key);
  }

  /** Failures currently counted against `key`. Exposed for tests and diagnostics. */
  failureCount(key: string): number {
    return this.current(key)?.failures ?? 0;
  }

  /** Fetch an entry, dropping it if its window has elapsed. */
  private current(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    if (this.now() - entry.lastFailureAt > this.policy.windowSeconds * 1000) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /**
   * Drop expired entries so a long-running process cannot be pushed into unbounded memory
   * by an attacker cycling through keys.
   */
  private prune(): void {
    if (this.entries.size < 1000) return;
    const cutoff = this.now() - this.policy.windowSeconds * 1000;
    for (const [key, entry] of this.entries) {
      if (entry.lastFailureAt < cutoff) this.entries.delete(key);
    }
  }
}
