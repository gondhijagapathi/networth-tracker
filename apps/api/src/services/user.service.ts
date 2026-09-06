/**
 * Admin user management.
 *
 * Deliberately small: an admin can invite, suspend, reactivate, change a role and cut
 * sessions. There is no "set another user's password" and no way to read anyone's data —
 * administering the instance and owning a household's finances are different jobs, and an
 * admin account that could quietly take over a member's assets would make the nominee and
 * escrow guarantees meaningless.
 */

import { and, asc, eq } from 'drizzle-orm';
import type { PublicUser, UpdateUserBody } from '@networth/shared';
import type { AppContext } from '../context.js';
import { users } from '../db/schema.js';
import { conflict, notFound } from '../lib/errors.js';
import { isoNow } from '../lib/time.js';
import { recordAudit } from './audit.service.js';
import { toPublicUser } from './auth.service.js';
import { revokeAllSessions } from './session.service.js';

export function listUsers(ctx: AppContext): PublicUser[] {
  return ctx.db.select().from(users).orderBy(asc(users.createdAt)).all().map(toPublicUser);
}

export function getUser(ctx: AppContext, userId: string): PublicUser {
  const user = ctx.db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw notFound('No such user');
  return toPublicUser(user);
}

export function updateUser(
  ctx: AppContext,
  actorUserId: string,
  userId: string,
  body: UpdateUserBody,
  ip: string | null,
): PublicUser {
  const user = ctx.db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw notFound('No such user');

  const nextStatus = body.status ?? user.status;
  const nextRole = body.role ?? user.role;

  // Locking yourself out of your own instance is unrecoverable without editing the
  // database by hand, so the two ways to do it are refused outright.
  if (userId === actorUserId && nextStatus === 'suspended') {
    throw conflict('You cannot suspend your own account');
  }
  if (userId === actorUserId && user.role === 'admin' && nextRole !== 'admin') {
    throw conflict('You cannot remove your own admin role');
  }
  if (user.role === 'admin' && (nextRole !== 'admin' || nextStatus !== 'active')) {
    if (countActiveAdmins(ctx) <= 1) {
      throw conflict('This is the only active admin. Promote someone else first.');
    }
  }

  const now = isoNow(ctx.now());
  ctx.db
    .update(users)
    .set({ status: nextStatus, role: nextRole, updatedAt: now })
    .where(eq(users.id, userId))
    .run();

  if (body.status !== undefined && body.status !== user.status) {
    // A suspended user must stop working now, not when their access token expires.
    if (body.status === 'suspended') revokeAllSessions(ctx, userId);
    recordAudit(ctx, {
      actorUserId,
      action: body.status === 'suspended' ? 'user.suspended' : 'user.reactivated',
      entityType: 'user',
      entityId: userId,
      ip,
    });
  }

  if (body.role !== undefined && body.role !== user.role) {
    recordAudit(ctx, {
      actorUserId,
      action: 'user.role_changed',
      entityType: 'user',
      entityId: userId,
      ip,
      meta: { from: user.role, to: body.role },
    });
  }

  return getUser(ctx, userId);
}

/** Sign a user out everywhere. The admin's blunt instrument for a lost or stolen device. */
export function revokeUserSessions(
  ctx: AppContext,
  actorUserId: string,
  userId: string,
  ip: string | null,
): number {
  const user = ctx.db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
  if (!user) throw notFound('No such user');

  const revoked = revokeAllSessions(ctx, userId);

  recordAudit(ctx, {
    actorUserId,
    action: 'session.revoked',
    entityType: 'user',
    entityId: userId,
    ip,
    meta: { sessions: revoked, scope: 'all' },
  });

  return revoked;
}

function countActiveAdmins(ctx: AppContext): number {
  return ctx.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.status, 'active')))
    .all().length;
}
