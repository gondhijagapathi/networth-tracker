/**
 * Analytics contracts and classification.
 *
 * The dashboard asks four questions — what am I worth, where is it, how is it doing, and
 * what would hurt if it went wrong — and the answers are shaped here so the API and the
 * browser cannot disagree about them.
 *
 * Classification lives here too, rather than in the API, because it is a judgement rather
 * than a lookup: an EPF balance is debt, an ELSS fund is equity, a sovereign gold bond is
 * gold and a term policy is worth nothing at all. Those calls belong somewhere a test can
 * read them and a person can argue with them.
 */

import { z } from 'zod';
import { isoDateSchema, type AssetType } from './assets.js';
import type { Paise } from './money.js';

/* -------------------------------------------------------------------------- */
/* Classification                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What a thing *behaves* like, which is not what table it lives in.
 *
 * Coarser than the asset types on purpose: nine types answer "what did I buy", and an
 * allocation chart answers "what happens to me if the market moves", where an ELSS fund and
 * an ESOP grant are the same answer.
 */
export const ASSET_CLASSES = [
  'cash',
  'debt',
  'equity',
  'hybrid',
  'gold',
  'real_estate',
  'crypto',
  'insurance',
  'other',
] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  cash: 'Cash & bank',
  debt: 'Debt & deposits',
  equity: 'Equity',
  hybrid: 'Hybrid',
  gold: 'Gold & metals',
  real_estate: 'Property',
  crypto: 'Crypto',
  insurance: 'Insurance',
  other: 'Other',
};

/**
 * How fast it turns into money in a bank account.
 *
 * The emergency-fund calculation is the whole reason this exists: a household with two
 * crore in EPF and property and ₹8,000 in a savings account is not liquid, and a net worth
 * figure alone will never say so.
 */
export const LIQUIDITY_BUCKETS = ['instant', 'days', 'months', 'locked'] as const;
export type LiquidityBucket = (typeof LIQUIDITY_BUCKETS)[number];

export const LIQUIDITY_LABELS: Record<LiquidityBucket, string> = {
  instant: 'Today',
  days: 'A few days',
  months: 'Within a year',
  locked: 'Locked in',
};

/** The little that classification needs to know about an asset. */
export interface ClassifiableAsset {
  type: AssetType;
  /** The detail row's discriminator: deposit `kind`, insurance `kind`, metal `form`, … */
  kind?: string | null;
  /** For a holding: the instrument's `kind` and free-text category. */
  instrumentKind?: 'mf' | 'equity' | 'etf' | 'bond' | null;
  instrumentCategory?: string | null;
  maturesOn?: string | null;
}

/** SEBI category names that mean "this fund holds bonds", however they are spelled. */
const DEBT_FUND_PATTERN =
  /\b(debt|liquid|gilt|overnight|money market|ultra short|low duration|short duration|medium duration|long duration|dynamic bond|corporate bond|credit risk|banking and psu|floater|income|fmp)\b/i;
const GOLD_FUND_PATTERN = /\b(gold|silver|precious)\b/i;
const HYBRID_FUND_PATTERN =
  /\b(hybrid|balanced|asset allocation|arbitrage|multi asset|equity savings)\b/i;

