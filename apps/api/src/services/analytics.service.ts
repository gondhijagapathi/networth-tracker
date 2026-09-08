/**
 * The dashboard.
 *
 * Four questions, in the order a person actually asks them: what am I worth, where is it,
 * how is it doing, and what would hurt if it went wrong. Everything here is assembled from
 * one {@link loadPortfolio} call and the valuation service, so the number on the summary
 * card, the number in the allocation chart and the last point on the net worth line are
 * the same number computed once.
 *
 * Two decisions run through the file and are worth stating plainly:
 *
 *   - **Every figure is scoped and ownership-adjusted.** The portfolio is whatever
 *     `readableOwnerIds` resolves to, and a joint asset contributes `ownershipBps` of
 *     itself, so two people who can each see a flat do not report two flats between them.
 *     Attribution — whose share is whose on a merged household view — is P6's problem.
 *   - **History is recomputed, not replayed.** A point on the net worth chart is every
 *     asset valued *as of that date*, not the sum of whatever valuations happened to be
 *     written that week. That is what makes a fixed deposit curve upward from a single
 *     opening entry instead of sitting flat until somebody remembers to update it.
 */

import {
  ALLOCATION_DIMENSIONS,
  addMonths,
  allocate,
  cagr,
  classifyAsset,
  daysBetween,
  delta,
  isLiabilityType,
  scheduleContributions,
  xirr,
  type AllocationQuery,
  type AllocationResponse,
  type AssetClass,
  type CashFlow,
  type ClassPerformance,
  type DashboardQuery,
  type DashboardResponse,
  type NetWorthPoint,
  type NetWorthQuery,
  type NetWorthSummary,
  type PerformanceEntry,
  type PerformanceResponse,
  type RiskIndicators,
  type SeriesInterval,
  type TransactionType,
  type ValuedAsset,
} from '@networth/shared';
import type { AppContext } from '../context.js';
import { notFound } from '../lib/errors.js';
import { isoNow } from '../lib/time.js';
import {
  firstValuation,
  loadPortfolio,
  type AssetFacts,
  type PortfolioData,
} from '../repos/analytics.repo.js';
import { assertCanSeeDetail, type Scope } from '../repos/scope.js';
import { existedOn, valueAsset, valuePortfolio } from './valuation.service.js';

/** Enough points for five years of weekly samples, and a hard stop on a silly request. */
const MAX_SERIES_POINTS = 400;

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                  */
/* -------------------------------------------------------------------------- */

export function dashboard(ctx: AppContext, scope: Scope, query: DashboardQuery): DashboardResponse {
  const data = loadPortfolio(ctx, scope);
  const asOf = query.asOf ?? today(ctx);
  const valued = valuePortfolio(data, scope, asOf);

  return {
    summary: summarise(data, scope, valued, asOf),
    allocation: allocate(investable(valued), query.by),
    risk: riskIndicators(data, valued, asOf),
    series: series(data, scope, {
      to: asOf,
      from: addMonths(asOf, -query.months),
      interval: query.interval,
    }),
  };
}

export function allocation(
  ctx: AppContext,
  scope: Scope,
  query: AllocationQuery,
): AllocationResponse {
  const data = loadPortfolio(ctx, scope);
  const asOf = query.asOf ?? today(ctx);
  return allocate(investable(valuePortfolio(data, scope, asOf)), query.by);
}

/** Every dimension at once, for a dashboard that lets the reader flip between them. */
export function allocationBreakdown(
  ctx: AppContext,
  scope: Scope,
  asOf: string | undefined,
): Record<string, AllocationResponse> {
  const data = loadPortfolio(ctx, scope);
  const valued = investable(valuePortfolio(data, scope, asOf ?? today(ctx)));
  return Object.fromEntries(ALLOCATION_DIMENSIONS.map((by) => [by, allocate(valued, by)]));
}

export function netWorth(ctx: AppContext, scope: Scope, query: NetWorthQuery): NetWorthPoint[] {
  const data = loadPortfolio(ctx, scope);
  const to = query.to ?? today(ctx);
  return series(data, scope, {
    to,
    from: query.from ?? addMonths(to, -query.months),
    interval: query.interval,
  });
}

