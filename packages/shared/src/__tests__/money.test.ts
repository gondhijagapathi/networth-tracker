import { describe, it, expect } from 'vitest';
import {
  rupeesToPaise,
  paiseToRupees,
  parseAmount,
  formatINR,
  formatCompactINR,
  sumPaise,
  splitPaise,
  percentOf,
  MoneyError,
} from '../money.js';

describe('rupee/paise conversion', () => {
  it('converts rupees to integer paise', () => {
    expect(rupeesToPaise(1234.56)).toBe(123456);
    expect(rupeesToPaise(0)).toBe(0);
    expect(rupeesToPaise(-99.99)).toBe(-9999);
  });

  it('rounds half away from zero rather than to even', () => {
    expect(rupeesToPaise(0.005)).toBe(1);
    expect(rupeesToPaise(-0.005)).toBe(-1);
  });

  it('round-trips', () => {
    expect(paiseToRupees(rupeesToPaise(87654.32))).toBeCloseTo(87654.32, 2);
  });

  it('rejects non-finite input', () => {
    expect(() => rupeesToPaise(Number.NaN)).toThrow(MoneyError);
    expect(() => rupeesToPaise(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });
});

describe('parseAmount', () => {
  it('accepts Indian grouped input with a rupee sign', () => {
    expect(parseAmount('₹1,23,456.78')).toBe(12345678);
  });

  it('accepts lakh and crore shorthand as people actually type it', () => {
    expect(parseAmount('12.5L')).toBe(12_50_000_00);
    expect(parseAmount('1.2 Cr')).toBe(1_20_00_000_00);
    expect(parseAmount('50k')).toBe(50_000_00);
    expect(parseAmount('2 lakh')).toBe(2_00_000_00);
  });

  it('rejects nonsense', () => {
    expect(() => parseAmount('')).toThrow(MoneyError);
    expect(() => parseAmount('abc')).toThrow(MoneyError);
    expect(() => parseAmount('12.5X')).toThrow(MoneyError);
  });
});

describe('Indian formatting', () => {
  it('groups digits 2-2-3, not 3-3-3', () => {
    // ₹1,23,45,678 — the grouping that distinguishes Indian formatting.
    const formatted = formatINR(1_23_45_678_00, { paise: false });
    expect(formatted).toContain('1,23,45,678');
  });

  it('formats compactly in lakh and crore', () => {
    expect(formatCompactINR(1_50_00_000_00)).toBe('₹1.50 Cr');
    expect(formatCompactINR(3_25_000_00)).toBe('₹3.25 L');
    expect(formatCompactINR(45_000_00)).toBe('₹45.00 K');
    expect(formatCompactINR(-1_00_00_000_00)).toBe('-₹1.00 Cr');
  });
});

describe('splitPaise', () => {
  it('splits so the parts sum back to exactly the whole', () => {
    const parts = splitPaise(100, [1, 1, 1]);
    expect(sumPaise(parts)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
  });

  it('handles a joint asset split by ownership percentage', () => {
    const parts = splitPaise(1_00_00_001, [60, 40]);
    expect(sumPaise(parts)).toBe(1_00_00_001);
  });

  it('rejects an empty or zero-weight split', () => {
    expect(() => splitPaise(100, [])).toThrow(MoneyError);
    expect(() => splitPaise(100, [0, 0])).toThrow(MoneyError);
  });
});

describe('percentOf', () => {
  it('returns 0 for an empty portfolio rather than NaN', () => {
    expect(percentOf(0, 0)).toBe(0);
  });

  it('computes an allocation share', () => {
    expect(percentOf(25_000_00, 1_00_000_00)).toBe(25);
  });
});
