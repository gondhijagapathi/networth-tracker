import { describe, expect, it } from 'vitest';
import { isUuidv7, uuidv7, uuidv7Timestamp } from '../id.js';

describe('uuidv7', () => {
  it('produces a well-formed version 7 uuid', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(isUuidv7(id)).toBe(true);
  });

  it('encodes the generation time in the leading 48 bits', () => {
    // Read from the clock rather than pinned to a fixed date. The generator never goes
    // backwards, so a timestamp already behind one this module has issued is clamped
    // forward — and a hardcoded date becomes a test that passes until the day the wall
    // clock overtakes it.
    const now = Date.now() + 1_000;
    const id = uuidv7(now);
    expect(uuidv7Timestamp(id)).toBe(now);
  });

  it('sorts lexicographically in creation order across milliseconds', () => {
    const early = uuidv7(1_700_000_000_000);
    const late = uuidv7(1_700_000_001_000);
    expect(early < late).toBe(true);
  });

  it('stays monotonic within a single millisecond', () => {
    const now = 1_700_000_002_000;
    const ids = Array.from({ length: 500 }, () => uuidv7(now));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never repeats an id across a large burst', () => {
    const ids = new Set(Array.from({ length: 20_000 }, () => uuidv7()));
    expect(ids.size).toBe(20_000);
  });

  it('rejects non-v7 uuids', () => {
    expect(isUuidv7('not-a-uuid')).toBe(false);
    // A v4 uuid: version nibble is 4, not 7.
    expect(isUuidv7('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(false);
    expect(uuidv7Timestamp('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBeNull();
  });
});
