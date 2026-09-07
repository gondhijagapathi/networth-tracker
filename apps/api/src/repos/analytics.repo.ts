/**
 * Bulk loads for the dashboard.
 *
 * The asset repository answers questions about one asset at a time, which is the right
 * shape for CRUD and the wrong shape here: valuing a portfolio touches every asset, every
 * detail row, every valuation, every transaction and every price, and doing that one asset
 * at a time is a few hundred round trips to answer a single page load.
 *
 * So this file loads the portfolio in a fixed number of queries — one per table — and hands
 * back a {@link PortfolioData} that the valuation and analytics services read from memory.
 * The scope is applied once, at the top, in exactly the same way the asset repository
 * applies it: reads are constrained to `scope.readableOwnerIds` and nothing above this
 * layer filters by owner.
 *
 * Everything comes back sorted oldest-first, because every consumer — accrual, cost basis,
 * XIRR, the net worth series — walks time forwards.
 */

import { inArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import {
  assets,
  bankAccounts,
  deposits,
  holdings,
  instrumentPrices,
  instruments,
  insurancePolicies,
  liabilities,
  otherAssets,
  preciousMetals,
  properties,
  retirementAccounts,
  transactions,
  valuations,
  type AssetRow,
  type TransactionRow,
  type ValuationRow,
} from '../db/schema.js';
import type { Scope } from './scope.js';

type DepositRow = typeof deposits.$inferSelect;
type HoldingRow = typeof holdings.$inferSelect;
type InsuranceRow = typeof insurancePolicies.$inferSelect;
type LiabilityRow = typeof liabilities.$inferSelect;
type MetalRow = typeof preciousMetals.$inferSelect;
type OtherAssetRow = typeof otherAssets.$inferSelect;
type PropertyRow = typeof properties.$inferSelect;
type RetirementRow = typeof retirementAccounts.$inferSelect;
type BankAccountRow = typeof bankAccounts.$inferSelect;
type PriceRow = typeof instrumentPrices.$inferSelect;

/**
 * One asset with the parts of its detail row that valuation and classification need.
 *
 * Not the full typed detail: this is the union of "what decides what it is worth" and "what
 * decides what class it belongs to", which is a much smaller thing than nine detail schemas
 * and keeps the valuation code from having to narrow a nine-way union at every step.
 */
export interface AssetFacts {
  asset: AssetRow;
  /** The detail row's discriminator — deposit `kind`, insurance `kind`, metal `form`, … */
  kind: string | null;
  /** Whichever maturity applies: a deposit's, a policy's, or an SGB's redemption date. */
  maturesOn: string | null;
  /**
   * When the asset itself began, which is not when its row was written.
   *
   * A household that enters fifteen years of PPF today created that row this morning, and
   * charting from `created_at` would draw a flat line and a cliff. The earliest date the
   * data actually supports — the opening date, the deposit's start, the first valuation or
   * the first transaction — is the honest one, and for anything this application can value
   * from its terms it is also a date it can compute a real figure for.
   */
  beganOn: string;
  deposit: DepositRow | null;
  holding: HoldingRow | null;
  insurance: InsuranceRow | null;
  liability: LiabilityRow | null;
  retirement: RetirementRow | null;
  other: OtherAssetRow | null;
  /** The instrument behind a holding, for classification and pricing. */
  instrument: {
    id: string;
    kind: 'mf' | 'equity' | 'etf' | 'bond';
    category: string | null;
  } | null;
}

export interface PortfolioData {
  assets: AssetFacts[];
  /** Valuations per asset, oldest first. */
  valuations: Map<string, ValuationRow[]>;
  /** Transactions per asset, oldest first. */
  transactions: Map<string, TransactionRow[]>;
  /** Prices per instrument, oldest first. */
  prices: Map<string, PriceRow[]>;
}

/**
 * Well beyond any household, and low enough that holding the portfolio in memory stays an
 * honest claim rather than an assumption. The same bound the asset list uses.
 */
const SCAN_LIMIT = 5_000;

/**
 * Every asset the caller may read, with everything needed to value it.
 *
 * Archived and closed assets are included on purpose: the net worth chart is history, and a
 * deposit that matured last March was part of what the household was worth in February.
 * Deciding whether a given asset counts on a given date is
 * {@link import('../services/valuation.service.js').existedOn}'s job, not this query's.
 */
export function loadPortfolio(ctx: AppContext, scope: Scope): PortfolioData {
  const rows = ctx.db
    .select()
    .from(assets)
    .where(inArray(assets.ownerUserId, scope.readableOwnerIds))
    .limit(SCAN_LIMIT)
    .all();

  const ids = rows.map((row) => row.id);
  if (ids.length === 0) {
    return { assets: [], valuations: new Map(), transactions: new Map(), prices: new Map() };
  }

  const depositRows = byAsset(select(ctx, deposits, ids));
  const holdingRows = byAsset(select(ctx, holdings, ids));
  const insuranceRows = byAsset(select(ctx, insurancePolicies, ids));
  const liabilityRows = byAsset(select(ctx, liabilities, ids));
  const retirementRows = byAsset(select(ctx, retirementAccounts, ids));
  const otherRows = byAsset(select(ctx, otherAssets, ids));
  const metalRows = byAsset(select(ctx, preciousMetals, ids));
  const propertyRows = byAsset(select(ctx, properties, ids));
  const bankRows = byAsset(select(ctx, bankAccounts, ids));

  const instrumentIds = [...new Set([...holdingRows.values()].map((row) => row.instrumentId))];
  const instrumentRows = new Map(
    (instrumentIds.length === 0
      ? []
      : ctx.db.select().from(instruments).where(inArray(instruments.id, instrumentIds)).all()
    ).map((row) => [row.id, row]),
  );

  const valuationsByAsset = group(
    ctx.db
      .select()
      .from(valuations)
      .where(inArray(valuations.assetId, ids))
      .orderBy(valuations.asOf, valuations.createdAt)
      .all(),
    (row) => row.assetId,
  );
  const transactionsByAsset = group(
    ctx.db
      .select()
      .from(transactions)
      .where(inArray(transactions.assetId, ids))
      .orderBy(transactions.date, transactions.createdAt)
      .all(),
    (row) => row.assetId,
  );

  const facts: AssetFacts[] = rows.map((asset) => {
    const holding = holdingRows.get(asset.id) ?? null;
    const instrument = holding ? (instrumentRows.get(holding.instrumentId) ?? null) : null;
    const deposit = depositRows.get(asset.id) ?? null;
    const insurance = insuranceRows.get(asset.id) ?? null;
    const metal = metalRows.get(asset.id) ?? null;
    const liability = liabilityRows.get(asset.id) ?? null;

    return {
      asset,
      kind: discriminator(asset, {
        deposit,
        insurance,
        liability: liabilityRows.get(asset.id) ?? null,
        retirement: retirementRows.get(asset.id) ?? null,
        other: otherRows.get(asset.id) ?? null,
        metal,
        property: propertyRows.get(asset.id) ?? null,
        bank: bankRows.get(asset.id) ?? null,
      }),
      maturesOn: deposit?.maturesOn ?? insurance?.maturesOn ?? metal?.sgbMaturesOn ?? null,
      beganOn: earliest([
        asset.openedOn,
        deposit?.startedOn,
        insurance?.startedOn,
        liability?.startedOn,
        valuationsByAsset.get(asset.id)?.[0]?.asOf,
        transactionsByAsset.get(asset.id)?.[0]?.date,
        asset.createdAt.slice(0, 10),
      ]),
      deposit,
      holding,
      insurance,
      liability,
      retirement: retirementRows.get(asset.id) ?? null,
      other: otherRows.get(asset.id) ?? null,
      instrument: instrument
        ? { id: instrument.id, kind: instrument.kind, category: instrument.category }
        : null,
    };
  });

  return {
    assets: facts,
    valuations: valuationsByAsset,
    transactions: transactionsByAsset,
    prices:
      instrumentIds.length === 0
        ? new Map()
        : group(
            ctx.db
              .select()
              .from(instrumentPrices)
              .where(inArray(instrumentPrices.instrumentId, instrumentIds))
              .orderBy(instrumentPrices.date)
              .all(),
            (row) => row.instrumentId,
          ),
  };
}

/* -------------------------------------------------------------------------- */
/* Plumbing                                                                   */
/* -------------------------------------------------------------------------- */

type DetailTable =
  | typeof deposits
  | typeof holdings
  | typeof insurancePolicies
  | typeof liabilities
  | typeof retirementAccounts
  | typeof otherAssets
  | typeof preciousMetals
  | typeof properties
  | typeof bankAccounts;

function select<T extends DetailTable>(
  ctx: AppContext,
  table: T,
  ids: string[],
): Array<T['$inferSelect']> {
  return ctx.db.select().from(table).where(inArray(table.assetId, ids)).all() as Array<
    T['$inferSelect']
  >;
}

/**
 * The earliest date present, ignoring the gaps. The last candidate is always `created_at`,
 * so this never returns nothing.
 */
function earliest(candidates: Array<string | null | undefined>): string {
  let found: string | null = null;
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === '') continue;
    const day = candidate.slice(0, 10);
    if (found === null || day < found) found = day;
  }
  return found ?? '9999-12-31';
}

