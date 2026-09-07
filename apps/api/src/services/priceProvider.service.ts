/**
 * Price providers: AMFI NAV ingest and a pluggable stock quote source.
 *
 * `manual` is not a class in this file. It is the instrument-price and valuation write paths
 * that already exist — a holding priced by hand today keeps working exactly as it does, and
 * everything below only ever *adds* a fresher `market`-basis price for `valuation.service.ts`
 * to prefer. A provider that cannot reach the network, or an instrument neither provider
 * recognises, simply leaves that fallback in place.
 *
 * Both providers are pure functions of the text or JSON they are handed, with the actual
 * network call factored out to one line each — `fetchImpl`, injected and defaulted to the
 * global `fetch`. That is what lets the AMFI parser be tested against a fixture on disk and
 * the stock provider against a canned response, with nothing here ever making a real request
 * in a test run.
 */

import { eq, inArray } from 'drizzle-orm';
import {
  toMicro,
  type PriceRefreshResult,
  type PriceRefreshSource,
  type ProviderRunSummary,
} from '@networth/shared';
import type { AppContext } from '../context.js';
import { instrumentPrices, instruments, type InstrumentRow } from '../db/schema.js';
import { isoNow } from '../lib/time.js';
import { recordAudit } from './audit.service.js';

export interface RefreshDeps {
  fetchImpl?: typeof fetch;
}

/* -------------------------------------------------------------------------- */
/* AMFI                                                                       */
/* -------------------------------------------------------------------------- */

export interface AmfiQuote {
  schemeCode: string;
  navMicro: number;
  /** ISO `YYYY-MM-DD`. */
  date: string;
}

const MONTHS: Record<string, string> = {
  Jan: '01',
  Feb: '02',
  Mar: '03',
  Apr: '04',
  May: '05',
  Jun: '06',
  Jul: '07',
  Aug: '08',
  Sep: '09',
  Oct: '10',
  Nov: '11',
  Dec: '12',
};

/** `07-Sep-2026` → `2026-09-07`. Returns null for anything else, so a bad row is skipped. */
function parseAmfiDate(text: string): string | null {
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(text.trim());
  if (!match) return null;
  const [, day, monthName, year] = match;
  const month = MONTHS[monthName as string];
  if (!month) return null;
  return `${year}-${month}-${day}`;
}

/**
 * Parse AMFI's `NAVAll.txt`.
 *
 * The file is semicolon-delimited with no consistent header: scheme-category banners
 * ("Open Ended Schemes(Debt Scheme-Liquid Fund)"), blank separator lines and a closing
 * disclaimer are interleaved with the data rows. Rather than special-case every banner
 * shape, a row is kept only if its first field is a scheme code (digits) and its NAV field
 * parses as a number — which every real data row does and nothing else does.
 */
export function parseAmfiNavText(text: string): AmfiQuote[] {
  const quotes: AmfiQuote[] = [];

  for (const line of text.split('\n')) {
    const fields = line.split(';').map((field) => field.trim());
    if (fields.length < 6) continue;

    const [schemeCode, , , , navText, dateText] = fields;
    if (!schemeCode || !/^\d+$/.test(schemeCode)) continue;

    const nav = Number(navText);
    if (!Number.isFinite(nav) || nav <= 0) continue;

    const date = parseAmfiDate(dateText ?? '');
    if (!date) continue;

    quotes.push({ schemeCode, navMicro: toMicro(nav), date });
  }

  return quotes;
}

async function fetchAmfiText(ctx: AppContext, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(ctx.config.AMFI_NAV_URL);
  if (!response.ok) {
    throw new Error(`AMFI NAV fetch failed: HTTP ${response.status}`);
  }
  return response.text();
}

async function runAmfiProvider(
  ctx: AppContext,
  candidates: InstrumentRow[],
  fetchImpl: typeof fetch,
): Promise<ProviderRunSummary> {
  const summary: ProviderRunSummary = {
    provider: 'amfi',
    checked: candidates.length,
    matched: 0,
    updated: 0,
    errors: [],
  };
  if (candidates.length === 0) return summary;

  let text: string;
  try {
    text = await fetchAmfiText(ctx, fetchImpl);
  } catch (error) {
    summary.errors.push(error instanceof Error ? error.message : 'AMFI fetch failed');
    return summary;
  }

  const quotes = new Map(parseAmfiNavText(text).map((quote) => [quote.schemeCode, quote]));

  for (const instrument of candidates) {
    const quote = instrument.amfiSchemeCode ? quotes.get(instrument.amfiSchemeCode) : undefined;
    if (!quote) continue;
    summary.matched += 1;
    if (upsertPrice(ctx, instrument.id, quote.date, quote.navMicro, 'amfi')) summary.updated += 1;
  }

  return summary;
}

