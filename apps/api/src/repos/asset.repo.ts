/**
 * Scoped data access for assets and their children.
 *
 * Every query in this file starts from a {@link Scope}. Reads are constrained to the owners
 * that scope resolved; writes are constrained to the caller themselves. Nothing above this
 * layer is trusted to filter, and nothing below it knows who is asking.
 *
 * A row outside the caller's scope is reported as `not found`, never as `forbidden`:
 * existence is private, and a 403 would confirm that some other household holds an asset
 * with the id being probed.
 */

import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { AssetQuery, AssetStatus, AssetType, ValuationSource } from '@networth/shared';
import type { AppContext } from '../context.js';
import { assets, transactions, valuations, type AssetRow } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { owns, type Scope } from './scope.js';

export interface LatestValue {
  valuePaise: number;
  asOf: string;
  source: ValuationSource;
}

/**
 * The rows a caller may read, filtered and ordered.
 *
 * Filtering happens in SQL; ordering and the page slice happen in memory. That is a
 * deliberate trade: sorting by value means sorting by a column that lives in a different
 * table, one row per asset per day, and the join to express that in SQL costs far more
 * complexity than sorting a few hundred rows costs time. `SCAN_LIMIT` keeps the honesty of
 * that claim enforced rather than assumed.
 */
export function listAssets(
  ctx: AppContext,
  scope: Scope,
  query: AssetQuery,
): { rows: AssetRow[]; total: number; latest: Map<string, LatestValue> } {
  const filters: SQL[] = [inArray(assets.ownerUserId, scope.readableOwnerIds)];

  if (query.type) filters.push(eq(assets.type, query.type));
  if (query.status) filters.push(eq(assets.status, query.status));
  if (query.nomineeRegistered !== undefined) {
    filters.push(eq(assets.nomineeRegistered, query.nomineeRegistered));
  }
  if (query.q) {
    const pattern = `%${escapeLike(query.q)}%`;
    // `escape` is spelled out because SQLite's LIKE otherwise treats a `%` the user typed as
    // a wildcard, turning a search for "50%" into a match for everything.
    filters.push(
      sql`(${assets.name} like ${pattern} escape '\\' or coalesce(${assets.institution}, '') like ${pattern} escape '\\')`,
    );
  }
  if (query.tag) {
    // Tags are a JSON array in one column; this is an exact element match, not a substring.
    filters.push(sql`exists (select 1 from json_each(${assets.tags}) where value = ${query.tag})`);
  }

  const rows = ctx.db
    .select()
    .from(assets)
    .where(and(...filters))
    .limit(SCAN_LIMIT)
    .all();

  const latest = latestValues(
    ctx,
    rows.map((row) => row.id),
  );

  const sorted = sortAssets(rows, latest, query.sort, query.order);
  return {
    rows: sorted.slice(query.offset, query.offset + query.limit),
    total: sorted.length,
    latest,
  };
}

/** Well beyond any household, and low enough that the in-memory sort stays honest. */
const SCAN_LIMIT = 5_000;

function sortAssets(
  rows: AssetRow[],
  latest: Map<string, LatestValue>,
  sort: AssetQuery['sort'],
  order: AssetQuery['order'],
): AssetRow[] {
  const direction = order === 'asc' ? 1 : -1;

  return [...rows].sort((a, b) => {
    switch (sort) {
      case 'name':
        return direction * a.name.localeCompare(b.name, 'en-IN');
      case 'value': {
        // An unvalued asset sorts as zero rather than dropping out of the list — it is
        // something the household owns, and hiding it is how an asset gets forgotten.
        const left = latest.get(a.id)?.valuePaise ?? 0;
        const right = latest.get(b.id)?.valuePaise ?? 0;
        return direction * (left - right);
      }
      case 'created':
      default:
        // Ids are UUIDv7, so this is creation order without reading a second column.
        return direction * a.id.localeCompare(b.id);
    }
  });
}

