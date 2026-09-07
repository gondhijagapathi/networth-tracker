/**
 * Display formatting.
 *
 * The money formatters live in `@networth/shared` because the server needs them too. What
 * is here is the part that is only ever seen: labels, dates as a person reads them, and the
 * colour a number should be.
 */

import {
  ASSET_CLASS_LABELS,
  LIQUIDITY_LABELS,
  formatCompactINR,
  formatINR,
  type AssetClass,
  type AssetStatus,
  type AssetType,
  type ValuationBasis,
} from '@networth/shared';

export { ASSET_CLASS_LABELS, LIQUIDITY_LABELS, formatCompactINR, formatINR };

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  bank_account: 'Bank account',
  deposit: 'Deposit',
  holding: 'Fund or share',
  insurance_policy: 'Insurance',
  property: 'Property',
  retirement_account: 'Retirement',
  precious_metal: 'Gold & metals',
  other_asset: 'Other',
  liability: 'Loan',
};

/** Plural headings for the asset list's groups and filter chips. */
export const ASSET_TYPE_PLURALS: Record<AssetType, string> = {
  bank_account: 'Bank accounts',
  deposit: 'Deposits',
  holding: 'Funds & shares',
  insurance_policy: 'Insurance',
  property: 'Property',
  retirement_account: 'Retirement',
  precious_metal: 'Gold & metals',
  other_asset: 'Other assets',
  liability: 'Loans',
};

export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  active: 'Active',
  closed: 'Closed',
  archived: 'Archived',
};

/**
 * Where a number came from, said out loud.
 *
 * Shown next to every value on purpose. "₹6,17,432" and "₹6,17,432, accrued" are different
 * claims, and a tracker that presents a model's output as a fact is one you stop trusting
 * the first time it is wrong.
 */
export const BASIS_LABELS: Record<ValuationBasis, string> = {
  manual: 'You entered this',
  market: 'Market price',
  accrued: 'Accrued from the terms',
  balance: 'Recorded balance',
  outstanding: 'Outstanding balance',
  none: 'Not valued yet',
};

/**
 * Chart colours, one per asset class.
 *
 * Deliberately not the gain/loss green and red — a pie slice that happens to be red should
 * not read as a loss. These are drawn from the same oklch family as the brand token so they
 * stay legible against both the light and the dark surface.
 */
export const CLASS_COLOURS: Record<AssetClass, string> = {
  equity: 'oklch(0.62 0.2 280)',
  debt: 'oklch(0.66 0.14 220)',
  cash: 'oklch(0.72 0.13 195)',
  hybrid: 'oklch(0.68 0.15 315)',
  gold: 'oklch(0.78 0.15 75)',
  real_estate: 'oklch(0.66 0.14 150)',
  crypto: 'oklch(0.7 0.16 45)',
  insurance: 'oklch(0.6 0.09 265)',
  other: 'oklch(0.62 0.03 265)',
};

/** A palette for dimensions that have no fixed set of keys — institutions, mostly. */
export const SERIES_COLOURS = [
  'oklch(0.62 0.2 280)',
  'oklch(0.66 0.14 220)',
  'oklch(0.72 0.13 195)',
  'oklch(0.78 0.15 75)',
  'oklch(0.66 0.14 150)',
  'oklch(0.68 0.15 315)',
  'oklch(0.7 0.16 45)',
  'oklch(0.62 0.03 265)',
];

export function colourFor(key: string, index: number): string {
  return CLASS_COLOURS[key as AssetClass] ?? SERIES_COLOURS[index % SERIES_COLOURS.length]!;
}

/** `2026-09-06` → `6 Sep 2026`. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** Axis ticks want `Sep '26`, not the whole date. */
export function formatMonth(iso: string): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  const month = new Intl.DateTimeFormat('en-IN', { month: 'short', timeZone: 'UTC' }).format(date);
  return `${month} '${iso.slice(2, 4)}`;
}

/** A ratio as a percentage: `0.1234` → `12.3%`. */
export function formatPercent(ratio: number | null | undefined, fractionDigits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(fractionDigits)}%`;
}

/** A signed change, with the sign a reader expects rather than the one `toFixed` gives. */
export function formatSignedINR(paise: number): string {
  const rendered = formatCompactINR(Math.abs(paise));
  return paise < 0 ? `−${rendered}` : `+${rendered}`;
}

/** The CSS colour for a gain or a loss. Zero is neither, and should not be green. */
export function toneOf(value: number): string {
  if (value > 0) return 'var(--color-gain)';
  if (value < 0) return 'var(--color-loss)';
  return 'var(--text-secondary)';
}
