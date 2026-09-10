/**
 * The India-specific reports: nomination hygiene, the due calendar, and the financial-year
 * tax estimate.
 *
 * These are the three screens that make this a tracker for an Indian household rather than
 * a generic one, and each answers a question a spreadsheet cannot:
 *
 *   - **What have I not nominated?** Ranked by value, with the registration steps for each
 *     institution. This is the feature `docs/INDIA-NOTES.md` argues is worth the whole
 *     application: nomination is free, takes minutes, and its absence is what turns an
 *     estate into a succession-certificate case.
 *   - **What is due?** FD maturities, premiums, the PPF minimum before 31 March, SGB
 *     coupons, EMIs. Each of these is a loss caused purely by forgetting.
 *   - **What will this cost in tax?** Unrealized gains split at the twelve- and
 *     twenty-four-month boundaries, the interest accruing invisibly inside deposits, and the
 *     80C bucket against its limit while there is still time to fill it.
 *
 * Two scoping decisions, made deliberately and differently:
 *
 *   - **Nomination and the calendar are household-wide**, over `readableOwnerIds`, the same
 *     as the dashboard. A partner's unnominated deposit is the household's problem, and a
 *     premium due next week is due whoever's policy it is.
 *   - **The tax report is personal.** Income tax is assessed per person, and pooling two
 *     people's capital gains would produce a figure that belongs to nobody — most obviously
 *     by applying one ₹1.25 lakh exemption to two individuals who each have their own.
 */

import { inArray } from 'drizzle-orm';
import {
  NOMINATION_PROCEDURES,
  accrueDeposit,
  addMonths,
  bucketGains,
  buildFinancialYear,
  currentFinancialYear,
  daysBetween,
  estimateTds,
  financialYearOf,
  isLiabilityType,
  maturityValue,
  monthlyOn,
  monthsHeld,
  scheduleContributions,
  taxRatesFor,
  treatmentFor,
  type CalendarEvent,
  type CalendarQuery,
  type CalendarResponse,
  type DeductionBucket,
  type DeductionEntry,
  type DepositTerms,
  type FinancialYearQuery,
  type FinancialYearReport,
  type GainEntry,
  type InterestEntry,
  type InterestReport,
  type NominationEntry,
  type NominationReport,
  type TaxRates,
  type ValuedAsset,
} from '@networth/shared';
import type { AppContext } from '../context.js';
import { preciousMetals } from '../db/schema.js';
import { isoNow } from '../lib/time.js';
import { loadPortfolio, type AssetFacts, type PortfolioData } from '../repos/analytics.repo.js';
import type { Scope } from '../repos/scope.js';
import { cashflows } from './analytics.service.js';
import { existedOn, valueAsset, valuePortfolio } from './valuation.service.js';

/* -------------------------------------------------------------------------- */
/* Nomination hygiene                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What is at risk of not being claimed, and what to do about each of it.
 *
 * Liabilities are excluded: nobody has to prove a claim to a loan. Archived assets are
 * excluded too — a closed account with no nominee is not a problem anyone can still fix.
 */
export function nominationReport(ctx: AppContext, scope: Scope, asOf?: string): NominationReport {
  const data = loadPortfolio(ctx, scope);
  const on = asOf ?? today(ctx);

  const valued = valuePortfolio(data, scope, on).filter((asset) => !isLiabilityType(asset.type));
  const live = new Set(
    data.assets.filter((facts) => facts.asset.status !== 'archived').map((facts) => facts.asset.id),
  );
  const considered = valued.filter((asset) => live.has(asset.assetId));

  const unnominated = considered.filter((asset) => !asset.nomineeRegistered);

  const atRisk: NominationEntry[] = unnominated
    .map((asset) => ({
      assetId: asset.assetId,
      name: asset.name,
      type: asset.type,
      institution: asset.institution,
      valuePaise: asset.valuePaise,
      procedure: NOMINATION_PROCEDURES[asset.type],
    }))
    // Largest first: an afternoon spent on the top three is worth more than a week on the
    // rest, and this list exists to be worked through rather than admired.
    .sort((a, b) => b.valuePaise - a.valuePaise);

  const byInstitution = new Map<string, { count: number; valuePaise: number }>();
  for (const asset of unnominated) {
    // Pooled under one heading, because "everything at this bank" is one visit or one
    // net-banking session rather than one errand per account.
    const key = asset.institution ?? 'Not held at an institution';
    const entry = byInstitution.get(key) ?? { count: 0, valuePaise: 0 };
    entry.count += 1;
    entry.valuePaise += asset.valuePaise;
    byInstitution.set(key, entry);
  }

  return {
    asOf: on,
    totalAssets: considered.length,
    nominatedCount: considered.length - unnominated.length,
    atRisk,
    atRiskPaise: sum(unnominated),
    coveredPaise: sum(considered.filter((asset) => asset.nomineeRegistered)),
    byInstitution: [...byInstitution.entries()]
      .map(([institution, entry]) => ({ institution, ...entry }))
      .sort((a, b) => b.valuePaise - a.valuePaise),
  };
}

