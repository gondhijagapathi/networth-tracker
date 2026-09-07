/**
 * The vault, from the server's side of the wall.
 *
 * Everything in this file moves ciphertext. There is no decryption here, no key derivation,
 * and no value the server could use to check a passphrase — read it as an inventory of what
 * this process is *unable* to do (docs/SECURITY-MODEL.md).
 *
 * Two rules keep that true:
 *
 *   - Every body is parsed by a schema from `@networth/shared` that rejects anything which
 *     is not a `{v, iv, ct}` envelope, so a client bug cannot upload a password in the
 *     clear. The database repeats the check as a CHECK constraint.
 *   - Vault rows are never scoped by a grant. A nominee with `vault` access reads the
 *     ciphertext through the estate endpoints and opens it with an escrowed key; there is
 *     no path by which one user's session reads another user's vault items directly.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  uuidv7,
  type CreateVaultItemBody,
  type PublicKeyJwk,
  type RekeyVaultBody,
  type SetupVaultBody,
  type UpdateVaultItemBody,
  type VaultItemKind,
  type VaultItemRecord,
  type VaultKeyMaterial,
  type VaultStatus,
} from '@networth/shared';
import type { AppContext } from '../context.js';
import { assets, documents, vaultItems, vaultKeys, type VaultItemRow } from '../db/schema.js';
import { packEnvelope, unpackEnvelope } from '../lib/envelope.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { isoNow } from '../lib/time.js';
import { recordAudit } from './audit.service.js';

/* -------------------------------------------------------------------------- */
/* Key material                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Whether a vault exists and how much is in it — deliberately without the key material.
 *
 * Splitting this from {@link unlockVault} is what gives the rate limiter something to
 * count. A locked screen can show "12 items, 3 documents" on every page load without that
 * being an unlock attempt.
 */
export function vaultStatus(ctx: AppContext, userId: string): VaultStatus {
  const keys = keyRow(ctx, userId);

  return {
    initialised: keys !== undefined,
    itemCount: countRows(ctx, vaultItems, userId),
    documentCount: countRows(ctx, documents, userId),
    keys: null,
  };
}

/**
 * Hand back the wrapped key material so the browser can try to open it.
 *
 * Charged against the vault limiter on every call and reset by {@link confirmUnlock}, so a
 * user who types their passphrase correctly pays nothing and a script pulling the material
 * in a loop backs off. The server cannot tell those two apart by itself — that is the whole
 * point of the design — so it counts retrievals and lets the client report success.
 */
export function unlockVault(ctx: AppContext, userId: string, ip: string | null): VaultKeyMaterial {
  const key = `user:${userId}`;
  ctx.vaultLimiter.assertAllowed(key);

  const row = keyRow(ctx, userId);
  if (!row) throw notFound('This account has no vault yet');

  ctx.vaultLimiter.recordFailure(key);
  recordAudit(ctx, { actorUserId: userId, action: 'vault.unlock_requested', ip });

  return toKeyMaterial(row);
}

/** The client opened the vault. Clears the backoff and marks the attempt successful. */
export function confirmUnlock(ctx: AppContext, userId: string, ip: string | null): void {
  ctx.vaultLimiter.reset(`user:${userId}`);
  recordAudit(ctx, { actorUserId: userId, action: 'vault.unlocked', ip });
}

/**
 * Create the vault.
 *
 * Once only. Overwriting the key material of a vault that already holds items would leave
 * every one of them undecryptable, and no confirmation dialog is worth the risk of a retried
 * request doing it — so the second call is a conflict and changing the passphrase is
 * {@link rekeyVault}, which is explicit about keeping the same data key.
 */
export function createVault(
  ctx: AppContext,
  userId: string,
  body: SetupVaultBody,
  ip: string | null,
): VaultKeyMaterial {
  if (keyRow(ctx, userId)) throw conflict('This account already has a vault');

  const now = isoNow(ctx.now());
  const row: typeof vaultKeys.$inferInsert = {
    userId,
    kdfSalt: body.kdfSalt,
    kdfParams: JSON.stringify(body.kdfParams),
    wrappedDek: packEnvelope(body.wrappedDek),
    publicKeyJwk: JSON.stringify(body.publicKeyJwk),
    wrappedPrivateKey: packEnvelope(body.wrappedPrivateKey),
    createdAt: now,
    updatedAt: now,
  };

  ctx.db.insert(vaultKeys).values(row).run();
  recordAudit(ctx, { actorUserId: userId, action: 'vault.created', ip });

  return toKeyMaterial({ ...row, createdAt: now, updatedAt: now });
}