/* -------------------------------------------------------------------------- */
/* Stock (Yahoo-style)                                                        */
/* -------------------------------------------------------------------------- */

interface YahooQuoteResponse {
  quoteResponse?: {
    result?: Array<{ symbol: string; regularMarketPrice?: number }>;
  };
}

const EXCHANGE_SUFFIX: Record<string, string> = { nse: '.NS', bse: '.BO' };

async function runYahooProvider(
  ctx: AppContext,
  candidates: InstrumentRow[],
  fetchImpl: typeof fetch,
): Promise<ProviderRunSummary> {
  const summary: ProviderRunSummary = {
    provider: 'yahoo',
    checked: candidates.length,
    matched: 0,
    updated: 0,
    errors: [],
  };
  if (candidates.length === 0) return summary;

  const symbolFor = new Map<string, InstrumentRow>();
  for (const instrument of candidates) {
    const suffix = EXCHANGE_SUFFIX[instrument.exchange];
    if (!instrument.symbol || !suffix) continue;
    symbolFor.set(`${instrument.symbol}${suffix}`, instrument);
  }
  if (symbolFor.size === 0) return summary;

  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(
    [...symbolFor.keys()].join(','),
  )}`;

  let payload: YahooQuoteResponse;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = (await response.json()) as YahooQuoteResponse;
  } catch (error) {
    summary.errors.push(error instanceof Error ? error.message : 'Stock quote fetch failed');
    return summary;
  }

  const today = isoNow(ctx.now()).slice(0, 10);
  for (const quote of payload.quoteResponse?.result ?? []) {
    const instrument = symbolFor.get(quote.symbol);
    if (!instrument || typeof quote.regularMarketPrice !== 'number') continue;
    summary.matched += 1;
    if (upsertPrice(ctx, instrument.id, today, toMicro(quote.regularMarketPrice), 'yahoo')) {
      summary.updated += 1;
    }
  }

  return summary;
}

/* -------------------------------------------------------------------------- */
/* Orchestration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Run whichever providers `source` calls for, over every instrument they could plausibly
 * price, and write what they found.
 *
 * `source: 'stock'` is a no-op when `STOCK_PRICE_PROVIDER` is `manual` — there is nothing to
 * run, not a failure to report, so the result carries no entry for it at all rather than one
 * full of empty counts.
 */
export async function refreshPrices(
  ctx: AppContext,
  opts: { source: PriceRefreshSource },
  actorUserId: string | null,
  ip: string | null,
  deps: RefreshDeps = {},
): Promise<PriceRefreshResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const runs: ProviderRunSummary[] = [];

  if (opts.source === 'amfi' || opts.source === 'all') {
    const mfInstruments = ctx.db
      .select()
      .from(instruments)
      .where(eq(instruments.kind, 'mf'))
      .all()
      .filter((instrument) => instrument.amfiSchemeCode !== null);
    runs.push(await runAmfiProvider(ctx, mfInstruments, fetchImpl));
  }

  if (
    (opts.source === 'stock' || opts.source === 'all') &&
    ctx.config.STOCK_PRICE_PROVIDER === 'yahoo'
  ) {
    const stockInstruments = ctx.db
      .select()
      .from(instruments)
      .where(inArray(instruments.kind, ['equity', 'etf']))
      .all();
    runs.push(await runYahooProvider(ctx, stockInstruments, fetchImpl));
  }

  const result: PriceRefreshResult = { requestedAt: isoNow(ctx.now()), runs };

  recordAudit(ctx, {
    actorUserId,
    action: 'prices.refreshed',
    ip,
    meta: {
      source: opts.source,
      updated: runs.reduce((total, run) => total + run.updated, 0),
    },
  });

  return result;
}

/** Write one price, and report whether the row was new or changed. */
function upsertPrice(
  ctx: AppContext,
  instrumentId: string,
  date: string,
  priceMicro: number,
  source: 'amfi' | 'yahoo',
): boolean {
  const existing = ctx.sqlite
    .prepare<[string, string], { price_micro: number; source: string }>(
      'SELECT price_micro, source FROM instrument_prices WHERE instrument_id = ? AND date = ?',
    )
    .get(instrumentId, date);

  if (existing && existing.price_micro === priceMicro && existing.source === source) return false;

  ctx.db
    .insert(instrumentPrices)
    .values({
      instrumentId,
      date,
      priceMicro,
      source,
      createdAt: isoNow(ctx.now()),
    })
    .onConflictDoUpdate({
      target: [instrumentPrices.instrumentId, instrumentPrices.date],
      set: { priceMicro, source },
    })
    .run();

  return true;
}