export function classifyAsset(asset: ClassifiableAsset): AssetClass {
  switch (asset.type) {
    case 'bank_account':
      return 'cash';

    // Every small-savings scheme is a bond you cannot trade: a fixed rate, a fixed term and
    // an issuer that does not default.
    case 'deposit':
      return 'debt';

    case 'holding':
      return classifyInstrument(asset.instrumentKind, asset.instrumentCategory);

    // An endowment or money-back policy is a savings product wearing a policy document. A
    // ULIP is a fund with a rider. A term or health policy has no investment value at all
    // and is here for the claim kit, not the allocation chart.
    case 'insurance_policy':
      if (asset.kind === 'endowment' || asset.kind === 'money_back') return 'debt';
      if (asset.kind === 'ulip') return 'hybrid';
      return 'insurance';

    case 'property':
      return 'real_estate';

    // EPF and VPF are a government-set fixed rate. NPS is a scheme mix that is usually part
    // equity, which makes it hybrid however conservatively it is allocated.
    case 'retirement_account':
      return asset.kind === 'nps' ? 'hybrid' : 'debt';

    case 'precious_metal':
      return 'gold';

    case 'other_asset':
      if (asset.kind === 'crypto') return 'crypto';
      if (asset.kind === 'esop' || asset.kind === 'rsu') return 'equity';
      // A chit fund and money lent to a cousin are both somebody else holding your money
      // and promising a return. That is debt, whatever the paperwork looks like.
      if (asset.kind === 'chit' || asset.kind === 'loan_given') return 'debt';
      return 'other';

    case 'liability':
      return 'other';
  }
}

function classifyInstrument(
  kind: ClassifiableAsset['instrumentKind'],
  category: string | null | undefined,
): AssetClass {
  if (kind === 'bond') return 'debt';

  const text = category ?? '';
  if (GOLD_FUND_PATTERN.test(text)) return 'gold';
  if (DEBT_FUND_PATTERN.test(text)) return 'debt';
  if (HYBRID_FUND_PATTERN.test(text)) return 'hybrid';

  // An uncategorised fund is assumed to be equity. It is the common case, and the error is
  // in the safe direction: over-reporting equity exposure prompts a look, under-reporting
  // it hides a risk.
  return 'equity';
}

/**
 * How quickly this could be turned into cash, as of a date.
 *
 * A deposit maturing next month is not locked in the way a fifteen-year PPF account is,
 * so the answer depends on the date the question is asked — which is why `asOf` is a
 * parameter rather than "now".
 */
export function liquidityOf(asset: ClassifiableAsset, asOf: string): LiquidityBucket {
  switch (asset.type) {
    case 'bank_account':
      return 'instant';

    case 'deposit': {
      // Locked by statute, not by term: no maturity date makes a PPF account liquid.
      if (asset.kind === 'ppf' || asset.kind === 'ssy') return 'locked';
      // An FD can be broken today for a penalty, so the question is really "without losing
      // money", and the honest answer is its maturity.
      if (!asset.maturesOn) return 'months';
      return withinAYear(asset.maturesOn, asOf) ? 'months' : 'locked';
    }

    case 'holding':
      // Settlement is T+1 for equity and T+2 or T+3 for a redeemed fund.
      return 'days';

    case 'precious_metal':
      // Digital gold sells instantly; a bond and a bangle do not.
      return asset.kind === 'digital' ? 'instant' : asset.kind === 'sgb' ? 'locked' : 'days';

    case 'other_asset':
      if (asset.kind === 'crypto') return 'instant';
      if (asset.kind === 'vehicle' || asset.kind === 'chit') return 'months';
      return 'locked';

    // Property takes months at best. Retirement money is locked until you retire, and a
    // policy surrendered early pays a fraction of what it is worth.
    case 'property':
    case 'retirement_account':
    case 'insurance_policy':
    case 'liability':
      return 'locked';
  }
}

