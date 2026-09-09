/**
 * Nominees and key escrow.
 *
 * A nomination in this app is three things that must stay in step, and the whole file is
 * about keeping them so:
 *
 *   1. a **record** — who the heir is, what share, what they may see;
 *   2. an **access grant** — the row every scoped read consults, so the portal shows them
 *      an estate without a single query in the codebase learning about nominees;
 *   3. an **escrow** — the owner's data key wrapped to the heir's public key, sealed until
 *      released.
 *
 * Levels 2 and 3 are deliberately independent. The access level governs the API; the escrow
 * governs the cryptography. An heir with `vault` access before release sees ciphertext and
 * can do nothing with it. Both have to open before a password is readable, and no single
 * mistake in either can produce that outcome on its own.
 */

import { and, eq, isNull } from 'drizzle-orm';
import {
  publicKeyFingerprint,
  uuidv7,
  type CreateNomineeBody,
  type EscrowReleaseReason,
  type EscrowSummary,
  type EstateSummary,
  type NomineeAccessLevel,
  type NomineeRecord,
  type PublicKeyJwk,
  type SealEscrowBody,
  type UpdateNomineeBody,
} from '@networth/shared';
import type { AppContext } from '../context.js';
import {
  accessGrants,
  nominees,
  users,
  vaultEscrow,
  vaultKeys,
  type NomineeRow,
  type VaultEscrowRow,
} from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { estateReleasedEmail } from '../lib/mailTemplates.js';
import { isoNow } from '../lib/time.js';
import { recordAudit } from './audit.service.js';
import { createInvite } from './invite.service.js';
import { queueEmail } from './mail.service.js';

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export function listNominees(ctx: AppContext, ownerUserId: string): NomineeRecord[] {
  const rows = ctx.db.select().from(nominees).where(eq(nominees.ownerUserId, ownerUserId)).all();

  const escrows = new Map<string, VaultEscrowRow>();
  for (const escrow of ctx.db
    .select()
    .from(vaultEscrow)
    .where(eq(vaultEscrow.ownerUserId, ownerUserId))
    .all()) {
    escrows.set(escrow.nomineeId, escrow);
  }

  return rows.map((row) =>
    toRecord(row, escrows.get(row.id) ?? null, hasPublicKey(ctx, row.nomineeUserId)),
  );
}

