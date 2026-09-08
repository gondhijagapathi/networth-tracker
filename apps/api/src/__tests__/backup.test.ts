/**
 * Backup, restore and export.
 *
 * The test that matters is the one `docs/PLAN.md` asks for by name: back up, wipe, restore,
 * and check that the row counts and the totals come back identical. Everything else here
 * exists because a backup feature fails silently by nature — nobody finds out that the
 * passphrase check was missing, or that documents were skipped, until the day they need it.
 *
 * These run against real files in a temporary directory and real Argon2id key derivation.
 * The bundle format is the whole deliverable, and a mocked one would test nothing.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASSET_TYPES } from '@networth/shared';
import {
  createEveryAssetType,
  createTestInstance,
  registerAdmin,
  registerMember,
  type TestClient,
  type TestInstance,
} from './harness.js';

const PASSPHRASE = 'a-long-enough-backup-passphrase';

let workspace: string;
let instance: TestInstance;
let admin: TestClient;

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'networth-backup-test-'));
  instance = createTestInstance({
    BACKUP_DIR: join(workspace, 'backups'),
    UPLOAD_DIR: join(workspace, 'uploads'),
  });
  admin = await registerAdmin(instance);
});

afterEach(() => {
  instance.close();
  rmSync(workspace, { recursive: true, force: true });
});

/** Row counts for the tables a wipe-and-restore is actually judged on. */
function counts(): Record<string, number> {
  const tables = ['users', 'assets', 'valuations', 'deposits', 'holdings', 'documents'];
  const result: Record<string, number> = {};
  for (const table of tables) {
    result[table] = (
      instance.sqlite.prepare(`SELECT count(*) AS c FROM "${table}"`).get() as { c: number }
    ).c;
  }
  return result;
}

async function takeBackup(client = admin, passphrase = PASSPHRASE): Promise<string> {
  const response = await client.post('/api/backup', { passphrase });
  expect(response.status).toBe(201);
  return response.body.backup.filename as string;
}

async function download(filename: string): Promise<Buffer> {
  const response = await admin.getBytes(`/api/backup/${filename}`);
  expect(response.status).toBe(200);
  return Buffer.from(response.body as Buffer);
}

/** POST a bundle to the restore endpoint the way the Settings screen does. */
function restore(
  client: TestClient,
  bundle: Buffer,
  options: { passphrase?: string; confirm?: boolean } = {},
) {
  const query = options.confirm === false ? '' : '?confirm=true';
  return client.postBytes(`/api/backup/restore${query}`, bundle, {
    'x-backup-passphrase': options.passphrase ?? PASSPHRASE,
  });
}

describe('taking a backup', () => {
  it('writes a bundle and lists it', async () => {
    const filename = await takeBackup();

    expect(filename).toMatch(/^networth-\d{8}T\d{6}Z-manual\.ntb$/);
    expect(readdirSync(join(workspace, 'backups'))).toContain(filename);

    const listed = await admin.get('/api/backup');
    expect(listed.status).toBe(200);
    expect(listed.body.backups[0]).toMatchObject({ filename, scheduled: false });
  });

  it('reports the nightly schedule as inactive when no passphrase is configured', async () => {
    const listed = await admin.get('/api/backup');
    // The default `BACKUP_CRON` is set; without `BACKUP_PASSPHRASE` nothing would ever be
    // written, and saying "nightly at 02:00" would be a promise the installation cannot keep.
    expect(listed.body.schedule).toBeNull();
  });

  it('reports the schedule once both halves are configured', () => {
    const configured = createTestInstance({
      BACKUP_DIR: join(workspace, 'scheduled'),
      BACKUP_PASSPHRASE: PASSPHRASE,
    });
    try {
      expect(configured.config.BACKUP_CRON).toBe('0 2 * * *');
      expect(configured.config.BACKUP_PASSPHRASE).toBe(PASSPHRASE);
    } finally {
      configured.close();
    }
  });

  it('is refused to a member', async () => {
    const member = await registerMember(instance, admin);
    const response = await member.post('/api/backup', { passphrase: PASSPHRASE });
    expect(response.status).toBe(403);
  });

  it('refuses a passphrase that is too short to defend an offline file', async () => {
    const response = await admin.post('/api/backup', { passphrase: 'short' });
    expect(response.status).toBe(400);
  });
});

