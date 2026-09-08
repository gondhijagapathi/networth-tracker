/**
 * Backup, restore and export contracts.
 *
 * A backup is the whole installation — every account, every asset, every vault ciphertext
 * and every uploaded blob — sealed under a passphrase that this server does not keep. An
 * export is the opposite: one person's data in a format that opens in a spreadsheet, so
 * nothing here is a trap. The two are deliberately separate features and neither is a
 * substitute for the other.
 *
 * The bundle format itself is described in `apps/api/src/lib/bundle.ts`. What lives here is
 * what crosses the wire: the passphrase rules, the manifest a restore checks itself against,
 * and the shapes the UI renders.
 */

import { z } from 'zod';

/** The extension a bundle is written with. Not a MIME type anything else recognises. */
export const BUNDLE_EXTENSION = '.ntb';

/**
 * Passphrase rules for a bundle.
 *
 * Longer than a password minimum on purpose, and not because a person's login is less
 * important. A password is defended by rate limiting, backoff and a server that can lock
 * the account; a bundle sitting in a synced cloud folder has none of that — the only thing
 * between it and an offline attack with a GPU is its length. Twelve characters is the floor,
 * and the UI asks for a phrase rather than a word.
 */
export const MIN_BACKUP_PASSPHRASE = 12;

export const backupPassphraseSchema = z
  .string()
  .min(MIN_BACKUP_PASSPHRASE, `Use at least ${MIN_BACKUP_PASSPHRASE} characters`)
  .max(256, 'That is longer than any passphrase needs to be');

export const createBackupSchema = z.object({
  passphrase: backupPassphraseSchema,
});
export type CreateBackupBody = z.infer<typeof createBackupSchema>;

/**
 * A restore names the bundle it wants and confirms what it is about to do.
 *
 * `confirm` is not decoration. Restoring replaces every row in the database, and an
 * accidental double-click on a "restore" button should not be able to do that — so the
 * client has to say it means it, in the body, where a replayed URL cannot.
 */
export const restoreBackupSchema = z.object({
  passphrase: backupPassphraseSchema,
  confirm: z.literal(true, 'Confirm that this replaces everything currently stored'),
});
export type RestoreBackupBody = z.infer<typeof restoreBackupSchema>;

/* -------------------------------------------------------------------------- */
/* The manifest                                                               */
/* -------------------------------------------------------------------------- */

/** Bumped only if the container layout changes in a way an older reader cannot parse. */
export const BUNDLE_FORMAT_VERSION = 1;

export interface BundleUploadEntry {
  /** Path relative to `UPLOAD_DIR`, exactly as `documents.storage_path` records it. */
  path: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * What a bundle says about itself.
 *
 * The two fields a restore actually gates on are `migrations` and `snapshotSha256`. The row
 * counts are for the human on the other end: a restore reports what it wrote next to what
 * the manifest promised, and a mismatch is visible rather than inferred.
 */
export interface BackupManifest {
  format: number;
  app: 'networth-tracker';
  appVersion: string;
  createdAt: string;
  /**
   * Every migration the source database had applied, in order. This *is* the schema
   * version — a name list rather than a number, because it says which schema, not just how
   * far along it was.
   */
  migrations: string[];
  /** Rows per table at snapshot time, for the restore report. */
  rowCounts: Record<string, number>;
  snapshotSha256: string;
  uploads: BundleUploadEntry[];
}

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

/** A bundle sitting in `BACKUP_DIR`. The contents are unreadable from here. */
export interface BackupRecord {
  filename: string;
  sizeBytes: number;
  createdAt: string;
  /** True for the automatic nightly run, false for one somebody asked for. */
  scheduled: boolean;
}

export interface BackupListResponse {
  backups: BackupRecord[];
  /** Where they are written, so the operator knows what to copy off the machine. */
  directory: string;
  /** Null when no schedule is configured — which the UI says out loud. */
  schedule: { cron: string; retention: number } | null;
}

/** One table's before-and-after, so a restore can be checked rather than trusted. */
export interface RestoredTable {
  table: string;
  /** What the manifest said the bundle held. */
  expected: number;
  /** What is in the database now. */
  actual: number;
}

export interface RestoreResult {
  restoredAt: string;
  manifest: Pick<BackupManifest, 'createdAt' | 'appVersion' | 'migrations'>;
  tables: RestoredTable[];
  documentsRestored: number;
  /** The pre-restore snapshot, which is what makes a mistaken restore undoable. */
  safetyBackup: string;
  /** Set when a table's count came back different from the manifest's. */
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The CSV datasets.
 *
 * One per asset type, because the whole reason this application has nine detail tables is
 * that a fixed deposit and a plot of land do not share columns — and flattening them into
 * one sheet with forty mostly-empty columns would undo that. Plus the two tables that cut
 * across every type.
 */
export const EXPORT_DATASETS = [
  'assets',
  'bank_account',
  'deposit',
  'holding',
  'insurance_policy',
  'property',
  'retirement_account',
  'precious_metal',
  'other_asset',
  'liability',
  'transactions',
  'valuations',
] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

export const exportQuerySchema = z.object({
  dataset: z.enum(EXPORT_DATASETS).default('assets'),
});
export type ExportQuery = z.infer<typeof exportQuerySchema>;

export const EXPORT_DATASET_LABELS: Record<ExportDataset, string> = {
  assets: 'All assets (summary)',
  bank_account: 'Bank accounts',
  deposit: 'Deposits',
  holding: 'Funds & shares',
  insurance_policy: 'Insurance policies',
  property: 'Property',
  retirement_account: 'Retirement accounts',
  precious_metal: 'Gold & metals',
  other_asset: 'Other assets',
  liability: 'Loans',
  transactions: 'Transactions',
  valuations: 'Valuations',
};

/**
 * The full JSON export.
 *
 * Vault items and documents appear as the ciphertext they are stored as. Exporting them at
 * all is the point — an export that silently dropped the vault would let somebody migrate
 * away and discover afterwards that their passwords did not come with them — and exporting
 * them in the clear is impossible, because this server has never been able to read them.
 */
export interface ExportBundle {
  exportedAt: string;
  appVersion: string;
  owner: { id: string; email: string; name: string };
  assets: unknown[];
  transactions: unknown[];
  valuations: unknown[];
  instruments: unknown[];
  vaultItems: unknown[];
  documents: unknown[];
  nominees: unknown[];
}