/**
 * An allocation chart answers "where is my money", and a home loan is not somewhere money
 * is. Insurance with no surrender value is dropped for the same reason: it would render as
 * a zero-width slice with a legend entry, which is noise.
 */
function investable(valued: ValuedAsset[]): ValuedAsset[] {
  return valued.filter((asset) => !isLiabilityType(asset.type) && asset.valuePaise !== 0);
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                    */
/* -------------------------------------------------------------------------- */

function summarise(
  data: PortfolioData,
  scope: Scope,
  valued: ValuedAsset[],
  asOf: string,
): NetWorthSummary {
  const totals = totalsOf(valued);

  const monthAgo = addMonths(asOf, -1);
  const yearAgo = addMonths(asOf, -12);

  return {
    asOf,
    assetsPaise: totals.assetsPaise,
    liabilitiesPaise: totals.liabilitiesPaise,
    netPaise: totals.netPaise,
    assetCount: valued.filter((asset) => !isLiabilityType(asset.type)).length,
    liabilityCount: valued.filter((asset) => isLiabilityType(asset.type)).length,
    // The number that keeps the total honest: a household with an unvalued flat is not
    // worth what this page says, and it should say so rather than quietly counting zero.
    unvaluedCount: valued.filter((asset) => asset.basis === 'none' && !isLiabilityType(asset.type))
      .length,
    month: deltaAt(data, scope, monthAgo, totals.netPaise),
    year: deltaAt(data, scope, yearAgo, totals.netPaise),
  };
}

function totalsOf(valued: ValuedAsset[]): {
  assetsPaise: number;
  liabilitiesPaise: number;
  netPaise: number;
} {
  let assetsPaise = 0;
  let liabilitiesPaise = 0;
  for (const asset of valued) {
    if (isLiabilityType(asset.type)) liabilitiesPaise += asset.valuePaise;
    else assetsPaise += asset.valuePaise;
  }
  return { assetsPaise, liabilitiesPaise, netPaise: assetsPaise - liabilitiesPaise };
}

/**
 * Movement since a date, or null when there is nothing to compare against.
 *
 * A household that opened its account last week has no month-on-month change, and showing
 * "+100%" because the earlier figure was zero would be a number pretending to be a fact.
 */
function deltaAt(data: PortfolioData, scope: Scope, from: string, netPaise: number) {
  const existed = data.assets.some((facts) => existedOn(facts, from));
  if (!existed) return null;
  return delta(from, totalsOf(valuePortfolio(data, scope, from)).netPaise, netPaise);
}

/* -------------------------------------------------------------------------- */
/* Net worth over time                                                        */
/* -------------------------------------------------------------------------- */

function series(
  data: PortfolioData,
  scope: Scope,
  window: { from: string; to: string; interval: SeriesInterval },
): NetWorthPoint[] {
  return sampleDates(window.from, window.to, window.interval).map((date) => {
    const totals = totalsOf(valuePortfolio(data, scope, date));
    return {
      date,
      assetsPaise: totals.assetsPaise,
      liabilitiesPaise: totals.liabilitiesPaise,
      netPaise: totals.netPaise,
    };
  });
}

/**
 * The dates to sample, oldest first, always ending on `to`.
 *
 * Monthly points land on month ends because that is when statements arrive and balances
 * are reconciled; the final point is the requested date itself, so the chart's last value
 * is the same number as the summary card above it.
 */
function sampleDates(from: string, to: string, interval: SeriesInterval): string[] {
  if (from > to) return [to];

  const dates: string[] = [];
  if (interval === 'month') {
    let cursor = endOfMonth(from);
    while (cursor < to && dates.length < MAX_SERIES_POINTS) {
      if (cursor >= from) dates.push(cursor);
      cursor = endOfMonth(addMonths(cursor, 1));
    }
  } else {
    const step = interval === 'week' ? 7 : 1;
    const span = daysBetween(from, to);
    // A daily series over five years is more points than a phone has pixels, and more
    // resolution than assets valued once a month can honestly carry.
    const stride = Math.max(step, Math.ceil(span / MAX_SERIES_POINTS));
    for (let day = 0; day < span; day += stride) {
      dates.push(addDays(from, day));
    }
  }

  dates.push(to);
  return dates;
}

function endOfMonth(iso: string): string {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const ms = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/* Risk                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The four things that go wrong with a portfolio nobody is looking at: too much in one
 * asset, too much at one institution, not enough that can be reached this week, and money
 * sitting in accounts with no nominee on them.
 */
function riskIndicators(data: PortfolioData, valued: ValuedAsset[], asOf: string): RiskIndicators {
  const assetsOnly = valued.filter((asset) => !isLiabilityType(asset.type));
  const grossPaise = assetsOnly.reduce((sum, asset) => sum + asset.valuePaise, 0);

  const largest = assetsOnly.reduce<ValuedAsset | null>(
    (top, asset) => (top === null || asset.valuePaise > top.valuePaise ? asset : top),
    null,
  );

  // Institution-less assets are pooled under one key by `allocate`, and "gold in a locker"
  // is not a bank that can fail, so it is excluded from the concentration figure.
  const institutions = allocate(assetsOnly, 'institution').slices.filter(
    (slice) => slice.key !== '__none__',
  );
  const topInstitution = institutions[0] ?? null;

  const liquidPaise = assetsOnly
    .filter((asset) => asset.liquidity === 'instant' || asset.liquidity === 'days')
    .reduce((sum, asset) => sum + asset.valuePaise, 0);

  const monthlyCommitmentPaise = monthlyCommitments(data, asOf);

  const unnominated = assetsOnly.filter((asset) => !asset.nomineeRegistered);

  return {
    topAssetShare: grossPaise === 0 || largest === null ? 0 : largest.valuePaise / grossPaise,
    topAssetName: largest?.name ?? null,
    topInstitutionShare: topInstitution?.share ?? 0,
    topInstitutionName: topInstitution?.label ?? null,
    liquidPaise,
    monthlyCommitmentPaise,
    // Months of *committed outflow*, not of household expenses — this application does not
    // know what a household spends, and inventing a figure would make the one indicator
    // people act on the least trustworthy thing on the page.
    emergencyFundMonths: monthlyCommitmentPaise === 0 ? null : liquidPaise / monthlyCommitmentPaise,
    unnominatedPaise: unnominated.reduce((sum, asset) => sum + asset.valuePaise, 0),
    unnominatedCount: unnominated.length,
  };
}

/** Premium frequencies, as a number of payments a year. `single` is not a commitment. */
const PREMIUMS_PER_YEAR: Record<string, number> = {
  monthly: 12,
  quarterly: 4,
  half_yearly: 2,
  yearly: 1,
  single: 0,
};

/**
 * Everything that leaves the household's account every month: EMIs, insurance premiums
 * spread over the year, SIP instalments and recurring deposit contributions.
 */
function monthlyCommitments(data: PortfolioData, asOf: string): number {
  let total = 0;

  for (const facts of data.assets) {
    if (!existedOn(facts, asOf)) continue;

    if (facts.liability) total += facts.liability.emiPaise;

    if (facts.insurance) {
      const perYear = PREMIUMS_PER_YEAR[facts.insurance.premiumFrequency] ?? 0;
      total += Math.round((facts.insurance.premiumPaise * perYear) / 12);
    }

    if (facts.holding?.sipAmountPaise) total += facts.holding.sipAmountPaise;

    if (facts.deposit && facts.deposit.installmentPaise > 0) {
      const stillContributing = facts.deposit.maturesOn === null || facts.deposit.maturesOn > asOf;
      if (stillContributing) {
        // An RD debits monthly; PPF and SSY take a yearly deposit, which is the same
        // commitment spread differently.
        total +=
          facts.deposit.kind === 'rd'
            ? facts.deposit.installmentPaise
            : Math.round(facts.deposit.installmentPaise / 12);
      }
    }
  }

  return total;
}

/* -------------------------------------------------------------------------- */
/* Performance                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Which way money moved, by transaction type.
 *
 * The *type* carries the direction and the amount is stored unsigned, so this is read
 * rather than inferred from a sign that a client may or may not have set. Negative is
 * money leaving your pocket, which is the convention `xirr` expects.
 */
const FLOW_DIRECTION: Record<TransactionType, -1 | 1> = {
  buy: -1,
  sip: -1,
  deposit: -1,
  premium: -1,
  emi: -1,
  sell: 1,
  dividend: 1,
  interest: 1,
  withdrawal: 1,
};

export function performance(ctx: AppContext, scope: Scope, asOf?: string): PerformanceResponse {
  const data = loadPortfolio(ctx, scope);
  const on = asOf ?? today(ctx);

  const entries: PerformanceEntry[] = [];
  const portfolioFlows: CashFlow[] = [];
  // Flows pooled per class, so a class rate is computed from the money rather than
  // averaged out of its members' rates.
  const classFlows = new Map<AssetClass, CashFlow[]>();
  const classTotals = new Map<AssetClass, { count: number; invested: number; value: number }>();
  let investedPaise = 0;
  let valuePaise = 0;

  for (const facts of data.assets) {
    if (!existedOn(facts, on)) continue;
    // A loan's XIRR is its interest rate, which is a true number and a confusing one on a
    // page headed "how are my investments doing".
    if (isLiabilityType(facts.asset.type)) continue;

    const entry = entryFor(facts, data, scope, on);
    if (entry === null) continue;

    entries.push(entry.entry);
    portfolioFlows.push(...entry.flows);
    investedPaise += entry.entry.investedPaise;
    valuePaise += entry.entry.valuePaise;

    const cls = entry.entry.assetClass;
    const pooled = classFlows.get(cls) ?? [];
    pooled.push(...entry.flows);
    classFlows.set(cls, pooled);

    const totals = classTotals.get(cls) ?? { count: 0, invested: 0, value: 0 };
    totals.count += 1;
    totals.invested += entry.entry.investedPaise;
    totals.value += entry.entry.valuePaise;
    classTotals.set(cls, totals);
  }

  entries.sort((a, b) => b.valuePaise - a.valuePaise);

  const classes: ClassPerformance[] = [...classTotals.entries()]
    .map(([assetClass, totals]) => ({
      assetClass,
      assetCount: totals.count,
      investedPaise: totals.invested,
      valuePaise: totals.value,
      gainPaise: totals.value - totals.invested,
      xirr: xirr([...(classFlows.get(assetClass) ?? []), { date: on, amount: totals.value }]),
    }))
    .sort((a, b) => b.valuePaise - a.valuePaise);

  return {
    portfolio: {
      investedPaise,
      valuePaise,
      gainPaise: valuePaise - investedPaise,
      xirr: xirr([...portfolioFlows, { date: on, amount: valuePaise }]),
    },
    classes,
    assets: entries,
  };
}

/** Per-asset performance, for the asset detail page. Scoped exactly like a read of it. */
export function assetPerformance(
  ctx: AppContext,
  scope: Scope,
  assetId: string,
  asOf?: string,
): PerformanceEntry {
  const data = loadPortfolio(ctx, scope);
  const facts = data.assets.find((entry) => entry.asset.id === assetId);
  // Consistent with the rest of the API: a row outside the caller's scope does not exist.
  if (!facts) throw notFound('No such asset');
  assertCanSeeDetail(scope, facts.asset.ownerUserId);

  const on = asOf ?? today(ctx);
  const computed = entryFor(facts, data, scope, on);
  if (computed !== null) return computed.entry;

  // An asset with neither flows nor a value still deserves a row rather than a 404: it is
  // owned, and "nothing is known about it yet" is the answer.
  const valued = valueAsset(facts, data, scope, on);
  return {
    assetId,
    name: valued.name,
    type: valued.type,
    assetClass: valued.assetClass,
    investedPaise: 0,
    valuePaise: valued.grossValuePaise,
    gainPaise: 0,
    xirr: null,
    cagr: null,
  };
}

/**
 * One asset's return.
 *
 * Gross throughout — full cashflows against the full value, not the owner's share of
 * either. Mixing an ownership-adjusted value with unadjusted transactions would produce a
 * rate of return that is simply wrong, and the split belongs on the net worth figure
 * rather than on the question "did this fund do well".
 */
function entryFor(
  facts: AssetFacts,
  data: PortfolioData,
  scope: Scope,
  asOf: string,
): { entry: PerformanceEntry; flows: CashFlow[] } | null {
  const valued = valueAsset(facts, data, scope, asOf);
  const flows = cashflows(facts, data, asOf);

  if (flows.length === 0 && valued.grossValuePaise === 0) return null;

  const investedPaise = -flows.reduce((sum, flow) => sum + flow.amount, 0);
  const valuePaise = valued.grossValuePaise;
  const withTerminal: CashFlow[] = [...flows, { date: asOf, amount: valuePaise }];
  const firstFlow = flows[0];

  return {
    flows,
    entry: {
      assetId: facts.asset.id,
      name: facts.asset.name,
      type: facts.asset.type,
      assetClass: classifyAsset({
        type: facts.asset.type,
        kind: facts.kind,
        instrumentKind: facts.instrument?.kind ?? null,
        instrumentCategory: facts.instrument?.category ?? null,
        maturesOn: facts.maturesOn,
      }),
      investedPaise,
      valuePaise,
      gainPaise: valuePaise - investedPaise,
      xirr: xirr(withTerminal),
      // CAGR assumes one lump sum in and one value out, so it is only reported when that
      // is what happened. For anything with instalments, XIRR is the honest figure.
      cagr:
        flows.length === 1 && firstFlow !== undefined
          ? cagr(-firstFlow.amount, valuePaise, firstFlow.date, asOf)
          : null,
    },
  };
}

/**
 * The money that went in and came back out, oldest first.
 *
 * Recorded transactions when there are any. Failing that, the deposit's own schedule — an
 * FD nobody has recorded a transaction against still had a principal paid in on the day it
 * was opened — and failing that, the first valuation, which is the earliest evidence the
 * asset existed and was worth something.
 *
 * Exported for the tax report in P9, which needs the same two numbers this produces — what
 * was put in, and when the first rupee of it went in. Deriving those a second time would be
 * two implementations of "what did this cost", free to disagree about an asset's cost basis
 * between the returns page and the capital-gains estimate.
 */
export function cashflows(facts: AssetFacts, data: PortfolioData, asOf: string): CashFlow[] {
  const recorded = (data.transactions.get(facts.asset.id) ?? [])
    .filter((row) => row.date <= asOf)
    .map((row) => ({
      date: row.date,
      // Charges are money out of pocket on the way in, and out of the proceeds on the way
      // back: either way they reduce the return, which is the point of counting them.
      amount:
        FLOW_DIRECTION[row.type] * Math.abs(row.amountPaise) -
        (row.chargesPaise > 0 ? row.chargesPaise : 0),
    }));
  if (recorded.length > 0) return recorded;

  if (facts.deposit) {
    // The same schedule the accrual engine values against, so the return is computed from
    // the payments the value assumes were made. A recurring deposit with no transactions
    // recorded has still had sixty instalments paid into it.
    const row = facts.deposit;
    return scheduleContributions(
      {
        kind: row.kind,
        principalPaise: row.principalPaise,
        installmentPaise: row.installmentPaise,
        rateBps: row.rateBps,
        compounding: row.compounding,
        payoutMode: row.payoutMode,
        startedOn: row.startedOn,
        maturesOn: row.maturesOn,
        autoRenew: row.autoRenew,
      },
      asOf,
    ).map((contribution) => ({ date: contribution.date, amount: -contribution.amountPaise }));
  }

  const first = firstValuation(data, facts.asset.id);
  if (first && first.asOf <= asOf && first.valuePaise !== 0) {
    return [{ date: first.asOf, amount: -first.valuePaise }];
  }
  return [];
}

function today(ctx: AppContext): string {
  return isoNow(ctx.now()).slice(0, 10);
}
