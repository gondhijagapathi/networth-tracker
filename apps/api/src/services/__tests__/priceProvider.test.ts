/**
 * Price providers.
 *
 * The AMFI parser is exercised against a fixture shaped like the real `NAVAll.txt` — category
 * banners, a blank separator and a disclaimer footer included — because that noise is exactly
 * what a naive "split every line on `;`" parser trips over. The refresh orchestration is
 * exercised through the real `/api/instruments/refresh` route with an injected `fetchImpl`,
 * so nothing here ever makes a real network call.
 */

import { describe, expect, it } from 'vitest';
import {
  TestClient,
  createTestInstance,
  registerAdmin,
  type TestInstance,
} from '../../__tests__/harness.js';
import { parseAmfiNavText, refreshPrices } from '../priceProvider.service.js';

const NAV_ALL_FIXTURE = `Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date

Open Ended Schemes(Debt Scheme-Liquid Fund)

119551;INF209K01157;-;Aditya Birla Sun Life Liquid Fund-Growth;123.4567;07-Sep-2026
120503;-;INF090I01239;Test Flexi Cap Fund-Growth;456.7891;07-Sep-2026
999999;-;-;A scheme with a bad NAV;not-a-number;07-Sep-2026

Open Ended Schemes(Equity Scheme-Flexi Cap Fund)

120504;-;-;Test Flexi Cap Fund-IDCW;10.0000;07-Sep-2026

Mutual Fund investments are subject to market risks, read all scheme related documents carefully.
`;

describe('parseAmfiNavText', () => {
  it('keeps only real data rows, in micro-rupees, with an ISO date', () => {
    const quotes = parseAmfiNavText(NAV_ALL_FIXTURE);

    expect(quotes).toContainEqual({
      schemeCode: '119551',
      navMicro: 123_456_700,
      date: '2026-09-07',
    });
    expect(quotes).toContainEqual({
      schemeCode: '120503',
      navMicro: 456_789_100,
      date: '2026-09-07',
    });
  });

  it('skips a row whose NAV is not a number, and every non-data line', () => {
    const quotes = parseAmfiNavText(NAV_ALL_FIXTURE);
    expect(quotes.find((q) => q.schemeCode === '999999')).toBeUndefined();
    expect(quotes).toHaveLength(3);
  });

  it('returns nothing for an empty or header-only file', () => {
    expect(parseAmfiNavText('')).toEqual([]);
    expect(parseAmfiNavText('Scheme Code;ISIN;ISIN;Scheme Name;Net Asset Value;Date')).toEqual([]);
  });
});

