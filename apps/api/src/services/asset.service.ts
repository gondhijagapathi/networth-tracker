/**
 * Asset business logic.
 *
 * Route handlers parse and delegate; everything about what an asset *is* lives here. Two
 * rules run through the whole file:
 *
 *   - **Scope first.** Every function takes a `Scope` and reaches the database through
 *     `repos/asset.repo.ts`. Nothing here filters by owner itself.
 *   - **Validate whole objects.** An update merges its partial into the stored detail and
 *     re-parses the result, because the interesting rules — maturity after start,
 *     outstanding within principal — are properties of a complete object, not of a field.
 */

import { eq } from 'drizzle-orm';
import {
  assetDetailSchemas,
  createTransactionSchema,
  uuidv7,
  type AssetQuery,
  type AssetRecord,
  type AssetSummary,
  type CreateAssetBody,
  type CreateTransactionBody,
  type CreateValuationBody,
  type TransactionRecord,
  type UpdateAssetBody,
  type UpdateTransactionBody,
  type ValuationRecord,
} from '@networth/shared';
import type { AppContext } from '../context.js';
import {
  assets,
  instruments,
  transactions,
  valuations,
  type AssetRow,
  type TransactionRow,
  type ValuationRow,
} from '../db/schema.js';
import { badRequest } from '../lib/errors.js';
import { isoNow } from '../lib/time.js';
import {
  latestValues,
  listAssets as listAssetRows,
  readableAsset,
  transactionHistory,
  transactionOfAsset,
  valuationHistory,
  writableAsset,
  type LatestValue,
} from '../repos/asset.repo.js';
import { assertCanSeeDetail, owns, type Scope } from '../repos/scope.js';
import { readDetail, writeDetail, type TypedDetail } from './assetDetail.js';
import { recordAudit } from './audit.service.js';

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export function listAssets(
  ctx: AppContext,
  scope: Scope,
  query: AssetQuery,
): { assets: AssetSummary[]; total: number } {
  const { rows, total, latest } = listAssetRows(ctx, scope, query);
  return {
    assets: rows.map((row) => toSummary(row, latest.get(row.id) ?? null, scope)),
    total,
  };
}

export function getAsset(ctx: AppContext, scope: Scope, assetId: string): AssetRecord {
  const row = readableAsset(ctx, scope, assetId);
  // Listing an asset and reading its detail are different permissions: a summary grantee
  // sees that a policy exists and what it is worth, not the policy number.
  assertCanSeeDetail(scope, row.ownerUserId);

  const latest = latestValues(ctx, [row.id]).get(row.id) ?? null;
  return {
    ...toSummary(row, latest, scope),
    detail: readDetail(ctx.db, row),
  } as AssetRecord;
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Create an asset, its detail row and — if a value was supplied — its first valuation, as
 * one unit. A base row without its detail is a corrupt asset, and every read path treats it
 * as such, so it must never be possible to observe one.
 */
export function createAsset(
  ctx: AppContext,
  scope: Scope,
  body: CreateAssetBody,
  ip: string | null,
): AssetRecord {
  if (body.type === 'holding') assertInstrumentExists(ctx, body.detail.instrumentId);

  const now = isoNow(ctx.now());
  const id = uuidv7(ctx.now().getTime());

  const row: AssetRow = {
    id,
    ownerUserId: scope.userId,
    type: body.type,
    name: body.name,
    institution: body.institution ?? null,
    nomineeRegistered: body.nomineeRegistered,
    ownershipBps: body.ownershipBps,
    jointWith: body.jointWith ?? null,
    status: body.status,
    openedOn: body.openedOn ?? null,
    closedOn: body.closedOn ?? null,
    tags: JSON.stringify(body.tags),
    notes: body.notes ?? null,
    createdAt: now,
    updatedAt: now,
  };

  ctx.db.transaction((tx) => {
    tx.insert(assets).values(row).run();
    writeDetail(tx, id, body, 'insert');

    if (body.valuePaise !== undefined) {
      tx.insert(valuations)
        .values({
          id: uuidv7(ctx.now().getTime()),
          assetId: id,
          asOf: body.valueAsOf ?? now.slice(0, 10),
          valuePaise: body.valuePaise,
          source: 'manual',
          createdAt: now,
        })
        .run();
    }
  });

  recordAudit(ctx, {
    actorUserId: scope.userId,
    action: 'asset.created',
    entityType: 'asset',
    entityId: id,
    ip,
    meta: { type: body.type },
  });

  return getAsset(ctx, scope, id);
}

/**
 * Update an asset. `type` is not updatable: changing it would orphan one detail row and
 * require inventing another, and "this fixed deposit is actually a flat" is a new asset.
 */
export function updateAsset(
  ctx: AppContext,
  scope: Scope,
  assetId: string,
  body: UpdateAssetBody,
): AssetRecord {
  const asset = writableAsset(ctx, scope, assetId);
  const now = isoNow(ctx.now());

  const merged = body.detail === undefined ? null : mergeDetail(ctx, asset, body.detail);

  ctx.db.transaction((tx) => {
    tx.update(assets)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.institution !== undefined && { institution: body.institution }),
        ...(body.nomineeRegistered !== undefined && { nomineeRegistered: body.nomineeRegistered }),
        ...(body.ownershipBps !== undefined && { ownershipBps: body.ownershipBps }),
        ...(body.jointWith !== undefined && { jointWith: body.jointWith }),
        ...(body.status !== undefined && { status: body.status }),
        ...(body.openedOn !== undefined && { openedOn: body.openedOn }),
        ...(body.closedOn !== undefined && { closedOn: body.closedOn }),
        ...(body.tags !== undefined && { tags: JSON.stringify(body.tags) }),
        ...(body.notes !== undefined && { notes: body.notes }),
        updatedAt: now,
      })
      .where(eq(assets.id, assetId))
      .run();

    if (merged) writeDetail(tx, assetId, merged, 'update');
  });

  return getAsset(ctx, scope, assetId);
}

