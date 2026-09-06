/**
 * Money handling.
 *
 * Every amount in this application is an integer number of **paise**. Floating point
 * rupees are never stored, summed or compared — a net worth tracker that drifts by a
 * paise per operation is worse than useless.
 *
 * ₹1,234.56  ->  123456 paise
 */

/** An integer count of paise. 100 paise = ₹1. */
export type Paise = number;

export const PAISE_PER_RUPEE = 100;

/** Largest amount we can represent exactly: ~₹90,071 crore. Comfortably beyond any household. */
export const MAX_PAISE = Number.MAX_SAFE_INTEGER;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Convert a rupee amount to paise, rounding half away from zero. */
export function rupeesToPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) {
    throw new MoneyError(`Cannot convert non-finite value to paise: ${rupees}`);
  }
  const paise = Math.round(Math.abs(rupees) * PAISE_PER_RUPEE) * Math.sign(rupees);
  if (!Number.isSafeInteger(paise)) {
    throw new MoneyError(`Amount out of safe range: ${rupees}`);
  }
  return paise;
}

/** Convert paise back to a rupee number. For display and ratios only — never for storage. */
export function paiseToRupees(paise: Paise): number {
  assertPaise(paise);
  return paise / PAISE_PER_RUPEE;
}

export function assertPaise(value: unknown): asserts value is Paise {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new MoneyError(`Expected an integer paise amount, received: ${String(value)}`);
  }
}

/**
 * Parse user input into paise. Accepts what an Indian user actually types:
 * "1,23,456.78", "₹5000", "12.5L", "1.2 Cr", "  -450  ".
 */
export function parseAmount(input: string): Paise {
  const cleaned = input.trim().replace(/[₹,\s]/g, '');
  if (cleaned === '') throw new MoneyError('Empty amount');

  const match = /^(-?\d*\.?\d+)(l|lakh|lac|cr|crore|k)?$/i.exec(cleaned);
  if (!match) throw new MoneyError(`Could not parse amount: "${input}"`);

  const value = Number(match[1]);
  const multiplier = match[2]?.toLowerCase();

  const scale =
    multiplier === undefined
      ? 1
      : multiplier === 'k'
        ? 1_000
        : multiplier === 'cr' || multiplier === 'crore'
          ? 1_00_00_000
          : 1_00_000; // l | lakh | lac

  return rupeesToPaise(value * scale);
}

const inrFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const inrFormatterNoPaise = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Format paise as Indian currency with 2-2-3 digit grouping: ₹1,23,45,678.00
 * Pass `paise: false` to drop the decimal part, which is how balances are usually read.
 */
export function formatINR(paise: Paise, options: { paise?: boolean } = {}): string {
  assertPaise(paise);
  const rupees = paiseToRupees(paise);
  return options.paise === false ? inrFormatterNoPaise.format(rupees) : inrFormatter.format(rupees);
}

/**
 * Compact Indian notation — how the numbers are actually spoken.
 * 1_50_00_000_00 paise -> "₹1.50 Cr"
 */
export function formatCompactINR(paise: Paise, fractionDigits = 2): string {
  assertPaise(paise);
  const rupees = paiseToRupees(paise);
  const abs = Math.abs(rupees);
  const sign = rupees < 0 ? '-' : '';

  if (abs >= 1_00_00_000) return `${sign}₹${(abs / 1_00_00_000).toFixed(fractionDigits)} Cr`;
  if (abs >= 1_00_000) return `${sign}₹${(abs / 1_00_000).toFixed(fractionDigits)} L`;
  if (abs >= 1_000) return `${sign}₹${(abs / 1_000).toFixed(fractionDigits)} K`;
  return `${sign}₹${abs.toFixed(0)}`;
}

/** Sum paise amounts without leaving integer space. */
export function sumPaise(amounts: readonly Paise[]): Paise {
  let total = 0;
  for (const amount of amounts) {
    assertPaise(amount);
    total += amount;
  }
  if (!Number.isSafeInteger(total)) throw new MoneyError('Sum exceeded safe integer range');
  return total;
}

/**
 * Apply a ratio (an ownership percentage, an allocation weight) to a paise amount.
 * Rounds half away from zero so a 50/50 split of an odd amount never loses a paise
 * silently — use `splitPaise` when the parts must add back to the whole exactly.
 */
export function scalePaise(paise: Paise, ratio: number): Paise {
  assertPaise(paise);
  if (!Number.isFinite(ratio)) throw new MoneyError(`Invalid ratio: ${ratio}`);
  return Math.round(Math.abs(paise * ratio)) * Math.sign(paise * ratio || 1);
}

/**
 * Split an amount into weighted parts that sum back to exactly the original.
 * Remainder paise are distributed to the largest parts first (largest-remainder method),
 * so a joint asset split 1/3 : 2/3 never gains or loses a paise on the dashboard.
 */
export function splitPaise(paise: Paise, weights: readonly number[]): Paise[] {
  assertPaise(paise);
  if (weights.length === 0) throw new MoneyError('Cannot split across zero weights');

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) throw new MoneyError('Split weights must sum to a positive number');

  const exact = weights.map((w) => (paise * w) / totalWeight);
  const floored = exact.map((v) => Math.floor(v));
  let remainder = paise - floored.reduce((a, b) => a + b, 0);

  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);

  const result = [...floored];
  for (let k = 0; remainder > 0 && k < order.length; k += 1, remainder -= 1) {
    const idx = order[k]!.i;
    result[idx] = result[idx]! + 1;
  }
  return result;
}

/** Percentage of a total, guarding the zero-total case that shows up on an empty portfolio. */
export function percentOf(part: Paise, total: Paise): number {
  assertPaise(part);
  assertPaise(total);
  if (total === 0) return 0;
  return (part / total) * 100;
}
