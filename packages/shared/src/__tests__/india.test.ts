/**
 * The India tax rules, tested at their edges.
 *
 * Everything here is a boundary somebody loses money on: the twelve-month equity line, the
 * twenty-four-month line for everything else, the April 2023 cut-off that turned debt funds
 * into slab income, and the ₹1.25 lakh exemption that applies once a year rather than once
 * an asset. Each of those is a rule this application asserts on a screen, so each of them
 * gets a test that says what it believes.
 */

import { describe, expect, it } from 'vitest';
import {
  DEBT_MF_SLAB_FROM,
  NOMINATION_PROCEDURES,
  TAX_RATES,
  bucketGains,
  estimateTds,
  rateForTreatment,
  taxRatesFor,
  treatmentFor,
  type GainEntry,
  type TaxableHolding,
} from '../india.js';
import { ASSET_TYPES } from '../assets.js';

const { rates } = taxRatesFor(2026);

function holding(overrides: Partial<TaxableHolding> = {}): TaxableHolding {
  return {
    assetType: 'holding',
    assetClass: 'equity',
    instrumentKind: 'mf',
    acquiredOn: '2024-01-01',
    monthsHeld: 24,
    ...overrides,
  };
}

describe('rates by financial year', () => {
  it('uses the year asked for when the table has it', () => {
    const found = taxRatesFor(2025);
    expect(found.rates.fyStartYear).toBe(2025);
    expect(found.carriedForward).toBe(false);
  });

  it('carries the most recent rates forward, and says that it did', () => {
    const found = taxRatesFor(2030);
    expect(found.rates.fyStartYear).toBe(2025);
    // The flag is the whole point: the figures are still shown, labelled as last year's,
    // rather than a blank screen in the February after a Budget nobody has encoded.
    expect(found.carriedForward).toBe(true);
  });

  it('records the 2025 increase in the TDS thresholds', () => {
    expect(taxRatesFor(2024).rates.fdTdsThresholdPaise).toBe(40_000_00);
    expect(taxRatesFor(2025).rates.fdTdsThresholdPaise).toBe(50_000_00);
    expect(taxRatesFor(2025).rates.fdTdsThresholdSeniorPaise).toBe(1_00_000_00);
  });

  it('is ordered oldest first, so carrying forward picks the newest applicable', () => {
    const years = TAX_RATES.map((entry) => entry.fyStartYear);
    expect(years).toEqual([...years].sort((a, b) => a - b));
  });
});

describe('gain treatment', () => {
  it('splits equity at twelve months', () => {
    expect(treatmentFor(holding({ monthsHeld: 11 }))).toBe('equity_stcg');
    expect(treatmentFor(holding({ monthsHeld: 12 }))).toBe('equity_ltcg');
  });

  it('splits property and gold at twenty-four months', () => {
    const flat = holding({
      assetType: 'property',
      assetClass: 'real_estate',
      instrumentKind: null,
    });
    expect(treatmentFor({ ...flat, monthsHeld: 23 })).toBe('other_stcg');
    expect(treatmentFor({ ...flat, monthsHeld: 24 })).toBe('other_ltcg');
  });

  it('taxes a debt fund bought since April 2023 at slab, however long it is held', () => {
    const debt = holding({ assetClass: 'debt', instrumentKind: 'mf', monthsHeld: 60 });
    expect(treatmentFor({ ...debt, acquiredOn: DEBT_MF_SLAB_FROM })).toBe('slab');
    expect(treatmentFor({ ...debt, acquiredOn: '2026-01-01' })).toBe('slab');
  });

  it('leaves a debt fund bought before that date on the old long-term footing', () => {
    const debt = holding({
      assetClass: 'debt',
      instrumentKind: 'mf',
      acquiredOn: '2023-03-31',
      monthsHeld: 60,
    });
    expect(treatmentFor(debt)).toBe('other_ltcg');
  });

  it('treats deposits, EPF and insurance as income rather than capital gains', () => {
    for (const assetType of [
      'deposit',
      'retirement_account',
      'insurance_policy',
      'bank_account',
    ] as const) {
      expect(treatmentFor(holding({ assetType, instrumentKind: null }))).toBe('exempt');
    }
  });

  it('has no rate for the buckets that depend on a slab it cannot know', () => {
    expect(rateForTreatment('slab', rates)).toBeNull();
    expect(rateForTreatment('other_stcg', rates)).toBeNull();
    expect(rateForTreatment('equity_ltcg', rates)).toBe(1_250);
  });
});

