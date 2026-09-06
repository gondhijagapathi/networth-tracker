/**
 * UUIDv7 identifiers.
 *
 * Every primary key in this application is a UUIDv7: the first 48 bits are a Unix
 * millisecond timestamp, so ids sort by creation time. That gives us the locality of an
 * autoincrement integer (SQLite b-tree inserts stay near the right edge, indexes stay
 * dense) without leaking a row count or letting one user guess another's ids.
 *
 * Layout (RFC 9562 §5.7):
 *
 *   0                   1                   2                   3
 *   |unix_ts_ms (48 bits)                   |ver| rand_a  |var| rand_b (62 bits) |
 *
 * `rand_a` is used as a monotonic counter rather than random data, so two ids minted in
 * the same millisecond still sort in creation order.
 */

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Milliseconds of the last id we produced, to detect same-millisecond bursts. */
let lastTimestamp = -1;
/** 12-bit counter within `lastTimestamp`. */
let counter = 0;

/**
 * Generate a UUIDv7 string.
 *
 * @param now - Injectable clock, for tests that need deterministic timestamps.
 */
export function uuidv7(now: number = Date.now()): string {
  const timestamp = Math.max(now, lastTimestamp);

  if (timestamp === lastTimestamp) {
    counter += 1;
    // 12 bits exhausted in a single millisecond: borrow the next one rather than
    // emitting a duplicate. 4096 ids/ms is far beyond anything this app does.
    if (counter > 0xfff) {
      counter = 0;
      lastTimestamp = timestamp + 1;
      return uuidv7(lastTimestamp);
    }
  } else {
    lastTimestamp = timestamp;
    counter = randomBits12();
  }

  const bytes = new Uint8Array(16);

  // 48-bit big-endian timestamp.
  bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;

  // Version 7 in the high nibble of byte 6, then the 12-bit counter.
  bytes[6] = 0x70 | ((counter >>> 8) & 0x0f);
  bytes[7] = counter & 0xff;

  // 62 bits of randomness with the RFC 4122 variant bits (10) on top.
  const random = new Uint8Array(8);
  crypto.getRandomValues(random);
  bytes[8] = 0x80 | (random[0]! & 0x3f);
  for (let i = 1; i < 8; i += 1) {
    bytes[8 + i] = random[i]!;
  }

  return (
    HEX[bytes[0]!]! +
    HEX[bytes[1]!]! +
    HEX[bytes[2]!]! +
    HEX[bytes[3]!]! +
    '-' +
    HEX[bytes[4]!]! +
    HEX[bytes[5]!]! +
    '-' +
    HEX[bytes[6]!]! +
    HEX[bytes[7]!]! +
    '-' +
    HEX[bytes[8]!]! +
    HEX[bytes[9]!]! +
    '-' +
    HEX[bytes[10]!]! +
    HEX[bytes[11]!]! +
    HEX[bytes[12]!]! +
    HEX[bytes[13]!]! +
    HEX[bytes[14]!]! +
    HEX[bytes[15]!]!
  );
}

/** The millisecond timestamp encoded in a UUIDv7, or `null` if this is not one. */
export function uuidv7Timestamp(id: string): number | null {
  if (!isUuidv7(id)) return null;
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidv7(value: string): boolean {
  return UUID_V7.test(value);
}

function randomBits12(): number {
  const buf = new Uint8Array(2);
  crypto.getRandomValues(buf);
  // Seed the counter in the lower half of its range so a burst has room to climb.
  return ((buf[0]! << 8) | buf[1]!) & 0x7ff;
}