export function getNominee(ctx: AppContext, ownerUserId: string, id: string): NomineeRecord {
  const row = ownedNominee(ctx, ownerUserId, id);
  return toRecord(row, escrowOf(ctx, id), hasPublicKey(ctx, row.nomineeUserId));
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

export function createNominee(
  ctx: AppContext,
  ownerUserId: string,
  body: CreateNomineeBody,
  ip: string | null,
): NomineeRecord {
  // Nominating yourself is not a nomination, and it would mint a grant from a user to
  // themselves — which `resolveScope` deletes, leaving a row that looks like access and
  // is not.
  if (body.email) assertNotSelf(ctx, ownerUserId, body.email);

  const now = ctx.now();
  const row: NomineeRow = {
    id: uuidv7(now.getTime()),
    ownerUserId,
    nomineeUserId: null,
    email: body.email ?? null,
    name: body.name,
    relation: body.relation ?? null,
    accessLevel: body.accessLevel,
    status: 'invited',
    invitedAt: null,
    acceptedAt: null,
    createdAt: isoNow(now),
    updatedAt: isoNow(now),
  };

  ctx.db.insert(nominees).values(row).run();

  // Linking on creation, not only on registration: the heir may already have an account —
  // a partner who is also a member — in which case the nomination should be live at once.
  const linked = linkExistingUser(ctx, row, ip);

  recordAudit(ctx, {
    actorUserId: ownerUserId,
    action: 'nominee.created',
    entityType: 'nominee',
    entityId: row.id,
    ip,
    meta: { accessLevel: body.accessLevel, linked: linked !== null },
  });

  return toRecord(linked ?? row, null, hasPublicKey(ctx, (linked ?? row).nomineeUserId));
}

export function updateNominee(
  ctx: AppContext,
  ownerUserId: string,
  id: string,
  body: UpdateNomineeBody,
  ip: string | null,
): NomineeRecord {
  const existing = ownedNominee(ctx, ownerUserId, id);
  if (existing.status === 'revoked') throw conflict('That nomination has been revoked');
  if (body.email) assertNotSelf(ctx, ownerUserId, body.email);

  const now = isoNow(ctx.now());
  const patch: Partial<NomineeRow> = { updatedAt: now };
  if (body.name !== undefined) patch.name = body.name;
  if (body.email !== undefined) patch.email = body.email;
  if (body.relation !== undefined) patch.relation = body.relation;
  if (body.accessLevel !== undefined) patch.accessLevel = body.accessLevel;

  ctx.db.update(nominees).set(patch).where(eq(nominees.id, id)).run();
  const updated = { ...existing, ...patch };

  // A narrowed access level has to bite immediately, not at the next sign-in. The grant is
  // rewritten in the same request that changed the nomination.
  if (body.accessLevel !== undefined && updated.nomineeUserId && updated.status === 'accepted') {
    revokeGrantsFor(ctx, ownerUserId, id);
    grantAccess(ctx, ownerUserId, updated.nomineeUserId, body.accessLevel, id);
  }

  recordAudit(ctx, {
    actorUserId: ownerUserId,
    action: 'nominee.updated',
    entityType: 'nominee',
    entityId: id,
    ip,
    meta: { accessLevel: updated.accessLevel },
  });

  return toRecord(updated, escrowOf(ctx, id), hasPublicKey(ctx, updated.nomineeUserId));
}

/**
 * Issue the invite that lets a nominee create their own account.
 *
 * The code is an ordinary invite with `role: 'nominee'`, bound to the nominee's address, so
 * registration is the same code path as everybody else's and the read-only guard falls out
 * of the role rather than a special case. Acceptance happens in {@link linkNomineeAccounts}
 * when that address registers.
 */
export function inviteNominee(
  ctx: AppContext,
  ownerUserId: string,
  id: string,
  ip: string | null,
): { nominee: NomineeRecord; code: string; emailQueued: boolean } {
  const existing = ownedNominee(ctx, ownerUserId, id);
  if (!existing.email) {
    throw badRequest('Add an email address before inviting this nominee');
  }
  if (existing.nomineeUserId) throw conflict('That nominee already has an account');

  const owner = ctx.db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, ownerUserId))
    .get();

  const { code, emailQueued } = createInvite(
    ctx,
    ownerUserId,
    {
      email: existing.email,
      role: 'nominee',
      expiresInDays: 30,
      note: `Nominee invite for ${existing.name}`,
      sendEmail: true,
    },
    {
      // A nominee is the one invitee who has no idea this application exists, so the mail
      // has to say who named them and why before it asks them to make an account.
      kind: 'nominee',
      ownerName: owner?.name ?? 'Somebody',
      nomineeName: existing.name,
      accessLevel: existing.accessLevel,
    },
  );

  const now = isoNow(ctx.now());
  ctx.db.update(nominees).set({ invitedAt: now, updatedAt: now }).where(eq(nominees.id, id)).run();

  recordAudit(ctx, {
    actorUserId: ownerUserId,
    action: 'nominee.invited',
    entityType: 'nominee',
    entityId: id,
    ip,
  });

  return {
    nominee: toRecord({ ...existing, invitedAt: now }, escrowOf(ctx, id), false),
    code,
    emailQueued,
  };
}

/**
 * End a nomination.
 *
 * Three things happen together and must not be separable: the record is marked revoked, the
 * access grant is closed so the portal goes dark on the next request, and the escrow is
 * revoked so the server will not hand over the wrapped key.
 *
 * One honest limitation, surfaced to the owner in the UI: revoking an escrow that was
 * *already released* stops the server serving it again, but an heir who fetched it holds a
 * copy of the data key. Genuinely taking that back means re-encrypting every vault item
 * under a new key, which this phase does not do.
 */
