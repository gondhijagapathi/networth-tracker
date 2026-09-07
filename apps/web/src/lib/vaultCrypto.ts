/**
 * The vault's cryptography. All of it, and it lives only here.
 *
 * ```
 * KEK = Argon2id(passphrase, salt, m=64MiB t=3 p=4)     never leaves this file
 * DEK = random AES-256 key                              wrapped by the KEK
 * item = AES-256-GCM(JSON, DEK)                         what the server stores
 * escrow = RSA-OAEP(DEK, nominee public key)            what an heir unwraps
 * ```
 *
 * Three rules hold everywhere below:
 *
 *   - **Nothing derived is ever persisted.** No `localStorage`, no `sessionStorage`, no
 *     IndexedDB. The keys exist as `CryptoKey` handles held by one React provider, and a
 *     page reload loses them, which is the correct behaviour rather than an inconvenience.
 *   - **Keys are non-extractable where they can be.** The KEK is imported with
 *     `extractable: false`, so even code running on this page cannot read the bytes back
 *     out of it. The DEK has to be extractable — escrow wraps its raw bytes — and that is a
 *     conscious trade, not an oversight.
 *   - **The server is never asked anything.** Every function here takes bytes and returns
 *     bytes. A wrong passphrase surfaces as an AES-GCM authentication failure in this file,
 *     which is why there is no verifier column in the database for anyone to attack.
 *
 * Argon2id comes from `hash-wasm`: a WASM build, no `SharedArrayBuffer`, and therefore no
 * cross-origin isolation headers to configure. It runs on the main thread for about a
 * second on a mid-range phone, which is why the unlock screen says what it is doing.
 */

import { argon2id } from 'hash-wasm';
import {
  AES_GCM_IV_BYTES,
  CIPHER_ENVELOPE_VERSION,
  DEFAULT_KDF_PARAMS,
  KDF_SALT_BYTES,
  fromBase64Url,
  toBase64Url,
  type CipherEnvelope,
  type KdfParams,
  type PublicKeyJwk,
} from '@networth/shared';

/**
 * Bytes WebCrypto will accept.
 *
 * `Uint8Array` on its own may be a view over a `SharedArrayBuffer`, which `BufferSource`
 * rejects. Naming the buffer once here keeps the casts out of every signature below.
 */
type Bytes = Uint8Array<ArrayBuffer>;

/* -------------------------------------------------------------------------- */
/* Key derivation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Turn a passphrase into the key that wraps everything else.
 *
 * The parameters travel with the vault rather than being constants here, so raising the
 * defaults later does not lock anybody out of a vault created under the old ones.
 */
export async function deriveKek(
  passphrase: string,
  saltBase64Url: string,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<CryptoKey> {
  // Copied into a fresh array rather than used in place: `hash-wasm` types its output as a
  // view over an unspecified buffer, and WebCrypto will not take one that might be shared.
  const raw = new Uint8Array(
    await argon2id({
      password: passphrase.normalize('NFKC'),
      salt: fromBase64Url(saltBase64Url),
      memorySize: params.memoryKib,
      iterations: params.iterations,
      parallelism: params.parallelism,
      hashLength: 32,
      outputType: 'binary',
    }),
  );

  // Not extractable: nothing in this application ever needs the derived bytes again, and a
  // key that cannot be exported cannot be exfiltrated by a script that gets a handle on it.
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export function randomSalt(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(KDF_SALT_BYTES)));
}

/* -------------------------------------------------------------------------- */
/* Symmetric encryption                                                       */
/* -------------------------------------------------------------------------- */

