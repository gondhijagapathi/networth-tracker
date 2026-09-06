/**
 * Units and per-unit prices.
 *
 * The case that matters is the one at the bottom: a real holding, valued against a real
 * four-decimal NAV, must come out to the paise a statement would show. Everything above it
 * is there to make sure the scaling that gets it there is exact.
 */

import { describe, expect, it } from 'vitest';
import { MoneyError } from '../money.js';
import {
  MICRO,
  blendAverageCost,
  fromMicro,
  paiseToMicroRupees,
  toMicro,
  valueOf,
} from '../quantity.js';

describe('scaling', () => {
  it('round-trips a decimal quantity', () => {
    expect(toMicro(1.5)).toBe(1_500_000);
    expect(fromMicro(1_500_000)).toBe(1.5);
    expect(fromMicro(toMicro(1234.5678))).toBe(1234.5678);
  });

  it('rounds half away from zero, in both directions', () => {
    expect(toMicro(0.0000005)).toBe(1);
    expect(toMicro(-0.0000005)).toBe(-1);
  });

  it('refuses what it cannot represent exactly', () => {
    expect(() => toMicro(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
    expect(() => toMicro(1e12)).toThrow(MoneyError);
    expect(() => fromMicro(1.5)).toThrow(MoneyError);
  });

  it('converts a paise price to micro-rupees', () => {
    expect(paiseToMicroRupees(12_345)).toBe(123_450_000);
  });
});

describe('valuing a holding', () => {
  it('multiplies units by price and rounds once, at the end', () => {
    // 1234.567 units of a fund at a NAV of ₹123.4567 is ₹152,415.5677..., and the only
    // rounding in the chain happens here.
    expect(valueOf(toMicro(1234.567), toMicro(123.4567))).toBe(15_241_557);
  });

  it('is exact for a whole number of units at a whole-rupee price', () => {
    expect(valueOf(toMicro(100), toMicro(250))).toBe(25_000_00);
  });

  it('values nothing as nothing', () => {
    expect(valueOf(0, toMicro(1234.5))).toBe(0);
  });

  it('refuses a quantity that is not a scaled integer', () => {
    expect(() => valueOf(1.5, MICRO)).toThrow(MoneyError);
  });
});

describe('average cost', () => {
  it('weights by units, the way a SIP actually averages', () => {
    // 100 units at ₹100 then 100 at ₹120 averages ₹110 — not the ₹110 of a naive mean by
    // coincidence, but because the unit counts are equal.
    const blended = blendAverageCost(toMicro(100), toMicro(100), toMicro(100), toMicro(120));
    expect(fromMicro(blended)).toBe(110);
  });

  it('weights an uneven purchase towards the larger one', () => {
    const blended = blendAverageCost(toMicro(300), toMicro(100), toMicro(100), toMicro(200));
    expect(fromMicro(blended)).toBe(125);
  });

  it('starts a position from nothing', () => {
    const blended = blendAverageCost(0, 0, toMicro(10), toMicro(99.5));
    expect(fromMicro(blended)).toBe(99.5);
  });

  it('reports zero for a position that has been sold out', () => {
    expect(blendAverageCost(toMicro(10), toMicro(100), toMicro(-10), toMicro(120))).toBe(0);
  });
});
