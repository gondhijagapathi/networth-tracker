import { describe, it, expect } from 'vitest';
import {
  financialYearOf,
  currentFinancialYear,
  isInFinancialYear,
  monthsHeld,
  gainTerm,
  recentFinancialYears,
} from '../fy.js';

describe('financial year boundaries', () => {
  it('puts 1 April at the start of a new FY', () => {
    const fy = financialYearOf('2026-04-01');
    expect(fy.label).toBe('FY 2026-27');
    expect(fy.start).toBe('2026-04-01');
    expect(fy.end).toBe('2027-03-31');
  });

  it('puts 31 March at the end of the previous FY', () => {
    expect(financialYearOf('2027-03-31').label).toBe('FY 2026-27');
  });

  it('assigns January to March to the FY that began the previous April', () => {
    expect(financialYearOf('2027-01-15').label).toBe('FY 2026-27');
  });

  it('labels the assessment year one year ahead', () => {
    expect(financialYearOf('2026-06-01').assessmentYear).toBe('AY 2027-28');
  });

  it('lists recent years newest first', () => {
    const years = recentFinancialYears(3, new Date('2026-09-06T00:00:00Z'));
    expect(years.map((y) => y.label)).toEqual(['FY 2026-27', 'FY 2025-26', 'FY 2024-25']);
  });
});

describe('isInFinancialYear', () => {
  const fy = currentFinancialYear(new Date('2026-09-06T00:00:00Z'));

  it('includes both bounds', () => {
    expect(isInFinancialYear('2026-04-01', fy)).toBe(true);
    expect(isInFinancialYear('2027-03-31', fy)).toBe(true);
  });

  it('excludes the day either side', () => {
    expect(isInFinancialYear('2026-03-31', fy)).toBe(false);
    expect(isInFinancialYear('2027-04-01', fy)).toBe(false);
  });
});

describe('capital gains holding period', () => {
  it('counts whole months only', () => {
    expect(monthsHeld('2025-01-15', '2026-01-14')).toBe(11);
    expect(monthsHeld('2025-01-15', '2026-01-15')).toBe(12);
  });

  it('turns equity long-term at exactly 12 months', () => {
    expect(gainTerm('2025-01-15', '2026-01-14', 'equity')).toBe('short');
    expect(gainTerm('2025-01-15', '2026-01-15', 'equity')).toBe('long');
  });

  it('uses 24 months for property and other non-equity assets', () => {
    expect(gainTerm('2024-01-15', '2025-06-15', 'other')).toBe('short');
    expect(gainTerm('2024-01-15', '2026-01-15', 'other')).toBe('long');
  });
});
