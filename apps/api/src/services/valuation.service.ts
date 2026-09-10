/**
 * What an asset is worth, on a date.
 *
 * One function, nine answers, and the whole dashboard downstream of it. The rules it
 * encodes are the difference between a tracker that reports what you typed in and one that
 * reports what you have:
 *
 *   - **A deposit is accrued, not remembered.** Nobody types in what an FD is worth today,
 *     so the accrual engine computes it from the terms. See `@networth/shared/accrual`.
 *   - **A holding is priced.** Units times the most recent NAV or quote on or before the
 *     date, falling back to average cost when no price has ever been imported.
 *   - **A balance is a balance.** EPF and a loan carry their own figure in their detail row.
 *   - **Everything else is what a human last said it was.** Property, gold and a chit fund
 *     have no computable value, and inventing one would be worse than admitting it.
 *
 * ### Newest wins, ties go to the human
 *
 * Where both a computed value and a manual valuation exist, the more recent of the two is
 * used, and an equal date goes to the person. A NAV from Friday should not override a
 * balance the owner reconciled against a statement on Friday, and a manual figure from
 * March should not freeze a deposit that has been earning ever since.
 *
 * Deposits are the exception that proves the rule: rather than discarding a manual
 * valuation, the accrual engine is *anchored* on it — the statement is treated as the
 * balance on its date and the model carries it forward. A reconciled figure is better
 * information than the terms, and it is still better a month later than a stale snapshot.
 */

import {
  accrueDeposit,
  classifyAsset,
  liquidityOf,
  scalePaise,
  scheduleContributions,
  valueOf,
  type DepositContribution,
  type DepositTerms,
  type ValuationBasis,
  type ValuedAsset,
} from '@networth/shared';
import type { AssetRow } from '../db/schema.js';
import {
  priceAsOf,
  valuationAsOf,
  type AssetFacts,
  type PortfolioData,
} from '../repos/analytics.repo.js';
import { owns, type Scope } from '../repos/scope.js';

/** A candidate value, with where it came from and the date it is true for. */
interface Candidate {
  valuePaise: number;
  basis: ValuationBasis;
  /** Null when the figure has no date of its own — an average cost, or nothing at all. */
  asOf: string | null;
}

const NOTHING: Candidate = { valuePaise: 0, basis: 'none', asOf: null };

/**
 * Whether an asset counts on a date.
 *
 * Two separate questions, both answered here so the dashboard and the chart cannot drift
 * apart. It did not exist before it began — which is `beganOn`, the earliest date the data
 * supports, and deliberately not `created_at`: a household that enters fifteen years of PPF
 * this morning should see fifteen years of PPF on the chart, not a flat line and a cliff.
 * And it stopped counting when it was closed; for a row archived without a closing date,
 * the archival itself is the best evidence of when it stopped being real.
 *
 * Both bounds are inclusive. An FD closed on 31 March was something the household owned on
 * 31 March — the money arrived that day — so the closing date is the last date it counts,
 * not the first date it does not. Treating one end as inclusive and the other as exclusive
 * dropped a closed asset out of the chart's own closing-day point.
 */
export function existedOn(facts: { asset: AssetRow; beganOn: string }, asOf: string): boolean {
  if (facts.beganOn > asOf) return false;
  if (facts.asset.status === 'active') return true;
  return (facts.asset.closedOn ?? facts.asset.updatedAt.slice(0, 10)) >= asOf;
}

/** Value every asset the caller can see, as of a date. */
export function valuePortfolio(data: PortfolioData, scope: Scope, asOf: string): ValuedAsset[] {
  return data.assets
    .filter((facts) => existedOn(facts, asOf))
    .map((facts) => valueAsset(facts, data, scope, asOf));
}