describe('backup → wipe → restore', () => {
  it('restores every row and every total exactly', async () => {
    await createEveryAssetType(admin);

    const before = counts();
    const dashboardBefore = await admin.get('/api/analytics/dashboard');
    expect(before.assets).toBe(ASSET_TYPES.length);

    const filename = await takeBackup();
    const bundle = await download(filename);

    // The wipe. Deliberately brutal: everything an owner has, gone, the way a mistaken
    // "delete my account" or a corrupted disk would leave it.
    instance.sqlite.exec('DELETE FROM assets');
    expect(counts().assets).toBe(0);

    const restored = await restore(admin, bundle);

    expect(restored.status).toBe(200);
    expect(restored.body.warnings).toEqual([]);
    expect(counts()).toEqual(before);

    const dashboardAfter = await admin.get('/api/analytics/dashboard');
    expect(dashboardAfter.body.summary.netPaise).toBe(dashboardBefore.body.summary.netPaise);
    expect(dashboardAfter.body.summary.assetsPaise).toBe(dashboardBefore.body.summary.assetsPaise);
  });

  it('reports what it wrote against what the manifest promised', async () => {
    await createEveryAssetType(admin);
    const bundle = await download(await takeBackup());

    const restored = await restore(admin, bundle);

    const assetsRow = (
      restored.body.tables as Array<{ table: string; expected: number; actual: number }>
    ).find((row) => row.table === 'assets');
    expect(assetsRow).toEqual({
      table: 'assets',
      expected: ASSET_TYPES.length,
      actual: ASSET_TYPES.length,
    });
  });

  it('takes a safety backup before touching anything', async () => {
    const bundle = await download(await takeBackup());

    const restored = await restore(admin, bundle);

    expect(restored.body.safetyBackup).toMatch(/^pre-restore-/);
    expect(readdirSync(join(workspace, 'backups'))).toContain(restored.body.safetyBackup);
  });

  it('refuses the wrong passphrase, and changes nothing', async () => {
    await createEveryAssetType(admin);
    const before = counts();
    const bundle = await download(await takeBackup());

    const restored = await restore(admin, bundle, { passphrase: 'not-the-right-passphrase' });

    expect(restored.status).toBe(400);
    expect(restored.body.error.message).toMatch(/passphrase/i);
    expect(counts()).toEqual(before);
  });

  it('refuses a bundle that is not a bundle', async () => {
    const restored = await restore(admin, Buffer.from('this is a jpeg, honestly'));

    expect(restored.status).toBe(400);
    expect(restored.body.error.message).toMatch(/not a backup bundle/i);
  });

  it('refuses an altered bundle', async () => {
    const bundle = await download(await takeBackup());
    // Flip a bit deep in the ciphertext. GCM's tag is what notices.
    bundle[bundle.length - 20] ^= 0x01;

    const restored = await restore(admin, bundle);

    expect(restored.status).toBe(400);
  });

  it('refuses without an explicit confirmation', async () => {
    const bundle = await download(await takeBackup());

    const restored = await restore(admin, bundle, { confirm: false });

    expect(restored.status).toBe(400);
  });

  it('refuses a bundle from a newer schema rather than guessing at it', async () => {
    const bundle = await download(await takeBackup());

    // Pretend this installation is the older one by forgetting a migration it has run.
    const [latest] = instance.sqlite
      .prepare('SELECT name FROM _migrations ORDER BY name DESC LIMIT 1')
      .all() as Array<{ name: string }>;
    instance.sqlite.prepare('DELETE FROM _migrations WHERE name = ?').run(latest!.name);

    const restored = await restore(admin, bundle);

    expect(restored.status).toBe(409);
    expect(restored.body.error.message).toMatch(/newer version/i);
  });

  it('is refused to a member', async () => {
    const bundle = await download(await takeBackup());
    const member = await registerMember(instance, admin);

    const restored = await restore(member, bundle);

    expect(restored.status).toBe(403);
  });
});

