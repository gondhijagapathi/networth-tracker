/**
 * Households and partner merge.
 *
 * The tables this file writes to have existed since P2, because `resolveScope` — the one
 * function every scoped read consults — has been reading `access_grants` since then too. What
 * this file adds is the only thing that was missing: a consent flow that turns "we agreed to
 * merge our view" into rows in that table, and takes them out again the moment either side
 * changes their mind.
 *
 * A grant is directional and re-derived, never hand-edited. Every mutation here — joining,
 * changing a share mode, leaving — ends by calling {@link syncHouseholdGrants}, which reads
 * every member of the household and recomputes, from scratch, exactly which directed grants
 * should exist. That is more database work than patching one row would be, and it is the
 * difference between "this grant matches what everyone currently consents to" being an
 * invariant enforced by the code and being a hope maintained by whichever handler last ran.
 * A household has a handful of members; the cost is nothing.
 */

import { and, eq, isNull } from 'drizzle-orm';
import {
  uuidv7,
  type CreateHouseholdBody,
  type HouseholdMemberRecord,
  type HouseholdMemberRole,
  type HouseholdRecord,
  type InvitePartnerBody,
  type ShareMode,
  type UpdateShareModeBody,
} from '@networth/shared';
import type { AppContext } from '../context.js';
import {
  accessGrants,
  households,
  householdMembers,
  users,
  type HouseholdMemberRow,
  type HouseholdRow,
} from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { householdInviteEmail } from '../lib/mailTemplates.js';
import { isoNow } from '../lib/time.js';
import { recordAudit } from './audit.service.js';
import { queueEmail } from './mail.service.js';

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export function listHouseholds(ctx: AppContext, userId: string): HouseholdRecord[] {
  const rows = ctx.db
    .select({ household: households })
    .from(householdMembers)
    .innerJoin(households, eq(households.id, householdMembers.householdId))
    .where(eq(householdMembers.userId, userId))
    .all();

  return rows.map(({ household }) => toRecord(ctx, household));
}