/**
 * Change the vault passphrase.
 *
 * The data key does not change, so not one item is re-encrypted — only the wrapping around
 * the key does. The public key is left alone for the same reason: rotating it would strand
 * every escrow an owner had already sealed to a nominee.
 */
export function rekeyVault(
  ctx: AppContext,
  userId: string,
  body: RekeyVaultBody,
  ip: string | null,
): VaultKeyMaterial {
  const existing = keyRow(ctx, userId);
  if (!existing) throw notFound('This account has no vault yet');

  const now = isoNow(ctx.now());
  ctx.db
    .update(vaultKeys)
    .set({
      kdfSalt: body.kdfSalt,
      kdfParams: JSON.stringify(body.kdfParams),
      wrappedDek: packEnvelope(body.wrappedDek),
      wrappedPrivateKey: packEnvelope(body.wrappedPrivateKey),
      updatedAt: now,
    })
    .where(eq(vaultKeys.userId, userId))
    .run();

  ctx.vaultLimiter.reset(`user:${userId}`);
  recordAudit(ctx, { actorUserId: userId, action: 'vault.rekeyed', ip });

  return toKeyMaterial({
    ...existing,
    kdfSalt: body.kdfSalt,
    kdfParams: JSON.stringify(body.kdfParams),
    wrappedDek: packEnvelope(body.wrappedDek),
    wrappedPrivateKey: packEnvelope(body.wrappedPrivateKey),
    updatedAt: now,
  });
}

/** True once a user has a keypair an owner could wrap a data key to. */
export function hasVault(ctx: AppContext, userId: string): boolean {
  return keyRow(ctx, userId) !== undefined;
}

/**
 * The public half of somebody's keypair.
 *
 * Public by design — an owner has to wrap their data key to a nominee who is not present —
 * but reached only through a nomination the caller owns, never by bare user id, so this is
 * not an enumeration endpoint.
 */
export function publicKeyOfUser(ctx: AppContext, userId: string): PublicKeyJwk | null {
  const found = keyRow(ctx, userId);
  return found ? (JSON.parse(found.publicKeyJwk) as PublicKeyJwk) : null;
}

/* -------------------------------------------------------------------------- */
/* Items                                                                      */
/* -------------------------------------------------------------------------- */

export function listVaultItems(
  ctx: AppContext,
  userId: string,
  filter: { assetId?: string } = {},
): VaultItemRecord[] {
  const conditions = [eq(vaultItems.ownerUserId, userId)];
  if (filter.assetId) conditions.push(eq(vaultItems.assetId, filter.assetId));

  return ctx.db
    .select()
    .from(vaultItems)
    .where(and(...conditions))
    .all()
    .map(toItemRecord);
}

export function getVaultItem(ctx: AppContext, userId: string, itemId: string): VaultItemRecord {
  return toItemRecord(ownedItem(ctx, userId, itemId));
}

export function createVaultItem(
  ctx: AppContext,
  userId: string,
  body: CreateVaultItemBody,
  ip: string | null,
): VaultItemRecord {
  requireVault(ctx, userId);
  const assetId = body.assetId ? assertOwnAsset(ctx, userId, body.assetId) : null;

  const now = ctx.now();
  const row: VaultItemRow = {
    id: uuidv7(now.getTime()),
    ownerUserId: userId,
    assetId,
    kind: body.kind,
    payload: packEnvelope(body.payload),
    createdAt: isoNow(now),
    updatedAt: isoNow(now),
  };

  ctx.db.insert(vaultItems).values(row).run();
  // The kind is logged and the label is not: the audit trail records that a bank login was
  // stored, never which bank.
  recordAudit(ctx, {
    actorUserId: userId,
    action: 'vault.item_created',
    entityType: 'vault_item',
    entityId: row.id,
    ip,
    meta: { kind: body.kind },
  });

  return toItemRecord(row);
}

export function updateVaultItem(
  ctx: AppContext,
  userId: string,
  itemId: string,
  body: UpdateVaultItemBody,
  ip: string | null,
): VaultItemRecord {
  const existing = ownedItem(ctx, userId, itemId);
  const now = isoNow(ctx.now());

  const patch: Partial<VaultItemRow> = { updatedAt: now };
  if (body.kind !== undefined) patch.kind = body.kind;
  if (body.payload !== undefined) patch.payload = packEnvelope(body.payload);
  if (body.assetId !== undefined) {
    patch.assetId = body.assetId === '' ? null : assertOwnAsset(ctx, userId, body.assetId);
  }

  ctx.db.update(vaultItems).set(patch).where(eq(vaultItems.id, itemId)).run();
  recordAudit(ctx, {
    actorUserId: userId,
    action: 'vault.item_updated',
    entityType: 'vault_item',
    entityId: itemId,
    ip,
  });

  return toItemRecord({ ...existing, ...patch });
}