function sum(assets: readonly ValuedAsset[]): number {
  return assets.reduce((total, asset) => total + asset.valuePaise, 0);
}

/* -------------------------------------------------------------------------- */
/* Calendar                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Everything due in the window, oldest first.
 *
 * Recurring obligations are expanded rather than shown once: an EMI is not "due on the 5th",
 * it is due on the 5th of each of the next three months, and a calendar that collapses that
 * into one row is not a calendar.
 */
export function dueCalendar(ctx: AppContext, scope: Scope, query: CalendarQuery): CalendarResponse {
  const data = loadPortfolio(ctx, scope);
  const from = query.from ?? today(ctx);
  const to = addDays(from, query.days);

  const events: CalendarEvent[] = [];
  const push = (event: CalendarEvent): void => {
    if (event.date >= from && event.date <= to) events.push(event);
  };

  const sgbInterestDates = sgbDatesByAsset(ctx, data);

  for (const facts of data.assets) {
    if (!existedOn(facts, from)) continue;
    const { asset } = facts;

    if (facts.deposit) depositEvents(facts, data, from, to, push);

    if (facts.insurance && facts.insurance.nextDueOn && facts.insurance.premiumPaise > 0) {
      for (const date of recurring(
        facts.insurance.nextDueOn,
        from,
        to,
        monthsPerPremium(facts.insurance.premiumFrequency),
      )) {
        push({
          date,
          kind: 'insurance_premium',
          title: `${asset.name} premium`,
          assetId: asset.id,
          assetName: asset.name,
          amountPaise: facts.insurance.premiumPaise,
          severity: 'critical',
          note: 'A lapsed policy is the one asset that becomes worthless by being forgotten.',
        });
      }
    }

    if (facts.holding?.sipDay && facts.holding.sipAmountPaise) {
      for (const date of monthlyOn(facts.holding.sipDay, from, to)) {
        push({
          date,
          kind: 'sip_debit',
          title: `${asset.name} SIP`,
          assetId: asset.id,
          assetName: asset.name,
          amountPaise: facts.holding.sipAmountPaise,
          severity: 'info',
        });
      }
    }

    if (facts.liability) {
      const { nextDueOn, endsOn, emiPaise } = facts.liability;
      if (nextDueOn && emiPaise > 0) {
        for (const date of recurring(nextDueOn, from, to, 1)) {
          push({
            date,
            kind: 'emi_due',
            title: `${asset.name} EMI`,
            assetId: asset.id,
            assetName: asset.name,
            amountPaise: emiPaise,
            severity: 'action',
          });
        }
      }
      if (endsOn) {
        push({
          date: endsOn,
          kind: 'loan_ends',
          title: `${asset.name} is repaid`,
          assetId: asset.id,
          assetName: asset.name,
          amountPaise: null,
          severity: 'info',
          note: 'Ask the lender for the no-dues certificate and the original documents back.',
        });
      }
    }

    if (asset.type === 'precious_metal' && facts.kind === 'sgb') {
      for (const date of sgbInterestDates.get(asset.id) ?? []) {
        for (const occurrence of yearlyOn(date, from, to)) {
          push({
            date: occurrence,
            kind: 'sgb_interest',
            title: `${asset.name} interest`,
            assetId: asset.id,
            assetName: asset.name,
            // 2.5% a year on the issue price, paid in two halves.
            amountPaise: null,
            severity: 'info',
            note: 'SGBs pay 2.5% a year on the issue price, in two half-yearly instalments.',
          });
        }
      }
      if (facts.maturesOn) {
        push({
          date: facts.maturesOn,
          kind: 'sgb_maturity',
          title: `${asset.name} redeems`,
          assetId: asset.id,
          assetName: asset.name,
          amountPaise: null,
          severity: 'action',
          note: 'Capital gain on redemption at maturity is exempt — selling early is not.',
        });
      }
    }
  }

  // The financial year itself, which is a deadline for more things than any single asset.
  const fyEnd = currentFinancialYear(new Date(`${from}T00:00:00Z`)).end;
  push({
    date: fyEnd,
    kind: 'fy_end',
    title: 'Financial year ends',
    assetId: null,
    assetName: null,
    amountPaise: null,
    severity: 'action',
    note: 'Last day for 80C investments, the PPF minimum and tax-loss harvesting.',
  });

  events.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
  return { from, to, events };
}