export function revokeNominee(
  ctx: AppContext,
  ownerUserId: string,
  id: string,
  ip: string | null,
): NomineeRecord {
  const existing = ownedNominee(ctx, ownerUserId, id);
  const now = isoNow(ctx.now());

  ctx.db.transaction((tx) => {
    tx.update(nominees).set({ status: 'revoked', updatedAt: now }).where(eq(nominees.id, id)).run();

    tx.update(accessGrants)
      .set({ revokedAt: now })
      .where(
        and(
          eq(accessGrants.ownerUserId, ownerUserId),
          eq(accessGrants.source, 'nominee'),
          eq(accessGrants.sourceId, id),
          isNull(accessGrants.revokedAt),
        ),
      )
      .run();

    tx.update(vaultEscrow)
      .set({ state: 'revoked', revokedAt: now, updatedAt: now })
      .where(eq(vaultEscrow.nomineeId, id))
      .run();
  });

  recordAudit(ctx, {
    actorUserId: ownerUserId,
    action: 'nominee.revoked',
    entityType: 'nominee',
    entityId: id,
    ip,
    meta: { hadEscrow: escrowOf(ctx, id) !== null },
  });

  return toRecord({ ...existing, status: 'revoked' }, escrowOf(ctx, id), false);
}

/* -------------------------------------------------------------------------- */
/* Escrow                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Store a data key wrapped to this nominee's public key.
 *
 * The wrapping happened in the owner's browser; all this does is check that it was wrapped
 * to the *right* key. The fingerprint is recomputed from the JWK this database holds rather
 * than trusted from the request, which closes the one substitution attack an otherwise
 * end-to-end flow leaves open — a compromised client handing the owner an attacker's public
 * key to wrap to.
 */
export async function sealEscrow(
  ctx: AppContext,
  ownerUserId: string,
  id: string,
  body: SealEscrowBody,
  ip: string | null,
): Promise<EscrowSummary> {
  const nominee = ownedNominee(ctx, ownerUserId, id);
  if (nominee.status !== 'accepted' || !nominee.nomineeUserId) {
    throw badRequest('This nominee has not accepted their invite yet');
  }

  const key = ctx.db
    .select({ publicKeyJwk: vaultKeys.publicKeyJwk })
    .from(vaultKeys)
    .where(eq(vaultKeys.userId, nominee.nomineeUserId))
    .get();
  if (!key) throw badRequest('This nominee has not set up their own vault yet');

  const expected = await publicKeyFingerprint(JSON.parse(key.publicKeyJwk) as PublicKeyJwk);
  if (expected !== body.publicKeyFingerprint) {
    throw badRequest('That key does not match the one on record for this nominee');
  }

  const now = isoNow(ctx.now());
  const existing = escrowRow(ctx, id);

  // Re-sealing replaces the row rather than adding one. There is exactly one wrapped key
  // per nomination, and a second would be an ambiguity about which one release means.
  const escrow: VaultEscrowRow = {
    id: existing?.id ?? uuidv7(ctx.now().getTime()),
    ownerUserId,
    nomineeId: id,
    granteeUserId: nominee.nomineeUserId,
    wrappedDek: body.wrappedDek,
    publicKeyFingerprint: body.publicKeyFingerprint,
    state: 'sealed',
    releaseReason: null,
    releasedAt: null,
    revokedAt: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (existing) {
    ctx.db.update(vaultEscrow).set(escrow).where(eq(vaultEscrow.id, existing.id)).run();
  } else {
    ctx.db.insert(vaultEscrow).values(escrow).run();
  }

  recordAudit(ctx, {
    actorUserId: ownerUserId,
    action: 'escrow.sealed',
    entityType: 'vault_escrow',
    entityId: escrow.id,
    ip,
    meta: { nomineeId: id, resealed: existing !== null },
  });

  return toEscrowSummary(escrow);
}

/**
 * Open a sealed escrow.
 *
 * Called by an owner who has decided to hand over access, and by the dead-man switch when
 * silence runs out. `reason` is stored rather than inferred, because "did they choose this
 * or did the timer" is the first question anyone will ask afterwards.
 */
export function releaseEscrow(
  ctx: AppContext,
  ownerUserId: string,
  nomineeId: string,
  reason: EscrowReleaseReason,
  ip: string | null,
): EscrowSummary {
  const escrow = escrowRow(ctx, nomineeId);
  if (!escrow || escrow.ownerUserId !== ownerUserId) throw notFound('No escrow for that nominee');
  if (escrow.state === 'revoked') throw conflict('That escrow has been revoked');
  if (escrow.state === 'released') return toEscrowSummary(escrow);

  const now = isoNow(ctx.now());
  const released: VaultEscrowRow = {
    ...escrow,
    state: 'released',
    releaseReason: reason,
    releasedAt: now,
    updatedAt: now,
  };

  ctx.db
    .update(vaultEscrow)
    .set({ state: 'released', releaseReason: reason, releasedAt: now, updatedAt: now })
    .where(eq(vaultEscrow.id, escrow.id))
    .run();

  recordAudit(ctx, {
    actorUserId: reason === 'owner' ? ownerUserId : null,
    action: 'escrow.released',
    entityType: 'vault_escrow',
    entityId: escrow.id,
    ip,
    meta: { nomineeId, reason },
  });

  notifyHeirOfRelease(ctx, escrow, reason);

  return toEscrowSummary(released);
}

/** Every sealed escrow an owner holds. The dead-man switch fires against exactly this list. */
/**
 * Tell the heir their key is open.
 *
 * The single most consequential notification this application sends, and the reason it is
 * sent at all: an escrow that opens silently is a claim kit nobody knows to look at. It
 * goes to the address on the *nominee record* rather than the linked account, because those
 * can differ and the record is what the owner actually wrote down.
 *
 * Failure here is swallowed. A release has already happened and is already audited; a
 * notification that could not be composed must not roll that back or bubble a 500 into the
 * dead-man sweep that is releasing the next one.
 */
function notifyHeirOfRelease(
  ctx: AppContext,
  escrow: VaultEscrowRow,
  reason: EscrowReleaseReason,
): void {
  try {
    const nominee = ctx.db.select().from(nominees).where(eq(nominees.id, escrow.nomineeId)).get();
    const grantee = ctx.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, escrow.granteeUserId))
      .get();

    const to = nominee?.email ?? grantee?.email;
    if (!to) return;

    const owner = ctx.db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, escrow.ownerUserId))
      .get();

    queueEmail(
      ctx,
      to,
      estateReleasedEmail(
        { baseUrl: ctx.config.appBaseUrl },
        {
          nomineeName: nominee?.name ?? 'Hello',
          ownerName: owner?.name ?? 'The account holder',
          reason,
        },
      ),
      { userId: escrow.granteeUserId },
    );
  } catch {
    // See the doc comment: the release stands regardless.
  }
}

