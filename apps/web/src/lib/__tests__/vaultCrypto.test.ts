/**
 * The vault's cryptography, as it ships.
 *
 * `apps/api/src/__tests__/vaultCrypto.ts` mirrors these operations so the API tests can act
 * as a browser. This file tests the real module instead, so the two cannot drift apart
 * without something failing — and so the claims in docs/SECURITY-MODEL.md are demonstrated
 * rather than asserted:
 *
 *   - the right passphrase opens the vault and the wrong one does not;
 *   - a tampered ciphertext is rejected rather than silently mis-decrypted;
 *   - an owner's data key, wrapped to a nominee's public key, comes back out of the
 *     nominee's private key and opens the owner's items.
 *
 * No DOM is involved: WebCrypto and the Argon2id WASM both run under Node.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_KDF_PARAMS, type KdfParams } from '@networth/shared';
import {
  deriveKek,
  generateDek,
  generateKeypair,
  importPrivateKey,
  open,
  openBytes,
  openFile,
  openJson,
  randomSalt,
  seal,
  sealBytes,
  sealFile,
  sealJson,
  unwrapDek,
  unwrapFromOwner,
  unwrapPrivateKey,
  wrapDek,
  wrapToNominee,
} from '../vaultCrypto.js';

/**
 * Argon2id at the shipped parameters is a second of work by design, and these tests derive
 * a key a dozen times. The cost is the point of the real parameters, not of this file, so
 * everything here uses the cheapest the schema will accept — except one test, which uses
 * the real ones precisely to prove they work.
 */
const FAST: KdfParams = {
  algorithm: 'argon2id',
  memoryKib: 16 * 1024,
  iterations: 2,
  parallelism: 1,
};

describe('key derivation', () => {
  it('is deterministic for one passphrase and salt', async () => {
    const salt = randomSalt();
    const key = await deriveKek('correct horse battery staple', salt, FAST);
    const again = await deriveKek('correct horse battery staple', salt, FAST);

    // The keys are non-extractable, so they are compared by what they do rather than by
    // their bytes — which is the only comparison that matters anyway.
    const envelope = await seal(key, 'same key or not');
    expect(await open(again, envelope)).toBe('same key or not');
  });

  it('produces a different key per salt, so two vaults never share one', async () => {
    const key = await deriveKek('same passphrase', randomSalt(), FAST);
    const other = await deriveKek('same passphrase', randomSalt(), FAST);
    await expect(open(other, await seal(key, 'secret'))).rejects.toThrow();
  });

  it('refuses to open a vault under the wrong passphrase', async () => {
    const salt = randomSalt();
    const right = await deriveKek('the right one', salt, FAST);
    const wrong = await deriveKek('the wrong one', salt, FAST);

    const dek = await generateDek();
    const wrapped = await wrapDek(right, dek);

    expect(await unwrapDek(right, wrapped)).toBeDefined();
    // This rejection *is* the passphrase check. Nothing was asked of a server.
    await expect(unwrapDek(wrong, wrapped)).rejects.toThrow();
  });

  it('works at the parameters the application actually ships', async () => {
    const salt = randomSalt();
    const key = await deriveKek('a real passphrase', salt, DEFAULT_KDF_PARAMS);
    const reopened = await deriveKek('a real passphrase', salt, DEFAULT_KDF_PARAMS);
    expect(await open(reopened, await seal(key, 'ok'))).toBe('ok');
  }, 30_000);
});

