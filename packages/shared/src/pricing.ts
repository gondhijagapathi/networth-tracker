/**
 * Price provider contracts.
 *
 * `manual` needs no entry here — it is the existing valuation and instrument-price write
 * paths, and it is why a household with zero provider coverage still works. What this file
 * describes is the two providers that refresh `instrument_prices` on their own: the AMFI
 * NAV dump for mutual funds, and a pluggable stock quote source for equity and ETFs. Both
 * write rows with a `source` a holding's valuation already knows how to prefer over a stale
 * manual entry — see `valuation.service.ts` on the API side.
 */

import { z } from 'zod';

export const PRICE_REFRESH_SOURCES = ['amfi', 'stock', 'all'] as const;
export const priceRefreshSourceSchema = z.enum(PRICE_REFRESH_SOURCES);
export type PriceRefreshSource = z.infer<typeof priceRefreshSourceSchema>;

export const refreshPricesSchema = z.object({
  source: priceRefreshSourceSchema.default('all'),
});
export type RefreshPricesBody = z.infer<typeof refreshPricesSchema>;

/** One provider's pass over the instruments it can price. */
export interface ProviderRunSummary {
  provider: 'amfi' | 'yahoo';
  /** Instruments this provider was asked about. */
  checked: number;
  /** Quotes the provider actually returned. */
  matched: number;
  /** `instrument_prices` rows written or changed as a result. */
  updated: number;
  /** Human-readable failures. A provider that cannot reach the network reports one entry
   *  here rather than throwing — a failed refresh must not take the rest of the app down,
   *  and manual entry stays available regardless. */
  errors: string[];
}

export interface PriceRefreshResult {
  requestedAt: string;
  runs: ProviderRunSummary[];
}

/**
 * A holding's price is worth flagging once it is this many days behind `asOf`.
 *
 * Five calendar days rather than a strict "yesterday": AMFI does not publish over a weekend
 * or a market holiday, and a badge that lights up every Saturday teaches people to ignore it.
 */
export const STALE_PRICE_DAYS = 5;
