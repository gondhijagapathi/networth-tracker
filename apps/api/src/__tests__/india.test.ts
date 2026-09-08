/**
 * The India endpoints, end to end.
 *
 * `india.test.ts` in `@networth/shared` covers the rules; this covers what happens when
 * they meet a real portfolio — that the calendar expands a recurring EMI into one row per
 * month, that a PPF account with nothing paid in raises the 31 March warning and one with a
 * deposit does not, and that a partner's assets appear in the nomination report but never in
 * the tax one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CalendarEvent, CalendarKind } from '@networth/shared';
import {
  createTestInstance,
  registerAdmin,
  registerMember,
  sampleAssetBody,
  type TestClient,
  type TestInstance,
} from './harness.js';

let instance: TestInstance;
let admin: TestClient;
let alice: TestClient;

beforeEach(async () => {
  instance = createTestInstance();
  admin = await registerAdmin(instance);
  alice = await registerMember(instance, admin, { email: 'alice@example.com', name: 'Alice' });
});

afterEach(() => {
  instance.close();
});

/** Today, as the injected clock sees it — every window in these reports is relative to it. */
function today(): string {
  return instance.ctx.now().toISOString().slice(0, 10);
}

function inDays(days: number): string {
  return new Date(instance.ctx.now().getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

async function create(client: TestClient, body: Record<string, unknown>): Promise<{ id: string }> {
  const response = await client.post('/api/assets', body);
  if (response.status !== 201) {
    throw new Error(`Create failed: ${response.status} ${response.text}`);
  }
  return { id: response.body.asset.id as string };
}

function kinds(events: CalendarEvent[], kind: CalendarKind): CalendarEvent[] {
  return events.filter((event) => event.kind === kind);
}

/**
 * The April the last *finished* financial year began in.
 *
 * Interest accrued "so far this year" is a few weeks' worth on 5 April and a full year's on
 * 30 March, so any assertion about crossing a threshold has to be made against a year that
 * has ended. This suite runs on the wall clock, so that year is computed rather than pinned.
 */
function lastCompletedFinancialYear(): number {
  const now = instance.ctx.now();
  const startYear = now.getUTCMonth() + 1 >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return startYear - 1;
}

/* -------------------------------------------------------------------------- */
/* Nomination hygiene                                                         */
/* -------------------------------------------------------------------------- */

describe('nomination hygiene', () => {
  it('counts what is nominated and ranks what is not by value', async () => {
    await create(alice, {
      ...sampleAssetBody('bank_account'),
      name: 'Small account',
      valuePaise: 10_000_00,
      nomineeRegistered: false,
    });
    await create(alice, {
      ...sampleAssetBody('property'),
      name: 'The flat',
      valuePaise: 80_00_000_00,
      nomineeRegistered: false,
    });
    await create(alice, {
      ...sampleAssetBody('bank_account'),
      name: 'Nominated account',
      valuePaise: 5_00_000_00,
      nomineeRegistered: true,
    });

    const response = await alice.get('/api/india/nomination');
    expect(response.status).toBe(200);

    const report = response.body;
    expect(report.totalAssets).toBe(3);
    expect(report.nominatedCount).toBe(1);
    // Biggest first — this list is meant to be worked through from the top.
    expect(report.atRisk.map((entry: { name: string }) => entry.name)).toEqual([
      'The flat',
      'Small account',
    ]);
    expect(report.atRiskPaise).toBe(80_00_000_00 + 10_000_00);
    expect(report.coveredPaise).toBe(5_00_000_00);
  });

  it('carries the registration steps for the asset type', async () => {
    await create(alice, { ...sampleAssetBody('retirement_account'), nomineeRegistered: false });

    const report = (await alice.get('/api/india/nomination')).body;
    expect(report.atRisk[0].procedure.authority).toMatch(/EPFO/);
    expect(report.atRisk[0].procedure.steps.join(' ')).toMatch(/e-nomination/i);
  });

  it('groups unnominated value by institution, so one visit fixes several', async () => {
    for (const name of ['Savings', 'Salary']) {
      await create(alice, {
        ...sampleAssetBody('bank_account'),
        name,
        institution: 'HDFC Bank',
        valuePaise: 1_00_000_00,
        nomineeRegistered: false,
      });
    }

    const report = (await alice.get('/api/india/nomination')).body;
    expect(report.byInstitution[0]).toEqual({
      institution: 'HDFC Bank',
      count: 2,
      valuePaise: 2_00_000_00,
    });
  });

  it('leaves liabilities out — nobody has to claim a loan', async () => {
    await create(alice, { ...sampleAssetBody('liability'), nomineeRegistered: false });

    const report = (await alice.get('/api/india/nomination')).body;
    expect(report.totalAssets).toBe(0);
    expect(report.atRisk).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Calendar                                                                   */
/* -------------------------------------------------------------------------- */

describe('the due calendar', () => {
  it('lists a deposit maturing inside the window and not one outside it', async () => {
    await create(alice, {
      ...sampleAssetBody('deposit'),
      name: 'Maturing FD',
      detail: {
        kind: 'fd',
        principalPaise: 1_00_000_00,
        rateBps: 700,
        compounding: 'quarterly',
        startedOn: inDays(-400),
        maturesOn: inDays(30),
      },
    });
    await create(alice, {
      ...sampleAssetBody('deposit'),
      name: 'Distant FD',
      detail: {
        kind: 'fd',
        principalPaise: 1_00_000_00,
        rateBps: 700,
        compounding: 'quarterly',
        startedOn: inDays(-400),
        maturesOn: inDays(300),
      },
    });

    const response = await alice.get('/api/india/calendar');
    expect(response.status).toBe(200);

    const maturities = kinds(response.body.events, 'deposit_maturity');
    expect(maturities).toHaveLength(1);
    expect(maturities[0]!.assetName).toBe('Maturing FD');
    // The amount is what it will actually be worth, accrued from the terms — not the
    // principal somebody typed in a year ago.
    expect(maturities[0]!.amountPaise).toBeGreaterThan(1_00_000_00);
  });

  it('expands a monthly EMI into one row per month', async () => {
    await create(alice, {
      ...sampleAssetBody('liability'),
      detail: {
        kind: 'home',
        lender: 'HDFC',
        principalPaise: 50_00_000_00,
        outstandingPaise: 32_00_000_00,
        rateBps: 865,
        emiPaise: 45_000_00,
        nextDueOn: inDays(3),
      },
    });

    const events = kinds((await alice.get('/api/india/calendar?days=90')).body.events, 'emi_due');
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.every((event) => event.amountPaise === 45_000_00)).toBe(true);
    // Strictly increasing, one per month — a calendar that repeated a date would be worse
    // than one that showed the obligation once.
    const dates = events.map((event) => event.date);
    expect([...new Set(dates)]).toHaveLength(dates.length);
  });

  it('warns about the PPF minimum when nothing has been paid in this year', async () => {
    await create(alice, {
      ...sampleAssetBody('deposit'),
      name: 'PPF',
      detail: {
        kind: 'ppf',
        principalPaise: 0,
        installmentPaise: 0,
        rateBps: 710,
        compounding: 'yearly',
        startedOn: inDays(-2_000),
      },
    });

    // A window wide enough to reach 31 March from any day of the year.
    const events = kinds(
      (await alice.get('/api/india/calendar?days=370')).body.events,
      'ppf_minimum',
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.amountPaise).toBe(500_00);
    expect(events[0]!.severity).toBe('critical');
  });

  it('stays quiet when the PPF minimum has already been met', async () => {
    const ppf = await create(alice, {
      ...sampleAssetBody('deposit'),
      name: 'PPF',
      detail: {
        kind: 'ppf',
        principalPaise: 0,
        installmentPaise: 1_50_000_00,
        rateBps: 710,
        compounding: 'yearly',
        startedOn: inDays(-2_000),
      },
    });
    await alice.post(`/api/assets/${ppf.id}/transactions`, {
      date: today(),
      type: 'deposit',
      amountPaise: 1_50_000_00,
    });

    const events = kinds(
      (await alice.get('/api/india/calendar?days=370')).body.events,
      'ppf_minimum',
    );
    expect(events).toEqual([]);
  });

  it('always marks the end of the financial year', async () => {
    const events = kinds((await alice.get('/api/india/calendar?days=370')).body.events, 'fy_end');
    expect(events).toHaveLength(1);
    expect(events[0]!.date.slice(5)).toBe('03-31');
  });

  it('comes back in date order', async () => {
    await create(alice, {
      ...sampleAssetBody('insurance_policy'),
      detail: {
        policyNumber: '123456789',
        insurer: 'LIC',
        kind: 'endowment',
        sumAssuredPaise: 10_00_000_00,
        premiumPaise: 24_000_00,
        premiumFrequency: 'quarterly',
        nextDueOn: inDays(10),
      },
    });

    const events: CalendarEvent[] = (await alice.get('/api/india/calendar?days=200')).body.events;
    expect(events.length).toBeGreaterThan(1);
    expect(events.map((event) => event.date)).toEqual(
      [...events].map((event) => event.date).sort(),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Financial year report                                                      */
/* -------------------------------------------------------------------------- */

describe('the financial year report', () => {
  it('names the year and the assessment year it is filed in', async () => {
    const report = (await alice.get('/api/india/financial-year?fy=2026')).body;
    expect(report.financialYear).toMatchObject({
      label: 'FY 2026-27',
      assessmentYear: 'AY 2027-28',
      start: '2026-04-01',
      end: '2027-03-31',
    });
    expect(report.rates.ltcgEquityExemptPaise).toBe(1_25_000_00);
  });

  it('splits a holding into long or short term by how long it has been held', async () => {
    const instrument = await alice.post('/api/instruments', {
      kind: 'mf',
      name: 'Flexi Cap Fund',
      amfiSchemeCode: '120503',
    });
    const asset = await create(alice, {
      ...sampleAssetBody('holding', { instrumentId: instrument.body.instrument.id as string }),
      name: 'Flexi Cap',
      valuePaise: 3_00_000_00,
    });
    await alice.post(`/api/assets/${asset.id}/transactions`, {
      date: inDays(-400),
      type: 'buy',
      units: 1_234_567_000,
      amountPaise: 1_00_000_00,
    });

    const report = (await alice.get('/api/india/financial-year')).body;
    const entry = report.gains.entries.find((row: { name: string }) => row.name === 'Flexi Cap');

    expect(entry.treatment).toBe('equity_ltcg');
    expect(entry.investedPaise).toBe(1_00_000_00);
    expect(entry.gainPaise).toBe(2_00_000_00);
    // ₹2 lakh of gain, ₹1.25 lakh exempt, 12.5% on the rest.
    const bucket = report.gains.buckets.find(
      (row: { treatment: string }) => row.treatment === 'equity_ltcg',
    );
    expect(bucket.taxablePaise).toBe(75_000_00);
    expect(bucket.estimatedTaxPaise).toBe(9_375_00);
  });

  it('reports deposit interest as income rather than as a capital gain', async () => {
    await create(alice, {
      ...sampleAssetBody('deposit'),
      name: 'Big FD',
      institution: 'SBI',
      detail: {
        kind: 'fd',
        principalPaise: 20_00_000_00,
        rateBps: 700,
        compounding: 'quarterly',
        startedOn: inDays(-800),
        maturesOn: inDays(800),
      },
    });

    const report = (await alice.get('/api/india/financial-year')).body;

    expect(report.gains.entries.some((row: { name: string }) => row.name === 'Big FD')).toBe(false);
    expect(report.interest.totalAccruedPaise).toBeGreaterThan(0);
    expect(report.interest.entries[0].institution).toBe('SBI');
  });

  it('applies the TDS threshold per payer and flags Form 15G', async () => {
    // Two deposits at the same bank: ₹42,000 of interest each, so each sits below the
    // ₹50,000 threshold and the pair sits above it. This is the case that surprises people,
    // and the reason the report groups by payer rather than by deposit.
    //
    // Reported over the *last* completed financial year rather than the current one, so the
    // figures are a full twelve months of accrual whatever day of the year this suite runs.
    const previousFy = lastCompletedFinancialYear();

    for (const name of ['FD one', 'FD two']) {
      await create(alice, {
        ...sampleAssetBody('deposit'),
        name,
        institution: 'SBI',
        detail: {
          kind: 'fd',
          principalPaise: 6_00_000_00,
          rateBps: 700,
          compounding: 'quarterly',
          startedOn: `${previousFy - 1}-04-01`,
          maturesOn: `${previousFy + 5}-04-01`,
        },
      });
    }

    const report = (await alice.get(`/api/india/financial-year?fy=${previousFy}`)).body;
    const payer = report.interest.byPayer.find(
      (row: { institution: string }) => row.institution === 'SBI',
    );

    expect(payer.accruedPaise).toBeGreaterThan(payer.thresholdPaise);
    expect(payer.crossesThreshold).toBe(true);
    // The whole amount, not the excess.
    expect(payer.estimatedTdsPaise).toBe(Math.round((payer.accruedPaise * 1_000) / 10_000));
    expect(report.interest.form15Advisable).toBe(true);
  });

  it('fills the 80C bucket from a PPF deposit and reports the headroom left', async () => {
    const ppf = await create(alice, {
      ...sampleAssetBody('deposit'),
      name: 'PPF',
      detail: {
        kind: 'ppf',
        principalPaise: 0,
        installmentPaise: 0,
        rateBps: 710,
        compounding: 'yearly',
        startedOn: inDays(-2_000),
      },
    });
    await alice.post(`/api/assets/${ppf.id}/transactions`, {
      date: today(),
      type: 'deposit',
      amountPaise: 50_000_00,
    });

    const report = (await alice.get('/api/india/financial-year')).body;
    const bucket = report.deductions.find((row: { section: string }) => row.section === '80C');

    expect(bucket.claimedPaise).toBe(50_000_00);
    expect(bucket.limitPaise).toBe(1_50_000_00);
    expect(bucket.headroomPaise).toBe(1_00_000_00);
    expect(bucket.entries[0]).toMatchObject({ source: 'ppf', estimated: false });
  });

  it('marks a home loan principal as the estimate it is', async () => {
    await create(alice, {
      ...sampleAssetBody('liability'),
      name: 'Home loan',
      detail: {
        kind: 'home',
        lender: 'HDFC',
        principalPaise: 50_00_000_00,
        outstandingPaise: 32_00_000_00,
        rateBps: 865,
        emiPaise: 45_000_00,
      },
    });

    const report = (await alice.get('/api/india/financial-year')).body;
    const bucket = report.deductions.find((row: { section: string }) => row.section === '80C');
    const entry = bucket.entries.find(
      (row: { source: string }) => row.source === 'home_loan_principal',
    );

    // 12 × ₹45,000 less a year of interest on ₹32 lakh at 8.65%.
    expect(entry.amountPaise).toBe(45_000_00 * 12 - Math.round((32_00_000_00 * 865) / 10_000));
    expect(entry.estimated).toBe(true);
  });

  it('puts a health policy under 80D rather than 80C, and raises the limit for a senior', async () => {
    await create(alice, {
      ...sampleAssetBody('insurance_policy'),
      name: 'Family floater',
      detail: {
        policyNumber: '999',
        insurer: 'Star Health',
        kind: 'health',
        sumAssuredPaise: 10_00_000_00,
        premiumPaise: 30_000_00,
        premiumFrequency: 'yearly',
      },
    });

    const ordinary = (await alice.get('/api/india/financial-year')).body.deductions.find(
      (row: { section: string }) => row.section === '80D',
    );
    expect(ordinary.claimedPaise).toBe(30_000_00);
    expect(ordinary.limitPaise).toBe(25_000_00);
    expect(ordinary.entries[0].estimated).toBe(true);

    const senior = (await alice.get('/api/india/financial-year?senior=true')).body.deductions.find(
      (row: { section: string }) => row.section === '80D',
    );
    expect(senior.limitPaise).toBe(50_000_00);
  });

  it('says when it is using rates carried forward from an earlier year', async () => {
    const future = (await alice.get('/api/india/financial-year?fy=2035')).body;
    expect(future.ratesCarriedForward).toBe(true);
    expect(future.rates.fyStartYear).toBe(2025);
  });
});

/* -------------------------------------------------------------------------- */
/* Scope                                                                      */
/* -------------------------------------------------------------------------- */

describe('what a partner sees', () => {
  it('shares nomination hygiene across the household but keeps the tax report personal', async () => {
    const bob = await registerMember(instance, admin, { email: 'bob@example.com', name: 'Bob' });

    await create(bob, {
      ...sampleAssetBody('property'),
      name: "Bob's plot",
      valuePaise: 40_00_000_00,
      nomineeRegistered: false,
    });

    // A full grant from Bob to Alice, the shape `household.service.ts` writes.
    instance.sqlite
      .prepare(
        `INSERT INTO access_grants (id, owner_user_id, grantee_user_id, scope, source, granted_at)
         VALUES ('grant-1', ?, ?, 'full', 'household', ?)`,
      )
      .run(bob.user!.id, alice.user!.id, instance.ctx.now().toISOString());

    const nomination = (await alice.get('/api/india/nomination')).body;
    expect(nomination.atRisk.map((entry: { name: string }) => entry.name)).toContain("Bob's plot");

    // Income tax is assessed per person; pooling two people's gains would apply one
    // exemption to two individuals who each have their own.
    const report = (await alice.get('/api/india/financial-year')).body;
    expect(report.gains.entries).toEqual([]);
  });
});
