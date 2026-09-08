/**
 * Backup and restore.
 *
 * Everything this application knows lives in one SQLite file and one directory of encrypted
 * blobs, which makes a complete backup genuinely achievable — and makes getting it wrong
 * genuinely expensive. Four rules shape what follows:
 *
 *   - **Never copy a live SQLite file.** With WAL enabled, `cp` can produce a database
 *     that is torn between pages. `sqlite.backup()` uses SQLite's own online backup API and
 *     yields a consistent snapshot while the server keeps serving requests.
 *   - **A restore is a transaction, not a file swap.** Swapping the file under a process
 *     that has it open is how you end up with a running server holding a handle to a
 *     database nobody can see. Instead the snapshot is attached and copied into the live
 *     database inside a single transaction: either every table is replaced or none is, and
 *     no request in flight ever sees a half-restored state.
 *   - **A restore takes a backup first.** The safety bundle is written before anything is
 *     touched, under the same passphrase, which is what makes a mistaken restore undoable.
 *   - **A newer bundle is refused, not guessed at.** The manifest carries the list of
 *     migrations the source had applied. If it holds one this installation has never seen,
 *     the bundle came from a later version and its rows may not fit these tables.
 *
 * What a backup deliberately does *not* contain is anything that would let it be opened
 * without the passphrase. Vault items and documents travel as the ciphertext they are
 * stored as, and the key that opens them was never on this server to begin with.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  APP_VERSION,
  BUNDLE_EXTENSION,
  BUNDLE_FORMAT_VERSION,
  type BackupListResponse,
  type BackupManifest,
  type BackupRecord,
  type BundleUploadEntry,
  type RestoreResult,
  type RestoredTable,
} from '@networth/shared';
import type { AppContext } from '../context.js';
import { appliedMigrations } from '../db/migrate.js';
import type { ArchiveEntry } from '../lib/archive.js';
import { BundleError, openBundle, sealBundle } from '../lib/bundle.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { isoNow } from '../lib/time.js';
import { recordAudit } from './audit.service.js';

const MANIFEST_ENTRY = 'manifest.json';
const SNAPSHOT_ENTRY = 'snapshot.db';
const UPLOAD_PREFIX = 'uploads/';

/**
 * `_migrations` is not restored.
 *
 * The live database's schema is whatever this build's migrations made it, and that stays
 * true after a restore — the rows are replaced, the tables are not. Copying an older
 * bundle's migration list over the top would leave the database claiming a schema it does
 * not have, and the next boot would try to re-apply migrations that had already run.
 */
const NOT_RESTORED = new Set(['_migrations']);

/* -------------------------------------------------------------------------- */
/* Taking a backup                                                            */
/* -------------------------------------------------------------------------- */

export interface CreateBackupOptions {
  passphrase: string;
  actorUserId?: string | null;
  ip?: string | null;
  /** Distinguishes the nightly run from one somebody asked for, in the filename. */
  scheduled?: boolean;
  /** Prefix for the pre-restore safety bundle, so it is obvious what it is. */
  namePrefix?: string;
}

/**
 * Snapshot the database and the uploads into an encrypted bundle in `BACKUP_DIR`.
 *
 * Async only because SQLite's online backup is: it yields between pages so that writers are
 * not blocked for the length of the copy.
 */