function withinAYear(date: string, asOf: string): boolean {
  const limit = new Date(`${asOf.slice(0, 10)}T00:00:00Z`);
  limit.setUTCFullYear(limit.getUTCFullYear() + 1);
  return date <= limit.toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/* Response shapes                                                            */
/* -------------------------------------------------------------------------- */

/** Where a valued number came from, so the UI can say so instead of implying certainty. */
export type ValuationBasis = 'manual' | 'market' | 'accrued' | 'balance' | 'outstanding' | 'none';

export interface ValuedAsset {
  assetId: string;
  name: string;
  type: AssetType;
  assetClass: AssetClass;
  liquidity: LiquidityBucket;
  institution: string | null;
  /** This owner's share of the asset, which is what net worth counts. */
  valuePaise: Paise;
  /** The whole asset, before `ownershipBps` is applied. */
  grossValuePaise: Paise;
  ownershipBps: number;
  basis: ValuationBasis;
  /** The date the value is true for. A stale price is only visible if this is shown. */
  asOf: string | null;
  nomineeRegistered: boolean;
  shared: boolean;
}

/** One day on the net worth chart. */
export interface NetWorthPoint {
  date: string;
  assetsPaise: Paise;
  liabilitiesPaise: Paise;
  netPaise: Paise;
}

export interface AllocationSlice {
  key: string;
  label: string;
  valuePaise: Paise;
  /** Fraction of the total, 0–1. Rendering decides how many decimals to believe. */
  share: number;
  count: number;
}

export const ALLOCATION_DIMENSIONS = ['class', 'institution', 'liquidity', 'type'] as const;
export type AllocationDimension = (typeof ALLOCATION_DIMENSIONS)[number];

export interface AllocationResponse {
  by: AllocationDimension;
  totalPaise: Paise;
  slices: AllocationSlice[];
}

/** A change between two dates, with the earlier figure kept so the UI need not guess. */
export interface Delta {
  fromDate: string;
  fromPaise: Paise;
  changePaise: Paise;
  /** Fractional change, or null when the earlier figure was zero and there is no ratio. */
  changeRatio: number | null;
}

export interface NetWorthSummary {
  asOf: string;
  assetsPaise: Paise;
  liabilitiesPaise: Paise;
  netPaise: Paise;
  assetCount: number;
  liabilityCount: number;
  /** Assets nobody has valued yet — the number that makes the total honest. */
  unvaluedCount: number;
  month: Delta | null;
  year: Delta | null;
}

export interface RiskIndicators {
  /** Largest single asset as a fraction of gross assets. */
  topAssetShare: number;
  topAssetName: string | null;
  /** Largest institution exposure — one bank failing is one row in an allocation chart. */
  topInstitutionShare: number;
  topInstitutionName: string | null;
  liquidPaise: Paise;
  /** EMIs, premiums and SIPs due every month, normalised. */
  monthlyCommitmentPaise: Paise;
  /** How many months of committed outflow the liquid money covers. Null when nothing is due. */
  emergencyFundMonths: number | null;
  /** Value sitting in assets with no registered nominee. */
  unnominatedPaise: Paise;
  unnominatedCount: number;
}

export interface DashboardResponse {
  summary: NetWorthSummary;
  allocation: AllocationResponse;
  risk: RiskIndicators;
  series: NetWorthPoint[];
}

export interface PerformanceEntry {
  assetId: string;
  name: string;
  type: AssetType;
  assetClass: AssetClass;
  /** What went in, net of what came back out. */
  investedPaise: Paise;
  valuePaise: Paise;
  gainPaise: Paise;
  /** Annualised, as a decimal. Null when the cashflows cannot produce one. */
  xirr: number | null;
  cagr: number | null;
}

/**
 * A class's return, computed from every cashflow in it rather than from its members'
 * rates.
 *
 * There is no CAGR here, and none on the portfolio either. CAGR describes one sum in and
 * one value out; a class is a dozen assets bought on a dozen dates, so the only honest
 * annualised figure is XIRR over the pooled flows. Averaging the members' CAGRs — or worse,
 * weighting them — would produce a number that looks like a return and is not one.
 */
export interface ClassPerformance {
  assetClass: AssetClass;
  /** How many assets of this class contributed, so a rate from one holding reads as one. */
  assetCount: number;
  investedPaise: Paise;
  valuePaise: Paise;
  gainPaise: Paise;
  xirr: number | null;
}

export interface PerformanceResponse {
  portfolio: {
    investedPaise: Paise;
    valuePaise: Paise;
    gainPaise: Paise;
    xirr: number | null;
  };
  classes: ClassPerformance[];
  assets: PerformanceEntry[];
}

/* -------------------------------------------------------------------------- */
/* Query contracts                                                            */
/* -------------------------------------------------------------------------- */

/**
 * How finely the net worth chart is sampled.
 *
 * Monthly by default. A daily series over five years is eighteen hundred points, which is
 * more than a phone screen has pixels and more than the underlying data justifies: outside
 * of holdings, most assets are valued once a month at best.
 */
export const SERIES_INTERVALS = ['day', 'week', 'month'] as const;
export type SeriesInterval = (typeof SERIES_INTERVALS)[number];

/**
 * The window is expressed in months back from `to` rather than as a mandatory `from`, so
 * the common request — "the last year" — does not require the client to do date arithmetic
 * the server is about to redo anyway.
 */
export const netWorthQuerySchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  months: z.coerce.number().int().min(1).max(240).default(24),
  interval: z.enum(SERIES_INTERVALS).default('month'),
});
export type NetWorthQuery = z.infer<typeof netWorthQuerySchema>;