export function valueAsset(
  facts: AssetFacts,
  data: PortfolioData,
  scope: Scope,
  asOf: string,
): ValuedAsset {
  const { asset } = facts;
  const chosen = chooseValue(facts, data, asOf);

  // A joint asset counts once. The owner's share is what net worth adds up; the whole
  // figure is kept alongside it so the asset page can show what the flat is actually worth.
  const valuePaise =
    asset.ownershipBps === 10_000
      ? chosen.valuePaise
      : scalePaise(chosen.valuePaise, asset.ownershipBps / 10_000);

  return {
    assetId: asset.id,
    name: asset.name,
    type: asset.type,
    assetClass: classifyAsset({
      type: asset.type,
      kind: facts.kind,
      instrumentKind: facts.instrument?.kind ?? null,
      instrumentCategory: facts.instrument?.category ?? null,
      maturesOn: facts.maturesOn,
    }),
    liquidity: liquidityOf(
      { type: asset.type, kind: facts.kind, maturesOn: facts.maturesOn },
      asOf,
    ),
    institution: asset.institution,
    valuePaise,
    grossValuePaise: chosen.valuePaise,
    ownershipBps: asset.ownershipBps,
    basis: chosen.basis,
    asOf: chosen.asOf,
    nomineeRegistered: asset.nomineeRegistered,
    shared: !owns(scope, asset.ownerUserId),
  };
}

/* -------------------------------------------------------------------------- */
/* Per-type valuation                                                         */
/* -------------------------------------------------------------------------- */

function chooseValue(facts: AssetFacts, data: PortfolioData, asOf: string): Candidate {
  const manual = manualValue(facts, data, asOf);

  switch (facts.asset.type) {
    // The accrual engine already folded the manual figure in as its anchor, so there is
    // nothing left to compare it against.
    case 'deposit':
      return depositValue(facts, data, asOf, manual);

    case 'holding':
      return newer(holdingValue(facts, data, asOf), manual);

    case 'retirement_account': {
      const row = facts.retirement;
      if (!row) return manual;
      return newer(
        {
          valuePaise: row.employeeBalancePaise + row.employerBalancePaise,
          basis: 'balance',
          asOf: facts.asset.updatedAt.slice(0, 10),
        },
        manual,
      );
    }

    case 'liability': {
      const row = facts.liability;
      if (!row) return manual;
      // Positive, always. Net worth subtracts these rows rather than storing a negative
      // balance, which is what keeps "total borrowings" free of sign gymnastics.
      return newer(
        {
          valuePaise: row.outstandingPaise,
          basis: 'outstanding',
          asOf: facts.asset.updatedAt.slice(0, 10),
        },
        manual,
      );
    }

    case 'insurance_policy':
      // Term and health cover pay out on an event that has not happened. Counting a ₹1
      // crore sum assured as an asset would be the single largest lie on the dashboard.
      if (facts.insurance?.kind === 'term' || facts.insurance?.kind === 'health') return NOTHING;
      return manual;

    case 'other_asset': {
      const kind = facts.other?.kind;
      // Money lent out is worth the principal until it is repaid or written off. The rest
      // of the long tail — crypto, a vehicle, an ESOP grant — has no price source until
      // P7, and a made-up number is worse than an honest blank.
      if (kind === 'loan_given') {
        const principal = loanPrincipal(facts.other?.detail ?? null);
        if (principal !== null) {
          return newer(
            { valuePaise: principal, basis: 'balance', asOf: facts.asset.updatedAt.slice(0, 10) },
            manual,
          );
        }
      }
      return manual;
    }

    // A bank balance, a flat and a bangle are all worth what somebody last said.
    case 'bank_account':
    case 'property':
    case 'precious_metal':
      return manual;
  }
}

/** The most recent thing a person said this was worth, on or before the date. */
function manualValue(facts: AssetFacts, data: PortfolioData, asOf: string): Candidate {
  const row = valuationAsOf(data, facts.asset.id, asOf);
  if (!row) return NOTHING;
  return {
    valuePaise: row.valuePaise,
    // `source` distinguishes a typed-in figure from an imported one; both are a statement
    // about a date rather than something this service computed.
    basis: row.source === 'manual' ? 'manual' : 'market',
    asOf: row.asOf,
  };
}

