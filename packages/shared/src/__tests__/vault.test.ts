/**
 * The vault contracts.
 *
 * These schemas are the wall. The API re-parses every vault body with them, so what is
 * asserted here is the property the whole zero-knowledge design rests on: a payload that
 * is not ciphertext cannot be stored, however it is dressed up.
 */

import { describe, expect, it } from 'vitest';
import {
  AES_GCM_IV_BYTES,
  CIPHER_ENVELOPE_VERSION,
  DEFAULT_KDF_PARAMS,
  cipherEnvelopeSchema,
  createVaultItemSchema,
  fromBase64Url,
  kdfParamsSchema,
  publicKeyFingerprint,
  setupVaultSchema,
  toBase64Url,
  wrappedKeySchema,
} from '../vault.js';

/** A well-formed envelope: a 12-byte IV and a ciphertext at least as long as a GCM tag. */
const envelope = {
  v: CIPHER_ENVELOPE_VERSION,
  iv: toBase64Url(new Uint8Array(AES_GCM_IV_BYTES)),
  ct: toBase64Url(new Uint8Array(32)),
};

describe('cipherEnvelopeSchema', () => {
  it('accepts an envelope of the shape the browser produces', () => {
    expect(cipherEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  const rejected: Array<[string, unknown]> = [
    ['a bare string', 'hunter2'],
    ['a plaintext object', { label: 'HDFC', password: 'hunter2' }],
    ['an empty ciphertext', { ...envelope, ct: '' }],
    ['a ciphertext shorter than the GCM tag', { ...envelope, ct: 'AAAA' }],
    ['an IV of the wrong length', { ...envelope, iv: 'AAAA' }],
    ['a ciphertext that is not base64url', { ...envelope, ct: 'not base64!!' }],
    ['a future envelope version', { ...envelope, v: 2 }],
    ['a missing version', { iv: envelope.iv, ct: envelope.ct }],
  ];

  it.each(rejected)('rejects %s', (_label, value) => {
    expect(cipherEnvelopeSchema.safeParse(value).success).toBe(false);
  });

  it('rejects a plaintext field smuggled alongside a valid envelope', () => {
    // `strictObject`, not `object`. Without it a client bug could attach the plaintext to
    // the ciphertext and the server would store both.
    expect(cipherEnvelopeSchema.safeParse({ ...envelope, plaintext: 'oops' }).success).toBe(false);
  });
});

describe('createVaultItemSchema', () => {
  it('accepts an encrypted item', () => {
    const parsed = createVaultItemSchema.parse({ kind: 'bank_login', payload: envelope });
    expect(parsed.kind).toBe('bank_login');
  });

  it('rejects an unknown kind and an unencrypted payload', () => {
    expect(createVaultItemSchema.safeParse({ kind: 'not_a_kind', payload: envelope }).success).toBe(
      false,
    );
    expect(
      createVaultItemSchema.safeParse({ kind: 'note', payload: { secret: 'hunter2' } }).success,
    ).toBe(false);
  });
});

describe('setupVaultSchema', () => {
  const setup = {
    kdfSalt: toBase64Url(new Uint8Array(16)),
    kdfParams: DEFAULT_KDF_PARAMS,
    wrappedDek: envelope,
    publicKeyJwk: {
      kty: 'RSA',
      alg: 'RSA-OAEP-256',
      e: 'AQAB',
      n: toBase64Url(new Uint8Array(256)),
    },
    wrappedPrivateKey: envelope,
  };

  it('accepts what the browser sends on setup', () => {
    expect(setupVaultSchema.parse(setup).kdfParams).toEqual(DEFAULT_KDF_PARAMS);
  });

  it('rejects a salt that is not sixteen bytes', () => {
    expect(setupVaultSchema.safeParse({ ...setup, kdfSalt: 'AAAA' }).success).toBe(false);
  });

  it('rejects an extra field — there is no verifier to smuggle in', () => {
    // The one field that must never exist. If a future change adds something the server
    // could check a passphrase against, this test is where it should be argued about.
    expect(setupVaultSchema.safeParse({ ...setup, passphraseCheck: 'x' }).success).toBe(false);
  });
});

describe('kdfParamsSchema', () => {
  it('refuses parameters weak enough to be worth brute-forcing', () => {
    expect(kdfParamsSchema.safeParse({ ...DEFAULT_KDF_PARAMS, memoryKib: 1024 }).success).toBe(
      false,
    );
    expect(kdfParamsSchema.safeParse({ ...DEFAULT_KDF_PARAMS, iterations: 1 }).success).toBe(false);
    expect(kdfParamsSchema.safeParse({ ...DEFAULT_KDF_PARAMS, algorithm: 'pbkdf2' }).success).toBe(
      false,
    );
  });

  it('allows parameters stronger than today’s defaults', () => {
    // A vault created under raised defaults must still parse when it is read back.
    expect(
      kdfParamsSchema.safeParse({ ...DEFAULT_KDF_PARAMS, memoryKib: 262_144, iterations: 6 })
        .success,
    ).toBe(true);
  });
});

describe('wrappedKeySchema', () => {
  it('accepts an RSA-2048 and an RSA-4096 wrapping, and nothing between or beyond', () => {
    expect(wrappedKeySchema.safeParse(toBase64Url(new Uint8Array(256))).success).toBe(true);
    expect(wrappedKeySchema.safeParse(toBase64Url(new Uint8Array(512))).success).toBe(true);
    expect(wrappedKeySchema.safeParse(toBase64Url(new Uint8Array(32))).success).toBe(false);
  });
});

describe('base64url', () => {
  it('round-trips every byte value', () => {
    const bytes = new Uint8Array(256).map((_, index) => index);
    expect([...fromBase64Url(toBase64Url(bytes))]).toEqual([...bytes]);
  });

  it('emits no padding and no characters that need escaping in a URL', () => {
    expect(toBase64Url(new Uint8Array([255, 254, 253]))).not.toMatch(/[+/=]/);
  });
});

describe('publicKeyFingerprint', () => {
  const key = { kty: 'RSA', alg: 'RSA-OAEP-256', e: 'AQAB', n: 'abcdef' } as const;

  it('is stable for one key', async () => {
    expect(await publicKeyFingerprint(key)).toBe(await publicKeyFingerprint(key));
  });

  it('changes when the key does', async () => {
    // The property the escrow check depends on: a substituted public key produces a
    // different fingerprint, and the server compares against the one it holds.
    expect(await publicKeyFingerprint(key)).not.toBe(
      await publicKeyFingerprint({ ...key, n: 'abcdeg' }),
    );
  });
});
