/**
 * Vault contracts shared by the API and the web client.
 *
 * The vault is the one part of this application the server cannot read. Everything below
 * describes *ciphertext* — its shape, its bounds, and the key material needed to open it
 * in a browser. There is no schema here for a bank password, because no bank password ever
 * reaches the server (docs/SECURITY-MODEL.md).
 *
 * The schemas are deliberately strict rather than permissive. `cipherEnvelopeSchema`
 * rejects anything that is not a base64url IV of exactly twelve bytes plus a ciphertext at
 * least as long as an AES-GCM tag, and every vault request body is a `strictObject`, so a
 * client bug that sent `{ password: "hunter2" }` fails at the door instead of writing a
 * plaintext secret into the database.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/** Unpadded base64url — the only encoding any binary value crosses the wire in. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export const base64UrlSchema = z
  .string()
  .trim()
  .regex(BASE64URL, 'Expected unpadded base64url')
  .max(16_384, 'Encoded value is too long');

/** `n` bytes encode to `ceil(n * 4 / 3)` unpadded base64url characters. */
const encodedLength = (bytes: number): number => Math.ceil((bytes * 4) / 3);

export const AES_GCM_IV_BYTES = 12;
export const AES_GCM_TAG_BYTES = 16;

/**
 * The envelope every encrypted value is stored in.
 *
 * `v` is a format version rather than decoration: re-wrapping a vault under different KDF
 * parameters is a migration this app will one day have to run, and a version byte is what
 * makes that possible without guessing.
 */
export const CIPHER_ENVELOPE_VERSION = 1;

export const cipherEnvelopeSchema = z.strictObject({
  v: z.literal(CIPHER_ENVELOPE_VERSION),
  iv: base64UrlSchema.length(
    encodedLength(AES_GCM_IV_BYTES),
    'Initialisation vector must be 12 bytes',
  ),
  /**
   * AES-GCM appends a 16-byte tag, so even an empty plaintext produces this much. A value
   * shorter than the tag is not ciphertext, whatever the client believes it is sending.
   */
  ct: base64UrlSchema.min(
    encodedLength(AES_GCM_TAG_BYTES),
    'Ciphertext is too short to be encrypted',
  ),
});
export type CipherEnvelope = z.infer<typeof cipherEnvelopeSchema>;

/* -------------------------------------------------------------------------- */
/* Key derivation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Argon2id parameters, stored alongside the salt so a vault created today still opens after
 * the defaults are raised. They are the client's to choose and the server's to hand back
 * untouched — the server cannot verify them, because it never derives the key.
 *
 * The defaults match the password hash on the server side: 64 MiB, three passes, four
 * lanes. That is roughly a second of work in WASM on a phone, which is the right price for
 * something typed once and then held for fifteen minutes.
 */
export const kdfParamsSchema = z.strictObject({
  algorithm: z.literal('argon2id'),
  /** Memory cost in KiB. Floor is high enough that a weak choice is still expensive. */
  memoryKib: z
    .number()
    .int()
    .min(16 * 1024)
    .max(1024 * 1024),
  iterations: z.number().int().min(2).max(16),
  parallelism: z.number().int().min(1).max(8),
});
export type KdfParams = z.infer<typeof kdfParamsSchema>;

export const DEFAULT_KDF_PARAMS: KdfParams = {
  algorithm: 'argon2id',
  memoryKib: 64 * 1024,
  iterations: 3,
  parallelism: 4,
};

export const KDF_SALT_BYTES = 16;

/**
 * An RSA-OAEP public key as a JWK.
 *
 * Public by design and stored in the clear: an owner has to be able to wrap their data key
 * to a nominee's key without that nominee being present, which is the whole point of
 * escrow.
 */
export const publicKeyJwkSchema = z.strictObject({
  kty: z.literal('RSA'),
  alg: z.literal('RSA-OAEP-256'),
  e: base64UrlSchema,
  n: base64UrlSchema,
  ext: z.literal(true).optional(),
  key_ops: z.array(z.string()).optional(),
});
export type PublicKeyJwk = z.infer<typeof publicKeyJwkSchema>;

/** RSA-OAEP-2048 produces 256 bytes; 4096-bit keys produce 512. Accept both, nothing else. */
export const wrappedKeySchema = base64UrlSchema
  .min(encodedLength(256), 'Wrapped key is too short')
  .max(encodedLength(512), 'Wrapped key is too long');

/* -------------------------------------------------------------------------- */
/* Vault setup                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Everything the browser needs to open a vault, and everything the server is able to hold.
 *
 * Note what is absent: any value the server could use to check a passphrase. Verification
 * is the AES-GCM tag on `wrappedDek` failing to authenticate, which happens in the browser.
 * A server-side verifier would be a free offline oracle for anyone who copied the database.
 */
export const setupVaultSchema = z.strictObject({
  kdfSalt: base64UrlSchema.length(encodedLength(KDF_SALT_BYTES), 'Salt must be 16 bytes'),
  kdfParams: kdfParamsSchema,
  /** The AES-256 data key, encrypted under the key derived from the passphrase. */
  wrappedDek: cipherEnvelopeSchema,
  publicKeyJwk: publicKeyJwkSchema,
  /** PKCS#8 private key, encrypted under the same derived key. */
  wrappedPrivateKey: cipherEnvelopeSchema,
});
export type SetupVaultBody = z.infer<typeof setupVaultSchema>;

/**
 * Change the vault passphrase.
 *
 * Only the wrapping changes. The data key itself is unchanged, so not one item has to be
 * re-encrypted — which is exactly why a data key exists rather than encrypting items under
 * the passphrase directly.
 */
