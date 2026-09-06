/**
 * Time handling.
 *
 * Every instant this application stores is an ISO-8601 UTC string with milliseconds, so
 * that `ORDER BY` on a TEXT column is chronological and a row read back in a different
 * timezone means the same thing it did when it was written.
 */

/** The current instant, in the format every timestamp column uses. */
export function isoNow(at: Date = new Date()): string {
  return at.toISOString();
}

/** `isoNow()` shifted forward by a number of seconds. Used for every expiry we set. */
export function isoIn(seconds: number, from: Date = new Date()): string {
  return new Date(from.getTime() + seconds * 1000).toISOString();
}

/** True when an ISO instant is in the past. A missing value is never expired. */
export function isExpired(isoInstant: string | null | undefined, now: Date = new Date()): boolean {
  if (!isoInstant) return false;
  return Date.parse(isoInstant) <= now.getTime();
}

const DURATION = /^(\d+)\s*(ms|s|m|h|d|w)$/i;

const MULTIPLIER: Record<string, number> = {
  ms: 1 / 1000,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

/**
 * Parse a human duration such as `15m` or `30d` into seconds.
 *
 * Token lifetimes come from the environment as strings; a typo like `15mm` must fail at
 * boot rather than silently becoming a session that never expires.
 */
export function parseDuration(value: string): number {
  const match = DURATION.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid duration "${value}". Use a form like 15m, 24h or 30d.`);
  }
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const seconds = amount * MULTIPLIER[unit]!;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Duration "${value}" must be greater than zero.`);
  }
  return seconds;
}
