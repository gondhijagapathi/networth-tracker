/**
 * Encrypted document storage.
 *
 * The bytes that arrive here are already ciphertext: the browser encrypts the file under
 * the vault's data key before the upload starts, and prepends the twelve-byte IV. So this
 * module writes an opaque blob to disk and reads it back, and the most security-relevant
 * thing it does is *not* look at it.
 *
 * Two consequences of that design are worth spelling out:
 *
 *   - **Even the filename is private.** `meta` is a second envelope over `{filename, mime}`,
 *     so a stolen database says how large a document is and which asset it belongs to, and
 *     nothing else. The response therefore has no name to show — the browser decrypts one.
 *   - **The file is self-describing.** IV-prefixed ciphertext means a blob recovered from a
 *     backup needs nothing from this database to be decryptable except the owner's key,
 *     which is what makes the P8 restore path a file copy rather than a migration.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import {
  MAX_DOCUMENT_BYTES,
  uploadDocumentSchema,
  uuidv7,
  type VaultDocumentRecord,
} from '@networth/shared';
import type { AppContext } from '../context.js';
import { assets, documents, type DocumentRow } from '../db/schema.js';
import { packEnvelope, unpackEnvelope } from '../lib/envelope.js';
import { badRequest, notFound } from '../lib/errors.js';
import { isoNow } from '../lib/time.js';
import { recordAudit } from './audit.service.js';
import { requireVault } from './vault.service.js';

/** IV plus GCM tag. Anything at or below this is not an encrypted file, whatever it claims. */
const MIN_CIPHERTEXT_BYTES = 12 + 16;

export function listDocuments(
  ctx: AppContext,
  userId: string,
  filter: { assetId?: string } = {},
): VaultDocumentRecord[] {
  const conditions = [eq(documents.ownerUserId, userId)];
  if (filter.assetId) conditions.push(eq(documents.assetId, filter.assetId));

  return ctx.db
    .select()
    .from(documents)
    .where(and(...conditions))
    .all()
    .map(toRecord);
}

export function uploadDocument(
  ctx: AppContext,
  userId: string,
  raw: unknown,
  ciphertext: Buffer,
  ip: string | null,
): VaultDocumentRecord {
  requireVault(ctx, userId);

  const body = uploadDocumentSchema.parse(raw);

  if (ciphertext.length < MIN_CIPHERTEXT_BYTES) {
    throw badRequest('That upload is too short to be encrypted');
  }
  if (ciphertext.length > MAX_DOCUMENT_BYTES) {
    throw badRequest('Documents are limited to 10 MB');
  }

  const assetId = body.assetId ? assertOwnAsset(ctx, userId, body.assetId) : null;

  const now = ctx.now();
  const id = uuidv7(now.getTime());
  // Per-owner directories, so an operator inspecting `data/uploads` can tell whose files
  // they are holding without opening the database — and so a future per-user export is a
  // directory copy.
  const storagePath = join(userId, `${id}.bin`);
  const absolute = resolveUpload(ctx, storagePath);

  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, ciphertext, { mode: 0o600 });

  const row: DocumentRow = {
    id,
    ownerUserId: userId,
    assetId,
    meta: packEnvelope(body.meta),
    sizeBytes: ciphertext.length,
    storagePath,
    // Of the ciphertext as written, so a truncated or corrupted blob is caught before the
    // browser is handed something that will fail to authenticate for no visible reason.
    sha256: createHash('sha256').update(ciphertext).digest('hex'),
    createdAt: isoNow(now),
  };

  ctx.db.insert(documents).values(row).run();

  recordAudit(ctx, {
    actorUserId: userId,
    action: 'vault.document_uploaded',
    entityType: 'document',
    entityId: id,
    ip,
    meta: { sizeBytes: row.sizeBytes, assetId },
  });

  return toRecord(row);
}

/**
 * Read a document's ciphertext back.
 *
 * Audit-logged on every read, per SECURITY-MODEL.md: a document download is a vault read,
 * and "who fetched the will, and when" is exactly the question this log exists to answer.
 */
export function readDocument(
  ctx: AppContext,
  ownerUserId: string,
  id: string,
  ip: string | null,
  /** Who is asking, when that is not the owner — an heir reading a released vault. */
  actorUserId: string = ownerUserId,
): { row: DocumentRow; content: Buffer } {
  const row = ownedDocument(ctx, ownerUserId, id);
  const absolute = resolveUpload(ctx, row.storagePath);

  if (!existsSync(absolute)) {
    // The row survived but the blob did not — a restore that missed `data/uploads`, or a
    // deletion outside the app. Say so plainly instead of returning an empty file the
    // browser would fail to decrypt with no explanation.
    throw notFound('That document is recorded but its file is missing from this server');
  }

  const content = readFileSync(absolute);

  recordAudit(ctx, {
    actorUserId,
    action: 'vault.document_downloaded',
    entityType: 'document',
    entityId: id,
    ip,
    // Recorded when they differ, so "the heir fetched the will" reads as one row rather
    // than looking like the owner did it from beyond the grave.
    meta: actorUserId === ownerUserId ? undefined : { ownerUserId },
  });

  return { row, content };
}

export function deleteDocument(
  ctx: AppContext,
  userId: string,
  id: string,
  ip: string | null,
): void {
  const row = ownedDocument(ctx, userId, id);

  ctx.db.delete(documents).where(eq(documents.id, id)).run();
  // The row goes first: a file left behind is recoverable rubbish, whereas a row pointing
  // at a file that is gone is an error the owner cannot do anything about.
  rmSync(resolveUpload(ctx, row.storagePath), { force: true });

  recordAudit(ctx, {
    actorUserId: userId,
    action: 'vault.document_deleted',
    entityType: 'document',
    entityId: id,
    ip,
  });
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Turn a stored relative path into an absolute one, refusing anything that escapes.
 *
 * The path is generated by this module and never comes from a request, so this is belt and
 * braces — but a traversal here would read or delete arbitrary files as the server user,
 * and the check is three lines.
 */
function resolveUpload(ctx: AppContext, storagePath: string): string {
  const root = resolve(ctx.config.UPLOAD_DIR);
  const absolute = resolve(root, storagePath);
  if (absolute !== root && !absolute.startsWith(root + '/')) {
    throw badRequest('Invalid document path');
  }
  return absolute;
}

function ownedDocument(ctx: AppContext, userId: string, id: string): DocumentRow {
  const found = ctx.db
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.ownerUserId, userId)))
    .get();
  if (!found) throw notFound('No such document');
  return found;
}

function assertOwnAsset(ctx: AppContext, userId: string, assetId: string): string {
  const found = ctx.db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.ownerUserId, userId)))
    .get();
  if (!found) throw notFound('No such asset');
  return found.id;
}

function toRecord(row: DocumentRow): VaultDocumentRecord {
  return {
    id: row.id,
    assetId: row.assetId,
    meta: unpackEnvelope(row.meta),
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    createdAt: row.createdAt,
  };
}
