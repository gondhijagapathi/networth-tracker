/**
 * A stand-in for the browser, for tests.
 *
 * The API's job is to move ciphertext it cannot read, and the only way to test that
 * honestly is to have the test *be* the client: encrypt here, store through the API, read
 * back, decrypt here, and assert the plaintext survived. A mock would test that the server
 * stores what it is given, which is not the interesting claim.
 *
 * This deliberately mirrors `apps/web/src/lib/vaultCrypto.ts` — same envelope, same
 * algorithms, same wrapping — with one exception: the data key is random rather than
 * derived with Argon2id. Key derivation is the browser's slow part and it is covered by its
 * own unit test; paying a second of memory-hard hashing per API test would buy nothing,
 * because the server never sees a derived key either way.
 */

import type { CipherEnvelope, PublicKeyJwk } from '@networth/shared';

const IV_BYTES = 12;

export interface TestKeypair {
  publicKeyJwk: PublicKeyJwk;
  privateKey: CryptoKey;
}

/** A random AES-256-GCM key, standing in for one derived from a passphrase. */
export async function randomKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function encrypt(key: CryptoKey, plaintext: string): Promise<CipherEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { v: 1, iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ct)) };
}

export async function decrypt(key: CryptoKey, envelope: CipherEnvelope): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(envelope.iv) },
    key,
    fromBase64Url(envelope.ct),
  );
  return new TextDecoder().decode(plaintext);
}

/** Encrypt raw bytes with the IV prefixed, the way a document upload is stored. */
export async function encryptBytes(key: CryptoKey, bytes: Uint8Array): Promise<Buffer> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return Buffer.concat([Buffer.from(iv), Buffer.from(ct)]);
}

export async function decryptBytes(key: CryptoKey, blob: Buffer): Promise<Uint8Array> {
  const iv = blob.subarray(0, IV_BYTES);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    blob.subarray(IV_BYTES),
  );
  return new Uint8Array(plaintext);
}

/** Wrap a key so it can be stored: the raw bytes of `key`, encrypted under `wrappingKey`. */
export async function wrapKey(wrappingKey: CryptoKey, key: CryptoKey): Promise<CipherEnvelope> {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, raw);
  return { v: 1, iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ct)) };
}

export async function unwrapKey(
  wrappingKey: CryptoKey,
  envelope: CipherEnvelope,
): Promise<CryptoKey> {
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(envelope.iv) },
    wrappingKey,
    fromBase64Url(envelope.ct),
  );
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

export async function generateKeypair(): Promise<TestKeypair> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['encrypt', 'decrypt'],
  );

  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Record<string, unknown>;
  return {
    publicKeyJwk: { kty: 'RSA', alg: 'RSA-OAEP-256', e: jwk.e as string, n: jwk.n as string },
    privateKey: pair.privateKey,
  };
}

/** The escrow operation: an owner's data key, wrapped to a nominee's public key. */
export async function wrapToPublicKey(jwk: PublicKeyJwk, key: CryptoKey): Promise<string> {
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { ...jwk, ext: true, key_ops: ['encrypt'] },
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    true,
    ['encrypt'],
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  return toBase64Url(
    new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, raw)),
  );
}

export async function unwrapWithPrivateKey(
  privateKey: CryptoKey,
  wrapped: string,
): Promise<CryptoKey> {
  const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, fromBase64Url(wrapped));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

/** A complete, valid `POST /api/vault` body, plus the data key it wraps. */
export async function vaultSetup(): Promise<{
  body: Record<string, unknown>;
  dek: CryptoKey;
  kek: CryptoKey;
  keypair: TestKeypair;
}> {
  const kek = await randomKey();
  const dek = await randomKey();
  const keypair = await generateKeypair();

  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keypair.privateKey));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const wrappedPrivate = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, pkcs8);

  return {
    body: {
      kdfSalt: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
      kdfParams: { algorithm: 'argon2id', memoryKib: 65536, iterations: 3, parallelism: 4 },
      wrappedDek: await wrapKey(kek, dek),
      publicKeyJwk: keypair.publicKeyJwk,
      wrappedPrivateKey: {
        v: 1,
        iv: toBase64Url(iv),
        ct: toBase64Url(new Uint8Array(wrappedPrivate)),
      },
    },
    dek,
    kek,
    keypair,
  };
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}
