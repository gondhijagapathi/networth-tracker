/**
 * Deposit accrual, checked against the tables the institutions themselves publish.
 *
 * That is the point of these tests. An accrual engine is easy to write and hard to be sure
 * of: every plausible convention — day count, when the stub compounds, whether interest
 * credits before or after a contribution — produces a number that looks right and is wrong
 * by a few thousand rupees over fifteen years. India Post publishes maturity values for
 * NSC, KVP, RD and MIS, and the PPF annuity is a widely reproduced figure. Those are the
 * only independent check available, so they are what this file asserts against.
 *
 * Tolerances are stated per case and are there because the published tables round, not
 * because the engine is approximate. A genuine error — a missing compounding period, a
 * contribution counted twice — moves these numbers by percent, not by rupees.
 */

import { describe, expect, it } from 'vitest';
import {
  accrueDeposit,
  addMonths,
  compoundedValue,
  daysBetween,
  maturityValue,
  scheduleContributions,
  type DepositTerms,
} from '../accrual.js';

const rupees = (paise: number): number => paise / 100;

/** Every deposit needs the same six fields; only the interesting ones vary per test. */
function terms(overrides: Partial<DepositTerms> & Pick<DepositTerms, 'kind'>): DepositTerms {
  return {
    principalPaise: 0,
    rateBps: 0,
    compounding: 'quarterly',
    payoutMode: 'cumulative',
    startedOn: '2021-01-01',
    ...overrides,
  };
}

describe('compoundedValue', () => {
  it('compounds whole periods exactly', () => {
    // ₹1,00,000 at 7% compounded quarterly for exactly one 365-day year:
    // 100000 × 1.0175⁴ = 107,185.90. No stub, so this is exact.
    const value = compoundedValue(1_00_000_00, 700, 'quarterly', '2021-01-01', '2022-01-01');
    expect(rupees(Math.round(value))).toBeCloseTo(107_185.9, 1);
  });

  it('carries the trailing stub at simple interest rather than compounding it', () => {
    // Half a quarter past a whole one. Compounding the stub would give a larger number;
    // this asserts the documented convention, which is what banks actually do.
    const from = '2021-01-01';
    const to = addMonths(from, 4); // one whole quarter plus roughly a third of the next
    const value = compoundedValue(1_00_000_00, 800, 'quarterly', from, to);

    const whole = 1_00_000_00 * 1.02;
    expect(value).toBeGreaterThan(whole);
    expect(value).toBeLessThan(whole * 1.02);
  });

  it('treats `simple` and `maturity` as no intermediate compounding', () => {
    const simple = compoundedValue(1_00_000_00, 1_000, 'simple', '2021-01-01', '2024-01-01');
    // Three 365-day years is 1095 days, and 2024 is not reached, so no leap day intrudes.
    expect(rupees(Math.round(simple))).toBeCloseTo(130_000, 0);
  });

  it('returns the amount unchanged for a zero rate or a date in the past', () => {
    expect(compoundedValue(5_000_00, 0, 'yearly', '2021-01-01', '2031-01-01')).toBe(5_000_00);
    expect(compoundedValue(5_000_00, 700, 'yearly', '2021-01-01', '2020-01-01')).toBe(5_000_00);
  });
});

describe('fixed and one-shot deposits', () => {
  it('matches the India Post NSC table', () => {
    // NSC VIII at 7.7% compounds annually and matures in five years. India Post publishes
    // ₹1,449 on a ₹1,000 certificate.
    const nsc = terms({
      kind: 'nsc',
      principalPaise: 1_000_00,
      rateBps: 770,
      compounding: 'yearly',
      startedOn: '2020-04-01',
      maturesOn: '2025-04-01',
    });
    const result = maturityValue(nsc);
    expect(result).not.toBeNull();
    expect(rupees(result!.valuePaise)).toBeCloseTo(1_449, 0);
    expect(result!.matured).toBe(false); // valued *on* maturity, not past it
  });

  it('doubles a KVP in the 115 months the scheme promises', () => {
    // The whole product is "your money doubles". At 7.5% compounded annually that takes
    // 115 months, and India Post prints exactly that on the certificate.
    const kvp = terms({
      kind: 'kvp',
      principalPaise: 1_00_000_00,
      rateBps: 750,
      compounding: 'yearly',
      startedOn: '2020-01-01',
    });
    const value = accrueDeposit(kvp, addMonths('2020-01-01', 115)).valuePaise;
    expect(rupees(value)).toBeGreaterThan(2_00_000);
    expect(rupees(value)).toBeLessThan(2_01_000);
  });

  it('stops earning at maturity and keeps earning when it renews', () => {
    const fd = terms({
      kind: 'fd',
      principalPaise: 5_00_000_00,
      rateBps: 710,
      startedOn: '2021-01-01',
      maturesOn: '2026-01-01',
    });

    const atMaturity = accrueDeposit(fd, '2026-01-01');
    const longAfter = accrueDeposit(fd, '2030-01-01');
    expect(longAfter.valuePaise).toBe(atMaturity.valuePaise);
    expect(longAfter.matured).toBe(true);
    // The result is honest about which date it is really for.
    expect(longAfter.asOf).toBe('2026-01-01');

    const renewed = accrueDeposit({ ...fd, autoRenew: true }, '2030-01-01');
    expect(renewed.valuePaise).toBeGreaterThan(atMaturity.valuePaise);
    expect(renewed.asOf).toBe('2030-01-01');
  });

  it('is worth nothing before it exists', () => {
    const fd = terms({ kind: 'fd', principalPaise: 1_00_000_00, rateBps: 700 });
    const before = accrueDeposit(fd, '2020-06-01');
    expect(before.valuePaise).toBe(0);
    expect(before.contributedPaise).toBe(0);
  });

  it('reports interest as the difference between value and contributions', () => {
    const fd = terms({
      kind: 'fd',
      principalPaise: 2_00_000_00,
      rateBps: 700,
      maturesOn: '2024-01-01',
    });
    const result = accrueDeposit(fd, '2023-01-01');
    expect(result.contributedPaise).toBe(2_00_000_00);
    expect(result.interestPaise).toBe(result.valuePaise - result.contributedPaise);
    expect(result.paidOutPaise).toBe(0);
  });
});