/** Deposit maturities, RD instalments and the small-savings minimums. */
function depositEvents(
  facts: AssetFacts,
  data: PortfolioData,
  from: string,
  to: string,
  push: (event: CalendarEvent) => void,
): void {
  const row = facts.deposit;
  if (!row) return;
  const terms = termsOf(row);
  const { asset } = facts;

  if (row.maturesOn) {
    push({
      date: row.maturesOn,
      kind: 'deposit_maturity',
      title: `${asset.name} matures`,
      assetId: asset.id,
      assetName: asset.name,
      amountPaise: maturityValue(terms)?.valuePaise ?? null,
      severity: 'action',
      note: row.autoRenew
        ? 'Set to auto-renew: it will roll over at whatever rate applies that day.'
        : 'Give the bank instructions before this date, or it may renew at a rate you did not choose.',
    });
  }

  if (row.kind === 'rd' && row.installmentPaise > 0 && (!row.maturesOn || row.maturesOn > from)) {
    for (const date of recurring(row.startedOn, from, to, 1)) {
      push({
        date,
        kind: 'rd_installment',
        title: `${asset.name} instalment`,
        assetId: asset.id,
        assetName: asset.name,
        amountPaise: row.installmentPaise,
        severity: 'info',
      });
    }
  }

  // PPF and SSY go dormant without a minimum deposit in the year, and reviving one costs a
  // penalty per missed year. The event is only raised when the minimum has not been met.
  if (row.kind === 'ppf' || row.kind === 'ssy') {
    const fy = currentFinancialYear(new Date(`${from}T00:00:00Z`));
    const contributed = contributionsIn(facts, data, fy.start, fy.end).total;
    const { rates } = taxRatesFor(fy.startYear);
    const minimum = row.kind === 'ppf' ? rates.ppfMinimumPaise : rates.ssyMinimumPaise;

    if (contributed < minimum) {
      push({
        date: fy.end,
        kind: row.kind === 'ppf' ? 'ppf_minimum' : 'ssy_minimum',
        title: `${asset.name}: minimum deposit for ${fy.label}`,
        assetId: asset.id,
        assetName: asset.name,
        amountPaise: minimum - contributed,
        severity: 'critical',
        note: 'Without it the account goes dormant, and reviving it costs a penalty for every missed year.',
      });
    }
  }
}

const PREMIUM_MONTHS: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  half_yearly: 6,
  yearly: 12,
  // A single-premium policy has one due date, which `recurring` handles by never stepping.
  single: 0,
};

function monthsPerPremium(frequency: string): number {
  return PREMIUM_MONTHS[frequency] ?? 12;
}

/* -------------------------------------------------------------------------- */
/* Financial year report                                                      */
/* -------------------------------------------------------------------------- */