/**
 * Retire an asset.
 *
 * A soft delete, always. Valuations, transactions and documents outlive the asset they
 * describe — a closed FD is still part of last year's net worth, and an archived row is the
 * only way that history stays true.
 */
export function archiveAsset(
  ctx: AppContext,
  scope: Scope,
  assetId: string,
  ip: string | null,
): AssetSummary {
  const asset = writableAsset(ctx, scope, assetId);
  const now = isoNow(ctx.now());

  ctx.db
    .update(assets)
    .set({ status: 'archived', updatedAt: now })
    .where(eq(assets.id, assetId))
    .run();

  recordAudit(ctx, {
    actorUserId: scope.userId,
    action: 'asset.archived',
    entityType: 'asset',
    entityId: assetId,
    ip,
    meta: { type: asset.type },
  });

  const row = { ...asset, status: 'archived' as const, updatedAt: now };
  return toSummary(row, latestValues(ctx, [assetId]).get(assetId) ?? null, scope);
}

/**
 * Merge a partial detail into what is stored, then validate the whole thing.
 *
 * The cast is the one place the correlation between a runtime `type` and its schema cannot
 * be expressed to the compiler: `assetDetailSchemas[asset.type]` has just guaranteed the
 * pairing, but TypeScript sees a lookup into a record, not a proof.
 */
function mergeDetail(
  ctx: AppContext,
  asset: AssetRow,
  patch: Record<string, unknown>,
): TypedDetail {
  const current = readDetail(ctx.db, asset);
  const parsed = assetDetailSchemas[asset.type].parse({ ...current, ...patch });
  return { type: asset.type, detail: parsed } as TypedDetail;
}

/* -------------------------------------------------------------------------- */
/* Valuations                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Append a valuation. There is no update and no delete: `valuations` is the history the net
 * worth chart is drawn from, and a correction is a new row rather than an edit to the past.
 */
export function recordValuation(
  ctx: AppContext,
  scope: Scope,
  assetId: string,
  body: CreateValuationBody,
): ValuationRecord {
  writableAsset(ctx, scope, assetId);

  const row: ValuationRow = {
    id: uuidv7(ctx.now().getTime()),
    assetId,
    asOf: body.asOf,
    valuePaise: body.valuePaise,
    source: body.source,
    notes: body.notes ?? null,
    createdAt: isoNow(ctx.now()),
  };

  ctx.db.insert(valuations).values(row).run();
  return toValuationRecord(row);
}

export function listValuations(ctx: AppContext, scope: Scope, assetId: string): ValuationRecord[] {
  const asset = readableAsset(ctx, scope, assetId);
  assertCanSeeDetail(scope, asset.ownerUserId);
  return valuationHistory(ctx, assetId).map(toValuationRecord);
}

/* -------------------------------------------------------------------------- */
/* Transactions                                                               */
/* -------------------------------------------------------------------------- */

export function listTransactions(
  ctx: AppContext,
  scope: Scope,
  assetId: string,
): TransactionRecord[] {
  const asset = readableAsset(ctx, scope, assetId);
  assertCanSeeDetail(scope, asset.ownerUserId);
  return transactionHistory(ctx, assetId).map(toTransactionRecord);
}