export async function createBackup(
  ctx: AppContext,
  options: CreateBackupOptions,
): Promise<BackupRecord> {
  const now = ctx.now();
  const workspace = mkdtempSync(join(tmpdir(), 'networth-backup-'));

  try {
    const snapshotPath = join(workspace, SNAPSHOT_ENTRY);
    await ctx.sqlite.backup(snapshotPath);
    const snapshot = readFileSync(snapshotPath);

    const uploads = collectUploads(ctx);

    const manifest: BackupManifest = {
      format: BUNDLE_FORMAT_VERSION,
      app: 'networth-tracker',
      appVersion: APP_VERSION,
      createdAt: isoNow(now),
      migrations: appliedMigrations(ctx.sqlite).map((row) => row.name),
      rowCounts: rowCounts(ctx),
      snapshotSha256: sha256(snapshot),
      uploads: uploads.map(({ path, content }) => ({
        path,
        sizeBytes: content.length,
        sha256: sha256(content),
      })),
    };

    const entries: ArchiveEntry[] = [
      { name: MANIFEST_ENTRY, content: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
      { name: SNAPSHOT_ENTRY, content: snapshot },
      ...uploads.map(({ path, content }) => ({ name: `${UPLOAD_PREFIX}${path}`, content })),
    ];

    const bundle = sealBundle(entries, options.passphrase, Math.floor(now.getTime() / 1000));

    const directory = backupDirectory(ctx);
    const filename = bundleName(now, options);
    // 0600: a bundle is the entire installation under one passphrase, and the default
    // umask on a shared host would make it world-readable.
    writeFileSync(join(directory, filename), bundle, { mode: 0o600 });

    recordAudit(ctx, {
      actorUserId: options.actorUserId ?? null,
      action: 'backup.created',
      entityType: 'backup',
      entityId: filename,
      ip: options.ip ?? null,
      meta: {
        sizeBytes: bundle.length,
        documents: uploads.length,
        scheduled: options.scheduled === true,
      },
    });

    return {
      filename,
      sizeBytes: bundle.length,
      createdAt: manifest.createdAt,
      scheduled: options.scheduled === true,
    };
  } finally {
    // The snapshot is a full copy of the database in plaintext. It does not outlive the
    // call that made it, whether or not that call succeeded.
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** Read a bundle back off disk, for the download endpoint. */
export function readBackup(ctx: AppContext, filename: string): Buffer {
  const path = join(backupDirectory(ctx), safeFilename(filename));
  if (!existsSync(path)) throw notFound('No such backup');
  return readFileSync(path);
}

export function deleteBackup(ctx: AppContext, filename: string, actorUserId: string): void {
  const name = safeFilename(filename);
  const path = join(backupDirectory(ctx), name);
  if (!existsSync(path)) throw notFound('No such backup');

  rmSync(path, { force: true });
  recordAudit(ctx, {
    actorUserId,
    action: 'backup.deleted',
    entityType: 'backup',
    entityId: name,
  });
}

export function listBackups(ctx: AppContext): BackupListResponse {
  const directory = backupDirectory(ctx);

  const backups = readdirSync(directory)
    .filter((name) => name.endsWith(BUNDLE_EXTENSION))
    .map((filename) => {
      const stats = statSync(join(directory, filename));
      return {
        filename,
        sizeBytes: stats.size,
        createdAt: stats.mtime.toISOString(),
        scheduled: filename.includes('-nightly'),
      } satisfies BackupRecord;
    })
    // Newest first: the one somebody wants is almost always the last one written.
    .sort((a, b) => b.filename.localeCompare(a.filename));

  return {
    backups,
    directory: resolve(directory),
    schedule: scheduleOf(ctx),
  };
}

/**
 * Whether the nightly backup is actually configured.
 *
 * Two things have to be true — a cron expression *and* a passphrase — and reporting the
 * schedule as active with no passphrase set would be the most dangerous kind of wrong: a
 * household believing they have nightly backups they have never had.
 */
export function scheduleOf(ctx: AppContext): { cron: string; retention: number } | null {
  if (ctx.config.BACKUP_CRON.trim() === '' || !ctx.config.BACKUP_PASSPHRASE) return null;
  return { cron: ctx.config.BACKUP_CRON, retention: ctx.config.BACKUP_RETENTION };
}

/**
 * Delete all but the newest `BACKUP_RETENTION` scheduled bundles.
 *
 * Only the scheduled ones. A bundle somebody downloaded on purpose, and the safety snapshot
 * a restore left behind, are not the nightly job's to tidy away — retention exists to stop
 * an automatic process filling a disk, not to expire what a person deliberately kept.
 */
export function pruneBackups(ctx: AppContext): string[] {
  const directory = backupDirectory(ctx);

  const scheduled = readdirSync(directory)
    .filter((name) => name.endsWith(BUNDLE_EXTENSION) && name.includes('-nightly'))
    .sort()
    .reverse();

  const stale = scheduled.slice(ctx.config.BACKUP_RETENTION);
  for (const filename of stale) {
    rmSync(join(directory, filename), { force: true });
  }
  return stale;
}

/* -------------------------------------------------------------------------- */
/* Restoring                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Replace everything with the contents of a bundle.
 *
 * The order is the whole design: verify before deciding, snapshot before touching, database
 * before files. By the time any existing row is deleted, the bundle has been decrypted, its
 * checksums have matched, its schema has been accepted and the current state has been
 * written to a bundle of its own.
 */
export async function restoreBackup(
  ctx: AppContext,
  bundleBytes: Buffer,
  passphrase: string,
  actorUserId: string,
  ip: string | null,
): Promise<RestoreResult> {
  const entries = openBundleOrFail(bundleBytes, passphrase);

  const manifest = readManifest(entries);
  const snapshot = entries.get(SNAPSHOT_ENTRY);
  if (!snapshot) throw badRequest('That bundle contains no database snapshot');

  if (sha256(snapshot) !== manifest.snapshotSha256) {
    throw badRequest('The database snapshot in that bundle does not match its checksum');
  }

  assertSchemaIsRestorable(ctx, manifest);

  const uploads = verifiedUploads(entries, manifest);

  // Everything below this line mutates. Nothing above it does.
  const safety = await createBackup(ctx, {
    passphrase,
    actorUserId,
    ip,
    namePrefix: 'pre-restore',
  });

  const workspace = mkdtempSync(join(tmpdir(), 'networth-restore-'));
  const warnings: string[] = [];
  let tables: RestoredTable[];

  try {
    const snapshotPath = join(workspace, SNAPSHOT_ENTRY);
    writeFileSync(snapshotPath, snapshot, { mode: 0o600 });

    tables = copyDatabase(ctx, snapshotPath, manifest, warnings);
    restoreUploads(ctx, uploads, workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }

  recordAudit(ctx, {
    actorUserId,
    action: 'backup.restored',
    entityType: 'backup',
    entityId: manifest.createdAt,
    ip,
    meta: {
      appVersion: manifest.appVersion,
      documents: uploads.length,
      safetyBackup: safety.filename,
      warnings: warnings.length,
    },
  });

  return {
    restoredAt: isoNow(ctx.now()),
    manifest: {
      createdAt: manifest.createdAt,
      appVersion: manifest.appVersion,
      migrations: manifest.migrations,
    },
    tables,
    documentsRestored: uploads.length,
    safetyBackup: safety.filename,
    warnings,
  };
}

/** Decrypt, translating the crypto layer's failures into ones the API answers with. */
function openBundleOrFail(bundleBytes: Buffer, passphrase: string): Map<string, Buffer> {
  try {
    return openBundle(bundleBytes, passphrase);
  } catch (error) {
    if (error instanceof BundleError) throw badRequest(error.message);
    throw error;
  }
}

function readManifest(entries: Map<string, Buffer>): BackupManifest {
  const raw = entries.get(MANIFEST_ENTRY);
  if (!raw) throw badRequest('That bundle has no manifest');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw badRequest('That bundle has an unreadable manifest');
  }

  const manifest = parsed as Partial<BackupManifest>;
  if (
    manifest?.app !== 'networth-tracker' ||
    typeof manifest.snapshotSha256 !== 'string' ||
    !Array.isArray(manifest.migrations)
  ) {
    throw badRequest('That bundle was not written by this application');
  }
  if (manifest.format !== BUNDLE_FORMAT_VERSION) {
    throw badRequest(`That bundle is in manifest format ${String(manifest.format)}, not this one`);
  }
  return manifest as BackupManifest;
}

/**
 * Refuse a bundle from a newer schema.
 *
 * Comparing migration *names* rather than a version number is what makes this answerable:
 * a bundle whose migrations are a subset of ours came from an older or identical build, and
 * its rows fit these tables with the newer columns taking their defaults. One migration we
 * have never heard of means the reverse, and there is no honest way to fit those rows into
 * tables that predate them.
 */
function assertSchemaIsRestorable(ctx: AppContext, manifest: BackupManifest): void {
  const here = new Set(appliedMigrations(ctx.sqlite).map((row) => row.name));
  const ahead = manifest.migrations.filter((name) => !here.has(name));

  if (ahead.length > 0) {
    throw conflict(
      `That backup was written by a newer version of this application (unknown migrations: ${ahead.join(', ')}). Upgrade before restoring it.`,
    );
  }
}

/** Check every blob against the manifest before a single one is written. */
function verifiedUploads(
  entries: Map<string, Buffer>,
  manifest: BackupManifest,
): Array<BundleUploadEntry & { content: Buffer }> {
  return manifest.uploads.map((entry) => {
    const content = entries.get(`${UPLOAD_PREFIX}${entry.path}`);
    if (!content) {
      throw badRequest(`That bundle is missing document ${entry.path}`);
    }
    if (sha256(content) !== entry.sha256) {
      throw badRequest(`Document ${entry.path} in that bundle does not match its checksum`);
    }
    return { ...entry, content };
  });
}

/**
 * Copy every table from the snapshot into the live database, in one transaction.
 *
 * Columns are matched by name rather than by position, so a bundle written before a
 * migration added a column still restores — the column simply takes its default. Foreign
 * keys are deferred rather than disabled: `PRAGMA defer_foreign_keys` can be set inside a
 * transaction (`foreign_keys` cannot), and it still checks every constraint at COMMIT, so a
 * snapshot that was internally inconsistent is rejected rather than quietly imported.
 */
function copyDatabase(
  ctx: AppContext,
  snapshotPath: string,
  manifest: BackupManifest,
  warnings: string[],
): RestoredTable[] {
  const { sqlite } = ctx;
  const restored: RestoredTable[] = [];

  sqlite.exec(`ATTACH DATABASE '${snapshotPath.replace(/'/g, "''")}' AS restore`);

  try {
    const targets = tableNames(sqlite, 'main').filter((name) => !NOT_RESTORED.has(name));
    const sources = new Set(tableNames(sqlite, 'restore'));

    const copy = sqlite.transaction(() => {
      sqlite.pragma('defer_foreign_keys = ON');

      // Every delete before any insert, and not as a matter of taste. Interleaving them
      // means that emptying `users` — which comes late in an alphabetical walk — cascades
      // away the assets, grants and documents that were restored a few tables earlier.
      // Clearing the database first makes each insert land in a table nothing else will
      // touch again.
      for (const table of targets) {
        sqlite.prepare(`DELETE FROM main."${table}"`).run();
      }

      for (const table of targets) {
        if (!sources.has(table)) {
          // A table this build has and the bundle did not: it was added by a migration
          // written after the backup. Empty is the only honest content for it.
          warnings.push(`Table "${table}" is not present in the backup and was left empty`);
          continue;
        }

        const shared = columnsOf(sqlite, 'main', table).filter((column) =>
          columnsOf(sqlite, 'restore', table).includes(column),
        );
        if (shared.length === 0) continue;

        const list = shared.map((column) => `"${column}"`).join(', ');
        sqlite
          .prepare(`INSERT INTO main."${table}" (${list}) SELECT ${list} FROM restore."${table}"`)
          .run();
      }
    });

    copy();

    for (const table of targets) {
      const actual = countRows(sqlite, table);
      const expected = manifest.rowCounts[table] ?? 0;
      restored.push({ table, expected, actual });
      if (actual !== expected) {
        warnings.push(`Table "${table}" holds ${actual} rows; the backup recorded ${expected}`);
      }
    }
  } finally {
    sqlite.exec('DETACH DATABASE restore');
  }

  return restored;
}

/**
 * Swap in the bundle's documents.
 *
 * The existing directory is moved aside rather than deleted, and only removed once the new
 * one is fully written — so a failure halfway through leaves the blobs that were there
 * before, rather than neither set. The safety bundle covers the case where even that fails.
 */
function restoreUploads(
  ctx: AppContext,
  uploads: Array<BundleUploadEntry & { content: Buffer }>,
  workspace: string,
): void {
  const root = resolve(ctx.config.UPLOAD_DIR);
  const staging = join(workspace, 'uploads');

  mkdirSync(staging, { recursive: true });
  for (const upload of uploads) {
    const absolute = safeJoin(staging, upload.path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, upload.content, { mode: 0o600 });
  }

  const displaced = `${root}.replaced-${Date.now()}`;
  const hadUploads = existsSync(root);
  if (hadUploads) renameSync(root, displaced);

  try {
    mkdirSync(dirname(root), { recursive: true });
    renameSync(staging, root);
  } catch (error) {
    // `rename` across filesystems fails with EXDEV — the workspace is in the system temp
    // directory, which is often a different mount from `data/`. Fall back to a copy.
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
      if (hadUploads) renameSync(displaced, root);
      throw error;
    }
    mkdirSync(root, { recursive: true });
    for (const upload of uploads) {
      const absolute = safeJoin(root, upload.path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, upload.content, { mode: 0o600 });
    }
  }

  if (hadUploads) rmSync(displaced, { recursive: true, force: true });
}

/* -------------------------------------------------------------------------- */
/* Plumbing                                                                   */
/* -------------------------------------------------------------------------- */

function backupDirectory(ctx: AppContext): string {
  const directory = resolve(ctx.config.BACKUP_DIR);
  mkdirSync(directory, { recursive: true });
  return directory;
}

/** `networth-20260908T020000Z-nightly.ntb` — sortable, and says where it came from. */
function bundleName(now: Date, options: CreateBackupOptions): string {
  const stamp = isoNow(now)
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const prefix = options.namePrefix ?? 'networth';
  const kind = options.scheduled === true ? 'nightly' : 'manual';
  return `${prefix}-${stamp}-${kind}${BUNDLE_EXTENSION}`;
}

/**
 * A filename from a request, reduced to a filename.
 *
 * The value only ever indexes into `BACKUP_DIR`, and a `..` in it would index out of it.
 * Rejecting rather than sanitising: there is no legitimate request this refuses.
 */
function safeFilename(filename: string): string {
  if (
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('..') ||
    !filename.endsWith(BUNDLE_EXTENSION)
  ) {
    throw badRequest('That is not a backup filename');
  }
  return filename;
}

/** Join under a root, refusing anything that would escape it. */
function safeJoin(root: string, relativePath: string): string {
  const absolute = resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw badRequest(`That bundle contains an unsafe document path: ${relativePath}`);
  }
  return absolute;
}

/** Every upload blob on disk, keyed by its path relative to `UPLOAD_DIR`. */
function collectUploads(ctx: AppContext): Array<{ path: string; content: Buffer }> {
  const root = resolve(ctx.config.UPLOAD_DIR);
  if (!existsSync(root)) return [];

  const found: Array<{ path: string; content: Buffer }> = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        found.push({
          // POSIX separators in the archive regardless of the host, so a bundle written on
          // one platform restores on another.
          path: relative(root, absolute).split(sep).join('/'),
          content: readFileSync(absolute),
        });
      }
    }
  };

  walk(root);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

function rowCounts(ctx: AppContext): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of tableNames(ctx.sqlite, 'main')) {
    counts[table] = countRows(ctx.sqlite, table);
  }
  return counts;
}

function tableNames(sqlite: AppContext['sqlite'], schema: 'main' | 'restore'): string[] {
  return sqlite
    .prepare<[], { name: string }>(
      `SELECT name FROM ${schema}.sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all()
    .map((row) => row.name);
}

function columnsOf(
  sqlite: AppContext['sqlite'],
  schema: 'main' | 'restore',
  table: string,
): string[] {
  return sqlite
    .prepare<[string, string], { name: string }>('SELECT name FROM pragma_table_info(?, ?)')
    .all(table, schema)
    .map((row) => row.name);
}

function countRows(sqlite: AppContext['sqlite'], table: string): number {
  const row = sqlite
    .prepare<[], { count: number }>(`SELECT count(*) AS count FROM main."${table}"`)
    .get();
  return row?.count ?? 0;
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
