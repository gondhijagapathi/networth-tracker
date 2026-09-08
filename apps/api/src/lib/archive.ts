/**
 * A minimal tar writer and reader.
 *
 * A backup bundle has to hold three kinds of thing — a manifest, a database snapshot and an
 * arbitrary number of upload blobs — so it needs *some* container. Tar is chosen over a zip
 * for one reason that matters more than either format's merits: an operator who has the
 * passphrase can recover their data with tools that were on the machine before this
 * application was, and will still be there after it is gone.
 *
 *     openssl enc -d -aes-256-gcm ... < backup.ntb | tar tzf -
 *
 * That is the whole argument. `docs/BACKUP.md` says "an untested backup is not a backup";
 * a format that can only be read by the program that wrote it is a close relation.
 *
 * What this implements is the ustar subset that plain files need: no symlinks, no
 * directories, no sparse files, no path longer than 100 bytes. Every name this application
 * writes is either a literal (`manifest.json`, `snapshot.db`) or `uploads/<uuid>/<uuid>.bin`
 * at 81 characters, so the limit is checked and refused rather than worked around with the
 * ustar prefix field — an unused code path in a restore is a code path nobody has tested.
 */

const BLOCK_SIZE = 512;
const NAME_LIMIT = 100;

export interface ArchiveEntry {
  name: string;
  content: Buffer;
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

/** Pack entries into a tar stream, in the order given. */
export function packTar(entries: readonly ArchiveEntry[], mtimeSeconds: number): Buffer {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    if (Buffer.byteLength(entry.name, 'utf8') > NAME_LIMIT) {
      throw new Error(`Archive entry name is too long for tar: ${entry.name}`);
    }
    blocks.push(header(entry, mtimeSeconds), entry.content, padding(entry.content.length));
  }

  // Two zero blocks mark the end of the archive; anything after them is ignored by tar.
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(blocks);
}

function header(entry: ArchiveEntry, mtimeSeconds: number): Buffer {
  const block = Buffer.alloc(BLOCK_SIZE);

  block.write(entry.name, 0, NAME_LIMIT, 'utf8');
  writeOctal(block, 0o600, 100, 8); // mode: readable by the account that runs the server
  writeOctal(block, 0, 108, 8); // uid
  writeOctal(block, 0, 116, 8); // gid
  writeOctal(block, entry.content.length, 124, 12);
  writeOctal(block, mtimeSeconds, 136, 12);
  block.write('0', 156, 1, 'ascii'); // typeflag: a regular file
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');

  // The checksum is computed with its own field read as eight spaces, then written into it.
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  // Six octal digits, a NUL, then a space — the one field tar does not pad like the others.
  writeOctal(block, sum, 148, 7);
  block.write(' ', 155, 1, 'ascii');

  return block;
}

/**
 * Tar fields are NUL-terminated octal, right-aligned and zero-padded — `0000600\0` for a
 * mode of 0600. `width` counts the terminator.
 */
function writeOctal(block: Buffer, value: number, offset: number, width: number): void {
  const text = value.toString(8).padStart(width - 1, '0');
  block.write(`${text}\0`, offset, width, 'ascii');
}

function padding(length: number): Buffer {
  const remainder = length % BLOCK_SIZE;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK_SIZE - remainder);
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Unpack a tar stream into entries, keyed by name.
 *
 * Non-regular entries — directories, anything a different writer might have added — are
 * skipped rather than refused: this reads bundles it wrote, and being liberal about what it
 * ignores costs nothing while being strict about what it *accepts* is what the manifest's
 * checksums are for.
 */
export function unpackTar(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;

  while (offset + BLOCK_SIZE <= archive.length) {
    const block = archive.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;

    // A zero block is the terminator. Stopping at the first one is correct even though the
    // format writes two, because there is nothing meaningful after it either way.
    if (block.every((byte) => byte === 0)) break;

    const name = readString(block, 0, NAME_LIMIT);
    const size = readOctal(block, 124, 12);
    const typeflag = String.fromCharCode(block[156] ?? 0);

    if (!Number.isSafeInteger(size) || size < 0 || offset + size > archive.length) {
      throw new Error(`Archive entry "${name}" has an invalid length`);
    }

    if (typeflag === '0' || typeflag === '\0') {
      entries.set(name, Buffer.from(archive.subarray(offset, offset + size)));
    }

    offset += size + padding(size).length;
  }

  return entries;
}

function readString(block: Buffer, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const text = readString(block, offset, length).trim();
  if (text === '') return 0;
  const value = Number.parseInt(text, 8);
  return Number.isNaN(value) ? -1 : value;
}
