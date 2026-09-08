/**
 * The `.ntb` bundle: a tar archive, gzipped, then encrypted under a passphrase.
 *
 * ```
 *   NTB1                     4 bytes, magic
 *   header length            4 bytes, big-endian
 *   header                   JSON: format, kdf parameters, salt, iv
 *   tag                      16 bytes, AES-GCM authentication tag
 *   ciphertext               AES-256-GCM(gzip(tar(manifest, snapshot, uploads)))
 * ```
 *
 * Three decisions worth writing down:
 *
 *   - **The header is plaintext, and authenticated.** A reader has to know the KDF
 *     parameters before it can derive a key, so they cannot be inside the ciphertext; they
 *     are passed to GCM as additional authenticated data instead, which means an attacker
 *     who edits the salt to something cheaper produces a bundle that fails to authenticate
 *     rather than one that decrypts wrongly.
 *   - **Argon2id, at the same parameters as a password.** A bundle is the one artefact of
 *     this application that is expected to sit on somebody else's disk — a synced folder, a
 *     USB stick, a backup host — with no rate limiting in front of it. That is precisely the
 *     threat a memory-hard KDF exists for, and `SECRET_ENCRYPTION_KEY`'s HKDF (see
 *     `secretbox.ts`) would be the wrong tool: it protects a server-held key, not a
 *     human-chosen phrase.
 *   - **The tag sits before the ciphertext.** Node's `decipher.final()` needs it up front,
 *     and putting it there means a bundle can be verified without seeking to the end of what
 *     might be a large file.
 *
 * The gzip layer is not compression for its own sake: a SQLite snapshot is mostly text and
 * empty page space, and it typically shrinks by a factor of five, which matters when the
 * thing is being copied off the machine every night.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { hashRawSync } from '@node-rs/argon2';
import { packTar, unpackTar, type ArchiveEntry } from './archive.js';
import { ARGON2_OPTIONS } from './passwords.js';

const MAGIC = Buffer.from('NTB1', 'ascii');
const HEADER_LENGTH_BYTES = 4;
const TAG_BYTES = 16;
const IV_BYTES = 12;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Argon2id at 64 MiB, three passes, four lanes — literally the same parameters the login
 * password and the browser vault use, imported rather than restated so a future increase
 * lands in one place. They are recorded in each bundle's header rather than assumed at read
 * time, so a bundle written today still opens after those parameters are raised.
 */
const KDF = ARGON2_OPTIONS;

interface BundleHeader {
  format: number;
  kdf: { name: 'argon2id'; memoryCost: number; timeCost: number; parallelism: number };
  salt: string;
  iv: string;
}

/** A bundle refused before any cryptography is attempted, or after the tag failed. */
export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

function deriveKey(passphrase: string, salt: Buffer, header: BundleHeader): Buffer {
  return hashRawSync(passphrase, {
    algorithm: KDF.algorithm,
    memoryCost: header.kdf.memoryCost,
    timeCost: header.kdf.timeCost,
    parallelism: header.kdf.parallelism,
    outputLen: KEY_BYTES,
    salt,
  });
}

/** Seal entries into a bundle. */
export function sealBundle(
  entries: readonly ArchiveEntry[],
  passphrase: string,
  mtimeSeconds: number,
): Buffer {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);

  const header: BundleHeader = {
    format: 1,
    kdf: {
      name: 'argon2id',
      memoryCost: KDF.memoryCost,
      timeCost: KDF.timeCost,
      parallelism: KDF.parallelism,
    },
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');

  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt, header), iv);
  cipher.setAAD(headerBytes);

  const payload = gzipSync(packTar(entries, mtimeSeconds), { level: 6 });
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);

  const lengthPrefix = Buffer.alloc(HEADER_LENGTH_BYTES);
  lengthPrefix.writeUInt32BE(headerBytes.length);

  return Buffer.concat([MAGIC, lengthPrefix, headerBytes, cipher.getAuthTag(), ciphertext]);
}

/**
 * Open a bundle.
 *
 * Every failure is the same failure as far as the caller is concerned — this is not a
 * bundle, or that is not its passphrase — but the messages differ because they are read by
 * the person who owns both, and "this file is not a backup" and "that passphrase is wrong"
 * lead to completely different next actions.
 */
export function openBundle(bundle: Buffer, passphrase: string): Map<string, Buffer> {
  if (bundle.length < MAGIC.length + HEADER_LENGTH_BYTES) {
    throw new BundleError('That file is too small to be a backup bundle');
  }
  if (!timingSafeEqual(bundle.subarray(0, MAGIC.length), MAGIC)) {
    throw new BundleError('That file is not a backup bundle');
  }

  const headerLength = bundle.readUInt32BE(MAGIC.length);
  const headerStart = MAGIC.length + HEADER_LENGTH_BYTES;
  const tagStart = headerStart + headerLength;
  const bodyStart = tagStart + TAG_BYTES;

  if (headerLength > 4_096 || bundle.length < bodyStart) {
    throw new BundleError('That backup bundle is truncated or corrupt');
  }

  const headerBytes = bundle.subarray(headerStart, tagStart);
  const header = parseHeader(headerBytes);

  const salt = Buffer.from(header.salt, 'base64');
  const iv = Buffer.from(header.iv, 'base64');
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES) {
    throw new BundleError('That backup bundle has a malformed header');
  }

  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt, header), iv);
  decipher.setAAD(headerBytes);
  decipher.setAuthTag(bundle.subarray(tagStart, bodyStart));

  let payload: Buffer;
  try {
    payload = Buffer.concat([decipher.update(bundle.subarray(bodyStart)), decipher.final()]);
  } catch {
    // GCM does not distinguish a wrong key from an edited file, and neither can we. The
    // passphrase is overwhelmingly the likelier of the two, so that is what it says.
    throw new BundleError('Wrong passphrase, or this bundle has been altered');
  }

  try {
    return unpackTar(gunzipSync(payload));
  } catch (error) {
    throw new BundleError(
      `That backup decrypted but could not be read: ${(error as Error).message}`,
    );
  }
}

function parseHeader(headerBytes: Buffer): BundleHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(headerBytes.toString('utf8'));
  } catch {
    throw new BundleError('That backup bundle has an unreadable header');
  }

  const header = parsed as Partial<BundleHeader>;
  if (
    typeof header?.format !== 'number' ||
    typeof header.salt !== 'string' ||
    typeof header.iv !== 'string' ||
    header.kdf?.name !== 'argon2id'
  ) {
    throw new BundleError('That backup bundle has a malformed header');
  }
  if (header.format !== 1) {
    // Written by a newer version of this application. Guessing at a format we do not know
    // is exactly the failure mode the version field exists to prevent.
    throw new BundleError(
      `This backup was written in format ${header.format}, which this version cannot read. Upgrade and try again.`,
    );
  }
  return header as BundleHeader;
}