export const allocationQuerySchema = z.object({
  by: z.enum(ALLOCATION_DIMENSIONS).default('class'),
  asOf: isoDateSchema.optional(),
});
export type AllocationQuery = z.infer<typeof allocationQuerySchema>;

export const dashboardQuerySchema = z.object({
  asOf: isoDateSchema.optional(),
  by: z.enum(ALLOCATION_DIMENSIONS).default('class'),
  months: z.coerce.number().int().min(1).max(240).default(12),
  interval: z.enum(SERIES_INTERVALS).default('month'),
});
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

export const performanceQuerySchema = z.object({
  asOf: isoDateSchema.optional(),
});
export type PerformanceQuery = z.infer<typeof performanceQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Group valued assets into allocation slices, largest first.
 *
 * Liabilities are excluded by the caller, not here: an allocation chart answers "where is
 * my money", and a home loan is not somewhere money is.
 */
export function allocate(
  assets: readonly ValuedAsset[],
  by: AllocationDimension,
): AllocationResponse {
  const buckets = new Map<string, AllocationSlice>();
  let totalPaise = 0;

  for (const asset of assets) {
    const [key, label] = allocationKey(asset, by);
    const slice = buckets.get(key) ?? { key, label, valuePaise: 0, share: 0, count: 0 };
    slice.valuePaise += asset.valuePaise;
    slice.count += 1;
    buckets.set(key, slice);
    totalPaise += asset.valuePaise;
  }

  const slices = [...buckets.values()].sort((a, b) => b.valuePaise - a.valuePaise);
  for (const slice of slices) {
    slice.share = totalPaise === 0 ? 0 : slice.valuePaise / totalPaise;
  }
  return { by, totalPaise, slices };
}

function allocationKey(asset: ValuedAsset, by: AllocationDimension): [string, string] {
  switch (by) {
    case 'class':
      return [asset.assetClass, ASSET_CLASS_LABELS[asset.assetClass]];
    case 'liquidity':
      return [asset.liquidity, LIQUIDITY_LABELS[asset.liquidity]];
    case 'institution':
      // Assets with no institution are pooled rather than dropped: gold in a locker and a
      // plot of land are still exposure, they are just not exposure to anybody.
      return asset.institution
        ? [asset.institution.toLowerCase(), asset.institution]
        : ['__none__', 'Not held at an institution'];
    case 'type':
      return [asset.type, asset.type];
  }
}

/** The change between an earlier figure and the current one. */
export function delta(fromDate: string, fromPaise: Paise, toPaise: Paise): Delta {
  return {
    fromDate,
    fromPaise,
    changePaise: toPaise - fromPaise,
    changeRatio: fromPaise === 0 ? null : (toPaise - fromPaise) / Math.abs(fromPaise),
  };
}
