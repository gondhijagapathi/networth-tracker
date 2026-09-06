/**
 * Quantities and per-unit prices.
 *
 * Money is paise (see `money.ts`), but two things in a portfolio are not money and cannot
 * be integers of it:
 *
 *   - **Units.** A mutual fund holding is `1234.567` units, not a whole number of anything.
 *   - **Per-unit prices.** AMFI publishes NAV to four decimal places: `₹123.4567`. Rounding
 *     that to paise before multiplying by ten thousand units loses real rupees.
 *
 * Both are stored as integers at a fixed scale of one million — "micro" units and micro
 * rupees. The scale is shared so that `units × price` is a plain integer multiplication and
 * the only rounding in the whole chain happens once, at the end, on the way to paise.
 */

import { MoneyError, type Paise } from './money.js';

/** Fixed-point scale for both units and per-unit prices: six decimal places. */
export const MICRO = 1_000_000;

/** Units of a holding, scaled by {@link MICRO}. 1.5 units is `1_500_000`. */
export type MicroUnits = number;

/** A per-unit price in micro-rupees. NAV ₹123.4567 is `123_456_700`. */
export type MicroRupees = number;

function assertScaled(value: unknown, what: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new MoneyError(`Expected an integer ${what}, received: ${String(value)}`);
  }
}

/**
 * Scale a decimal quantity for storage, rounding half away from zero.
 *
 * Anything beyond six decimals is below the precision any registrar or exchange reports,
 * so discarding it is a decision rather than an accident.
 */
export function toMicro(value: number): number {
  if (!Number.isFinite(value)) {
    throw new MoneyError(`Cannot scale non-finite value: ${value}`);
  }
  const scaled = Math.round(Math.abs(value) * MICRO) * Math.sign(value);
  if (!Number.isSafeInteger(scaled)) {
    throw new MoneyError(`Value out of safe range: ${value}`);
  }
  return scaled;
}

/** Back to a decimal number. For display and ratios only — never for storage. */
export function fromMicro(scaled: number): number {
  assertScaled(scaled, 'scaled value');
  return scaled / MICRO;
}

export function assertMicroUnits(value: unknown): asserts value is MicroUnits {
  assertScaled(value, 'unit count');
}

export function assertMicroRupees(value: unknown): asserts value is MicroRupees {
  assertScaled(value, 'price');
}

/**
 * Value a holding: units × price, rounded to the nearest paise exactly once.
 *
 * `units × price` carries twelve decimal places between two integers scaled by a million
 * each, which is why the division is by `MICRO * MICRO / PAISE_PER_RUPEE` rather than a
 * pair of separate roundings.
 */
export function valueOf(units: MicroUnits, price: MicroRupees): Paise {
  assertMicroUnits(units);
  assertMicroRupees(price);

  // Divide by the unit scale first: `units * price` alone overflows the safe integer range
  // for any realistic holding (10,000 units at ₹100 is already 10^18).
  const rupees = (units / MICRO) * (price / MICRO);
  const paise = Math.round(Math.abs(rupees) * 100) * Math.sign(rupees);

  if (!Number.isSafeInteger(paise)) {
    throw new MoneyError(`Holding value out of safe range: ${units} units at ${price}`);
  }
  return paise;
}

/** A per-unit price in micro-rupees, from a paise amount. `₹123.45` -> `123_450_000`. */
export function paiseToMicroRupees(paise: Paise): MicroRupees {
  return toMicro(paise / 100);
}

/**
 * The average cost of a position after adding units at a price.
 *
 * Weighted by units, which is what "average cost" means for a SIP: twelve instalments at
 * twelve different NAVs, and the cost basis is the total paid over the total units held.
 */
export function blendAverageCost(
  heldUnits: MicroUnits,
  heldAverage: MicroRupees,
  addedUnits: MicroUnits,
  addedPrice: MicroRupees,
): MicroRupees {
  assertMicroUnits(heldUnits);
  assertMicroUnits(addedUnits);
  assertMicroRupees(heldAverage);
  assertMicroRupees(addedPrice);

  const total = heldUnits + addedUnits;
  if (total <= 0) return 0;

  const cost = (heldUnits / MICRO) * heldAverage + (addedUnits / MICRO) * addedPrice;
  return Math.round(cost / (total / MICRO));
}