export const rekeyVaultSchema = setupVaultSchema.omit({ publicKeyJwk: true });
export type RekeyVaultBody = z.infer<typeof rekeyVaultSchema>;

export interface VaultKeyMaterial {
  kdfSalt: string;
  kdfParams: KdfParams;
  wrappedDek: CipherEnvelope;
  publicKeyJwk: PublicKeyJwk;
  wrappedPrivateKey: CipherEnvelope;
  createdAt: string;
  updatedAt: string;
}

/** What `GET /vault` answers before anything is unlocked. */
export interface VaultStatus {
  initialised: boolean;
  itemCount: number;
  documentCount: number;
  /** Null until the vault is set up; the browser needs all of it to derive and unwrap. */
  keys: VaultKeyMaterial | null;
}

/* -------------------------------------------------------------------------- */
/* Items                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What a vault item is *about*, kept in the clear.
 *
 * A deliberate, documented leak. The kind and the linked asset stay readable so the app can
 * say "this fixed deposit has two vault items" on a locked screen, and so an owner can find
 * their way around without unlocking. The label, the username, the password, the locker
 * address and the note to an heir are all inside `payload`, and the server sees none of it.
 */
export const VAULT_ITEM_KINDS = [
  'bank_login',
  'card',
  'demat',
  'policy',
  'locker',
  'credential',
  'document_location',
  'instruction',
  'note',
] as const;
export const vaultItemKindSchema = z.enum(VAULT_ITEM_KINDS);
export type VaultItemKind = z.infer<typeof vaultItemKindSchema>;

export const VAULT_ITEM_KIND_LABELS: Record<VaultItemKind, string> = {
  bank_login: 'Bank login',
  card: 'Card',
  demat: 'Demat / trading',
  policy: 'Policy details',
  locker: 'Locker',
  credential: 'Credential',
  document_location: 'Where the papers are',
  instruction: 'Instruction for heirs',
  note: 'Note',
};

/** The decrypted shape. It exists only in the browser; no server code imports it. */
export const vaultItemPayloadSchema = z.object({
  label: z.string().trim().min(1, 'Give this a name').max(120),
  username: z.string().trim().max(200).optional(),
  secret: z.string().max(4_000).optional(),
  url: z.string().trim().max(500).optional(),
  /** Full account or policy numbers live here, never in the masked column on the asset. */
  reference: z.string().trim().max(200).optional(),
  location: z.string().trim().max(500).optional(),
  notes: z.string().max(8_000).optional(),
});
export type VaultItemPayload = z.infer<typeof vaultItemPayloadSchema>;

export const createVaultItemSchema = z.strictObject({
  kind: vaultItemKindSchema,
  /** Optional link to the asset this unlocks. Validated as belonging to the caller. */
  assetId: z.string().trim().max(64).optional(),
  payload: cipherEnvelopeSchema,
});
export type CreateVaultItemBody = z.infer<typeof createVaultItemSchema>;

export const updateVaultItemSchema = createVaultItemSchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
export type UpdateVaultItemBody = z.infer<typeof updateVaultItemSchema>;

export interface VaultItemRecord {
  id: string;
  kind: VaultItemKind;
  assetId: string | null;
  payload: CipherEnvelope;
  createdAt: string;
  updatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Documents                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * An encrypted upload.
 *
 * The bytes arrive as `application/octet-stream` with the twelve-byte IV prepended to the
 * ciphertext, so the file on disk is self-describing: a restored backup needs nothing from
 * the database to be decryptable except the vault key. The metadata a human needs to
 * recognise the file — its name and type — is itself encrypted, and only `sizeBytes` and
 * the link to an asset are readable.
 */
export const uploadDocumentSchema = z.strictObject({
  assetId: z.string().trim().max(64).optional(),
  /** Filename and MIME type, encrypted under the data key. */
  meta: cipherEnvelopeSchema,
});
export type UploadDocumentBody = z.infer<typeof uploadDocumentSchema>;

export const documentMetaPayloadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  mime: z.string().trim().max(120),
});
export type DocumentMetaPayload = z.infer<typeof documentMetaPayloadSchema>;

export interface VaultDocumentRecord {
  id: string;
  assetId: string | null;
  meta: CipherEnvelope;
  /** Ciphertext length, including the prepended IV and the GCM tag. */
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

/** Ten megabytes. A scanned policy document is under one; anything larger is a mistake. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/* -------------------------------------------------------------------------- */
/* Fingerprints                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A stable, short name for a public key.
 *
 * An escrow records the fingerprint of the key its payload was wrapped to. The server
 * recomputes it from the nominee's stored key and rejects a mismatch, which means an owner
 * cannot be tricked into wrapping their data key to a public key that is not the one this
 * database holds for that person — the one substitution attack available to a compromised
 * client in an otherwise end-to-end flow.
 *
 * `crypto.subtle` is present in both Node 22+ and every browser this app supports, so the
 * same function runs on both sides and the two cannot drift apart.
 */
export async function publicKeyFingerprint(jwk: PublicKeyJwk): Promise<string> {
  const canonical = `${jwk.kty}.${jwk.alg}.${jwk.e}.${jwk.n}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return toBase64Url(new Uint8Array(digest));
}

/** Unpadded base64url, the encoding every binary value in this app crosses the wire in. */
export function toBase64Url(bytes: Uint8Array<ArrayBufferLike>): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The return type is `Uint8Array<ArrayBuffer>`, not the default `Uint8Array`.
 *
 * WebCrypto's `BufferSource` will not accept a view over a `SharedArrayBuffer`, and the
 * unparameterised `Uint8Array` includes that possibility. Being specific here saves every
 * call site in `apps/web/src/lib/vaultCrypto.ts` from a cast.
 */
export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
