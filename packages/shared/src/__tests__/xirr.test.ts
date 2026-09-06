import { describe, it, expect } from 'vitest';
import { xirr, cagr, formatRate } from '../xirr.js';

describe('xirr', () => {
  it('returns ~10% for a one-year 10% gain', () => {
    const rate = xirr([
      { date: '2025-01-01', amount: -100000 },
      { date: '2026-01-01', amount: 110000 },
    ]);
    expect(rate).not.toBeNull();
    expect(rate!).toBeCloseTo(0.1, 3);
  });

  it('handles a monthly SIP with a final redemption', () => {
    const flows = Array.from({ length: 12 }, (_, i) => ({
      date: `2025-${String(i + 1).padStart(2, '0')}-01`,
      amount: -10_000_00,
    }));
    flows.push({ date: '2026-01-01', amount: 1_26_000_00 });

    const rate = xirr(flows);
    expect(rate).not.toBeNull();
    // ~₹1.2L invested over the year, worth ₹1.26L — annualised well above the 5% simple gain.
    expect(rate!).toBeGreaterThan(0.08);
    expect(rate!).toBeLessThan(0.15);
  });

  it('handles a loss', () => {
    const rate = xirr([
      { date: '2025-01-01', amount: -100000 },
      { date: '2026-01-01', amount: 80000 },
    ]);
    expect(rate!).toBeCloseTo(-0.2, 2);
  });

  it('returns null when there is nothing to solve', () => {
    expect(xirr([])).toBeNull();
    expect(xirr([{ date: '2025-01-01', amount: -100 }])).toBeNull();
    // All outflows — a holding bought today with no value recorded yet.
    expect(
      xirr([
        { date: '2025-01-01', amount: -100 },
        { date: '2025-06-01', amount: -100 },
      ]),
    ).toBeNull();
  });

  it('is insensitive to input order', () => {
    const ordered = xirr([
      { date: '2025-01-01', amount: -100000 },
      { date: '2026-01-01', amount: 110000 },
    ]);
    const shuffled = xirr([
      { date: '2026-01-01', amount: 110000 },
      { date: '2025-01-01', amount: -100000 },
    ]);
    expect(shuffled!).toBeCloseTo(ordered!, 6);
  });
});

describe('cagr', () => {
  it('computes annualised growth for a lump sum', () => {
    const rate = cagr(1_00_000, 1_21_000, '2024-01-01', '2026-01-01');
    expect(rate!).toBeCloseTo(0.1, 2);
  });

  it('refuses impossible inputs', () => {
    expect(cagr(0, 100, '2024-01-01', '2026-01-01')).toBeNull();
    expect(cagr(100, 200, '2026-01-01', '2026-01-01')).toBeNull();
  });
});

describe('formatRate', () => {
  it('renders a percentage', () => {
    expect(formatRate(0.1234)).toBe('12.34%');
  });

  it('renders an em dash when there is no rate', () => {
    expect(formatRate(null)).toBe('—');
  });
});