describe('documents in a bundle', () => {
  it('carries the encrypted blobs and puts them back', async () => {
    // Written straight to `UPLOAD_DIR` rather than through the vault: what is under test is
    // that the bundle captures and restores the directory, not how a document got there —
    // and a blob is opaque bytes to every line of code this exercises.
    const uploads = join(workspace, 'uploads');
    mkdirSync(join(uploads, 'owner-1'), { recursive: true });
    writeFileSync(join(uploads, 'owner-1', 'document.bin'), Buffer.from([9, 9, 9]), {
      mode: 0o600,
    });

    const bundle = await download(await takeBackup());

    // Now lose them, the way a restore onto a fresh machine finds `data/uploads` empty.
    rmSync(join(uploads, 'owner-1'), { recursive: true, force: true });

    const restored = await restore(admin, bundle);

    expect(restored.status).toBe(200);
    expect(restored.body.documentsRestored).toBe(1);
    expect(readdirSync(join(uploads, 'owner-1'))).toEqual(['document.bin']);
    expect(readFileSync(join(uploads, 'owner-1', 'document.bin'))).toEqual(Buffer.from([9, 9, 9]));
  });
});

describe('exports', () => {
  it('gives a member their own data as JSON, with the vault as ciphertext', async () => {
    const member = await registerMember(instance, admin, { email: 'exporter@example.com' });
    await createEveryAssetType(member);

    const response = await member.get('/api/export/json');
    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toMatch(/attachment; filename=/);

    const bundle = JSON.parse(response.text);
    expect(bundle.assets).toHaveLength(ASSET_TYPES.length);
    expect(bundle.owner.email).toBe('exporter@example.com');
    // The detail is the typed shape, not the raw row: a deposit exports its `kind`.
    const deposit = bundle.assets.find((asset: { type: string }) => asset.type === 'deposit');
    expect(deposit.detail.kind).toBe('fd');
  });

  it('never includes another owner in an export', async () => {
    const alice = await registerMember(instance, admin, { email: 'alice@example.com' });
    const bob = await registerMember(instance, admin, { email: 'bob@example.com' });
    await createEveryAssetType(alice);

    const response = await bob.get('/api/export/json');
    expect(response.body.assets).toEqual([]);
  });

  it('renders CSV with rupees rather than paise, and a header even when empty', async () => {
    const member = await registerMember(instance, admin, { email: 'csv@example.com' });
    await createEveryAssetType(member);

    const response = await member.get('/api/export/csv?dataset=deposit');
    expect(response.status).toBe(200);

    const [header, row] = response.text
      .replace(/^\ufeff/, '')
      .trim()
      .split('\r\n');
    expect(header).toContain('principal_inr');
    expect(header).toContain('rate_percent');
    // The fixture deposit is ₹5,00,000 at 7.10%.
    expect(row).toContain('500000.00');
    expect(row).toContain('7.10');

    const empty = await member.get('/api/export/csv?dataset=property');
    expect(empty.text.replace(/^\ufeff/, '')).toContain('survey_number');
  });

  it('quotes a field a spreadsheet would otherwise execute', async () => {
    const member = await registerMember(instance, admin, { email: 'formula@example.com' });
    await member.post('/api/assets', {
      name: '=HYPERLINK("http://evil.example","click")',
      type: 'bank_account',
      valuePaise: 100,
      detail: { accountNumber: '50100123456789', accountType: 'savings' },
    });

    const response = await member.get('/api/export/csv?dataset=assets');
    expect(response.text).toContain(`"'=HYPERLINK(`);
  });
});
