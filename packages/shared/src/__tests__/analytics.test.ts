/**
 * Classification and allocation.
 *
 * These tests read as a list of opinions, and that is deliberate: "an ELSS fund is equity",
 * "a term policy is not an investment", "an uncategorised fund is assumed to be equity" are
 * judgement calls, not facts, and a judgement call that nothing asserts is one nobody can
 * argue with or safely change.
 */

import { describe, expect, it } from 'vitest';
import {
  ASSET_CLASS_LABELS,
  allocate,
  classifyAsset,
  delta,
  liquidityOf,
  type ClassifiableAsset,
  type ValuedAsset,
} from '../analytics.js';

const TODAY = '2026-09-06';

describe('classifyAsset', () => {
  it('puts a bank account in cash and every deposit in debt', () => {
    expect(classifyAsset({ type: 'bank_account' })).toBe('cash');
    // A small-savings scheme is a bond you cannot trade, whatever the post office calls it.
    for (const kind of ['fd', 'rd', 'ppf', 'ssy', 'nsc', 'kvp', 'mis', 'scss']) {
      expect(classifyAsset({ type: 'deposit', kind })).toBe('debt');
    }
  });

  it('classifies a holding by what the instrument actually holds', () => {
    const holding = (
      instrumentKind: ClassifiableAsset['instrumentKind'],
      instrumentCategory?: string,
    ): ClassifiableAsset => ({ type: 'holding', instrumentKind, instrumentCategory });

    expect(classifyAsset(holding('bond'))).toBe('debt');
    expect(classifyAsset(holding('mf', 'Equity Scheme - ELSS'))).toBe('equity');
    expect(classifyAsset(holding('mf', 'Debt Scheme - Corporate Bond Fund'))).toBe('debt');
    expect(classifyAsset(holding('mf', 'Debt Scheme - Liquid Fund'))).toBe('debt');
    expect(classifyAsset(holding('mf', 'Hybrid Scheme - Balanced Advantage'))).toBe('hybrid');
    expect(classifyAsset(holding('mf', 'Other Scheme - Gold ETF'))).toBe('gold');
    expect(classifyAsset(holding('equity'))).toBe('equity');
  });

  it('assumes an uncategorised fund is equity', () => {
    // The error is deliberately in the safe direction: over-reporting equity exposure
    // prompts a look, under-reporting it hides a risk.
    expect(classifyAsset({ type: 'holding', instrumentKind: 'mf' })).toBe('equity');
    expect(classifyAsset({ type: 'holding', instrumentKind: null, instrumentCategory: null })).toBe(
      'equity',
    );
  });

  it('separates policies that save from policies that only insure', () => {
    expect(classifyAsset({ type: 'insurance_policy', kind: 'endowment' })).toBe('debt');
    expect(classifyAsset({ type: 'insurance_policy', kind: 'money_back' })).toBe('debt');
    expect(classifyAsset({ type: 'insurance_policy', kind: 'ulip' })).toBe('hybrid');
    // Term and health cover have no investment value; they are here for the claim kit.
    expect(classifyAsset({ type: 'insurance_policy', kind: 'term' })).toBe('insurance');
    expect(classifyAsset({ type: 'insurance_policy', kind: 'health' })).toBe('insurance');
  });

  it('treats EPF as debt and NPS as hybrid', () => {
    expect(classifyAsset({ type: 'retirement_account', kind: 'epf' })).toBe('debt');
    expect(classifyAsset({ type: 'retirement_account', kind: 'vpf' })).toBe('debt');
    // NPS is a scheme mix that is usually part equity, however conservatively allocated.
    expect(classifyAsset({ type: 'retirement_account', kind: 'nps' })).toBe('hybrid');
  });

  it('classifies the long tail by what it behaves like', () => {
    expect(classifyAsset({ type: 'other_asset', kind: 'crypto' })).toBe('crypto');
    expect(classifyAsset({ type: 'other_asset', kind: 'esop' })).toBe('equity');
    expect(classifyAsset({ type: 'other_asset', kind: 'rsu' })).toBe('equity');
    // A chit fund and money lent to a cousin are both somebody else holding your money.
    expect(classifyAsset({ type: 'other_asset', kind: 'chit' })).toBe('debt');
    expect(classifyAsset({ type: 'other_asset', kind: 'loan_given' })).toBe('debt');
    expect(classifyAsset({ type: 'other_asset', kind: 'vehicle' })).toBe('other');
  });

  it('covers every asset type', () => {
    expect(classifyAsset({ type: 'property', kind: 'land' })).toBe('real_estate');
    expect(classifyAsset({ type: 'precious_metal', kind: 'sgb' })).toBe('gold');
    expect(classifyAsset({ type: 'liability', kind: 'home' })).toBe('other');
  });
});

