/**
 * Dashboard and analytics endpoints.
 *
 * Three things are worth testing here and the rest is arithmetic already covered by the
 * shared package's own tests:
 *
 *   1. **The numbers agree with each other.** The summary card, the allocation total and
 *      the last point on the net worth line are one figure computed once, and a regression
 *      that makes them disagree is the kind a user reports as "the dashboard is lying".
 *   2. **A deposit is accrued rather than remembered**, and a holding is priced — the two
 *      reasons this application computes value instead of echoing it back.
 *   3. **The scope holds.** Analytics reads across every asset a caller can see, which
 *      makes it the widest read in the codebase and the easiest place to leak.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7, type AccessScope, type DashboardResponse } from '@networth/shared';
import { accessGrants, instrumentPrices } from '../db/schema.js';
import { isoNow } from '../lib/time.js';
import {
  TestClient,
  createTestInstance,
  registerAdmin,
  registerMember,
  type TestInstance,
} from './harness.js';

let instance: TestInstance;
let admin: TestClient;
let alice: TestClient;
let bob: TestClient;

beforeEach(async () => {
  instance = createTestInstance();
  admin = await registerAdmin(instance);
  alice = await registerMember(instance, admin, { email: 'alice@example.com', name: 'Alice' });
  bob = await registerMember(instance, admin, { email: 'bob@example.com', name: 'Bob' });
});

afterEach(() => {
  instance.close();
});

const TODAY = isoNowDate();

function isoNowDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Some date safely in the past, for opening balances and start dates. */
function yearsAgo(years: number): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

/** The day after an ISO date, for checking an inclusive bound from both sides. */
function addDay(iso: string): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

async function createAsset(
  client: TestClient,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  const response = await client.post('/api/assets', body);
  if (response.status !== 201) {
    throw new Error(`Create failed: ${response.status} ${response.text}`);
  }
  return { id: response.body.asset.id as string };
}

async function dashboardOf(client: TestClient, query = ''): Promise<DashboardResponse> {
  const response = await client.get(`/api/analytics/dashboard${query}`);
  expect(response.status).toBe(200);
  return response.body as DashboardResponse;
}

/** Insert a grant directly: the flows that create these arrive in P5 and P6. */
function grant(scope: AccessScope): void {
  instance.ctx.db
    .insert(accessGrants)
    .values({
      id: uuidv7(),
      ownerUserId: alice.user!.id,
      granteeUserId: bob.user!.id,
      scope,
      source: 'manual',
      grantedAt: isoNow(instance.ctx.now()),
      expiresAt: null,
      revokedAt: null,
    })
    .run();
}

describe('an empty portfolio', () => {
  it('answers with zeros rather than failing', async () => {
    const body = await dashboardOf(alice);

    expect(body.summary.netPaise).toBe(0);
    expect(body.summary.assetCount).toBe(0);
    // No earlier figure exists, so there is no change to report — not "+100%".
    expect(body.summary.month).toBeNull();
    expect(body.summary.year).toBeNull();
    expect(body.allocation.slices).toEqual([]);
    expect(body.risk.emergencyFundMonths).toBeNull();
    expect(body.series.length).toBeGreaterThan(0);
    expect(body.series.at(-1)!.netPaise).toBe(0);
  });
});

