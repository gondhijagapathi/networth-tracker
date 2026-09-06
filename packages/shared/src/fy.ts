/**
 * Indian financial year helpers.
 *
 * The FY runs 1 April – 31 March. FY 2026-27 is assessed in AY 2027-28.
 * Every report in this app defaults to an FY window rather than a calendar year.
 */

export interface FinancialYear {
  /** The year the FY starts in. FY 2026-27 -> 2026 */
  startYear: number;
  /** ISO date, inclusive. e.g. "2026-04-01" */
  start: string;
  /** ISO date, inclusive. e.g. "2027-03-31" */
  end: string;
  /** "FY 2026-27" */
  label: string;
  /** "AY 2027-28" — the assessment year this FY is filed in. */
  assessmentYear: string;
}

const FY_START_MONTH = 4; // April

function toDate(date: string | Date): Date {
  const d = typeof date === 'string' ? new Date(`${date.slice(0, 10)}T00:00:00Z`) : date;
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${String(date)}`);
  return d;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Which financial year does this date fall in? */
export function financialYearOf(date: string | Date): FinancialYear {
  const d = toDate(date);
  const month = d.getUTCMonth() + 1;
  const year = d.getUTCFullYear();
  // January to March belong to the FY that started the previous April.
  const startYear = month >= FY_START_MONTH ? year : year - 1;
  return buildFinancialYear(startYear);
}

export function buildFinancialYear(startYear: number): FinancialYear {
  const endYear = startYear + 1;
  const shortEnd = pad(endYear % 100);
  return {
    startYear,
    start: `${startYear}-04-01`,
    end: `${endYear}-03-31`,
    label: `FY ${startYear}-${shortEnd}`,
    assessmentYear: `AY ${endYear}-${pad((endYear + 1) % 100)}`,
  };
}

export function currentFinancialYear(now: Date = new Date()): FinancialYear {
  return financialYearOf(now);
}

/** Is an ISO date inside this financial year? Both bounds inclusive. */
export function isInFinancialYear(date: string, fy: FinancialYear): boolean {
  const d = date.slice(0, 10);
  return d >= fy.start && d <= fy.end;
}

/** The most recent `count` financial years, newest first — for a year picker. */
export function recentFinancialYears(count: number, now: Date = new Date()): FinancialYear[] {
  const current = currentFinancialYear(now);
  return Array.from({ length: count }, (_, i) => buildFinancialYear(current.startYear - i));
}

/**
 * Days until the FY ends. Drives the "₹42,000 of 80C headroom left, 24 days to go"
 * nudge that is the whole point of tracking this in March.
 */
export function daysLeftInFinancialYear(now: Date = new Date()): number {
  const fy = currentFinancialYear(now);
  const end = toDate(fy.end);
  const today = toDate(now.toISOString().slice(0, 10));
  return Math.max(0, Math.round((end.getTime() - today.getTime()) / 86_400_000));
}

/**
 * Whole months between two dates, used for the 12-month long-term capital gains
 * boundary on equity and equity mutual funds.
 */
export function monthsHeld(from: string | Date, to: string | Date = new Date()): number {
  const a = toDate(from);
  const b = toDate(to);
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1;
  return months;
}

/**
 * Long-term or short-term for gains purposes.
 *
 * Equity and equity-oriented mutual funds turn long-term at 12 months. Everything else
 * (property, gold, unlisted shares) uses 24 months. Debt mutual funds bought on or after
 * 1 April 2023 are taxed at slab regardless of holding period and are handled separately
 * by the tax module — this function only answers the duration question.
 */
export function gainTerm(
  purchaseDate: string | Date,
  saleDate: string | Date = new Date(),
  assetClass: 'equity' | 'other' = 'equity',
): 'short' | 'long' {
  const threshold = assetClass === 'equity' ? 12 : 24;
  return monthsHeld(purchaseDate, saleDate) >= threshold ? 'long' : 'short';
}