describe('bucketing gains', () => {
  function entry(overrides: Partial<GainEntry>): GainEntry {
    return {
      assetId: 'a',
      name: 'Fund',
      assetClass: 'equity',
      acquiredOn: '2023-01-01',
      monthsHeld: 30,
      treatment: 'equity_ltcg',
      investedPaise: 1_00_000_00,
      valuePaise: 2_00_000_00,
      gainPaise: 1_00_000_00,
      ...overrides,
    };
  }

  it('applies the ₹1.25 lakh exemption once across the portfolio, not once per fund', () => {
    // Two funds, ₹1 lakh of gain each. Per-asset exemption would tax nothing at all.
    const buckets = bucketGains([entry({ assetId: 'a' }), entry({ assetId: 'b' })], rates);
    const ltcg = buckets.find((bucket) => bucket.treatment === 'equity_ltcg')!;

    expect(ltcg.gainPaise).toBe(2_00_000_00);
    expect(ltcg.taxablePaise).toBe(2_00_000_00 - 1_25_000_00);
    expect(ltcg.estimatedTaxPaise).toBe(Math.round((75_000_00 * 1_250) / 10_000));
  });

  it('leaves a gain inside the exemption untaxed', () => {
    const buckets = bucketGains([entry({ gainPaise: 50_000_00 })], rates);
    expect(buckets[0]!.taxablePaise).toBe(0);
    expect(buckets[0]!.estimatedTaxPaise).toBe(0);
  });

  it('nets a loss against a gain inside the same bucket', () => {
    const buckets = bucketGains(
      [entry({ gainPaise: 3_00_000_00 }), entry({ assetId: 'b', gainPaise: -1_00_000_00 })],
      rates,
    );
    expect(buckets[0]!.gainPaise).toBe(2_00_000_00);
  });

  it('never reports negative tax on a bucket that is entirely a loss', () => {
    const buckets = bucketGains([entry({ gainPaise: -50_000_00 })], rates);
    expect(buckets[0]!.taxablePaise).toBe(0);
    expect(buckets[0]!.estimatedTaxPaise).toBe(0);
  });

  it('reports a slab bucket with no tax figure at all', () => {
    const buckets = bucketGains([entry({ treatment: 'slab', gainPaise: 5_00_000_00 })], rates);
    // Null rather than zero. Zero would read as "this is not taxed", which is the opposite
    // of what slab treatment means.
    expect(buckets[0]!.estimatedTaxPaise).toBeNull();
    expect(buckets[0]!.gainPaise).toBe(5_00_000_00);
  });
});

describe('TDS on deposit interest', () => {
  it('deducts nothing at or below the threshold', () => {
    expect(estimateTds(50_000_00, 50_000_00, 1_000)).toBe(0);
    expect(estimateTds(49_999_00, 50_000_00, 1_000)).toBe(0);
  });

  it('deducts on the whole amount once the threshold is crossed, not on the excess', () => {
    // One rupee over, and ₹5,000.10 is withheld rather than ten paise. This cliff is the
    // entire reason Form 15G and 15H exist, and getting it wrong would understate the
    // deduction by a factor of fifty thousand.
    expect(estimateTds(50_001_00, 50_000_00, 1_000)).toBe(5_000_10);
  });
});

describe('nomination procedures', () => {
  it('covers every asset type, including the ones that cannot be nominated', () => {
    for (const type of ASSET_TYPES) {
      const procedure = NOMINATION_PROCEDURES[type];
      expect(procedure.authority.length).toBeGreaterThan(0);
      expect(procedure.steps.length).toBeGreaterThan(0);
    }
  });

  it('says plainly that a loan is not nominated rather than inventing a process', () => {
    expect(NOMINATION_PROCEDURES.liability.authority).toMatch(/not applicable/i);
  });
});
