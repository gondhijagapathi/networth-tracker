import { describe, expect, it } from 'vitest';
import { openSecret, sealSecret } from '../secretbox.js';

const KEY = 'a-master-key-of-at-least-32-characters';
const OTHER_KEY = 'a-different-master-key-32-characters!';

describe('secretbox', () => {
  it('round-trips a secret', () => {
    const sealed = sealSecret('JBSWY3DPEHPK3PXP', KEY, 'totp');
    expect(openSecret(sealed, KEY, 'totp')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('never stores the plaintext', () => {
    const sealed = sealSecret('JBSWY3DPEHPK3PXP', KEY, 'totp');
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(sealed.startsWith('v1.')).toBe(true);
  });

  it('produces a different ciphertext each time', () => {
    // A fresh IV per seal: identical secrets must not be visibly identical in the database.
    const first = sealSecret('same-secret', KEY, 'totp');
    const second = sealSecret('same-secret', KEY, 'totp');
    expect(first).not.toBe(second);
    expect(openSecret(second, KEY, 'totp')).toBe('same-secret');
  });

  it('refuses to open with the wrong key', () => {
    const sealed = sealSecret('JBSWY3DPEHPK3PXP', KEY, 'totp');
    expect(() => openSecret(sealed, OTHER_KEY, 'totp')).toThrow();
  });

  it('detects tampering through the GCM tag', () => {
    const sealed = sealSecret('JBSWY3DPEHPK3PXP', KEY, 'totp');
    const [version, iv, payload] = sealed.split('.');
    const flipped = payload!.slice(0, -2) + (payload!.endsWith('AA') ? 'BB' : 'AA');
    expect(() => openSecret(`${version}.${iv}.${flipped}`, KEY, 'totp')).toThrow();
  });

  it('rejects a malformed or unversioned value', () => {
    for (const bad of ['', 'nonsense', 'v2.aaa.bbb', 'v1.aaa', 'v1..']) {
      expect(() => openSecret(bad, KEY, 'totp')).toThrow();
    }
  });
});