describe('net worth', () => {
  it('adds up assets, subtracts liabilities and agrees with its own chart', async () => {
    await createAsset(alice, {
      name: 'Savings',
      type: 'bank_account',
      institution: 'HDFC Bank',
      valuePaise: 5_00_000_00,
      valueAsOf: TODAY,
      detail: { accountType: 'savings' },
    });
    await createAsset(alice, {
      name: 'Home loan',
      type: 'liability',
      institution: 'HDFC Bank',
      detail: {
        kind: 'home',
        lender: 'HDFC',
        principalPaise: 50_00_000_00,
        outstandingPaise: 32_00_000_00,
        rateBps: 865,
        emiPaise: 45_000_00,
      },
    });

    const body = await dashboardOf(alice);

    expect(body.summary.assetsPaise).toBe(5_00_000_00);
    expect(body.summary.liabilitiesPaise).toBe(32_00_000_00);
    expect(body.summary.netPaise).toBe(-27_00_000_00);
    expect(body.summary.assetCount).toBe(1);
    expect(body.summary.liabilityCount).toBe(1);

    // The last point on the chart is the summary card. If these ever disagree the
    // dashboard is contradicting itself on screen.
    expect(body.series.at(-1)!.netPaise).toBe(body.summary.netPaise);
    // A loan is not somewhere money is, so it is not a slice of the allocation.
    expect(body.allocation.totalPaise).toBe(5_00_000_00);
  });

  it('counts a joint asset once, at the share that is actually owned', async () => {
    await createAsset(alice, {
      name: 'Flat',
      type: 'property',
      ownershipBps: 5_000,
      valuePaise: 1_00_00_000_00,
      valueAsOf: TODAY,
      detail: { kind: 'flat' },
    });

    const body = await dashboardOf(alice);
    expect(body.summary.assetsPaise).toBe(50_00_000_00);
    expect(body.allocation.slices[0]!.valuePaise).toBe(50_00_000_00);
  });

  it('says how many assets nobody has valued', async () => {
    await createAsset(alice, { name: 'Land in Kolar', type: 'property', detail: { kind: 'land' } });

    const body = await dashboardOf(alice);
    expect(body.summary.assetsPaise).toBe(0);
    // The number that keeps the total honest rather than quietly counting zero.
    expect(body.summary.unvaluedCount).toBe(1);
  });
});

describe('deposits are accrued, not remembered', () => {
  it('is worth more than was paid in, with nothing typed in since', async () => {
    // ₹5,00,000 at 7.1% compounded quarterly, opened three years ago and never revalued.
    await createAsset(alice, {
      name: 'SBI fixed deposit',
      type: 'deposit',
      institution: 'SBI',
      detail: {
        kind: 'fd',
        principalPaise: 5_00_000_00,
        rateBps: 710,
        compounding: 'quarterly',
        startedOn: yearsAgo(3),
        maturesOn: '2099-01-01',
      },
    });

    const body = await dashboardOf(alice);

    // Three years of compounding at 7.1% is about ₹6.17 lakh. A tracker that echoed the
    // principal back would report ₹5,00,000 and be a lakh out.
    expect(body.summary.assetsPaise).toBeGreaterThan(6_10_000_00);
    expect(body.summary.assetsPaise).toBeLessThan(6_25_000_00);

    const [deposit] = body.allocation.slices;
    expect(deposit!.key).toBe('debt');
  });

  it('curves upward through the chart instead of sitting flat', async () => {
    await createAsset(alice, {
      name: 'Fixed deposit',
      type: 'deposit',
      detail: {
        kind: 'fd',
        principalPaise: 10_00_000_00,
        rateBps: 750,
        compounding: 'quarterly',
        startedOn: yearsAgo(5),
      },
    });

    const { series } = await dashboardOf(alice, '?months=24');
    const rising = series.every(
      (point, index) => index === 0 || point.netPaise >= series[index - 1]!.netPaise,
    );
    expect(rising).toBe(true);
    expect(series.at(-1)!.netPaise).toBeGreaterThan(series[0]!.netPaise);
  });

  it('is anchored on a statement the owner reconciled', async () => {
    // A manual valuation is better information than the terms, so the engine carries it
    // forward rather than discarding it — or being frozen by it.
    const asset = await createAsset(alice, {
      name: 'Fixed deposit',
      type: 'deposit',
      detail: {
        kind: 'fd',
        principalPaise: 1_00_000_00,
        rateBps: 700,
        compounding: 'quarterly',
        startedOn: yearsAgo(5),
      },
    });

    const before = (await dashboardOf(alice)).summary.assetsPaise;

    const statement = await alice.post(`/api/assets/${asset.id}/valuations`, {
      asOf: yearsAgo(1),
      valuePaise: 3_00_000_00,
    });
    expect(statement.status).toBe(201);

    const after = (await dashboardOf(alice)).summary.assetsPaise;
    // The statement wins over the model's own history…
    expect(after).toBeGreaterThan(before);
    // …and the year since it was written has still earned interest.
    expect(after).toBeGreaterThan(3_00_000_00);
    expect(after).toBeLessThan(3_30_000_00);
  });
});

