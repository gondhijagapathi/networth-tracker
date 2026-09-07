/**
 * Reading and writing the ciphertext envelopes stored in TEXT columns.
 *
 * The vault's encrypted values live in the database as the JSON `{v, iv, ct}` that the
 * browser produced, stored verbatim. This module is the only place that turns that column
 * into an object and back, and it exists to make one guarantee easy to check: nothing on
 * the server inspects, transforms or re-encodes the ciphertext. It is opaque bytes in, the
 * same opaque bytes out.
 *
 * A column that fails to parse is a corrupted row, not a recoverable state — the CHECK
 * constraints in `schema.ts` mean this application could not have written it — so the read
 * throws rather than returning a half-item the client would try to decrypt.
 */

import { cipherEnvelopeSchema, type CipherEnvelope } from '@networth/shared';
import { ApiError } from './errors.js';

/** Serialise an envelope for storage. Key order is fixed so the column is stable. */
export function packEnvelope(envelope: CipherEnvelope): string {
  return JSON.stringify({ v: envelope.v, iv: envelope.iv, ct: envelope.ct });
}

export function unpackEnvelope(stored: string): CipherEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    throw corrupt();
  }

  const result = cipherEnvelopeSchema.safeParse(parsed);
  if (!result.success) throw corrupt();
  return result.data;
}

function corrupt(): ApiError {
  // 500, not 400: the caller did nothing wrong, and the operator needs to know that a row
  // in their database is not what this application wrote.
  return new ApiError('internal', 'A stored vault record is not readable');
}
