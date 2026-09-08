/**
 * Portable exports.
 *
 * A backup exists so this installation can be put back. An export exists so it can be
 * walked away from — `docs/BACKUP.md` puts it plainly: "backups are for restoring this app;
 * exports are for not being trapped in it". They are different features and neither
 * substitutes for the other, which is why an export is neither encrypted nor restorable.
 *
 * Two rules follow from what an export is for:
 *
 *   - **It is one person's data, not the installation's.** Scoped to rows the caller owns,
 *     deliberately ignoring the grants that let them *read* a partner's assets on a merged
 *     dashboard. Being able to see a total is not the same as being handed a spreadsheet of
 *     somebody else's accounts, and a household member exporting their partner's portfolio
 *     is not something the partner consented to.
 *   - **The vault comes too, as ciphertext.** An export that silently dropped it would let
 *     somebody migrate away and find out afterwards that their passwords did not come with
 *     them. It cannot come any other way: this server has never been able to read it.
 *
 * JSON is the exact record — integer paise, integer micro-units, every field as stored. CSV
 * is for a spreadsheet, so amounts are converted to rupees and quantities to decimals, with
 * the column names saying so. The two disagree on purpose, and the one to migrate from is
 * the JSON.
 */

import { eq, inArray } from 'drizzle-orm';
import {
  APP_VERSION,
  MICRO,
  PAISE_PER_RUPEE,
  type ExportBundle,
  type ExportDataset,
} from '@networth/shared';
import type { AppContext } from '../context.js';
import {
  assets,
  documents,
  holdings,
  instruments,
  nominees,
  transactions,
  users,
  valuations,
  vaultItems,
} from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { isoNow } from '../lib/time.js';
import { readDetail } from './assetDetail.js';

/* -------------------------------------------------------------------------- */
/* JSON                                                                       */
/* -------------------------------------------------------------------------- */

export function exportJson(ctx: AppContext, userId: string): ExportBundle {
  const owner = ctx.db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!owner) throw notFound('No such user');

  const owned = ctx.db.select().from(assets).where(eq(assets.ownerUserId, userId)).all();
  const ids = owned.map((row) => row.id);

  const holdingRows = ids.length === 0 ? [] : selectByAsset(ctx, holdings, ids);
  const instrumentIds = [...new Set(holdingRows.map((row) => row.instrumentId))];

  return {
    exportedAt: isoNow(ctx.now()),
    appVersion: APP_VERSION,
    owner,
    assets: owned.map((row) => ({
      ...row,
      tags: parseTags(row.tags),
      // The typed detail rather than the raw row, so an export reads the way the API does.
      detail: readDetail(ctx.db, row),
    })),
    transactions: ids.length === 0 ? [] : selectByAsset(ctx, transactions, ids),
    valuations: ids.length === 0 ? [] : selectByAsset(ctx, valuations, ids),
    // Only the instruments this portfolio actually references: the catalogue is shared
    // between households and is not this person's data to carry away.
    instruments:
      instrumentIds.length === 0
        ? []
        : ctx.db.select().from(instruments).where(inArray(instruments.id, instrumentIds)).all(),
    vaultItems: ctx.db.select().from(vaultItems).where(eq(vaultItems.ownerUserId, userId)).all(),
    // Metadata and checksums, not the blobs: a 10 MB scan base64'd into a JSON file helps
    // nobody, and the blobs travel in a backup bundle where they belong.
    documents: ctx.db
      .select()
      .from(documents)
      .where(eq(documents.ownerUserId, userId))
      .all()
      .map(({ storagePath: _storagePath, ...rest }) => rest),
    nominees: ctx.db.select().from(nominees).where(eq(nominees.ownerUserId, userId)).all(),
  };
}

/* -------------------------------------------------------------------------- */
/* CSV                                                                        */
/* -------------------------------------------------------------------------- */

/** Asset base columns every per-type sheet starts with, in the order a person reads them. */
const ASSET_COLUMNS = [
  'id',
  'type',
  'name',
  'institution',
  'nominee_registered',
  'ownership_bps',
  'joint_with',
  'status',
  'opened_on',
  'closed_on',
  'tags',
  'notes',
  'created_at',
] as const;

/** Which detail table each asset-type dataset joins. */
const DETAIL_TABLES: Record<string, string> = {
  bank_account: 'bank_accounts',
  deposit: 'deposits',
  holding: 'holdings',
  insurance_policy: 'insurance_policies',
  property: 'properties',
  retirement_account: 'retirement_accounts',
  precious_metal: 'precious_metals',
  other_asset: 'other_assets',
  liability: 'liabilities',
};

export function exportCsv(ctx: AppContext, userId: string, dataset: ExportDataset): string {
  if (dataset === 'assets') return assetSheet(ctx, userId);
  if (dataset === 'transactions') return crossAssetSheet(ctx, userId, 'transactions');
  if (dataset === 'valuations') return crossAssetSheet(ctx, userId, 'valuations');
  return detailSheet(ctx, userId, dataset);
}