describe('holdings are priced', () => {
  async function fundWithPrice(priceMicro: number): Promise<{ id: string }> {
    const instrument = await alice.post('/api/instruments', {
      kind: 'mf',
      name: 'Test Flexi Cap Fund',
      amfiSchemeCode: '120503',
      category: 'Equity Scheme - Flexi Cap Fund',
    });
    const instrumentId = instrument.body.instrument.id as string;

    instance.ctx.db
      .insert(instrumentPrices)
      .values({ instrumentId, date: TODAY, priceMicro, source: 'amfi' })
      .run();

    return createAsset(alice, {
      name: 'Flexi cap fund',
      type: 'holding',
      institution: 'Zerodha',
      detail: { instrumentId, units: 1_000_000_000, avgCostMicro: 98_500_000 },
    });
  }

  it('values units at the most recent NAV', async () => {
    // 1,000 units at a NAV of ₹123.4567.
    await fundWithPrice(123_456_700);

    const body = await dashboardOf(alice);
    expect(body.summary.assetsPaise).toBe(1_23_456_70);
    expect(body.allocation.slices[0]!.key).toBe('equity');
  });

  it('falls back to what was paid when no NAV has ever been imported', async () => {
    const instrument = await alice.post('/api/instruments', {
      kind: 'mf',
      name: 'Unpriced Fund',
      amfiSchemeCode: '999999',
    });
    await createAsset(alice, {
      name: 'Unpriced fund',
      type: 'holding',
      detail: {
        instrumentId: instrument.body.instrument.id as string,
        units: 1_000_000_000,
        avgCostMicro: 100_000_000,
      },
    });

    const body = await dashboardOf(alice);
    expect(body.summary.assetsPaise).toBe(1_00_000_00);
  });
});

describe('allocation', () => {
  beforeEach(async () => {
    await createAsset(alice, {
      name: 'Savings',
      type: 'bank_account',
      institution: 'HDFC Bank',
      valuePaise: 2_00_000_00,
      valueAsOf: TODAY,
      detail: { accountType: 'savings' },
    });
    await createAsset(alice, {
      name: 'Fixed deposit',
      type: 'deposit',
      institution: 'HDFC Bank',
      valuePaise: 8_00_000_00,
      valueAsOf: TODAY,
      detail: {
        kind: 'fd',
        principalPaise: 8_00_000_00,
        rateBps: 0,
        compounding: 'quarterly',
        startedOn: TODAY,
      },
    });
  });

  it('groups by class, largest first, with shares that sum to one', async () => {
    const response = await alice.get('/api/analytics/allocation?by=class');
    expect(response.status).toBe(200);

    const { allocation } = response.body;
    expect(allocation.totalPaise).toBe(10_00_000_00);
    expect(allocation.slices[0]!.key).toBe('debt');
    expect(allocation.slices[1]!.key).toBe('cash');
    expect(
      allocation.slices.reduce((sum: number, slice: { share: number }) => sum + slice.share, 0),
    ).toBeCloseTo(1, 6);
  });

  it('pools one institution across asset types', async () => {
    // The point of the institution view: one bank failing is one row, not two.
    const response = await alice.get('/api/analytics/allocation?by=institution');
    const slices = response.body.allocation.slices as Array<{ key: string; valuePaise: number }>;

    expect(slices).toHaveLength(1);
    expect(slices[0]!.key).toBe('hdfc bank');
    expect(slices[0]!.valuePaise).toBe(10_00_000_00);
  });

  it('answers every dimension in one round trip', async () => {
    const response = await alice.get('/api/analytics/allocation/all');
    expect(response.status).toBe(200);
    expect(Object.keys(response.body.allocations).sort()).toEqual([
      'class',
      'institution',
      'liquidity',
      'type',
    ]);
    expect(response.body.allocations.liquidity.totalPaise).toBe(10_00_000_00);
  });

  it('rejects a dimension it cannot group by', async () => {
    expect((await alice.get('/api/analytics/allocation?by=astrology')).status).toBe(400);
  });
});