/**
 * Delete, not archive.
 *
 * The opposite of the rule for assets, and for the opposite reason: an asset's history is
 * worth keeping, while a password that has been changed is a liability. Nothing here needs
 * to be reconstructible after the fact except the audit row saying it was removed.
 */
export function deleteVaultItem(
  ctx: AppContext,
  userId: string,
  itemId: string,
  ip: string | null,
): void {
  const existing = ownedItem(ctx, userId, itemId);
  ctx.db.delete(vaultItems).where(eq(vaultItems.id, itemId)).run();
  recordAudit(ctx, {
    actorUserId: userId,
    action: 'vault.item_deleted',
    entityType: 'vault_item',
    entityId: itemId,
    ip,
    meta: { kind: existing.kind },
  });
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Throws unless the caller has set up a vault. Items without key material are unopenable. */
export function requireVault(ctx: AppContext, userId: string): void {
  if (!keyRow(ctx, userId)) {
    throw badRequest('Set up your vault before adding anything to it');
  }
}

/**
 * Confirm an asset belongs to the caller.
 *
 * A vault item may link to an asset, and that link is the one field on a vault row an
 * attacker could use to probe: pointing an item at somebody else's asset id and reading the
 * error would confirm the id exists. `not found` either way.
 */
function assertOwnAsset(ctx: AppContext, userId: string, assetId: string): string {
  const found = ctx.db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.ownerUserId, userId)))
    .get();
  if (!found) throw notFound('No such asset');
  return found.id;
}

function ownedItem(ctx: AppContext, userId: string, itemId: string): VaultItemRow {
  const found = ctx.db
    .select()
    .from(vaultItems)
    .where(and(eq(vaultItems.id, itemId), eq(vaultItems.ownerUserId, userId)))
    .get();
  if (!found) throw notFound('No such vault item');
  return found;
}

function keyRow(ctx: AppContext, userId: string) {
  return ctx.db.select().from(vaultKeys).where(eq(vaultKeys.userId, userId)).get();
}

function countRows(
  ctx: AppContext,
  table: typeof vaultItems | typeof documents,
  userId: string,
): number {
  const result = ctx.db
    .select({ count: sql<number>`count(*)` })
    .from(table)
    .where(eq(table.ownerUserId, userId))
    .get();
  return result?.count ?? 0;
}

function toKeyMaterial(stored: {
  kdfSalt: string;
  kdfParams: string;
  wrappedDek: string;
  publicKeyJwk: string;
  wrappedPrivateKey: string;
  createdAt: string;
  updatedAt: string;
}): VaultKeyMaterial {
  return {
    kdfSalt: stored.kdfSalt,
    // Stored verbatim as the client chose them, so a vault created under older parameters
    // still derives the key it was created with.
    kdfParams: JSON.parse(stored.kdfParams) as VaultKeyMaterial['kdfParams'],
    wrappedDek: unpackEnvelope(stored.wrappedDek),
    publicKeyJwk: JSON.parse(stored.publicKeyJwk) as VaultKeyMaterial['publicKeyJwk'],
    wrappedPrivateKey: unpackEnvelope(stored.wrappedPrivateKey),
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

function toItemRecord(item: VaultItemRow): VaultItemRecord {
  return {
    id: item.id,
    kind: item.kind as VaultItemKind,
    assetId: item.assetId,
    payload: unpackEnvelope(item.payload),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/**
 * Which vault items belong to which asset.
 *
 * The claim kit needs this to tell an heir "the login for this account is item 3" without
 * the server ever learning what item 3 says. Items with no asset are left out; they appear
 * in the kit's own section instead.
 */
export function vaultItemIdsByAsset(ctx: AppContext, userId: string): Map<string, string[]> {
  const rows = ctx.db
    .select({ id: vaultItems.id, assetId: vaultItems.assetId })
    .from(vaultItems)
    .where(eq(vaultItems.ownerUserId, userId))
    .all();

  const byAsset = new Map<string, string[]>();
  for (const entry of rows) {
    if (entry.assetId === null) continue;
    const list = byAsset.get(entry.assetId) ?? [];
    list.push(entry.id);
    byAsset.set(entry.assetId, list);
  }
  return byAsset;
}