export function financialYearReport(
  ctx: AppContext,
  scope: Scope,
  query: FinancialYearQuery,
): FinancialYearReport {
  const data = loadPortfolio(ctx, scope);
  const on = query.asOf ?? today(ctx);
  const fy = query.fy === undefined ? financialYearOf(on) : buildFinancialYear(query.fy);
  const { rates, carriedForward } = taxRatesFor(fy.startYear);

  // Personal, not household: see the note at the top of this file.
  const mine = data.assets.filter((facts) => facts.asset.ownerUserId === scope.userId);
  // Nothing is reported past the end of the year being asked about, so last year's report
  // does not grow every time it is opened.
  const reportOn = on > fy.end ? fy.end : on;

  const entries = gainEntries(mine, data, scope, reportOn);
  const buckets = bucketGains(entries, rates);

  return {
    financialYear: {
      label: fy.label,
      assessmentYear: fy.assessmentYear,
      start: fy.start,
      end: fy.end,
    },
    asOf: reportOn,
    daysLeft: Math.max(0, daysBetween(reportOn, fy.end)),
    rates,
    ratesCarriedForward: carriedForward,
    gains: {
      entries,
      buckets,
      estimatedTaxPaise: buckets.reduce(
        (total, bucket) => total + (bucket.estimatedTaxPaise ?? 0),
        0,
      ),
    },
    interest: interestReport(mine, data, fy.start, minDate(reportOn, fy.end), rates, query.senior),
    deductions: deductionBuckets(mine, data, fy.start, fy.end, rates, query.senior),
  };
}

/**
 * Unrealized gains, per asset.
 *
 * Unrealized on purpose. A report of what has already been sold is a record; this is a
 * decision aid — "if I sold this today, where would it land" — which is the question worth
 * asking in the weeks before 31 March.
 */
function gainEntries(
  owned: AssetFacts[],
  data: PortfolioData,
  scope: Scope,
  asOf: string,
): GainEntry[] {
  const entries: GainEntry[] = [];

  for (const facts of owned) {
    if (!existedOn(facts, asOf)) continue;
    if (isLiabilityType(facts.asset.type)) continue;

    const valued = valueAsset(facts, data, scope, asOf);
    const flows = cashflows(facts, data, asOf);
    const investedPaise = -flows.reduce((total, flow) => total + flow.amount, 0);
    // Nothing bought and nothing worth anything: an empty row on a tax page is noise.
    if (investedPaise <= 0 && valued.grossValuePaise === 0) continue;

    const acquiredOn = flows[0]?.date ?? facts.beganOn;
    const held = monthsHeld(acquiredOn, asOf);

    const treatment = treatmentFor({
      assetType: facts.asset.type,
      assetClass: valued.assetClass,
      instrumentKind: facts.instrument?.kind ?? null,
      acquiredOn,
      monthsHeld: held,
    });
    // Deposits, EPF and insurance come back `exempt` — they are interest and maturity
    // proceeds rather than capital gains, and they are reported in their own section.
    if (treatment === 'exempt') continue;

    entries.push({
      assetId: facts.asset.id,
      name: facts.asset.name,
      assetClass: valued.assetClass,
      acquiredOn,
      monthsHeld: held,
      treatment,
      investedPaise,
      valuePaise: valued.grossValuePaise,
      gainPaise: valued.grossValuePaise - investedPaise,
    });
  }

  return entries.sort((a, b) => b.gainPaise - a.gainPaise);
}

/**
 * Interest accruing inside deposits during the year.
 *
 * This is the number a bank statement hides until payout, and the reason INDIA-NOTES.md
 * calls it out: FD interest is taxable **on accrual**, so a five-year cumulative deposit
 * generates a tax liability every year while paying nothing out to cover it.
 *
 * The figure is what has accrued *so far* rather than a projection to 31 March. It answers
 * "have I crossed the TDS threshold yet", which is the question with an action attached.
 */