describe('risk indicators', () => {
  it('measures concentration against the largest holding and the largest institution', async () => {
    await createAsset(alice, {
      name: 'The flat',
      type: 'property',
      valuePaise: 90_00_000_00,
      valueAsOf: TODAY,
      detail: { kind: 'flat' },
    });
    await createAsset(alice, {
      name: 'Savings',
      type: 'bank_account',
      institution: 'HDFC Bank',
      valuePaise: 10_00_000_00,
      valueAsOf: TODAY,
      detail: { accountType: 'savings' },
    });

    const { risk } = await dashboardOf(alice);
    expect(risk.topAssetName).toBe('The flat');
    expect(risk.topAssetShare).toBeCloseTo(0.9, 6);
    // A flat is not held *at* anybody, so the bank is the only institution exposure.
    expect(risk.topInstitutionName).toBe('HDFC Bank');
  });

  it('counts liquidity as months of committed outflow', async () => {
    await createAsset(alice, {
      name: 'Savings',
      type: 'bank_account',
      valuePaise: 6_00_000_00,
      valueAsOf: TODAY,
      detail: { accountType: 'savings' },
    });
    await createAsset(alice, {
      name: 'Home loan',
      type: 'liability',
      detail: {
        kind: 'home',
        lender: 'HDFC',
        principalPaise: 50_00_000_00,
        outstandingPaise: 30_00_000_00,
        rateBps: 865,
        emiPaise: 50_000_00,
      },
    });
    await createAsset(alice, {
      name: 'Term cover',
      type: 'insurance_policy',
      detail: {
        insurer: 'LIC',
        kind: 'term',
        sumAssuredPaise: 1_00_00_000_00,
        premiumPaise: 12_000_00,
        premiumFrequency: 'yearly',
      },
    });

    const { risk } = await dashboardOf(alice);

    // ₹50,000 of EMI plus ₹1,000 a month of premium.
    expect(risk.monthlyCommitmentPaise).toBe(51_000_00);
    expect(risk.liquidPaise).toBe(6_00_000_00);
    expect(risk.emergencyFundMonths).toBeCloseTo(600_000 / 51_000, 4);
  });

  it('keeps a term policy out of the totals entirely', async () => {
    // A ₹1 crore sum assured pays out on an event that has not happened. Counting it would
    // be the single largest lie the dashboard could tell.
    await createAsset(alice, {
      name: 'Term cover',
      type: 'insurance_policy',
      detail: {
        insurer: 'LIC',
        kind: 'term',
        sumAssuredPaise: 1_00_00_000_00,
        premiumPaise: 24_000_00,
        premiumFrequency: 'yearly',
      },
    });

    const body = await dashboardOf(alice);
    expect(body.summary.assetsPaise).toBe(0);
  });

  it('reports what is sitting in assets with no nominee registered', async () => {
    await createAsset(alice, {
      name: 'Unnominated deposit',
      type: 'deposit',
      valuePaise: 4_00_000_00,
      valueAsOf: TODAY,
      detail: {
        kind: 'fd',
        principalPaise: 4_00_000_00,
        rateBps: 0,
        compounding: 'quarterly',
        startedOn: TODAY,
      },
    });
    await createAsset(alice, {
      name: 'Nominated savings',
      type: 'bank_account',
      nomineeRegistered: true,
      valuePaise: 1_00_000_00,
      valueAsOf: TODAY,
      detail: { accountType: 'savings' },
    });

    const { risk } = await dashboardOf(alice);
    expect(risk.unnominatedCount).toBe(1);
    expect(risk.unnominatedPaise).toBe(4_00_000_00);
  });
});