describe('liquidityOf', () => {
  it('reads a deposit by how close its maturity is', () => {
    const fd = (maturesOn: string): ClassifiableAsset => ({
      type: 'deposit',
      kind: 'fd',
      maturesOn,
    });
    expect(liquidityOf(fd('2027-01-01'), TODAY)).toBe('months');
    expect(liquidityOf(fd('2030-01-01'), TODAY)).toBe('locked');
    // Same deposit, asked about later: the answer depends on the date, which is why the
    // date is a parameter rather than "now".
    expect(liquidityOf(fd('2030-01-01'), '2029-06-01')).toBe('months');
  });

  it('locks PPF and SSY by statute rather than by term', () => {
    expect(liquidityOf({ type: 'deposit', kind: 'ppf' }, TODAY)).toBe('locked');
    expect(liquidityOf({ type: 'deposit', kind: 'ssy', maturesOn: '2026-10-01' }, TODAY)).toBe(
      'locked',
    );
  });

  it('separates gold you can sell today from gold you cannot', () => {
    expect(liquidityOf({ type: 'precious_metal', kind: 'digital' }, TODAY)).toBe('instant');
    expect(liquidityOf({ type: 'precious_metal', kind: 'sgb' }, TODAY)).toBe('locked');
    expect(liquidityOf({ type: 'precious_metal', kind: 'jewellery' }, TODAY)).toBe('days');
  });

  it('gives the rest of the portfolio the answer its settlement cycle implies', () => {
    expect(liquidityOf({ type: 'bank_account' }, TODAY)).toBe('instant');
    expect(liquidityOf({ type: 'holding' }, TODAY)).toBe('days');
    expect(liquidityOf({ type: 'other_asset', kind: 'crypto' }, TODAY)).toBe('instant');
    expect(liquidityOf({ type: 'other_asset', kind: 'vehicle' }, TODAY)).toBe('months');
    expect(liquidityOf({ type: 'property', kind: 'flat' }, TODAY)).toBe('locked');
    expect(liquidityOf({ type: 'retirement_account', kind: 'epf' }, TODAY)).toBe('locked');
    expect(liquidityOf({ type: 'insurance_policy', kind: 'endowment' }, TODAY)).toBe('locked');
  });
});

describe('allocate', () => {
  const valued = (
    overrides: Partial<ValuedAsset> & Pick<ValuedAsset, 'valuePaise'>,
  ): ValuedAsset => ({
    assetId: `asset-${Math.random()}`,
    name: 'Something',
    type: 'bank_account',
    assetClass: 'cash',
    liquidity: 'instant',
    institution: null,
    grossValuePaise: overrides.valuePaise,
    ownershipBps: 10_000,
    basis: 'manual',
    asOf: TODAY,
    nomineeRegistered: false,
    shared: false,
    ...overrides,
  });

  const portfolio: ValuedAsset[] = [
    valued({ valuePaise: 6_00_000_00, assetClass: 'equity', institution: 'Zerodha' }),
    valued({ valuePaise: 3_00_000_00, assetClass: 'debt', institution: 'HDFC Bank' }),
    valued({ valuePaise: 1_00_000_00, assetClass: 'cash', institution: 'HDFC Bank' }),
  ];

  it('groups largest first and shares sum to one', () => {
    const result = allocate(portfolio, 'class');
    expect(result.totalPaise).toBe(10_00_000_00);
    expect(result.slices.map((s) => s.key)).toEqual(['equity', 'debt', 'cash']);
    expect(result.slices[0]!.share).toBeCloseTo(0.6, 6);
    expect(result.slices.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 6);
    expect(result.slices[0]!.label).toBe(ASSET_CLASS_LABELS.equity);
  });

  it('pools one institution across asset types', () => {
    // The point of the institution view: one bank failing is one row, not three.
    const result = allocate(portfolio, 'institution');
    const hdfc = result.slices.find((s) => s.key === 'hdfc bank');
    expect(hdfc?.valuePaise).toBe(4_00_000_00);
    expect(hdfc?.count).toBe(2);
  });

  it('pools assets held at no institution rather than dropping them', () => {
    // Gold in a locker and a plot of land are still exposure; they are just not exposure
    // to anybody.
    const result = allocate(
      [...portfolio, valued({ valuePaise: 50_00_000_00, assetClass: 'real_estate' })],
      'institution',
    );
    const none = result.slices.find((s) => s.key === '__none__');
    expect(none?.valuePaise).toBe(50_00_000_00);
    expect(none?.label).toBe('Not held at an institution');
  });

  it('survives an empty portfolio and a portfolio worth nothing', () => {
    expect(allocate([], 'class')).toEqual({ by: 'class', totalPaise: 0, slices: [] });

    const worthless = allocate([valued({ valuePaise: 0 })], 'class');
    expect(worthless.totalPaise).toBe(0);
    // No division by zero, and the asset still appears: it is owned, just unvalued.
    expect(worthless.slices[0]!.share).toBe(0);
    expect(worthless.slices[0]!.count).toBe(1);
  });
});

describe('delta', () => {
  it('reports the change and the ratio it represents', () => {
    const result = delta('2026-08-06', 10_00_000_00, 11_00_000_00);
    expect(result.changePaise).toBe(1_00_000_00);
    expect(result.changeRatio).toBeCloseTo(0.1, 6);
    expect(result.fromDate).toBe('2026-08-06');
  });

  it('has no ratio to report when there was nothing to grow from', () => {
    // A first month with no earlier figure is not "infinite growth".
    expect(delta('2026-08-06', 0, 5_00_000_00).changeRatio).toBeNull();
  });

  it('reads a shrinking net worth against the size of what was there', () => {
    // Net worth can be negative — a new home loan against a small deposit — and the ratio
    // must stay signed the way a human reads it.
    const result = delta('2026-08-06', -2_00_000_00, -1_00_000_00);
    expect(result.changePaise).toBe(1_00_000_00);
    expect(result.changeRatio).toBeCloseTo(0.5, 6);
  });
});