describe('recurring deposits', () => {
  it('matches the post office five-year RD', () => {
    // ₹5,000 a month for sixty months at 6.7%, compounded quarterly. The published table
    // gives about ₹3,56,830; a 1% band absorbs the table's rounding without hiding a
    // miscounted instalment, which would cost ₹5,000 or more.
    const rd = terms({
      kind: 'rd',
      installmentPaise: 5_000_00,
      rateBps: 670,
      startedOn: '2020-01-01',
      maturesOn: '2025-01-01',
    });

    const result = maturityValue(rd);
    expect(result).not.toBeNull();
    expect(result!.contributedPaise).toBe(60 * 5_000_00);
    expect(rupees(result!.valuePaise)).toBeGreaterThan(3_53_000);
    expect(rupees(result!.valuePaise)).toBeLessThan(3_60_000);
  });

  it('pays its last instalment the month before it matures', () => {
    const rd = terms({
      kind: 'rd',
      installmentPaise: 5_000_00,
      rateBps: 670,
      startedOn: '2020-01-01',
      maturesOn: '2025-01-01',
    });
    const schedule = scheduleContributions(rd, '2025-01-01');
    expect(schedule).toHaveLength(60);
    expect(schedule[0]!.date).toBe('2020-01-01');
    expect(schedule.at(-1)!.date).toBe('2024-12-01');
  });

  it('prefers a real payment history to a modelled one', () => {
    // The schedule is a guess about an untouched account. The moment somebody skips a
    // month the guess is wrong, and the transaction history is what must win.
    const rd = terms({
      kind: 'rd',
      installmentPaise: 5_000_00,
      rateBps: 670,
      startedOn: '2024-01-01',
      maturesOn: '2029-01-01',
    });

    const skipped = accrueDeposit(rd, '2024-06-01', [
      { date: '2024-01-01', amountPaise: 5_000_00 },
      { date: '2024-02-01', amountPaise: 5_000_00 },
      // March missed.
      { date: '2024-04-01', amountPaise: 5_000_00 },
    ]);

    expect(skipped.contributedPaise).toBe(15_000_00);
    expect(skipped.valuePaise).toBeLessThan(accrueDeposit(rd, '2024-06-01').valuePaise);
  });
});