describe('the net worth series', () => {
  it('ends on the requested date and starts no earlier than asked', async () => {
    await createAsset(alice, {
      name: 'Savings',
      type: 'bank_account',
      valuePaise: 1_00_000_00,
      valueAsOf: TODAY,
      detail: { accountType: 'savings' },
    });

    const response = await alice.get('/api/analytics/networth?months=6&interval=month');
    expect(response.status).toBe(200);

    const points = response.body.series as Array<{ date: string }>;
    expect(points.at(-1)!.date).toBe(TODAY);
    expect(points.length).toBeGreaterThan(1);
    // Ordered oldest first, which every chart library and every reader assumes.
    const dates = points.map((point) => point.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('leaves an asset out of the dates before it existed', async () => {
    await createAsset(alice, {
      name: 'Savings',
      type: 'bank_account',
      valuePaise: 1_00_000_00,
      valueAsOf: TODAY,
      detail: { accountType: 'savings' },
    });

    const response = await alice.get('/api/analytics/networth?months=12&interval=month');
    const points = response.body.series as Array<{ netPaise: number }>;
    expect(points[0]!.netPaise).toBe(0);
    expect(points.at(-1)!.netPaise).toBe(1_00_000_00);
  });

  it('still counts an asset on the day it closed', async () => {
    const closedOn = yearsAgo(1);
    await createAsset(alice, {
      name: 'Closed savings account',
      type: 'bank_account',
      status: 'closed',
      openedOn: yearsAgo(3),
      closedOn,
      valuePaise: 1_00_000_00,
      valueAsOf: yearsAgo(3),
      detail: { accountType: 'savings' },
    });

    // The money was there on the closing date — it is the day it came back out. Both bounds
    // are inclusive, so the asset counts on `closedOn` and not on the day after.
    const onClosingDay = await alice.get(`/api/analytics/allocation?asOf=${closedOn}`);
    expect(onClosingDay.body.allocation.totalPaise).toBe(1_00_000_00);

    const dayAfter = await alice.get(`/api/analytics/allocation?asOf=${addDay(closedOn)}`);
    expect(dayAfter.body.allocation.totalPaise).toBe(0);
  });

  it('drops an archived asset from the day it was archived', async () => {
    const asset = await createAsset(alice, {
      name: 'Savings',
      type: 'bank_account',
      valuePaise: 1_00_000_00,
      valueAsOf: yearsAgo(1),
      detail: { accountType: 'savings' },
    });
    expect((await alice.get('/api/analytics/allocation')).body.allocation.totalPaise).toBe(
      1_00_000_00,
    );

    await alice.delete(`/api/assets/${asset.id}`);

    // Archiving records no closing date, so the fallback is `updated_at` — an instant
    // meaning "as of now", not a day the household still owned this. It has to leave the
    // dashboard immediately rather than at midnight.
    expect((await alice.get('/api/analytics/allocation')).body.allocation.totalPaise).toBe(0);

    // History is untouched: it was real yesterday and the chart still says so.
    const yesterday = await alice.get(`/api/analytics/allocation?asOf=${yearsAgo(1)}`);
    expect(yesterday.body.allocation.totalPaise).toBe(1_00_000_00);
  });

  it('refuses a window it will not compute', async () => {
    expect((await alice.get('/api/analytics/networth?months=9999')).status).toBe(400);
    expect((await alice.get('/api/analytics/networth?interval=fortnight')).status).toBe(400);
  });
});

describe('performance', () => {
  it('computes XIRR from recorded cashflows', async () => {
    const asset = await createAsset(alice, {
      name: 'Flexi cap fund',
      type: 'property', // any asset with a value; the cashflows are what is under test
      valuePaise: 1_10_000_00,
      valueAsOf: TODAY,
      detail: { kind: 'flat' },
    });

    // ₹1,00,000 in a year ago, worth ₹1,10,000 today: a 10% return. `deposit` rather than
    // `buy` because there are no units here — a `buy` without them is refused at the door.
    const paid = await alice.post(`/api/assets/${asset.id}/transactions`, {
      date: yearsAgo(1),
      type: 'deposit',
      amountPaise: 1_00_000_00,
    });
    expect(paid.status).toBe(201);

    const response = await alice.get('/api/analytics/performance');
    expect(response.status).toBe(200);

    const entry = response.body.assets[0];
    expect(entry.investedPaise).toBe(1_00_000_00);
    expect(entry.valuePaise).toBe(1_10_000_00);
    expect(entry.gainPaise).toBe(10_000_00);
    expect(entry.xirr).toBeGreaterThan(0.09);
    expect(entry.xirr).toBeLessThan(0.11);
    // One flow in and one value out is exactly the shape CAGR is correct for.
    expect(entry.cagr).not.toBeNull();

    expect(response.body.portfolio.xirr).toBeGreaterThan(0.09);
  });

  it('has no rate to report for something bought today', async () => {
    await createAsset(alice, {
      name: 'Bought today',
      type: 'property',
      valuePaise: 1_00_000_00,
      valueAsOf: TODAY,
      detail: { kind: 'plot' },
    });

    const response = await alice.get('/api/analytics/performance');
    // Two flows on the same day cannot produce an annualised rate, and inventing one
    // would be worse than admitting there isn't one.
    expect(response.body.assets[0]!.xirr).toBeNull();
  });

  it('leaves liabilities out', async () => {
    await createAsset(alice, {
      name: 'Home loan',
      type: 'liability',
      detail: {
        kind: 'home',
        lender: 'HDFC',
        principalPaise: 50_00_000_00,
        outstandingPaise: 30_00_000_00,
        rateBps: 865,
        emiPaise: 45_000_00,
      },
    });

    const response = await alice.get('/api/analytics/performance');
    expect(response.body.assets).toEqual([]);
  });

  it('pools a class from its members rather than averaging their rates', async () => {
    // Two flats, bought a year apart for different money. The class rate has to come from
    // the four cashflows between them, not from the mean of two per-asset rates.
    for (const [name, kind, valuePaise, paidPaise, when] of [
      ['Flat one', 'flat', 1_10_000_00, 1_00_000_00, yearsAgo(1)],
      ['Flat two', 'plot', 4_40_000_00, 4_00_000_00, yearsAgo(2)],
    ] as const) {
      const asset = await createAsset(alice, {
        name,
        type: 'property',
        valuePaise,
        valueAsOf: TODAY,
        detail: { kind },
      });
      await alice.post(`/api/assets/${asset.id}/transactions`, {
        date: when,
        type: 'deposit',
        amountPaise: paidPaise,
      });
    }

    const response = await alice.get('/api/analytics/performance');
    expect(response.status).toBe(200);

    const classes = response.body.classes;
    expect(classes).toHaveLength(1);

    const realEstate = classes[0];
    expect(realEstate.assetClass).toBe('real_estate');
    expect(realEstate.assetCount).toBe(2);
    expect(realEstate.investedPaise).toBe(5_00_000_00);
    expect(realEstate.valuePaise).toBe(5_50_000_00);
    expect(realEstate.gainPaise).toBe(50_000_00);
    // 10% over one year and 10% over two are both real; pooled, the annualised rate sits
    // between them rather than at either.
    expect(realEstate.xirr).toBeGreaterThan(0.04);
    expect(realEstate.xirr).toBeLessThan(0.11);
    // CAGR is deliberately absent: many purchase dates, no single compound growth rate.
    expect(realEstate.cagr).toBeUndefined();
  });

  it('separates the classes and orders them by what they are worth', async () => {
    await createAsset(alice, {
      name: 'Small plot',
      type: 'property',
      valuePaise: 1_00_000_00,
      valueAsOf: TODAY,
      detail: { kind: 'plot' },
    });
    await createAsset(alice, {
      name: 'Fixed deposit',
      type: 'deposit',
      detail: {
        kind: 'fd',
        principalPaise: 5_00_000_00,
        rateBps: 700,
        compounding: 'quarterly',
        startedOn: yearsAgo(2),
      },
    });

    const classes = (await alice.get('/api/analytics/performance')).body.classes;
    expect(classes.map((entry: { assetClass: string }) => entry.assetClass)).toEqual([
      'debt',
      'real_estate',
    ]);
    expect(classes[0].assetCount).toBe(1);
    expect(classes[1].assetCount).toBe(1);
  });

  it('leaves liabilities out of the class rollup too', async () => {
    await createAsset(alice, {
      name: 'Car loan',
      type: 'liability',
      detail: {
        kind: 'car',
        lender: 'ICICI',
        principalPaise: 8_00_000_00,
        outstandingPaise: 5_00_000_00,
        rateBps: 900,
        emiPaise: 20_000_00,
      },
    });

    const response = await alice.get('/api/analytics/performance');
    expect(response.body.classes).toEqual([]);
  });

  it('answers for one asset on its own page', async () => {
    const asset = await createAsset(alice, {
      name: 'Fixed deposit',
      type: 'deposit',
      detail: {
        kind: 'fd',
        principalPaise: 1_00_000_00,
        rateBps: 700,
        compounding: 'quarterly',
        startedOn: yearsAgo(2),
      },
    });

    const response = await alice.get(`/api/assets/${asset.id}/performance`);
    expect(response.status).toBe(200);

    const { performance } = response.body;
    expect(performance.assetId).toBe(asset.id);
    // The principal counts as invested even with no transaction recorded against it.
    expect(performance.investedPaise).toBe(1_00_000_00);
    expect(performance.gainPaise).toBeGreaterThan(0);
    expect(performance.xirr).toBeGreaterThan(0.06);
    expect(performance.xirr).toBeLessThan(0.08);
  });
});

describe('scope', () => {
  beforeEach(async () => {
    await createAsset(alice, {
      name: "Alice's savings",
      type: 'bank_account',
      institution: 'HDFC Bank',
      valuePaise: 5_00_000_00,
      valueAsOf: TODAY,
      detail: { accountType: 'savings' },
    });
    await createAsset(bob, {
      name: "Bob's savings",
      type: 'bank_account',
      institution: 'ICICI Bank',
      valuePaise: 3_00_000_00,
      valueAsOf: TODAY,
      detail: { accountType: 'savings' },
    });
  });

  it('shows each user only their own portfolio', async () => {
    expect((await dashboardOf(alice)).summary.assetsPaise).toBe(5_00_000_00);
    expect((await dashboardOf(bob)).summary.assetsPaise).toBe(3_00_000_00);
  });

  it("includes a grantor's assets once a grant exists", async () => {
    grant('full');

    const body = await dashboardOf(bob);
    expect(body.summary.assetsPaise).toBe(8_00_000_00);
    expect(body.summary.assetCount).toBe(2);

    const institutions = await bob.get('/api/analytics/allocation?by=institution');
    expect(
      (institutions.body.allocation.slices as Array<{ key: string }>).map((slice) => slice.key),
    ).toEqual(expect.arrayContaining(['hdfc bank', 'icici bank']));
  });

  it('closes the door the moment a grant is revoked', async () => {
    grant('full');
    expect((await dashboardOf(bob)).summary.assetsPaise).toBe(8_00_000_00);

    instance.ctx.db
      .update(accessGrants)
      .set({ revokedAt: isoNow(instance.ctx.now()) })
      .run();

    expect((await dashboardOf(bob)).summary.assetsPaise).toBe(3_00_000_00);
  });

  it('refuses per-asset performance on an asset outside the scope', async () => {
    const list = await alice.get('/api/assets');
    const aliceAssetId = list.body.assets[0].id as string;

    // A 404, not a 403: existence is private, and a 403 would confirm the id belongs
    // to somebody.
    expect((await bob.get(`/api/assets/${aliceAssetId}/performance`)).status).toBe(404);
  });

  it('stops a summary grantee at the detail of one asset', async () => {
    grant('summary');

    // A summary grant is enough for the merged dashboard…
    expect((await dashboardOf(bob)).summary.assetsPaise).toBe(8_00_000_00);

    const list = await alice.get('/api/assets');
    const aliceAssetId = list.body.assets[0].id as string;
    // …and not enough to open one asset's own page.
    expect((await bob.get(`/api/assets/${aliceAssetId}/performance`)).status).toBe(403);
  });

  it('requires a signed-in caller', async () => {
    const stranger = new TestClient(instance.app);
    expect((await stranger.get('/api/analytics/dashboard')).status).toBe(401);
    expect((await stranger.get('/api/analytics/performance')).status).toBe(401);
  });

  it('lets a nominee read the dashboard without being able to write anything', async () => {
    const nominee = await registerMember(instance, admin, {
      email: 'heir@example.com',
      name: 'Heir',
      role: 'nominee',
    });

    // Analytics is read-only by construction, so a nominee is welcome here…
    expect((await nominee.get('/api/analytics/dashboard')).status).toBe(200);
    // …and still refused at every write, which is the guard this depends on.
    expect(
      (
        await nominee.post('/api/assets', {
          name: 'Mine now',
          type: 'property',
          detail: { kind: 'land' },
        })
      ).status,
    ).toBe(403);
  });
});