function byAsset<T extends { assetId: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.assetId, row]));
}

function group<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const existing = out.get(key(row));
    if (existing) existing.push(row);
    else out.set(key(row), [row]);
  }
  return out;
}

/**
 * The sub-type an asset is, whichever column carries it.
 *
 * Classification asks one question — "what kind of thing is this" — and nine tables answer
 * it under different column names. Resolving that here keeps `classifyAsset` a pure
 * function of a small record rather than of the database schema.
 */
function discriminator(
  asset: AssetRow,
  rows: {
    deposit: DepositRow | null;
    insurance: InsuranceRow | null;
    liability: LiabilityRow | null;
    retirement: RetirementRow | null;
    other: OtherAssetRow | null;
    metal: MetalRow | null;
    property: PropertyRow | null;
    bank: BankAccountRow | null;
  },
): string | null {
  switch (asset.type) {
    case 'deposit':
      return rows.deposit?.kind ?? null;
    case 'insurance_policy':
      return rows.insurance?.kind ?? null;
    case 'liability':
      return rows.liability?.kind ?? null;
    case 'retirement_account':
      return rows.retirement?.kind ?? null;
    case 'other_asset':
      return rows.other?.kind ?? null;
    // A metal's liquidity turns on its *form*, not the metal: digital gold sells today and
    // a sovereign gold bond does not.
    case 'precious_metal':
      return rows.metal?.form ?? null;
    case 'property':
      return rows.property?.kind ?? null;
    case 'bank_account':
      return rows.bank?.accountType ?? null;
    case 'holding':
      return null;
  }
}

/** The most recent price on or before a date, or null if the instrument has none yet. */
export function priceAsOf(
  data: PortfolioData,
  instrumentId: string,
  asOf: string,
): PriceRow | null {
  const history = data.prices.get(instrumentId);
  if (!history) return null;

  let found: PriceRow | null = null;
  for (const row of history) {
    if (row.date > asOf) break;
    found = row;
  }
  return found;
}

/**
 * The valuation in force on a date.
 *
 * `valuations` is append-only, so a correction is a later row with the same `as_of` — which
 * is why the scan keeps the *last* match rather than the first, and why the rows arrive
 * ordered by `created_at` within `as_of`.
 */
export function valuationAsOf(
  data: PortfolioData,
  assetId: string,
  asOf: string,
): ValuationRow | null {
  const history = data.valuations.get(assetId);
  if (!history) return null;

  let found: ValuationRow | null = null;
  for (const row of history) {
    if (row.asOf > asOf) break;
    found = row;
  }
  return found;
}

/** The earliest valuation an asset ever had, for a cost basis when nothing else exists. */
export function firstValuation(data: PortfolioData, assetId: string): ValuationRow | null {
  return data.valuations.get(assetId)?.[0] ?? null;
}
