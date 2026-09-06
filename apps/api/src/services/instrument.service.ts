/**
 * Instruments — the schemes, shares, ETFs and bonds a holding can be in.
 *
 * Deliberately *not* scoped. An instrument is public reference data: two users holding the
 * same fund point at one row, so one NAV import revalues both portfolios and a search sees
 * everything already known to this instance. Nothing personal lives here — the units, folio
 * and cost basis are on `holdings`, which is scoped.
 *
 * Creation is find-or-create rather than insert-or-conflict. A second user adding the fund
 * their spouse already added wants that fund, not an error, and a duplicate row would
 * silently split the NAV history in two.
 */

import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import {
  uuidv7,
  type CreateInstrumentBody,
  type InstrumentQuery,
  type InstrumentRecord,
  type ValuationSource,
} from '@networth/shared';
import type { AppContext } from '../context.js';
import { instruments, type InstrumentRow } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { isoNow } from '../lib/time.js';
import { recordAudit } from './audit.service.js';

export interface LatestPrice {
  priceMicro: number;
  date: string;
  source: ValuationSource;
}

export function searchInstruments(ctx: AppContext, query: InstrumentQuery): InstrumentRecord[] {
  const filters: SQL[] = [];
  if (query.kind) filters.push(eq(instruments.kind, query.kind));

  if (query.q) {
    // Autocomplete: a scheme is found by what the user is holding a statement of — its name,
    // its AMFI code, its ISIN or its ticker.
    const pattern = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    filters.push(
      sql`(${instruments.name} like ${pattern} escape '\\'
        or coalesce(${instruments.amfiSchemeCode}, '') like ${pattern} escape '\\'
        or coalesce(${instruments.isin}, '') like ${pattern} escape '\\'
        or coalesce(${instruments.symbol}, '') like ${pattern} escape '\\')`,
    );
  }

  const rows = ctx.db
    .select()
    .from(instruments)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(instruments.name)
    .limit(query.limit)
    .all();

  const prices = latestPrices(
    ctx,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toRecord(row, prices.get(row.id) ?? null));
}

export function getInstrument(ctx: AppContext, instrumentId: string): InstrumentRecord {
  const row = ctx.db.select().from(instruments).where(eq(instruments.id, instrumentId)).get();
  if (!row) throw notFound('No such instrument');
  return toRecord(row, latestPrices(ctx, [row.id]).get(row.id) ?? null);
}

/**
 * Find an instrument by any of its identifiers, or create it.
 *
 * @returns the instrument and whether this call is what created it, so the route can answer
 *          `201` or `200` honestly.
 */
export function findOrCreateInstrument(
  ctx: AppContext,
  actorUserId: string,
  body: CreateInstrumentBody,
  ip: string | null,
): { instrument: InstrumentRecord; created: boolean } {
  const identifiers: SQL[] = [];
  if (body.amfiSchemeCode) identifiers.push(eq(instruments.amfiSchemeCode, body.amfiSchemeCode));
  if (body.isin) identifiers.push(eq(instruments.isin, body.isin));
  // A ticker is only unique within an exchange — `SBIN` on the NSE and the BSE are the same
  // company but different rows to a price provider.
  if (body.symbol) {
    identifiers.push(
      and(eq(instruments.symbol, body.symbol), eq(instruments.exchange, body.exchange))!,
    );
  }

  const existing =
    identifiers.length > 0
      ? ctx.db
          .select()
          .from(instruments)
          .where(or(...identifiers))
          .get()
      : undefined;

  if (existing) {
    return {
      instrument: toRecord(existing, latestPrices(ctx, [existing.id]).get(existing.id) ?? null),
      created: false,
    };
  }

  const now = isoNow(ctx.now());
  const row: InstrumentRow = {
    id: uuidv7(ctx.now().getTime()),
    kind: body.kind,
    name: body.name,
    amfiSchemeCode: body.amfiSchemeCode ?? null,
    isin: body.isin ?? null,
    symbol: body.symbol ?? null,
    exchange: body.exchange,
    amc: body.amc ?? null,
    category: body.category ?? null,
    createdAt: now,
    updatedAt: now,
  };

  ctx.db.insert(instruments).values(row).run();

  recordAudit(ctx, {
    actorUserId,
    action: 'instrument.created',
    entityType: 'instrument',
    entityId: row.id,
    ip,
    meta: { kind: row.kind, amfiSchemeCode: row.amfiSchemeCode, symbol: row.symbol },
  });

  return { instrument: toRecord(row, null), created: true };
}

/**
 * The most recent price of each instrument.
 *
 * The same window-function shape as `latestValues` in the asset repository, for the same
 * reason: one pass, and a same-day correction wins over what it corrected.
 */
export function latestPrices(ctx: AppContext, instrumentIds: string[]): Map<string, LatestPrice> {
  const result = new Map<string, LatestPrice>();
  if (instrumentIds.length === 0) return result;

  const placeholders = instrumentIds.map(() => '?').join(', ');
  const rows = ctx.sqlite
    .prepare<
      string[],
      { instrument_id: string; price_micro: number; date: string; source: string }
    >(
      `SELECT instrument_id, price_micro, date, source
         FROM (
           SELECT instrument_id, price_micro, date, source,
                  row_number() OVER (
                    PARTITION BY instrument_id ORDER BY date DESC, created_at DESC
                  ) AS rn
             FROM instrument_prices
            WHERE instrument_id IN (${placeholders})
         )
        WHERE rn = 1`,
    )
    .all(...instrumentIds);

  for (const row of rows) {
    result.set(row.instrument_id, {
      priceMicro: row.price_micro,
      date: row.date,
      source: row.source as ValuationSource,
    });
  }
  return result;
}

function toRecord(row: InstrumentRow, latestPrice: LatestPrice | null): InstrumentRecord {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    amfiSchemeCode: row.amfiSchemeCode,
    isin: row.isin,
    symbol: row.symbol,
    exchange: row.exchange,
    amc: row.amc,
    category: row.category,
    latestPrice,
  };
}