export function addTransaction(
  ctx: AppContext,
  scope: Scope,
  assetId: string,
  body: CreateTransactionBody,
): TransactionRecord {
  writableAsset(ctx, scope, assetId);
  const now = isoNow(ctx.now());

  const row: TransactionRow = {
    id: uuidv7(ctx.now().getTime()),
    assetId,
    date: body.date,
    type: body.type,
    units: body.units ?? null,
    amountPaise: body.amountPaise,
    priceMicro: body.priceMicro ?? null,
    chargesPaise: body.chargesPaise,
    notes: body.notes ?? null,
    createdAt: now,
    updatedAt: now,
  };

  ctx.db.insert(transactions).values(row).run();
  return toTransactionRecord(row);
}

/**
 * Correct a transaction.
 *
 * Merged and re-validated as a whole for the same reason as asset detail: "a sell carries
 * negative units" is a rule about the finished row, and editing only the type would
 * otherwise leave a sell holding positive units.
 */
export function updateTransaction(
  ctx: AppContext,
  scope: Scope,
  assetId: string,
  transactionId: string,
  body: UpdateTransactionBody,
): TransactionRecord {
  writableAsset(ctx, scope, assetId);
  const current = transactionOfAsset(ctx, assetId, transactionId);

  const merged = createTransactionSchema.parse({
    date: body.date ?? current.date,
    type: body.type ?? current.type,
    units: body.units ?? current.units ?? undefined,
    amountPaise: body.amountPaise ?? current.amountPaise,
    priceMicro: body.priceMicro ?? current.priceMicro ?? undefined,
    chargesPaise: body.chargesPaise ?? current.chargesPaise,
    notes: body.notes ?? current.notes ?? undefined,
  });

  const now = isoNow(ctx.now());
  ctx.db
    .update(transactions)
    .set({
      date: merged.date,
      type: merged.type,
      units: merged.units ?? null,
      amountPaise: merged.amountPaise,
      priceMicro: merged.priceMicro ?? null,
      chargesPaise: merged.chargesPaise,
      notes: merged.notes ?? null,
      updatedAt: now,
    })
    .where(eq(transactions.id, transactionId))
    .run();

  return toTransactionRecord({
    ...current,
    ...merged,
    units: merged.units ?? null,
    updatedAt: now,
  });
}

/**
 * Remove a transaction outright.
 *
 * The one genuinely destructive operation in this file, and the reason it is audited: a
 * deleted transaction changes a cost basis and an XIRR, and there is no other record that
 * it ever existed.
 */
export function deleteTransaction(
  ctx: AppContext,
  scope: Scope,
  assetId: string,
  transactionId: string,
  ip: string | null,
): void {
  writableAsset(ctx, scope, assetId);
  const row = transactionOfAsset(ctx, assetId, transactionId);

  ctx.db.delete(transactions).where(eq(transactions.id, transactionId)).run();

  recordAudit(ctx, {
    actorUserId: scope.userId,
    action: 'transaction.deleted',
    entityType: 'transaction',
    entityId: transactionId,
    ip,
    meta: { assetId, type: row.type, amountPaise: row.amountPaise, date: row.date },
  });
}

/* -------------------------------------------------------------------------- */
/* Shaping                                                                    */
/* -------------------------------------------------------------------------- */

export function toSummary(row: AssetRow, latest: LatestValue | null, scope: Scope): AssetSummary {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    type: row.type,
    name: row.name,
    institution: row.institution,
    nomineeRegistered: row.nomineeRegistered,
    ownershipBps: row.ownershipBps,
    jointWith: row.jointWith,
    status: row.status,
    openedOn: row.openedOn,
    closedOn: row.closedOn,
    tags: parseTags(row.tags),
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    latestValue: latest,
    shared: !owns(scope, row.ownerUserId),
  };
}

function toValuationRecord(row: ValuationRow): ValuationRecord {
  return {
    id: row.id,
    assetId: row.assetId,
    asOf: row.asOf,
    valuePaise: row.valuePaise,
    source: row.source,
    notes: row.notes,
    createdAt: row.createdAt,
  };
}

function toTransactionRecord(row: TransactionRow): TransactionRecord {
  return {
    id: row.id,
    assetId: row.assetId,
    date: row.date,
    type: row.type,
    units: row.units,
    amountPaise: row.amountPaise,
    priceMicro: row.priceMicro,
    chargesPaise: row.chargesPaise,
    notes: row.notes,
    createdAt: row.createdAt,
  };
}

/** Tags are stored as a JSON array; a corrupted column costs the tags, not the asset. */
function parseTags(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * A holding must point at a real instrument.
 *
 * The foreign key would catch this too, but as a constraint violation surfacing as a 500.
 * A missing instrument is a client mistake, and it should read like one.
 */
function assertInstrumentExists(ctx: AppContext, instrumentId: string): void {
  const found = ctx.db
    .select({ id: instruments.id })
    .from(instruments)
    .where(eq(instruments.id, instrumentId))
    .get();
  if (!found)
    throw badRequest('No such instrument', { 'detail.instrumentId': ['Unknown instrument'] });
}