export async function generateDek(): Promise<CryptoKey> {
  // Extractable, because escrow has to wrap its raw bytes to a nominee's public key. That
  // is the one capability the vault's whole purpose depends on.
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function seal(key: CryptoKey, plaintext: string): Promise<CipherEnvelope> {
  return sealBytes(key, new TextEncoder().encode(plaintext));
}

export async function open(key: CryptoKey, envelope: CipherEnvelope): Promise<string> {
  return new TextDecoder().decode(await openBytes(key, envelope));
}

/** Encrypt an arbitrary object. Every vault item's payload goes through here. */
export async function sealJson(key: CryptoKey, value: unknown): Promise<CipherEnvelope> {
  return seal(key, JSON.stringify(value));
}

export async function openJson<T>(key: CryptoKey, envelope: CipherEnvelope): Promise<T> {
  return JSON.parse(await open(key, envelope)) as T;
}

/**
 * Encrypt raw bytes.
 *
 * Exported alongside the string helpers because the private key is PKCS#8 — binary that a
 * UTF-8 round trip would quietly corrupt. Reach for this whenever the plaintext is not text.
 */
export async function sealBytes(key: CryptoKey, bytes: Bytes): Promise<CipherEnvelope> {
  // A fresh IV per message, always. Reusing one under the same key with GCM is not a
  // weakness, it is a total break — it leaks the XOR of the plaintexts and the auth key.
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return {
    v: CIPHER_ENVELOPE_VERSION,
    iv: toBase64Url(iv),
    ct: toBase64Url(new Uint8Array(ct)),
  };
}

export async function openBytes(key: CryptoKey, envelope: CipherEnvelope): Promise<Bytes> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(envelope.iv) },
    key,
    fromBase64Url(envelope.ct),
  );
  return new Uint8Array(plaintext);
}

/* -------------------------------------------------------------------------- */
/* Files                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Encrypt a file with its IV prefixed to the ciphertext.
 *
 * Self-describing on purpose: a blob recovered from a backup needs nothing from the
 * database to be decryptable except this key, which is what lets the P8 restore path be a
 * directory copy rather than a migration.
 */
export async function sealFile(key: CryptoKey, bytes: ArrayBuffer): Promise<Bytes> {
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));

  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;
}

export async function openFile(key: CryptoKey, blob: ArrayBuffer): Promise<Bytes> {
  const bytes = new Uint8Array(blob) as Bytes;
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.subarray(0, AES_GCM_IV_BYTES) },
    key,
    bytes.subarray(AES_GCM_IV_BYTES),
  );
  return new Uint8Array(plaintext);
}

/* -------------------------------------------------------------------------- */
/* Key wrapping                                                               */
/* -------------------------------------------------------------------------- */

export async function wrapDek(kek: CryptoKey, dek: CryptoKey): Promise<CipherEnvelope> {
  return sealBytes(kek, new Uint8Array(await crypto.subtle.exportKey('raw', dek)));
}

export async function unwrapDek(kek: CryptoKey, envelope: CipherEnvelope): Promise<CryptoKey> {
  // This line is the passphrase check. A wrong KEK fails GCM's authentication tag and
  // throws; there is no oracle anywhere else, and deliberately so.
  const raw = await openBytes(kek, envelope);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

/* -------------------------------------------------------------------------- */
/* The escrow keypair                                                         */
/* -------------------------------------------------------------------------- */

export interface GeneratedKeypair {
  publicKeyJwk: PublicKeyJwk;
  wrappedPrivateKey: CipherEnvelope;
  privateKey: CryptoKey;
}

/**
 * A fresh RSA-OAEP-2048 keypair, with the private half wrapped by the KEK.
 *
 * The public half is stored in the clear because an owner has to be able to wrap their data
 * key to a nominee who is not present — asynchronous escrow is the entire point, and it
 * cannot be done with a shared secret.
 */
export async function generateKeypair(kek: CryptoKey): Promise<GeneratedKeypair> {
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
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));

  return {
    publicKeyJwk: { kty: 'RSA', alg: 'RSA-OAEP-256', e: jwk.e as string, n: jwk.n as string },
    wrappedPrivateKey: await sealBytes(kek, pkcs8),
    privateKey: pair.privateKey,
  };
}

export async function unwrapPrivateKey(
  kek: CryptoKey,
  envelope: CipherEnvelope,
): Promise<CryptoKey> {
  return importPrivateKey(await openBytes(kek, envelope));
}

/** Import a PKCS#8 private key as non-extractable. Used by unlock and by rekey. */
export async function importPrivateKey(pkcs8: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, [
    'decrypt',
  ]);
}

/** Wrap the data key to a nominee's public key. The result is what `vault_escrow` holds. */
export async function wrapToNominee(jwk: PublicKeyJwk, dek: CryptoKey): Promise<string> {
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { ...jwk, ext: true, key_ops: ['encrypt'] },
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    true,
    ['encrypt'],
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', dek));
  const wrapped = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, raw);
  return toBase64Url(new Uint8Array(wrapped));
}

/** The heir's side of the same operation, once an escrow has been released. */
export async function unwrapFromOwner(
  privateKey: CryptoKey,
  wrappedDek: string,
): Promise<CryptoKey> {
  const raw = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    privateKey,
    fromBase64Url(wrappedDek),
  );
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
}
