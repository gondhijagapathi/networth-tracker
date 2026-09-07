/**
 * The estate contracts.
 *
 * Mostly bounds, and the bounds are the point. A dead-man switch that could be set to fire
 * after a week would fire on somebody's holiday, and what it releases is a household's
 * entire financial life — so the floor is enforced by the schema rather than by the form.
 */

import { describe, expect, it } from 'vitest';
import {
  CLAIM_PROCEDURES,
  configureDeadManSchema,
  createNomineeSchema,
  sealEscrowSchema,
  sharePercentBpsSchema,
} from '../estate.js';
import { ASSET_TYPES } from '../assets.js';
import { toBase64Url } from '../vault.js';

describe('configureDeadManSchema', () => {
  it('accepts the documented default', () => {
    expect(
      configureDeadManSchema.parse({ enabled: true, inactivityDays: 90, graceDays: 7 }),
    ).toEqual({ enabled: true, inactivityDays: 90, graceDays: 7 });
  });

  it('refuses a window short enough to trip on a long holiday', () => {
    expect(
      configureDeadManSchema.safeParse({ enabled: true, inactivityDays: 14, graceDays: 7 }).success,
    ).toBe(false);
  });

  it('refuses a grace period that is not shorter than the window', () => {
    // Otherwise the grace period would begin after the switch had already fired, which is
    // not a grace period at all.
    expect(
      configureDeadManSchema.safeParse({ enabled: true, inactivityDays: 30, graceDays: 30 })
        .success,
    ).toBe(false);
  });
});

describe('createNomineeSchema', () => {
  it('defaults to the narrowest access', () => {
    // Naming somebody should not hand them the vault by omission.
    expect(createNomineeSchema.parse({ name: 'Priya' }).accessLevel).toBe('summary');
  });

  it('normalises the email the same way the login form does', () => {
    expect(createNomineeSchema.parse({ name: 'Priya', email: '  Priya@Example.COM ' }).email).toBe(
      'priya@example.com',
    );
  });

  it('rejects a share above one hundred per cent', () => {
    expect(sharePercentBpsSchema.safeParse(10_001).success).toBe(false);
    expect(sharePercentBpsSchema.safeParse(3_333).success).toBe(true);
  });
});

describe('sealEscrowSchema', () => {
  it('requires a wrapped key and the fingerprint it was wrapped to', () => {
    expect(
      sealEscrowSchema.safeParse({
        wrappedDek: toBase64Url(new Uint8Array(256)),
        publicKeyFingerprint: 'a'.repeat(43),
      }).success,
    ).toBe(true);

    expect(
      sealEscrowSchema.safeParse({ wrappedDek: toBase64Url(new Uint8Array(256)) }).success,
    ).toBe(false);
  });
});

describe('CLAIM_PROCEDURES', () => {
  it('covers every asset type this app tracks', () => {
    // An asset with no procedure prints as "ask the institution", which is a fallback and
    // not an answer. Every type we know about should have a real one.
    for (const type of ASSET_TYPES) {
      expect(CLAIM_PROCEDURES[type], `no claim procedure for ${type}`).toBeDefined();
    }
  });

  it('names an authority and the documents for each', () => {
    for (const [type, procedure] of Object.entries(CLAIM_PROCEDURES)) {
      expect(procedure.authority.length, type).toBeGreaterThan(0);
      expect(procedure.documents.length, type).toBeGreaterThan(0);
    }
  });
});