function interestReport(
  owned: AssetFacts[],
  data: PortfolioData,
  fyStart: string,
  asOf: string,
  rates: TaxRates,
  senior: boolean,
): InterestReport {
  const entries: InterestEntry[] = [];

  for (const facts of owned) {
    const row = facts.deposit;
    if (!row) continue;

    const terms = termsOf(row);
    const contributions = recordedContributions(facts, data);
    // Interest to the end of the window, less interest to the day before it opened: the
    // difference is what this year earned, including anything MIS or SCSS paid out.
    const atEnd = accrueDeposit(terms, asOf, contributions);
    const atStart = accrueDeposit(terms, addDays(fyStart, -1), contributions);
    const accrued =
      atEnd.interestPaise + atEnd.paidOutPaise - (atStart.interestPaise + atStart.paidOutPaise);

    if (accrued <= 0) continue;
    entries.push({
      assetId: facts.asset.id,
      name: facts.asset.name,
      institution: facts.asset.institution,
      accruedPaise: accrued,
      kind: row.kind,
      // PPF and SSY interest is exempt under section 10. It is still listed, because "why is
      // this not in my total" is a worse question than the answer.
      exempt: row.kind === 'ppf' || row.kind === 'ssy',
    });
  }

  const taxable = entries.filter((entry) => !entry.exempt);
  const thresholdPaise = senior ? rates.fdTdsThresholdSeniorPaise : rates.fdTdsThresholdPaise;

  const byPayer = new Map<string, number>();
  for (const entry of taxable) {
    // TDS is applied per payer, not per deposit and not per household — which is exactly
    // what surprises somebody holding four fixed deposits at the same branch.
    const key = entry.institution ?? 'Unnamed institution';
    byPayer.set(key, (byPayer.get(key) ?? 0) + entry.accruedPaise);
  }

  const payers = [...byPayer.entries()]
    .map(([institution, accruedPaise]) => ({
      institution,
      accruedPaise,
      thresholdPaise,
      crossesThreshold: accruedPaise > thresholdPaise,
      estimatedTdsPaise: estimateTds(accruedPaise, thresholdPaise, rates.fdTdsRateBps),
    }))
    .sort((a, b) => b.accruedPaise - a.accruedPaise);

  const sumOf = (rows: InterestEntry[]): number =>
    rows.reduce((total, entry) => total + entry.accruedPaise, 0);

  return {
    totalAccruedPaise: sumOf(entries),
    taxableAccruedPaise: sumOf(taxable),
    exemptAccruedPaise: sumOf(entries.filter((entry) => entry.exempt)),
    entries: entries.sort((a, b) => b.accruedPaise - a.accruedPaise),
    byPayer: payers,
    form15Advisable: payers.some((payer) => payer.crossesThreshold),
  };
}

/**
 * The 80C and 80D buckets.
 *
 * Incomplete by construction, and the UI says so: tuition fees, stamp duty and tax-saver
 * fixed deposits are all eligible and none of them is something this application can see.
 * What it can do is total the sources it *does* hold and show the headroom left, which is
 * the number that decides whether to make a deposit before the 31st.
 */
function deductionBuckets(
  owned: AssetFacts[],
  data: PortfolioData,
  fyStart: string,
  fyEnd: string,
  rates: TaxRates,
  senior: boolean,
): DeductionBucket[] {
  const under80C: DeductionEntry[] = [];
  const under80D: DeductionEntry[] = [];

  for (const facts of owned) {
    const { asset } = facts;

    if (facts.deposit) {
      const source =
        facts.deposit.kind === 'ppf'
          ? 'ppf'
          : facts.deposit.kind === 'ssy'
            ? 'ssy'
            : facts.deposit.kind === 'nsc'
              ? 'nsc'
              : null;
      if (source !== null) {
        const { total, estimated } = contributionsIn(facts, data, fyStart, fyEnd);
        if (total > 0) {
          under80C.push({
            assetId: asset.id,
            name: asset.name,
            source,
            amountPaise: total,
            estimated,
          });
        }
      }
    }

    if (facts.holding && isElss(facts)) {
      // Only what was actually recorded. A SIP amount on the holding says what is *meant*
      // to happen monthly; claiming a deduction for instalments nobody confirmed would be
      // inventing the one number on this page somebody might put in a return.
      const invested = recordedIn(facts, data, fyStart, fyEnd);
      if (invested > 0) {
        under80C.push({
          assetId: asset.id,
          name: asset.name,
          source: 'elss',
          amountPaise: invested,
          estimated: false,
        });
      }
    }

    if (facts.insurance) {
      const { total, estimated } = premiumsIn(facts, data, fyStart, fyEnd);
      if (total > 0) {
        const entry = {
          assetId: asset.id,
          name: asset.name,
          source: 'life_insurance' as const,
          amountPaise: total,
          estimated,
        };
        if (facts.insurance.kind === 'health') under80D.push(entry);
        else under80C.push(entry);
      }
    }

    if (facts.retirement?.kind === 'epf') {
      const contributed = recordedIn(facts, data, fyStart, fyEnd);
      if (contributed > 0) {
        under80C.push({
          assetId: asset.id,
          name: asset.name,
          source: 'epf',
          amountPaise: contributed,
          estimated: false,
        });
      }
    }

    if (facts.liability?.kind === 'home' && facts.liability.emiPaise > 0) {
      const principal = annualPrincipal(facts.liability);
      if (principal > 0) {
        under80C.push({
          assetId: asset.id,
          name: asset.name,
          source: 'home_loan_principal',
          amountPaise: principal,
          // Split out of the EMI arithmetically rather than read from a lender's statement.
          estimated: true,
        });
      }
    }
  }

  return [
    bucket('80C', rates.section80CLimitPaise, under80C),
    bucket('80D', senior ? rates.section80DSelfSeniorPaise : rates.section80DSelfPaise, under80D),
  ];
}