export function sealedEscrows(ctx: AppContext, ownerUserId: string): VaultEscrowRow[] {
  return ctx.db
    .select()
    .from(vaultEscrow)
    .where(and(eq(vaultEscrow.ownerUserId, ownerUserId), eq(vaultEscrow.state, 'sealed')))
    .all();
}

/* -------------------------------------------------------------------------- */
/* The nominee's own view                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The estates this user has been named in.
 *
 * `wrappedDek` is present only on a released escrow. That is the single line in this file
 * where the server decides whether an heir can read a household's passwords, which is why
 * it is a `case` on state rather than a filter somewhere upstream.
 */
export function listEstates(ctx: AppContext, granteeUserId: string): EstateSummary[] {
  const rows = ctx.db
    .select({
      nominee: nominees,
      owner: { id: users.id, name: users.name, email: users.email },
      escrow: vaultEscrow,
    })
    .from(nominees)
    .innerJoin(users, eq(users.id, nominees.ownerUserId))
    .leftJoin(vaultEscrow, eq(vaultEscrow.nomineeId, nominees.id))
    .where(and(eq(nominees.nomineeUserId, granteeUserId), eq(nominees.status, 'accepted')))
    .all();

  return rows.map(({ nominee, owner, escrow }) => ({
    ownerUserId: owner.id,
    ownerName: owner.name,
    ownerEmail: owner.email,
    relation: nominee.relation,
    accessLevel: nominee.accessLevel as NomineeAccessLevel,
    escrowState: escrow?.state ?? null,
    wrappedDek: escrow?.state === 'released' ? escrow.wrappedDek : null,
    releasedAt: escrow?.releasedAt ?? null,
  }));
}

