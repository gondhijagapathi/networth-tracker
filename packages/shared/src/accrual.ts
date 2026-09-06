/**
 * Deposit accrual.
 *
 * A fixed deposit is worth more today than the day it was opened, and nobody types that
 * number in. Banks show it on a statement once a quarter, the post office shows it never,
 * and PPF shows it once a year on 31 March. A tracker that waits to be told what a deposit
 * is worth reports a household as poorer than it is for eleven months out of twelve.
 *
 * So this module computes it. Everything here is a pure function of the deposit's terms and
 * a date, which is why it lives in `@networth/shared`: the API values a portfolio with it,
 * the browser projects a maturity with it, and the tests check it against published tables.
 *
 * ### Conventions
 *
 * - **Whole periods compound, the stub is simple.** Six-and-a-half quarters of an FD is six
 *   quarterly compoundings followed by simple interest on the half. That is what banks do,
 *   and the alternative — a fractional exponent — quietly overstates every deposit.
 * - **365-day years.** No leap-year day count. The error is under 0.3% of the interest and
 *   the honesty of a documented convention beats the false precision of an undocumented one.
 * - **Maturity stops the clock**, unless the deposit auto-renews, in which case it keeps
 *   compounding at the same rate. A renewed FD gets whatever rate prevails on the day, which
 *   this cannot know; the last known rate is the least wrong assumption available.
 * - **PPF and SSY get their own engine**, because their rule — interest on the minimum
 *   balance between the 5th and the last day of each month, credited on 31 March — is not
 *   expressible as compounding from a contribution date, and it is the rule that decides
 *   whether depositing on the 4th or the 6th of April costs you a year of interest.
 */

import type { COMPOUNDING_FREQUENCIES, DEPOSIT_KINDS, PAYOUT_MODES } from './assets.js';
import type { Paise } from './money.js';

export type DepositKind = (typeof DEPOSIT_KINDS)[number];
export type Compounding = (typeof COMPOUNDING_FREQUENCIES)[number];
export type PayoutMode = (typeof PAYOUT_MODES)[number];

/** Everything the engine needs, mirroring the `deposits` detail row. */
export interface DepositTerms {
  kind: DepositKind;
  /** The lump sum paid in on `startedOn`. Zero for a pure recurring deposit. */
  principalPaise: Paise;
  /** The recurring contribution — monthly for an RD, yearly for PPF and SSY. */
  installmentPaise?: Paise;
  rateBps: number;
  compounding: Compounding;
  payoutMode: PayoutMode;
  startedOn: string;
  maturesOn?: string | null;
  autoRenew?: boolean;
}

/** A payment into the deposit. Supplied from `transactions` when the real dates are known. */
export interface DepositContribution {
  date: string;
  amountPaise: Paise;
}

export interface AccrualResult {
  /** The date the value is for — `maturesOn` when a matured deposit stopped earning. */
  asOf: string;
  /** What it is worth: contributions plus interest that has not been paid out. */
  valuePaise: Paise;
  /** Everything paid in up to `asOf`. */
  contributedPaise: Paise;
  /** Interest earned and still inside the deposit. */
  interestPaise: Paise;
  /** Interest already handed over — MIS and SCSS pay it out rather than compound it. */
  paidOutPaise: Paise;
  matured: boolean;
}

const MS_PER_DAY = 86_400_000;
const DAYS_PER_YEAR = 365;

/** How many times a year interest is added. Zero means it is not added until the end. */
const PERIODS_PER_YEAR: Record<Compounding, number> = {
  monthly: 12,
  quarterly: 4,
  half_yearly: 2,
  yearly: 1,
  maturity: 0,
  simple: 0,
};

const PAYOUTS_PER_YEAR: Record<PayoutMode, number> = {
  cumulative: 0,
  monthly: 12,
  quarterly: 4,
  half_yearly: 2,
  yearly: 1,
};

/**
 * SSY takes deposits for fifteen years but matures at twenty-one, so `maturesOn` is the
 * wrong bound for its contribution schedule and the right one for its interest.
 */
const CONTRIBUTION_YEARS: Partial<Record<DepositKind, number>> = { ssy: 15, ppf: 15 };