describe('item encryption', () => {
  it('round-trips an object', async () => {
    const dek = await generateDek();
    const item = { label: 'HDFC', username: 'jaga', secret: 'hunter2', notes: 'locker 44' };
    expect(await openJson(dek, await sealJson(dek, item))).toEqual(item);
  });

  it('never produces the same ciphertext twice', async () => {
    const dek = await generateDek();
    // A repeated IV under one key is a total break of GCM, not a weakness. If this ever
    // fails, the IV has become deterministic somewhere.
    const first = await seal(dek, 'identical plaintext');
    const second = await seal(dek, 'identical plaintext');
    expect(first.iv).not.toBe(second.iv);
    expect(first.ct).not.toBe(second.ct);
  });

  it('rejects a tampered ciphertext rather than returning something wrong', async () => {
    const dek = await generateDek();
    const envelope = await seal(dek, 'the original message');

    const flipped = [...envelope.ct];
    flipped[0] = flipped[0] === 'A' ? 'B' : 'A';
    await expect(open(dek, { ...envelope, ct: flipped.join('') })).rejects.toThrow();
  });

  it('round-trips binary without a UTF-8 detour', async () => {
    const dek = await generateDek();
    // PKCS#8 is binary, and a private key that went through a text round trip would be
    // quietly corrupt. Every byte value, to be sure.
    const bytes = new Uint8Array(new ArrayBuffer(256)).map((_, index) => index);
    expect([...(await openBytes(dek, await sealBytes(dek, bytes)))]).toEqual([...bytes]);
  });
});

describe('documents', () => {
  it('prefixes the IV so the file is decryptable on its own', async () => {
    const dek = await generateDek();
    const original = new TextEncoder().encode('%PDF-1.4 a policy schedule');

    const blob = await sealFile(dek, original.buffer as ArrayBuffer);
    // Twelve bytes of IV and sixteen of tag on top of the plaintext, and nothing else: the
    // blob carries everything needed to decrypt it except the key.
    expect(blob.length).toBe(original.length + 12 + 16);
    expect(await openFile(dek, blob.buffer as ArrayBuffer)).toEqual(original);
  });
});

describe('the escrow keypair', () => {
  it('wraps the private key under the passphrase and gets it back', async () => {
    const kek = await deriveKek('vault passphrase', randomSalt(), FAST);
    const pair = await generateKeypair(kek);

    expect(pair.publicKeyJwk.kty).toBe('RSA');
    expect(await unwrapPrivateKey(kek, pair.wrappedPrivateKey)).toBeDefined();

    const wrongKek = await deriveKek('not the passphrase', randomSalt(), FAST);
    await expect(unwrapPrivateKey(wrongKek, pair.wrappedPrivateKey)).rejects.toThrow();
  });

  it('carries an owner’s data key to a nominee and back', async () => {
    // The whole succession story, in eight lines.
    const ownerDek = await generateDek();
    const secret = await sealJson(ownerDek, { label: 'SBI', secret: 'hunter2' });

    const heirKek = await deriveKek('the heir’s own passphrase', randomSalt(), FAST);
    const heir = await generateKeypair(heirKek);

    const escrowed = await wrapToNominee(heir.publicKeyJwk, ownerDek);

    // Months later: the heir unlocks their own vault, which yields their private key…
    const heirPrivate = await unwrapPrivateKey(heirKek, heir.wrappedPrivateKey);
    // …which unwraps the owner's data key…
    const recovered = await unwrapFromOwner(heirPrivate, escrowed);
    // …which opens the owner's items.
    expect(await openJson(recovered, secret)).toEqual({ label: 'SBI', secret: 'hunter2' });
  });

  it('does not let the wrong heir open an escrow meant for someone else', async () => {
    const ownerDek = await generateDek();
    const kek = await deriveKek('passphrase', randomSalt(), FAST);

    const intended = await generateKeypair(kek);
    const other = await generateKeypair(kek);

    const escrowed = await wrapToNominee(intended.publicKeyJwk, ownerDek);
    const otherPrivate = await unwrapPrivateKey(kek, other.wrappedPrivateKey);

    await expect(unwrapFromOwner(otherPrivate, escrowed)).rejects.toThrow();
  });

  it('imports a private key without making it extractable', async () => {
    const kek = await deriveKek('passphrase', randomSalt(), FAST);
    const pair = await generateKeypair(kek);
    const pkcs8 = await openBytes(kek, pair.wrappedPrivateKey);

    const imported = await importPrivateKey(pkcs8);
    expect(imported.extractable).toBe(false);
    // A key that cannot be exported cannot be exfiltrated by a script that gets a handle
    // on it — the reason unlock imports rather than keeps the bytes around.
    await expect(crypto.subtle.exportKey('pkcs8', imported)).rejects.toThrow();
  });
});