/**
 * Fetch a released wrapped key, and write down that it was fetched.
 *
 * Separate from {@link listEstates} even though the list already carries the key, because
 * an audit row per *read* is what SECURITY-MODEL.md promises, and a list that is refreshed
 * by a polling UI would otherwise fill the log with noise that means nothing.
 */
export function readEscrowKey(
  ctx: AppContext,
  granteeUserId: string,
  ownerUserId: string,
  ip: string | null,
): { wrappedDek: string; releasedAt: string } {
  const escrow = ctx.db
    .select()
    .from(vaultEscrow)
    .where(
      and(eq(vaultEscrow.granteeUserId, granteeUserId), eq(vaultEscrow.ownerUserId, ownerUserId)),
    )
    .get();

  if (!escrow) throw notFound('No escrow for that estate');
  if (escrow.state !== 'released') {
    // A 403 rather than a 404: this heir already knows the escrow exists — they were told
    // so when they were named — and pretending otherwise would only confuse them.
    throw forbidden('That vault has not been released');
  }

  recordAudit(ctx, {
    actorUserId: granteeUserId,
    action: 'escrow.read',
    entityType: 'vault_escrow',
    entityId: escrow.id,
    ip,
    meta: { ownerUserId },
  });

  return { wrappedDek: escrow.wrappedDek, releasedAt: escrow.releasedAt! };
}

/**
 * The gate on an heir reading an owner's vault.
 *
 * Both locks have to be open. The nomination must be live and carry `vault` access — that
 * is the owner's stated intent — *and* the escrow must be released, which is the event that
 * actually happened. Either one alone is not enough, and this is the only function in the
 * codebase that says so, which is why the estate router calls it rather than assembling the
 * same two checks itself.
 */
export function assertVaultReleased(
  ctx: AppContext,
  granteeUserId: string,
  ownerUserId: string,
): void {
  const nominee = ctx.db
    .select()
    .from(nominees)
    .where(
      and(
        eq(nominees.nomineeUserId, granteeUserId),
        eq(nominees.ownerUserId, ownerUserId),
        eq(nominees.status, 'accepted'),
      ),
    )
    .get();

  if (!nominee) throw notFound('No such estate');
  if (nominee.accessLevel !== 'vault') {
    throw forbidden('You were not given vault access to this estate');
  }

  const escrow = escrowRow(ctx, nominee.id);
  if (!escrow || escrow.state !== 'released') {
    throw forbidden('That vault has not been released');
  }
}

/* -------------------------------------------------------------------------- */
/* Linking accounts                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Turn a nomination into a live grant once the heir has an account.
 *
 * Called after registration rather than wired into the invite: a nomination can be recorded
 * for somebody who never registers, and an heir may register from an invite an admin issued
 * for another reason entirely. Matching on the address covers both, and matching only rows
 * still in `invited` means a revoked nomination is never silently resurrected.
 */
export function linkNomineeAccounts(
  ctx: AppContext,
  user: { id: string; email: string },
  ip: string | null,
): number {
  const pending = ctx.db
    .select()
    .from(nominees)
    .where(and(eq(nominees.email, user.email), eq(nominees.status, 'invited')))
    .all();

  let linked = 0;
  for (const nominee of pending) {
    // Somebody could be nominated by their own account only through a data edit, but the
    // grant it would produce is nonsense, so it is refused here too.
    if (nominee.ownerUserId === user.id) continue;
    acceptNomination(ctx, nominee, user.id, ip);
    linked += 1;
  }
  return linked;
}

/** The same acceptance, for a nominee whose account already existed when they were named. */
function linkExistingUser(
  ctx: AppContext,
  nominee: NomineeRow,
  ip: string | null,
): NomineeRow | null {
  if (!nominee.email) return null;

  const user = ctx.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, nominee.email))
    .get();

  if (!user || user.id === nominee.ownerUserId) return null;
  return acceptNomination(ctx, nominee, user.id, ip);
}