export function getHousehold(
  ctx: AppContext,
  userId: string,
  householdId: string,
): HouseholdRecord {
  const household = requireHousehold(ctx, householdId);
  assertMember(ctx, householdId, userId);
  return toRecord(ctx, household);
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Start a household. The creator is a joined member from the first moment — there is nobody
 * else yet to accept anything from them — but they share nothing until they turn it on
 * themselves, same as anyone they later invite.
 */
export function createHousehold(
  ctx: AppContext,
  userId: string,
  body: CreateHouseholdBody,
  ip: string | null,
): HouseholdRecord {
  const now = isoNow(ctx.now());
  const household: HouseholdRow = {
    id: uuidv7(ctx.now().getTime()),
    name: body.name,
    createdByUserId: userId,
    createdAt: now,
    updatedAt: now,
  };

  ctx.db.transaction((tx) => {
    tx.insert(households).values(household).run();
    tx.insert(householdMembers)
      .values({
        id: uuidv7(ctx.now().getTime()),
        householdId: household.id,
        userId,
        role: 'owner',
        shareMode: 'none',
        consentedAt: null,
        acceptedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });

  recordAudit(ctx, {
    actorUserId: userId,
    action: 'household.created',
    entityType: 'household',
    entityId: household.id,
    ip,
  });

  return toRecord(ctx, household);
}

/**
 * Add a partner by email.
 *
 * The address must already belong to an account. This is a self-hosted, invite-only instance
 * — every partner worth merging with is already a user of it — so there is no second invite
 * system to build here, unlike a nominee who may not exist yet. The new row starts pending:
 * it grants nothing on its own, and it becomes a real membership only when that person
 * accepts it themselves.
 */
export function invitePartner(
  ctx: AppContext,
  userId: string,
  householdId: string,
  body: InvitePartnerBody,
  ip: string | null,
): HouseholdMemberRecord {
  const household = requireHousehold(ctx, householdId);
  assertMember(ctx, householdId, userId);

  const invitee = ctx.db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.email, body.email))
    .get();
  if (!invitee) throw badRequest('No account exists for that email address');
  if (invitee.id === userId) throw badRequest('You are already in this household');

  const existing = memberRow(ctx, householdId, invitee.id);
  if (existing) throw conflict('That person is already part of this household');

  const now = isoNow(ctx.now());
  const row: HouseholdMemberRow = {
    id: uuidv7(ctx.now().getTime()),
    householdId,
    userId: invitee.id,
    role: 'partner',
    shareMode: 'none',
    consentedAt: null,
    acceptedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  ctx.db.insert(householdMembers).values(row).run();

  recordAudit(ctx, {
    actorUserId: userId,
    action: 'household.invited',
    entityType: 'household',
    entityId: householdId,
    ip,
    meta: { granteeUserId: invitee.id },
  });

  // A pending membership shows up on the Household screen, but nothing takes anybody there
  // — an invitation that waits for the invitee to happen to look is not an invitation.
  const inviter = ctx.db.select({ name: users.name }).from(users).where(eq(users.id, userId)).get();
  queueEmail(
    ctx,
    invitee.email,
    householdInviteEmail(
      { baseUrl: ctx.config.appBaseUrl },
      {
        inviterName: inviter?.name ?? 'Someone',
        householdName: household.name,
        recipientName: invitee.name,
      },
    ),
    { userId: invitee.id },
  );

  return toMemberRecord(ctx, row);
}

/** The invited side accepts membership. Grants nothing by itself — see the module doc. */
export function acceptHousehold(
  ctx: AppContext,
  userId: string,
  householdId: string,
  ip: string | null,
): HouseholdMemberRecord {
  const member = memberRow(ctx, householdId, userId);
  if (!member) throw notFound('No such invitation');
  if (member.acceptedAt !== null) return toMemberRecord(ctx, member);

  const now = isoNow(ctx.now());
  ctx.db
    .update(householdMembers)
    .set({ acceptedAt: now, updatedAt: now })
    .where(eq(householdMembers.id, member.id))
    .run();

  syncHouseholdGrants(ctx, householdId);

  recordAudit(ctx, {
    actorUserId: userId,
    action: 'household.joined',
    entityType: 'household',
    entityId: householdId,
    ip,
  });

  return toMemberRecord(ctx, { ...member, acceptedAt: now });
}

/**
 * The Settings toggle: how much of *my* data the rest of this household sees.
 *
 * Setting anything other than `none` records `consentedAt` now; setting `none` clears it. A
 * member who has not yet accepted the household can still set this — it takes effect the
 * moment they do accept, rather than making acceptance a two-step dance.
 */
export function updateShareMode(
  ctx: AppContext,
  userId: string,
  householdId: string,
  body: UpdateShareModeBody,
  ip: string | null,
): HouseholdMemberRecord {
  const member = memberRow(ctx, householdId, userId);
  if (!member) throw notFound('No such household');

  const now = isoNow(ctx.now());
  const patch = {
    shareMode: body.shareMode,
    consentedAt: body.shareMode === 'none' ? null : now,
    updatedAt: now,
  };
  ctx.db.update(householdMembers).set(patch).where(eq(householdMembers.id, member.id)).run();

  syncHouseholdGrants(ctx, householdId);

  recordAudit(ctx, {
    actorUserId: userId,
    action: 'household.share_updated',
    entityType: 'household',
    entityId: householdId,
    ip,
    meta: { shareMode: body.shareMode },
  });

  return toMemberRecord(ctx, { ...member, ...patch });
}

/**
 * Leave, or — for an owner acting on somebody else — remove.
 *
 * The membership row is deleted outright rather than marked revoked: it carries no history
 * worth keeping once it is gone, and the audit row this writes is the record that somebody
 * was once part of this household. Every grant `syncHouseholdGrants` would have derived for
 * this member, in either direction, is revoked in the same transaction — that is what makes
 * this instant rather than eventually consistent with the next sync.
 */
export function leaveHousehold(
  ctx: AppContext,
  userId: string,
  householdId: string,
  targetUserId: string,
  ip: string | null,
): void {
  const actor = memberRow(ctx, householdId, userId);
  if (!actor) throw notFound('No such household');
  if (targetUserId !== userId && actor.role !== 'owner') {
    throw forbidden('Only the household owner can remove another member');
  }

  const target = memberRow(ctx, householdId, targetUserId);
  if (!target) throw notFound('No such member');

  const now = isoNow(ctx.now());
  ctx.db.transaction((tx) => {
    tx.delete(householdMembers).where(eq(householdMembers.id, target.id)).run();

    tx.update(accessGrants)
      .set({ revokedAt: now })
      .where(
        and(
          eq(accessGrants.source, 'household'),
          eq(accessGrants.sourceId, householdId),
          isNull(accessGrants.revokedAt),
        ),
      )
      .run();
  });

  // The rows just revoked wholesale may have included grants between two members who are
  // both still here (say, a third partner leaving a household of three) — put those back.
  syncHouseholdGrants(ctx, householdId);

  recordAudit(ctx, {
    actorUserId: userId,
    action: 'household.left',
    entityType: 'household',
    entityId: householdId,
    ip,
    meta: { targetUserId },
  });
}

/* -------------------------------------------------------------------------- */
/* Grants                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Recompute every directed grant a household's current membership implies.
 *
 * For each ordered pair of members `(from, to)` with `from !== to`: a grant from `from` to
 * `to` should exist, at `from.shareMode`, exactly when `from` has both joined and consented to
 * share, `from.shareMode` is not `none`, and `to` has joined too — sharing with somebody who
 * has not accepted membership would hand out access before they agreed to anything, including
 * before *they* have decided whether to share back.
 */
function syncHouseholdGrants(ctx: AppContext, householdId: string): void {
  const members = ctx.db
    .select()
    .from(householdMembers)
    .where(eq(householdMembers.householdId, householdId))
    .all();

  const now = isoNow(ctx.now());

  for (const from of members) {
    for (const to of members) {
      if (from.userId === to.userId) continue;

      const shouldGrant =
        from.acceptedAt !== null &&
        from.consentedAt !== null &&
        from.shareMode !== 'none' &&
        to.acceptedAt !== null;

      const existing = ctx.db
        .select()
        .from(accessGrants)
        .where(
          and(
            eq(accessGrants.ownerUserId, from.userId),
            eq(accessGrants.granteeUserId, to.userId),
            eq(accessGrants.source, 'household'),
            eq(accessGrants.sourceId, householdId),
            isNull(accessGrants.revokedAt),
          ),
        )
        .get();

      if (shouldGrant) {
        const scope = from.shareMode as Exclude<ShareMode, 'none'>;
        if (!existing) {
          ctx.db
            .insert(accessGrants)
            .values({
              id: uuidv7(ctx.now().getTime()),
              ownerUserId: from.userId,
              granteeUserId: to.userId,
              scope,
              source: 'household',
              sourceId: householdId,
              grantedAt: now,
            })
            .run();
        } else if (existing.scope !== scope) {
          // A narrowed or widened share mode has to bite immediately, same as a nominee's
          // access level does — not at the grantee's next sign-in.
          ctx.db.update(accessGrants).set({ scope }).where(eq(accessGrants.id, existing.id)).run();
        }
      } else if (existing) {
        ctx.db
          .update(accessGrants)
          .set({ revokedAt: now })
          .where(eq(accessGrants.id, existing.id))
          .run();
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function requireHousehold(ctx: AppContext, householdId: string): HouseholdRow {
  const row = ctx.db.select().from(households).where(eq(households.id, householdId)).get();
  if (!row) throw notFound('No such household');
  return row;
}

function assertMember(ctx: AppContext, householdId: string, userId: string): void {
  if (!memberRow(ctx, householdId, userId)) throw notFound('No such household');
}

function memberRow(
  ctx: AppContext,
  householdId: string,
  userId: string,
): HouseholdMemberRow | undefined {
  return ctx.db
    .select()
    .from(householdMembers)
    .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.userId, userId)))
    .get();
}

function toRecord(ctx: AppContext, household: HouseholdRow): HouseholdRecord {
  const members = ctx.db
    .select()
    .from(householdMembers)
    .where(eq(householdMembers.householdId, household.id))
    .all();

  return {
    id: household.id,
    name: household.name,
    createdByUserId: household.createdByUserId,
    createdAt: household.createdAt,
    members: members.map((member) => toMemberRecord(ctx, member)),
  };
}

function toMemberRecord(ctx: AppContext, member: HouseholdMemberRow): HouseholdMemberRecord {
  const user = ctx.db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, member.userId))
    .get();

  return {
    id: member.id,
    householdId: member.householdId,
    userId: member.userId,
    name: user?.name ?? 'Unknown',
    email: user?.email ?? '',
    role: member.role as HouseholdMemberRole,
    shareMode: member.shareMode as ShareMode,
    consentedAt: member.consentedAt,
    acceptedAt: member.acceptedAt,
    createdAt: member.createdAt,
  };
}