/** Every asset, with whatever it was last valued at. One row per asset, nine types mixed. */
function assetSheet(ctx: AppContext, userId: string): string {
  const columns = [...ASSET_COLUMNS, 'latest_value_inr', 'latest_value_as_of', 'latest_source'];

  const rows = ctx.sqlite
    .prepare<[string], Record<string, unknown>>(
      `SELECT ${ASSET_COLUMNS.map((c) => `a."${c}"`).join(', ')},
              v.value_paise AS latest_value_inr,
              v.as_of       AS latest_value_as_of,
              v.source      AS latest_source
         FROM assets a
         LEFT JOIN valuations v ON v.id = (
           SELECT id FROM valuations
             WHERE asset_id = a.id
             ORDER BY as_of DESC, created_at DESC
             LIMIT 1
         )
        WHERE a.owner_user_id = ?
        ORDER BY a.type, a.name`,
    )
    .all(userId);

  return toCsv(columns, rows);
}

/**
 * One asset type, with its detail columns.
 *
 * The columns come from the table definition rather than from the first row, so a household
 * with no gold still exports a `precious_metal` sheet with headers — which is what somebody
 * building an import on the other side needs to see.
 */
function detailSheet(ctx: AppContext, userId: string, type: ExportDataset): string {
  const table = DETAIL_TABLES[type];
  if (!table) throw notFound('No such export');

  const detailColumns = tableColumns(ctx, table).filter((column) => column !== 'asset_id');
  const columns = [...ASSET_COLUMNS, ...detailColumns];

  const rows = ctx.sqlite
    .prepare<[string, string], Record<string, unknown>>(
      `SELECT ${ASSET_COLUMNS.map((c) => `a."${c}"`).join(', ')},
              ${detailColumns.map((c) => `d."${c}"`).join(', ')}
         FROM assets a
         JOIN "${table}" d ON d.asset_id = a.id
        WHERE a.owner_user_id = ? AND a.type = ?
        ORDER BY a.name`,
    )
    .all(userId, type);

  return toCsv(columns, rows);
}

/** Transactions or valuations, with the asset they belong to named rather than referenced. */
function crossAssetSheet(
  ctx: AppContext,
  userId: string,
  table: 'transactions' | 'valuations',
): string {
  const own = tableColumns(ctx, table);
  const columns = ['asset_name', 'asset_type', ...own];
  const dateColumn = table === 'transactions' ? 'date' : 'as_of';

  const rows = ctx.sqlite
    .prepare<[string], Record<string, unknown>>(
      `SELECT a.name AS asset_name, a.type AS asset_type,
              ${own.map((c) => `t."${c}"`).join(', ')}
         FROM "${table}" t
         JOIN assets a ON a.id = t.asset_id
        WHERE a.owner_user_id = ?
        ORDER BY t."${dateColumn}", a.name`,
    )
    .all(userId);

  return toCsv(columns, rows);
}

/* -------------------------------------------------------------------------- */
/* CSV rendering                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Columns whose stored integer is not what a spreadsheet should show.
 *
 * `_paise` becomes rupees and `_micro` becomes a decimal, and both are renamed so the header
 * says which one it is. Nothing here is used for arithmetic that matters — the JSON export
 * carries the exact integers — so a float on the way out is a display choice rather than
 * the drift `money.ts` exists to prevent.
 */
function renderCell(column: string, value: unknown): string {
  if (value === null || value === undefined) return '';

  if (typeof value === 'number') {
    if (column.endsWith('_paise') || column.endsWith('_inr')) {
      return (value / PAISE_PER_RUPEE).toFixed(2);
    }
    if (column.endsWith('_micro') || column === 'units') return (value / MICRO).toFixed(6);
    if (column.endsWith('_bps')) return (value / 100).toFixed(2);
  }

  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Buffer.isBuffer(value)) return value.toString('base64');
  return String(value);
}

/** `rate_bps` reads as a percentage once divided by a hundred; say so in the header. */
function renderHeader(column: string): string {
  if (column.endsWith('_paise')) return column.replace(/_paise$/, '_inr');
  if (column.endsWith('_micro')) return column.replace(/_micro$/, '');
  if (column.endsWith('_bps')) return column.replace(/_bps$/, '_percent');
  return column;
}

function toCsv(columns: readonly string[], rows: Array<Record<string, unknown>>): string {
  const lines = [columns.map(renderHeader).map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCell(renderCell(column, row[column]))).join(','));
  }
  // A trailing newline: POSIX text, and Excel is happier with it than without.
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Quote a field, and defuse the ones a spreadsheet would execute.
 *
 * A cell beginning `=`, `+` or `@` is a formula to Excel and to Sheets, and an asset named
 * `=HYPERLINK(...)` would run on open. Prefixing with an apostrophe forces it to text.
 * A leading `-` is deliberately *not* guarded: negative numbers are ordinary here and
 * mangling every one of them to defend against a contrived `-1+cmd` is the worse trade.
 */
function escapeCell(value: string): string {
  const guarded = /^[=+@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/* -------------------------------------------------------------------------- */
/* Plumbing                                                                   */
/* -------------------------------------------------------------------------- */

function tableColumns(ctx: AppContext, table: string): string[] {
  return ctx.sqlite
    .prepare<[string], { name: string }>('SELECT name FROM pragma_table_info(?)')
    .all(table)
    .map((row) => row.name);
}

type AssetScopedTable = typeof transactions | typeof valuations | typeof holdings;

function selectByAsset<T extends AssetScopedTable>(
  ctx: AppContext,
  table: T,
  ids: string[],
): Array<T['$inferSelect']> {
  return ctx.db.select().from(table).where(inArray(table.assetId, ids)).all() as Array<
    T['$inferSelect']
  >;
}

/** `assets.tags` is a JSON array in a TEXT column; an export should carry the array. */
function parseTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string')
      : [];
  } catch {
    return [];
  }
}