describe('refreshPrices — AMFI', () => {
  let instance: TestInstance;
  let admin: TestClient;

  async function setup() {
    instance = createTestInstance();
    admin = await registerAdmin(instance);
    const instrument = await admin.post('/api/instruments', {
      kind: 'mf',
      name: 'Test Flexi Cap Fund',
      amfiSchemeCode: '120503',
    });
    return instrument.body.instrument.id as string;
  }

  it('writes a fresh market price for a matched instrument via the refresh endpoint', async () => {
    const instrumentId = await setup();
    const fetchImpl = (async () =>
      new Response(NAV_ALL_FIXTURE, { status: 200 })) as unknown as typeof fetch;

    const result = await refreshPrices(instance.ctx, { source: 'amfi' }, admin.user!.id, null, {
      fetchImpl,
    });

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ provider: 'amfi', checked: 1, matched: 1, updated: 1 });

    const fetched = await admin.get(`/api/instruments/${instrumentId}`);
    expect(fetched.body.instrument.latestPrice).toMatchObject({
      priceMicro: 456_789_100,
      date: '2026-09-07',
      source: 'amfi',
    });
    instance.close();
  });

  it('leaves manual pricing untouched and reports an error when the fetch fails', async () => {
    await setup();
    const fetchImpl = (async () => {
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;

    const result = await refreshPrices(instance.ctx, { source: 'amfi' }, admin.user!.id, null, {
      fetchImpl,
    });

    expect(result.runs[0]).toMatchObject({ matched: 0, updated: 0 });
    expect(result.runs[0]?.errors[0]).toMatch(/network unreachable/);
    instance.close();
  });

  it('does not update a price that already matches, and does count a changed one', async () => {
    const instrumentId = await setup();
    const fetchImpl = (async () =>
      new Response(NAV_ALL_FIXTURE, { status: 200 })) as unknown as typeof fetch;

    await refreshPrices(instance.ctx, { source: 'amfi' }, admin.user!.id, null, { fetchImpl });
    const second = await refreshPrices(instance.ctx, { source: 'amfi' }, admin.user!.id, null, {
      fetchImpl,
    });
    expect(second.runs[0]).toMatchObject({ matched: 1, updated: 0 });

    const changedFixture = NAV_ALL_FIXTURE.replace('456.7891', '460.0000');
    const third = await refreshPrices(instance.ctx, { source: 'amfi' }, admin.user!.id, null, {
      fetchImpl: (async () =>
        new Response(changedFixture, { status: 200 })) as unknown as typeof fetch,
    });
    expect(third.runs[0]).toMatchObject({ matched: 1, updated: 1 });

    const fetched = await admin.get(`/api/instruments/${instrumentId}`);
    expect(fetched.body.instrument.latestPrice.priceMicro).toBe(460_000_000);
    instance.close();
  });

  it('skips instruments a provider has nothing to say about, leaving them for manual entry', async () => {
    instance = createTestInstance();
    admin = await registerAdmin(instance);
    await admin.post('/api/instruments', {
      kind: 'mf',
      name: 'A fund AMFI does not list in this fixture',
      amfiSchemeCode: '000001',
    });

    const fetchImpl = (async () =>
      new Response(NAV_ALL_FIXTURE, { status: 200 })) as unknown as typeof fetch;
    const result = await refreshPrices(instance.ctx, { source: 'amfi' }, admin.user!.id, null, {
      fetchImpl,
    });

    expect(result.runs[0]).toMatchObject({ checked: 1, matched: 0, updated: 0 });
    instance.close();
  });
});

describe('refreshPrices — stock provider gating', () => {
  it('runs no stock provider at all while STOCK_PRICE_PROVIDER is manual', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance);
    await admin.post('/api/instruments', {
      kind: 'equity',
      name: 'Test Bank Ltd',
      symbol: 'TESTBANK',
      exchange: 'nse',
    });

    const result = await refreshPrices(instance.ctx, { source: 'all' }, admin.user!.id, null, {
      fetchImpl: (async () => {
        throw new Error('must not be called');
      }) as unknown as typeof fetch,
    });

    expect(result.runs.map((run) => run.provider)).toEqual(['amfi']);
    instance.close();
  });

  it('prices equities by symbol when the provider is yahoo', async () => {
    const instance = createTestInstance({ STOCK_PRICE_PROVIDER: 'yahoo' });
    const admin = await registerAdmin(instance);
    const instrument = await admin.post('/api/instruments', {
      kind: 'equity',
      name: 'Test Bank Ltd',
      symbol: 'TESTBANK',
      exchange: 'nse',
    });
    const instrumentId = instrument.body.instrument.id as string;

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          quoteResponse: { result: [{ symbol: 'TESTBANK.NS', regularMarketPrice: 512.5 }] },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const result = await refreshPrices(instance.ctx, { source: 'stock' }, admin.user!.id, null, {
      fetchImpl,
    });

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ provider: 'yahoo', matched: 1, updated: 1 });

    const fetched = await admin.get(`/api/instruments/${instrumentId}`);
    expect(fetched.body.instrument.latestPrice.priceMicro).toBe(512_500_000);
    instance.close();
  });
});

describe('POST /api/instruments/refresh', () => {
  it('requires authentication and defaults to refreshing everything', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance);

    const anonymous = new TestClient(instance.app);
    expect((await anonymous.post('/api/instruments/refresh')).status).toBe(401);

    const response = await admin.post('/api/instruments/refresh');
    expect(response.status).toBe(200);
    expect(response.body.runs).toEqual(expect.any(Array));
    instance.close();
  });
});