function depositValue(
  facts: AssetFacts,
  data: PortfolioData,
  asOf: string,
  manual: Candidate,
): Candidate {
  const row = facts.deposit;
  if (!row) return manual;

  const terms: DepositTerms = {
    kind: row.kind,
    principalPaise: row.principalPaise,
    installmentPaise: row.installmentPaise,
    rateBps: row.rateBps,
    compounding: row.compounding,
    payoutMode: row.payoutMode,
    startedOn: row.startedOn,
    maturesOn: row.maturesOn,
    autoRenew: row.autoRenew,
  };

  const result = accrueDeposit(terms, asOf, depositContributions(facts, data, terms, asOf, manual));
  if (result.contributedPaise === 0 && result.valuePaise === 0) return manual;

  return {
    valuePaise: result.valuePaise,
    // The value is the model's output even when a statement seeded it, because everything
    // after that date is accrual. Saying `manual` would overstate how much of it is known.
    basis: result.asOf === manual.asOf && result.interestPaise === 0 ? 'manual' : 'accrued',
    asOf: result.asOf,
  };
}

/**
 * The payments into a deposit, in order of preference: what really happened, what the
 * terms imply, and — ahead of both from its own date onwards — what a statement said.
 */
function depositContributions(
  facts: AssetFacts,
  data: PortfolioData,
  terms: DepositTerms,
  asOf: string,
  manual: Candidate,
): DepositContribution[] {
  const recorded = (data.transactions.get(facts.asset.id) ?? [])
    .filter((row) => row.type === 'deposit' || row.type === 'buy' || row.type === 'sip')
    .map((row) => ({ date: row.date, amountPaise: Math.abs(row.amountPaise) }));

  const modelled = recorded.length > 0 ? recorded : scheduleContributions(terms, asOf);

  // Anchoring a payout deposit would restart the payout clock and lose every credit before
  // the statement, so MIS and SCSS keep their own schedule.
  const anchorable =
    terms.payoutMode === 'cumulative' && manual.asOf !== null && manual.asOf >= terms.startedOn;
  if (!anchorable) return modelled;

  return [
    { date: manual.asOf!, amountPaise: manual.valuePaise },
    ...modelled.filter((row) => row.date > manual.asOf!),
  ];
}

function holdingValue(facts: AssetFacts, data: PortfolioData, asOf: string): Candidate {
  const row = facts.holding;
  if (!row || row.units === 0) return NOTHING;

  const price = facts.instrument ? priceAsOf(data, facts.instrument.id, asOf) : null;
  if (price) {
    return { valuePaise: valueOf(row.units, price.priceMicro), basis: 'market', asOf: price.date };
  }

  // No price has ever been imported for this scheme. Average cost is what the owner paid,
  // which is a real number about a real holding — but it has no date, so any valuation at
  // all beats it in `newer`.
  if (row.avgCostMicro > 0) {
    return { valuePaise: valueOf(row.units, row.avgCostMicro), basis: 'manual', asOf: null };
  }
  return NOTHING;
}

/**
 * `other_assets.detail` is JSON validated by a discriminated union on write, so the shape
 * is known — but it has been through the database, and a restore or a hand-edit can put
 * anything in a TEXT column. One loan's value is not worth a 500.
 */
function loanPrincipal(detail: string | null): number | null {
  if (detail === null) return null;
  try {
    const parsed: unknown = JSON.parse(detail);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = (parsed as { principalPaise?: unknown }).principalPaise;
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The more recent of two candidates, with an equal date going to the human.
 *
 * A candidate with no date loses to any dated one: an average cost is a fact about a
 * purchase, not a claim about today.
 */
function newer(computed: Candidate, manual: Candidate): Candidate {
  if (manual.asOf === null) return computed;
  if (computed.asOf === null) return manual.basis === 'none' ? computed : manual;
  return computed.asOf > manual.asOf ? computed : manual;
}