describe('PPF and SSY minimum-balance interest', () => {
  const ppf = terms({
    kind: 'ppf',
    installmentPaise: 1_50_000_00,
    rateBps: 710,
    compounding: 'yearly',
    startedOn: '2000-04-01',
    maturesOn: '2015-04-01',
  });

  it('reproduces the published fifteen-year PPF maturity', () => {
    // The most reproduced number in Indian personal finance: ₹1.5 lakh deposited on
    // 1 April every year for fifteen years at 7.1% matures at ₹40,68,209.
    const result = maturityValue(ppf);
    expect(result).not.toBeNull();
    expect(result!.contributedPaise).toBe(15 * 1_50_000_00);
    expect(Math.round(rupees(result!.valuePaise))).toBe(40_68_209);
  });

  it('takes exactly fifteen deposits, however long the account runs', () => {
    expect(scheduleContributions(ppf, '2015-04-01')).toHaveLength(15);
    expect(scheduleContributions(ppf, '2015-04-01').at(-1)!.date).toBe('2014-04-01');
  });

  it('costs a month of interest to deposit after the fifth', () => {
    // The rule that makes "deposit before the 5th of April" standard advice: interest is
    // computed on the lowest balance between the 5th and the end of the month, so money
    // arriving on the 6th earns nothing until May.
    const account = terms({
      kind: 'ppf',
      rateBps: 710,
      compounding: 'yearly',
      startedOn: '2021-04-01',
    });

    const early = accrueDeposit(account, '2022-03-31', [
      { date: '2021-04-04', amountPaise: 1_50_000_00 },
    ]);
    const late = accrueDeposit(account, '2022-03-31', [
      { date: '2021-04-06', amountPaise: 1_50_000_00 },
    ]);

    expect(early.valuePaise).toBeGreaterThan(late.valuePaise);
    // One month of interest on ₹1.5 lakh at 7.1% is ₹887.50.
    expect(rupees(early.valuePaise - late.valuePaise)).toBeCloseTo(887.5, 0);
  });

  it('counts interest earned in the current, uncredited financial year', () => {
    // PPF credits on 31 March, but the money has been earned by December and a household
    // that is told otherwise is being told it is poorer than it is.
    const account = terms({
      kind: 'ppf',
      rateBps: 710,
      compounding: 'yearly',
      startedOn: '2021-04-01',
    });
    const contributions = [{ date: '2021-04-01', amountPaise: 1_50_000_00 }];

    const december = accrueDeposit(account, '2021-12-31', contributions);
    expect(december.valuePaise).toBeGreaterThan(1_50_000_00);
    // Nine completed months, April through December, at 7.1% on ₹1.5 lakh.
    expect(rupees(december.interestPaise)).toBeCloseTo((1_50_000 * 0.071 * 9) / 12, 0);
  });

  it('keeps an SSY account growing for six years after the deposits stop', () => {
    // SSY takes deposits for fifteen years and matures at twenty-one. The gap is the whole
    // reason `maturesOn` cannot double as the contribution bound.
    const ssy = terms({
      kind: 'ssy',
      installmentPaise: 1_50_000_00,
      rateBps: 820,
      compounding: 'yearly',
      startedOn: '2010-04-01',
      maturesOn: '2031-04-01',
    });

    expect(scheduleContributions(ssy, '2031-04-01')).toHaveLength(15);

    const atFifteen = accrueDeposit(ssy, '2025-04-01').valuePaise;
    const atMaturity = maturityValue(ssy)!.valuePaise;

    expect(atMaturity).toBeGreaterThan(atFifteen);
    // Six further years of compounding at 8.2%, and nothing more paid in.
    expect(atMaturity / atFifteen).toBeCloseTo(Math.pow(1.082, 6), 1);
    expect(maturityValue(ssy)!.contributedPaise).toBe(15 * 1_50_000_00);
  });
});

describe('deposits that pay their interest out', () => {
  it('matches the post office monthly income scheme', () => {
    // ₹9,00,000 at 7.4% pays ₹5,550 a month and returns the principal at the end. The
    // deposit is worth its principal throughout — the income is income, not a balance.
    const mis = terms({
      kind: 'mis',
      principalPaise: 9_00_000_00,
      rateBps: 740,
      compounding: 'simple',
      payoutMode: 'monthly',
      startedOn: '2024-01-01',
      maturesOn: '2029-01-01',
    });

    const afterAYear = accrueDeposit(mis, '2025-01-01');
    expect(afterAYear.valuePaise).toBe(9_00_000_00);
    expect(afterAYear.interestPaise).toBe(0);
    expect(rupees(afterAYear.paidOutPaise)).toBeCloseTo(5_550 * 12, 0);
  });

  it('counts only completed payout periods', () => {
    const scss = terms({
      kind: 'scss',
      principalPaise: 30_00_000_00,
      rateBps: 820,
      payoutMode: 'quarterly',
      startedOn: '2024-01-01',
      maturesOn: '2029-01-01',
    });

    // Two months in, the first quarterly credit has not been paid.
    expect(accrueDeposit(scss, '2024-03-01').paidOutPaise).toBe(0);
    // A full year in, four have.
    expect(rupees(accrueDeposit(scss, '2025-01-01').paidOutPaise)).toBeCloseTo(
      30_00_000 * 0.082,
      0,
    );
  });
});

describe('date helpers', () => {
  it('counts whole days, signed', () => {
    expect(daysBetween('2021-01-01', '2021-01-31')).toBe(30);
    expect(daysBetween('2021-01-31', '2021-01-01')).toBe(-30);
    // 2024 is a leap year; the count is real days even though interest uses 365-day years.
    expect(daysBetween('2024-01-01', '2025-01-01')).toBe(366);
  });

  it('clamps to the end of a shorter month rather than spilling into the next', () => {
    // A deposit opened on the 31st recurs on the 30th in April, not the 1st of May.
    expect(addMonths('2021-01-31', 1)).toBe('2021-02-28');
    expect(addMonths('2021-03-31', 1)).toBe('2021-04-30');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2021-01-15', 24)).toBe('2023-01-15');
    expect(addMonths('2021-01-15', -1)).toBe('2020-12-15');
  });
});

describe('guards', () => {
  it('refuses to spin on a mistyped year', () => {
    // 1925 for 2025 is a plausible typo and must not produce a million instalments.
    const rd = terms({
      kind: 'rd',
      installmentPaise: 1_000_00,
      rateBps: 600,
      startedOn: '1925-01-01',
    });
    expect(scheduleContributions(rd, '2026-01-01').length).toBeLessThanOrEqual(360);
  });

  it('has no maturity value for a deposit with no maturity date', () => {
    // An extended PPF account or a rolled-over SCSS: real, and it does not mature.
    expect(maturityValue(terms({ kind: 'ppf', rateBps: 710 }))).toBeNull();
  });
});