function bucket(
  section: '80C' | '80D',
  limitPaise: number,
  entries: DeductionEntry[],
): DeductionBucket {
  const claimedPaise = entries.reduce((total, entry) => total + entry.amountPaise, 0);
  return {
    section,
    limitPaise,
    claimedPaise,
    headroomPaise: Math.max(0, limitPaise - claimedPaise),
    entries: entries.sort((a, b) => b.amountPaise - a.amountPaise),
  };
}

/**
 * A year's principal repayment on a home loan, split out of the EMI.
 *
 * `12 × EMI − (outstanding × rate)` — a year of payments less a year of interest on the
 * current balance. It slightly understates the principal, because the balance falls through
 * the year while this holds it fixed, and understating a deduction is the right direction to
 * be wrong in. Flagged `estimated` wherever it appears.
 */
function annualPrincipal(liability: {
  emiPaise: number;
  outstandingPaise: number;
  rateBps: number;
}): number {
  const yearOfPayments = liability.emiPaise * 12;
  const yearOfInterest = Math.round((liability.outstandingPaise * liability.rateBps) / 10_000);
  return Math.max(0, Math.min(yearOfPayments - yearOfInterest, liability.outstandingPaise));
}

/** ELSS is a category on the instrument, not a kind — it is an ordinary equity fund. */
function isElss(facts: AssetFacts): boolean {
  return /\b(elss|tax\s*saver|tax\s*saving)\b/i.test(facts.instrument?.category ?? '');
}

/* -------------------------------------------------------------------------- */
/* Contributions                                                              */
/* -------------------------------------------------------------------------- */

/** Money paid into an asset, as recorded. Zero when nothing was entered. */
function recordedIn(facts: AssetFacts, data: PortfolioData, from: string, to: string): number {
  return (data.transactions.get(facts.asset.id) ?? [])
    .filter(
      (row) =>
        row.date >= from &&
        row.date <= to &&
        (row.type === 'deposit' || row.type === 'buy' || row.type === 'sip'),
    )
    .reduce((total, row) => total + Math.abs(row.amountPaise), 0);
}

function recordedContributions(
  facts: AssetFacts,
  data: PortfolioData,
): Array<{ date: string; amountPaise: number }> | undefined {
  const rows = (data.transactions.get(facts.asset.id) ?? []).filter(
    (row) => row.type === 'deposit' || row.type === 'buy' || row.type === 'sip',
  );
  // `undefined` rather than an empty array: the accrual engine reads that as "model the
  // schedule", where `[]` would mean "nothing was ever paid in".
  return rows.length === 0
    ? undefined
    : rows.map((row) => ({ date: row.date, amountPaise: Math.abs(row.amountPaise) }));
}

/**
 * What went into a deposit during a window — recorded if it was, modelled if it was not.
 *
 * The distinction is carried out to the caller as `estimated`, because a PPF minimum
 * warning based on a modelled schedule is a different claim from one based on a transaction
 * somebody entered.
 */
