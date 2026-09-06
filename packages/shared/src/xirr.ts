/**
 * XIRR — the annualised return of an irregular series of cashflows.
 *
 * This is the number that actually matters for an Indian portfolio, because SIPs,
 * top-ups and partial redemptions mean money goes in and out on arbitrary dates.
 * A simple CAGR over first and last value would be wrong for almost every holding here.
 *
 * Newton–Raphson with a bisection fallback, because Newton alone diverges on the
 * awkward cashflow shapes that real portfolios produce.
 */

export interface CashFlow {
  /** ISO date */
  date: string;
  /**
   * Amount in paise. Negative for money leaving your pocket (a purchase or SIP
   * instalment), positive for money coming back (a redemption, dividend, or the
   * current value as a final synthetic inflow).
   */
  amount: number;
}

const DAYS_PER_YEAR = 365;
const MAX_ITERATIONS = 100;
const TOLERANCE = 1e-7;

function yearsBetween(start: string, end: string): number {
  const a = Date.parse(`${start.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${end.slice(0, 10)}T00:00:00Z`);
  return (b - a) / (86_400_000 * DAYS_PER_YEAR);
}

function netPresentValue(rate: number, flows: readonly CashFlow[], base: string): number {
  let npv = 0;
  for (const flow of flows) {
    npv += flow.amount / Math.pow(1 + rate, yearsBetween(base, flow.date));
  }
  return npv;
}

function npvDerivative(rate: number, flows: readonly CashFlow[], base: string): number {
  let d = 0;
  for (const flow of flows) {
    const t = yearsBetween(base, flow.date);
    if (t === 0) continue;
    d -= (t * flow.amount) / Math.pow(1 + rate, t + 1);
  }
  return d;
}

/**
 * Returns the annualised rate as a decimal (0.1234 = 12.34%), or `null` when the
 * cashflows cannot produce one — fewer than two flows, or all flows in the same
 * direction, which is a legitimate state for a holding bought today.
 */
export function xirr(flows: readonly CashFlow[], guess = 0.1): number | null {
  if (flows.length < 2) return null;

  const hasInflow = flows.some((f) => f.amount > 0);
  const hasOutflow = flows.some((f) => f.amount < 0);
  if (!hasInflow || !hasOutflow) return null;

  const sorted = [...flows].sort((a, b) => a.date.localeCompare(b.date));
  const base = sorted[0]!.date;

  // Newton–Raphson first: fast when it works.
  let rate = guess;
  for (let i = 0; i < MAX_ITERATIONS; i += 1) {
    const npv = netPresentValue(rate, sorted, base);
    if (Math.abs(npv) < TOLERANCE) return rate;

    const derivative = npvDerivative(rate, sorted, base);
    if (derivative === 0 || !Number.isFinite(derivative)) break;

    const next = rate - npv / derivative;
    if (!Number.isFinite(next) || next <= -1) break;
    if (Math.abs(next - rate) < TOLERANCE) return next;
    rate = next;
  }

  // Bisection fallback across a range wide enough for anything a household holds.
  let low = -0.9999;
  let high = 10;
  let npvLow = netPresentValue(low, sorted, base);
  const npvHigh = netPresentValue(high, sorted, base);
  if (npvLow * npvHigh > 0) return null; // no sign change: no root in range

  for (let i = 0; i < MAX_ITERATIONS * 2; i += 1) {
    const mid = (low + high) / 2;
    const npvMid = netPresentValue(mid, sorted, base);
    if (Math.abs(npvMid) < TOLERANCE || (high - low) / 2 < TOLERANCE) return mid;
    // Keep the bracket on the side where the sign still changes.
    if (npvLow * npvMid < 0) {
      high = mid;
    } else {
      low = mid;
      npvLow = npvMid;
    }
  }
  return (low + high) / 2;
}

/**
 * Compound annual growth rate for a single lump sum. Simpler than XIRR and correct
 * only when there were no intermediate cashflows — an FD, or a one-off purchase.
 */
export function cagr(
  initialValue: number,
  finalValue: number,
  startDate: string,
  endDate: string,
): number | null {
  if (initialValue <= 0 || finalValue <= 0) return null;
  const years = yearsBetween(startDate, endDate);
  if (years <= 0) return null;
  return Math.pow(finalValue / initialValue, 1 / years) - 1;
}

/** 0.1234 -> "12.34%" */
export function formatRate(rate: number | null, fractionDigits = 2): string {
  if (rate === null || !Number.isFinite(rate)) return '—';
  return `${(rate * 100).toFixed(fractionDigits)}%`;
}
