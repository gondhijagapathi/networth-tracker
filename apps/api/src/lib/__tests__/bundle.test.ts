/**
 * The bundle container, tested apart from the backup service that fills it.
 *
 * Two things are worth this file's existence. The tar writer is hand-rolled, and a format
 * whose whole justification is "an operator can open it with `tar` when this application is
 * gone" earns a test that says so rather than a comment claiming it. And the failure modes —
 * a wrong passphrase, an edited byte, a header from a future version — are the ones that
 * matter on the worst day, which is exactly when nobody is in a position to debug them.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packTar, unpackTar } from '../archive.js';
import { BundleError, openBundle, sealBundle } from '../bundle.js';

const PASSPHRASE = 'a-long-enough-backup-passphrase';
const MTIME = 1_757_280_000;

const ENTRIES = [
  { name: 'manifest.json', content: Buffer.from('{"app":"networth-tracker"}', 'utf8') },
  // Deliberately not a multiple of 512, so the block padding is exercised.
  { name: 'snapshot.db', content: Buffer.from('SQLite format 3\0'.repeat(94), 'utf8') },
  {
    name: 'uploads/019621b7-0000-7000-8000-000000000001/doc.bin',
    content: Buffer.from([0, 1, 255]),
  },
];

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'networth-bundle-test-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('tar', () => {
  it('round-trips names and bytes exactly', () => {
    const unpacked = unpackTar(packTar(ENTRIES, MTIME));

    expect([...unpacked.keys()]).toEqual(ENTRIES.map((entry) => entry.name));
    for (const entry of ENTRIES) {
      expect(unpacked.get(entry.name)).toEqual(entry.content);
    }
  });

  it('produces an archive the system tar can read', () => {
    const path = join(workspace, 'bundle.tar');
    writeFileSync(path, packTar(ENTRIES, MTIME));

    // The escape hatch, asserted rather than promised: if this ever stops holding, the
    // format has quietly become one only this application can open.
    const listing = execFileSync('tar', ['tf', path], { encoding: 'utf8' });
    expect(listing.trim().split('\n')).toEqual(ENTRIES.map((entry) => entry.name));
  });

  it('refuses a name too long for a ustar header rather than truncating it', () => {
    expect(() => packTar([{ name: 'x'.repeat(101), content: Buffer.alloc(0) }], MTIME)).toThrow(
      /too long/i,
    );
  });

  it('reads an empty archive as no entries', () => {
    expect(unpackTar(packTar([], MTIME)).size).toBe(0);
  });
});

describe('sealed bundles', () => {
  it('opens with the right passphrase', () => {
    const opened = openBundle(sealBundle(ENTRIES, PASSPHRASE, MTIME), PASSPHRASE);
    expect(opened.get('manifest.json')?.toString('utf8')).toBe('{"app":"networth-tracker"}');
  });

  it('is smaller than what went into it', () => {
    const raw = ENTRIES.reduce((total, entry) => total + entry.content.length, 0);
    // Not a compression benchmark — the point is that a nightly copy of a mostly-empty
    // SQLite file does not cost its full page count on disk every night.
    expect(sealBundle(ENTRIES, PASSPHRASE, MTIME).length).toBeLessThan(raw);
  });

  it('produces a different ciphertext every time, for the same input', () => {
    const first = sealBundle(ENTRIES, PASSPHRASE, MTIME);
    const second = sealBundle(ENTRIES, PASSPHRASE, MTIME);
    // A fresh salt and IV per bundle: two nightly backups of an unchanged database must not
    // be byte-identical, or the pair leaks that nothing changed.
    expect(first.equals(second)).toBe(false);
  });

  it('refuses the wrong passphrase', () => {
    const sealed = sealBundle(ENTRIES, PASSPHRASE, MTIME);
    expect(() => openBundle(sealed, `${PASSPHRASE}!`)).toThrow(BundleError);
  });

  it('refuses a file that is not a bundle', () => {
    expect(() => openBundle(Buffer.from('PK a zip, actually'), PASSPHRASE)).toThrow(
      /not a backup bundle/i,
    );
  });

  it('notices a single flipped bit in the ciphertext', () => {
    const sealed = sealBundle(ENTRIES, PASSPHRASE, MTIME);
    sealed[sealed.length - 1] ^= 0x01;
    expect(() => openBundle(sealed, PASSPHRASE)).toThrow(/altered/i);
  });

  it('notices an edited header, which is authenticated but not encrypted', () => {
    const sealed = sealBundle(ENTRIES, PASSPHRASE, MTIME);
    const headerStart = 8;
    // The header carries the KDF cost parameters in the clear. Weakening them has to fail,
    // or an attacker could downgrade the work factor and then brute-force at leisure.
    const text = sealed.toString('utf8');
    const index = text.indexOf('65536');
    expect(index).toBeGreaterThan(headerStart);
    sealed.write('00512', index, 5, 'utf8');

    expect(() => openBundle(sealed, PASSPHRASE)).toThrow(BundleError);
  });

  it('refuses a bundle from a format it does not know', () => {
    const sealed = sealBundle(ENTRIES, PASSPHRASE, MTIME);
    const index = sealed.toString('utf8').indexOf('"format":1');
    sealed.write('"format":9', index, 10, 'utf8');

    expect(() => openBundle(sealed, PASSPHRASE)).toThrow(/cannot read/i);
  });
});