function contributionsIn(
  facts: AssetFacts,
  data: PortfolioData,
  from: string,
  to: string,
): { total: number; estimated: boolean } {
  const recorded = recordedContributions(facts, data);
  if (recorded !== undefined) {
    return {
      total: recorded
        .filter((row) => row.date >= from && row.date <= to)
        .reduce((total, row) => total + row.amountPaise, 0),
      estimated: false,
    };
  }

  if (!facts.deposit) return { total: 0, estimated: false };

  return {
    total: scheduleContributions(termsOf(facts.deposit), to)
      .filter((row) => row.date >= from && row.date <= to)
      .reduce((total, row) => total + row.amountPaise, 0),
    estimated: true,
  };
}

/** Premiums paid in a window: the recorded ones, or the ones the policy implies. */
function premiumsIn(
  facts: AssetFacts,
  data: PortfolioData,
  from: string,
  to: string,
): { total: number; estimated: boolean } {
  const recorded = (data.transactions.get(facts.asset.id) ?? []).filter(
    (row) => row.type === 'premium' && row.date >= from && row.date <= to,
  );
  if (recorded.length > 0) {
    return {
      total: recorded.reduce((total, row) => total + Math.abs(row.amountPaise), 0),
      estimated: false,
    };
  }

  const policy = facts.insurance;
  if (!policy || policy.premiumPaise === 0) return { total: 0, estimated: false };

  const months = monthsPerPremium(policy.premiumFrequency);
  // A single-premium policy pays nothing in an ordinary year; assuming otherwise would put
  // a deduction in the bucket for money that did not move.
  if (months === 0) return { total: 0, estimated: false };
  return { total: policy.premiumPaise * Math.floor(12 / months), estimated: true };
}

/* -------------------------------------------------------------------------- */
/* Dates                                                                      */
/* -------------------------------------------------------------------------- */

/** Occurrences of a recurring date within a window, starting from `anchor`. */
function recurring(anchor: string, from: string, to: string, everyMonths: number): string[] {
  if (everyMonths <= 0) return anchor >= from && anchor <= to ? [anchor] : [];

  const dates: string[] = [];
  let cursor = anchor;

  // Wind forward to the window rather than stepping from the anchor, which may be years
  // back — a policy taken out in 2009 should not cost two hundred iterations.
  while (cursor < from) cursor = addMonths(cursor, everyMonths);
  while (cursor <= to) {
    dates.push(cursor);
    cursor = addMonths(cursor, everyMonths);
  }
  return dates;
}

/** An `MM-DD` that recurs every year. */
function yearlyOn(monthDay: string, from: string, to: string): string[] {
  const dates: string[] = [];
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year += 1) {
    const date = `${year}-${monthDay}`;
    if (date >= from && date <= to) dates.push(date);
  }
  return dates;
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

function today(ctx: AppContext): string {
  return isoNow(ctx.now()).slice(0, 10);
}

/** The accrual engine's view of a deposit row. */
function termsOf(row: NonNullable<AssetFacts['deposit']>): DepositTerms {
  return {
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
}

/**
 * SGB coupon dates, which `loadPortfolio` does not carry.
 *
 * The portfolio loader deliberately keeps only what valuation and classification need, and
 * a bond's two payment dates are neither. One extra query for the calendar is cheaper than
 * widening a structure every other consumer would then pay for.
 */
function sgbDatesByAsset(ctx: AppContext, data: PortfolioData): Map<string, string[]> {
  const ids = data.assets
    .filter((facts) => facts.asset.type === 'precious_metal')
    .map((facts) => facts.asset.id);
  if (ids.length === 0) return new Map();

  const rows = ctx.db
    .select({ assetId: preciousMetals.assetId, dates: preciousMetals.sgbInterestDates })
    .from(preciousMetals)
    .where(inArray(preciousMetals.assetId, ids))
    .all();

  const result = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.dates) continue;
    try {
      const parsed: unknown = JSON.parse(row.dates);
      if (Array.isArray(parsed)) {
        result.set(
          row.assetId,
          parsed.filter(
            (date): date is string => typeof date === 'string' && /^\d{2}-\d{2}$/.test(date),
          ),
        );
      }
    } catch {
      // A hand-edited or restored row with rubbish in it costs this asset its coupon
      // reminders and nothing else.
    }
  }
  return result;
}
