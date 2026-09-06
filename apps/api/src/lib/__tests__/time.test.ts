import { describe, expect, it } from 'vitest';
import { isExpired, isoIn, isoNow, parseDuration } from '../time.js';

describe('parseDuration', () => {
  it('parses every supported unit', () => {
    expect(parseDuration('500ms')).toBe(0.5);
    expect(parseDuration('45s')).toBe(45);
    expect(parseDuration('15m')).toBe(900);
    expect(parseDuration('24h')).toBe(86400);
    expect(parseDuration('30d')).toBe(2592000);
    expect(parseDuration('2w')).toBe(1209600);
  });

  it('tolerates whitespace and case', () => {
    expect(parseDuration('  15M ')).toBe(900);
  });

  it('rejects malformed values rather than guessing', () => {
    // The failure mode this guards against: a typo silently becoming an unbounded session.
    for (const bad of ['15mm', '15', 'm', '', 'fifteen minutes', '-5m', '1.5h']) {
      expect(() => parseDuration(bad)).toThrow(/Invalid duration|greater than zero/);
    }
  });

  it('rejects a zero duration', () => {
    expect(() => parseDuration('0m')).toThrow(/greater than zero/);
  });
});

describe('instants', () => {
  it('formats as ISO-8601 UTC with milliseconds', () => {
    expect(isoNow(new Date(Date.UTC(2026, 8, 6, 7, 30, 0)))).toBe('2026-09-06T07:30:00.000Z');
  });

  it('sorts lexicographically in chronological order', () => {
    const from = new Date(Date.UTC(2026, 8, 6));
    expect(isoNow(from) < isoIn(1, from)).toBe(true);
    expect(isoIn(60, from) < isoIn(3600, from)).toBe(true);
  });

  it('treats an instant at or before now as expired', () => {
    const now = new Date(Date.UTC(2026, 8, 6));
    expect(isExpired(isoIn(-1, now), now)).toBe(true);
    expect(isExpired(isoNow(now), now)).toBe(true);
    expect(isExpired(isoIn(1, now), now)).toBe(false);
  });

  it('treats a missing instant as never expiring', () => {
    expect(isExpired(null)).toBe(false);
    expect(isExpired(undefined)).toBe(false);
  });
});