/**
 * What a deposit is worth on a date.
 *
 * @param contributions the real payment history, when it is known. Without it the schedule
 *   is modelled from `installmentPaise` — right for an untouched RD or PPF account, and
 *   wrong the moment somebody skips a month, which is exactly why the real history wins.
 */
export function accrueDeposit(
  terms: DepositTerms,
  asOf: string,
  contributions?: readonly DepositContribution[],
): AccrualResult {
  const day = asOf.slice(0, 10);
  const maturesOn = terms.maturesOn ?? null;
  const matured = maturesOn !== null && day > maturesOn;
  // A matured deposit stops earning on its maturity date; a renewed one carries on.
  const valueDate = matured && maturesOn !== null && terms.autoRenew !== true ? maturesOn : day;

  const paid = (contributions ?? scheduleContributions(terms, valueDate))
    .filter((c) => c.date.slice(0, 10) <= valueDate && c.amountPaise > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const contributedPaise = paid.reduce((sum, c) => sum + c.amountPaise, 0);

  if (valueDate < terms.startedOn) {
    return {
      asOf: valueDate,
      valuePaise: 0,
      contributedPaise: 0,
      interestPaise: 0,
      paidOutPaise: 0,
      matured: false,
    };
  }

  // Interest that leaves the account never becomes part of what the account is worth. An
  // SCSS holder lives on those quarterly credits; they are income, not a balance.
  if (terms.payoutMode !== 'cumulative') {
    const paidOut = paid.reduce(
      (sum, c) =>
        sum + payoutInterest(c.amountPaise, terms.rateBps, terms.payoutMode, c.date, valueDate),
      0,
    );
    return {
      asOf: valueDate,
      valuePaise: contributedPaise,
      contributedPaise,
      interestPaise: 0,
      paidOutPaise: Math.round(paidOut),
      matured,
    };
  }

  const value =
    terms.kind === 'ppf' || terms.kind === 'ssy'
      ? minimumBalanceValue(paid, terms.rateBps, valueDate)
      : paid.reduce(
          (sum, c) =>
            sum +
            compoundedValue(c.amountPaise, terms.rateBps, terms.compounding, c.date, valueDate),
          0,
        );

  const valuePaise = Math.round(value);
  return {
    asOf: valueDate,
    valuePaise,
    contributedPaise,
    interestPaise: valuePaise - contributedPaise,
    paidOutPaise: 0,
    matured,
  };
}

/**
 * What the deposit will be worth on its maturity date, or `null` for one with no maturity —
 * a PPF account that has been extended, or an SCSS the holder keeps rolling over.
 */
export function maturityValue(
  terms: DepositTerms,
  contributions?: readonly DepositContribution[],
): AccrualResult | null {
  if (terms.maturesOn === null || terms.maturesOn === undefined) return null;
  return accrueDeposit({ ...terms, autoRenew: false }, terms.maturesOn, contributions);
}

/**
 * One amount, compounded for whole periods and then carried simply across the remainder.
 *
 * Exported because a `simple`-compounding deposit and an EPF balance want the same maths
 * without the surrounding schedule machinery.
 */
export function compoundedValue(
  amountPaise: number,
  rateBps: number,
  compounding: Compounding,
  from: string,
  to: string,
): number {
  const rate = rateBps / 10_000;
  const years = daysBetween(from, to) / DAYS_PER_YEAR;
  if (years <= 0 || rate === 0) return amountPaise;

  const periodsPerYear = PERIODS_PER_YEAR[compounding];
  if (periodsPerYear === 0) return amountPaise * (1 + rate * years);

  const periods = years * periodsPerYear;
  const whole = Math.floor(periods);
  const stub = periods - whole;
  const periodRate = rate / periodsPerYear;

  return amountPaise * Math.pow(1 + periodRate, whole) * (1 + periodRate * stub);
}

/** Interest handed over so far on one contribution, counted in completed payout periods. */
function payoutInterest(
  amountPaise: number,
  rateBps: number,
  payoutMode: PayoutMode,
  from: string,
  to: string,
): number {
  const perYear = PAYOUTS_PER_YEAR[payoutMode];
  if (perYear === 0) return 0;
  const periods = Math.floor((daysBetween(from, to) / DAYS_PER_YEAR) * perYear);
  return (amountPaise * (rateBps / 10_000) * periods) / perYear;
}

/**
 * The PPF and SSY rule, written out.
 *
 * Interest for a month is computed on the lowest balance between the 5th and the last day
 * of that month, which in practice means a deposit made after the 5th earns nothing until
 * the following month. It is credited once, on 31 March. Both halves matter: the first is
 * why the advice is always "deposit before the 5th of April", and the second is why a PPF
 * balance sits flat all year and then jumps.
 *
 * Interest accrued in the current, uncredited financial year is included in the value. It
 * has been earned; only the bookkeeping is pending, and reporting a household as poorer
 * until 31 March would be the same lie this module exists to stop telling.
 *
 * Withdrawals are not modelled. PPF permits them from year seven and SSY from year eighteen;
 * when one happens it arrives as a `transactions` row, and the caller passes the real
 * contribution history instead of a modelled one.
 */
function minimumBalanceValue(
  contributions: readonly DepositContribution[],
  rateBps: number,
  asOf: string,
): number {
  if (contributions.length === 0) return 0;
  const monthlyRate = rateBps / 10_000 / 12;

  let balance = 0;
  let accrued = 0;
  let cursor = monthStart(contributions[0]!.date);
  let index = 0;

  // Only completed months earn: the month in progress has not reached the last day the
  // minimum balance is measured against.
  while (endOfMonth(cursor) <= asOf) {
    let earning = balance;
    while (index < contributions.length && contributions[index]!.date <= endOfMonth(cursor)) {
      const contribution = contributions[index]!;
      balance += contribution.amountPaise;
      // On or before the 5th, it counts for this month too.
      if (Number(contribution.date.slice(8, 10)) <= 5) earning += contribution.amountPaise;
      index += 1;
    }

    accrued += earning * monthlyRate;

    if (cursor.slice(5, 7) === '03') {
      balance += accrued;
      accrued = 0;
    }
    cursor = addMonths(cursor, 1);
  }

  // Anything paid in during the month still running is part of the balance, even though it
  // has not earned yet.
  while (index < contributions.length && contributions[index]!.date <= asOf) {
    balance += contributions[index]!.amountPaise;
    index += 1;
  }

  return balance + accrued;
}

/**
 * The payment schedule implied by the terms, when the real one is not known.
 *
 * A lump sum on the start date, plus the recurring instalment at the cadence the instrument
 * uses: monthly for an RD, yearly on the anniversary for PPF and SSY. Contributions stop at
 * maturity, or after fifteen years for the two that take deposits for less time than they
 * run.
 */
export function scheduleContributions(terms: DepositTerms, until: string): DepositContribution[] {
  const out: DepositContribution[] = [];
  if (terms.principalPaise > 0) {
    out.push({ date: terms.startedOn, amountPaise: terms.principalPaise });
  }

  const installment = terms.installmentPaise ?? 0;
  const cadence =
    terms.kind === 'rd'
      ? 'monthly'
      : terms.kind === 'ppf' || terms.kind === 'ssy'
        ? 'yearly'
        : null;
  if (installment <= 0 || cadence === null) return out;

  const years = CONTRIBUTION_YEARS[terms.kind];
  const bounds = [until, terms.maturesOn ?? until];
  if (years !== undefined) bounds.push(addMonths(terms.startedOn, years * 12));
  const last = bounds.reduce((a, b) => (a < b ? a : b));

  const step = cadence === 'monthly' ? 1 : 12;
  // Guard rather than trust the dates: a typo of 1925 for 2025 must not spin here.
  const maxPayments = cadence === 'monthly' ? 12 * 30 : 30;

  for (let i = 0; i < maxPayments; i += 1) {
    const date = addMonths(terms.startedOn, i * step);
    if (date > last) break;
    out.push({ date, amountPaise: installment });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Date helpers                                                               */
/* -------------------------------------------------------------------------- */

function epoch(iso: string): number {
  const ms = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`Invalid date: ${iso}`);
  return ms;
}

/** Whole days between two ISO dates. Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((epoch(to) - epoch(from)) / MS_PER_DAY);
}

/**
 * The same day-of-month `n` months on, clamped to the end of a shorter month — a deposit
 * opened on the 31st recurs on the 30th in April rather than skipping into May.
 */
export function addMonths(iso: string, months: number): string {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7)) - 1 + months;
  const day = Number(iso.slice(8, 10));
  const target = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

function endOfMonth(iso: string): string {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}