/**
 * An asset the caller may read, or a 404.
 *
 * Note what this does *not* do: it does not check whether the caller may see the asset's
 * detail. That is `assertCanSeeDetail`, and separating the two is what lets a summary
 * grantee list an asset without reading its policy number.
 */
export function readableAsset(ctx: AppContext, scope: Scope, assetId: string): AssetRow {
  const row = ctx.db.select().from(assets).where(eq(assets.id, assetId)).get();
  if (!row || !scope.readableOwnerIds.includes(row.ownerUserId)) {
    throw notFound('No such asset');
  }
  return row;
}

/**
 * An asset the caller may modify, or a 404.
 *
 * Only the owner writes. A grant — household, nominee or manual — never carries a write,
 * so a shared asset is refused here in exactly the same terms as one that does not exist.
 */
export function writableAsset(ctx: AppContext, scope: Scope, assetId: string): AssetRow {
  const row = ctx.db.select().from(assets).where(eq(assets.id, assetId)).get();
  if (!row || !owns(scope, row.ownerUserId)) {
    throw notFound('No such asset');
  }
  return row;
}

/**
 * The most recent valuation of each asset.
 *
 * Written as raw SQL because a window function is the only way to say "the latest row per
 * group, ties broken by insertion order" in one pass, and `valuations` is append-only, so
 * ties are real: a correction written on the same `as_of` must win over what it corrects.
 */
export function latestValues(ctx: AppContext, assetIds: string[]): Map<string, LatestValue> {
  const result = new Map<string, LatestValue>();
  if (assetIds.length === 0) return result;

  const placeholders = assetIds.map(() => '?').join(', ');
  const rows = ctx.sqlite
    .prepare<string[], { asset_id: string; value_paise: number; as_of: string; source: string }>(
      `SELECT asset_id, value_paise, as_of, source
         FROM (
           SELECT asset_id, value_paise, as_of, source,
                  row_number() OVER (
                    PARTITION BY asset_id ORDER BY as_of DESC, created_at DESC
                  ) AS rn
             FROM valuations
            WHERE asset_id IN (${placeholders})
         )
        WHERE rn = 1`,
    )
    .all(...assetIds);

  for (const row of rows) {
    result.set(row.asset_id, {
      valuePaise: row.value_paise,
      asOf: row.as_of,
      source: row.source as ValuationSource,
    });
  }
  return result;
}

/** Valuation history for one asset, newest first. */
export function valuationHistory(ctx: AppContext, assetId: string, limit = 500) {
  return ctx.db
    .select()
    .from(valuations)
    .where(eq(valuations.assetId, assetId))
    .orderBy(sql`${valuations.asOf} desc, ${valuations.createdAt} desc`)
    .limit(limit)
    .all();
}

/** Transactions for one asset, oldest first — the order cost basis and XIRR read them in. */
export function transactionHistory(ctx: AppContext, assetId: string, limit = 1_000) {
  return ctx.db
    .select()
    .from(transactions)
    .where(eq(transactions.assetId, assetId))
    .orderBy(sql`${transactions.date} asc, ${transactions.createdAt} asc`)
    .limit(limit)
    .all();
}

/** One transaction, scoped to its asset so an id from another asset cannot be reached. */
export function transactionOfAsset(ctx: AppContext, assetId: string, transactionId: string) {
  const row = ctx.db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, transactionId), eq(transactions.assetId, assetId)))
    .get();
  if (!row) throw notFound('No such transaction');
  return row;
}

/** Counts per status and type, for the asset list's filter chips. */
export function assetTypeCounts(
  ctx: AppContext,
  scope: Scope,
): Array<{ type: AssetType; status: AssetStatus; count: number }> {
  return ctx.db
    .select({
      type: assets.type,
      status: assets.status,
      count: sql<number>`count(*)`,
    })
    .from(assets)
    .where(inArray(assets.ownerUserId, scope.readableOwnerIds))
    .groupBy(assets.type, assets.status)
    .all();
}

/** Neutralise LIKE's own wildcards so a search for `50%` means what it says. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