function acceptNomination(
  ctx: AppContext,
  nominee: NomineeRow,
  granteeUserId: string,
  ip: string | null,
): NomineeRow {
  const now = isoNow(ctx.now());

  ctx.db
    .update(nominees)
    .set({ nomineeUserId: granteeUserId, status: 'accepted', acceptedAt: now, updatedAt: now })
    .where(eq(nominees.id, nominee.id))
    .run();

  grantAccess(
    ctx,
    nominee.ownerUserId,
    granteeUserId,
    nominee.accessLevel as NomineeAccessLevel,
    nominee.id,
  );

  recordAudit(ctx, {
    actorUserId: granteeUserId,
    action: 'nominee.accepted',
    entityType: 'nominee',
    entityId: nominee.id,
    ip,
    meta: { ownerUserId: nominee.ownerUserId, accessLevel: nominee.accessLevel },
  });

  return { ...nominee, nomineeUserId: granteeUserId, status: 'accepted', acceptedAt: now };
}

/* -------------------------------------------------------------------------- */
/* Grants                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Write the row `resolveScope` will read.
 *
 * A grant never expires on its own here — a nomination is open-ended by nature — and it is
 * always read-only, because `access_grants` has no scope that confers writes and nothing in
 * the codebase resolves one into a write path.
 */
function grantAccess(
  ctx: AppContext,
  ownerUserId: string,
  granteeUserId: string,
  scope: NomineeAccessLevel,
  nomineeId: string,
): void {
  ctx.db
    .insert(accessGrants)
    .values({
      id: uuidv7(ctx.now().getTime()),
      ownerUserId,
      granteeUserId,
      scope,
      source: 'nominee',
      sourceId: nomineeId,
      grantedAt: isoNow(ctx.now()),
    })
    .run();
}

function revokeGrantsFor(ctx: AppContext, ownerUserId: string, nomineeId: string): void {
  ctx.db
    .update(accessGrants)
    .set({ revokedAt: isoNow(ctx.now()) })
    .where(
      and(
        eq(accessGrants.ownerUserId, ownerUserId),
        eq(accessGrants.source, 'nominee'),
        eq(accessGrants.sourceId, nomineeId),
        isNull(accessGrants.revokedAt),
      ),
    )
    .run();
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function ownedNominee(ctx: AppContext, ownerUserId: string, id: string): NomineeRow {
  const found = ctx.db
    .select()
    .from(nominees)
    .where(and(eq(nominees.id, id), eq(nominees.ownerUserId, ownerUserId)))
    .get();
  if (!found) throw notFound('No such nominee');
  return found;
}

function assertNotSelf(ctx: AppContext, ownerUserId: string, email: string): void {
  const owner = ctx.db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, ownerUserId))
    .get();
  if (owner?.email === email) throw badRequest('You cannot nominate yourself');
}

function escrowRow(ctx: AppContext, nomineeId: string): VaultEscrowRow | undefined {
  return ctx.db.select().from(vaultEscrow).where(eq(vaultEscrow.nomineeId, nomineeId)).get();
}

function escrowOf(ctx: AppContext, nomineeId: string): VaultEscrowRow | null {
  return escrowRow(ctx, nomineeId) ?? null;
}

function hasPublicKey(ctx: AppContext, userId: string | null): boolean {
  if (!userId) return false;
  return (
    ctx.db
      .select({ userId: vaultKeys.userId })
      .from(vaultKeys)
      .where(eq(vaultKeys.userId, userId))
      .get() !== undefined
  );
}

function toRecord(row: NomineeRow, escrow: VaultEscrowRow | null, hasKey: boolean): NomineeRecord {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    relation: row.relation,
    accessLevel: row.accessLevel as NomineeAccessLevel,
    status: row.status,
    nomineeUserId: row.nomineeUserId,
    hasPublicKey: hasKey,
    escrow: escrow ? toEscrowSummary(escrow) : null,
    invitedAt: row.invitedAt,
    acceptedAt: row.acceptedAt,
    createdAt: row.createdAt,
  };
}

function toEscrowSummary(escrow: VaultEscrowRow): EscrowSummary {
  return {
    id: escrow.id,
    state: escrow.state,
    releaseReason: escrow.releaseReason,
    publicKeyFingerprint: escrow.publicKeyFingerprint,
    createdAt: escrow.createdAt,
    releasedAt: escrow.releasedAt,
  };
}
