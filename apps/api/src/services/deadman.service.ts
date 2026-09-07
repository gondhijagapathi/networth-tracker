/**
 * The dead-man switch.
 *
 * The premise of this application is that heirs lose money they already own because nobody
 * told them it existed. The vault fixes the "nobody told them" half; this fixes the case
 * where the owner is no longer able to.
 *
 * It measures one thing — silence — and it is deliberately slow and loud about it. The
 * default is ninety days without a sign-in, three escalating warnings, and then a week of
 * grace that a single ordinary login cancels. The floor on the inactivity window is thirty
 * days, not seven, because what fires at the end of it is handing somebody the keys to a
 * household's entire financial life. A fortnight's holiday must not be able to do that.
 *
 * Two design notes worth stating:
 *
 *   - **Aliveness is authentication, not a button.** The clock reads the later of
 *     `users.last_active_at` and an explicit check-in, so somebody who uses the app normally
 *     never has to think about this feature at all.
 *   - **Warnings are recorded, not delivered.** This app has no mail transport yet — email
 *     and push are in the backlog — so a stage change writes an audit row and raises a
 *     banner the owner sees on their next visit. That is honest but weaker than the design
 *     intends, and `docs/TASKS.md` says so rather than letting a checked box imply an email
 *     that never went out.
 */

import { and, eq, ne } from 'drizzle-orm';
import type { ConfigureDeadManBody, DeadManStage, DeadManStatus } from '@networth/shared';
import type { AppContext } from '../context.js';
import { deadManSwitch, users, type DeadManSwitchRow } from '../db/schema.js';
import { isoNow } from '../lib/time.js';
import { recordAudit } from './audit.service.js';
import { releaseEscrow, sealedEscrows } from './nominee.service.js';

const DAY_MS = 86_400_000;

/** The fractions of the window at which the owner is warned, latest first. */
const WARNING_STAGES: Array<{ at: number; stage: DeadManStage }> = [
  { at: 0.9, stage: 'warned_90' },
  { at: 0.75, stage: 'warned_75' },
  { at: 0.5, stage: 'warned_50' },
];

const STAGE_ORDER: DeadManStage[] = [
  'idle',
  'warned_50',
  'warned_75',
  'warned_90',
  'grace',
  'fired',
];

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export function deadManStatus(ctx: AppContext, userId: string): DeadManStatus {
  const row = switchRow(ctx, userId) ?? defaults(ctx, userId);
  const now = ctx.now().getTime();
  const silentMs = now - lastActiveAt(ctx, row);

  const untilGrace = row.inactivityDays * DAY_MS - silentMs;
  const untilRelease =
    row.graceStartedAt === null
      ? null
      : row.graceDays * DAY_MS - (now - Date.parse(row.graceStartedAt));

  return {
    enabled: row.enabled,
    inactivityDays: row.inactivityDays,
    graceDays: row.graceDays,
    lastCheckinAt: row.lastCheckinAt,
    stage: row.stage,
    graceStartedAt: row.graceStartedAt,
    firedAt: row.firedAt,
    daysUntilGrace: Math.max(0, Math.ceil(untilGrace / DAY_MS)),
    daysUntilRelease: untilRelease === null ? null : Math.max(0, Math.ceil(untilRelease / DAY_MS)),
    sealedEscrowCount: sealedEscrows(ctx, userId).length,
  };
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

export function configureDeadMan(
  ctx: AppContext,
  userId: string,
  body: ConfigureDeadManBody,
  ip: string | null,
): DeadManStatus {
  const now = isoNow(ctx.now());
  const existing = switchRow(ctx, userId);

  const next: DeadManSwitchRow = {
    userId,
    enabled: body.enabled,
    inactivityDays: body.inactivityDays,
    graceDays: body.graceDays,
    // Turning the switch on restarts the clock. Counting silence that predates the decision
    // to be watched would let somebody enable this and trip it in the same afternoon.
    lastCheckinAt: existing && existing.enabled === body.enabled ? existing.lastCheckinAt : now,
    stage: body.enabled ? (existing?.enabled === true ? existing.stage : 'idle') : 'idle',
    graceStartedAt: body.enabled && existing?.enabled === true ? existing.graceStartedAt : null,
    firedAt: existing?.firedAt ?? null,
    updatedAt: now,
  };

  if (existing) {
    ctx.db.update(deadManSwitch).set(next).where(eq(deadManSwitch.userId, userId)).run();
  } else {
    ctx.db.insert(deadManSwitch).values(next).run();
  }

  recordAudit(ctx, {
    actorUserId: userId,
    action: 'deadman.configured',
    entityType: 'dead_man_switch',
    entityId: userId,
    ip,
    meta: { enabled: body.enabled, inactivityDays: body.inactivityDays, graceDays: body.graceDays },
  });

  return deadManStatus(ctx, userId);
}

/**
 * "I am still here."
 *
 * Resets the clock and unwinds any warning or grace stage. `firedAt` is deliberately left
 * in place: if this switch has already released escrows, that happened, and the owner needs
 * to see it rather than have a check-in quietly tidy it away. Released escrows are not
 * re-sealed — the heir may already hold the key, and pretending otherwise would be a lie
 * told by a green tick.
 */
export function checkIn(
  ctx: AppContext,
  userId: string,
  ip: string | null,
  reason: 'checkin' | 'cancel' = 'checkin',
): DeadManStatus {
  const now = isoNow(ctx.now());
  const existing = switchRow(ctx, userId);

  if (!existing) {
    ctx.db
      .insert(deadManSwitch)
      .values({ ...defaults(ctx, userId), lastCheckinAt: now, updatedAt: now })
      .run();
  } else {
    ctx.db
      .update(deadManSwitch)
      .set({ lastCheckinAt: now, stage: 'idle', graceStartedAt: null, updatedAt: now })
      .where(eq(deadManSwitch.userId, userId))
      .run();
  }

  recordAudit(ctx, {
    actorUserId: userId,
    action: reason === 'cancel' ? 'deadman.cancelled' : 'deadman.checkin',
    entityType: 'dead_man_switch',
    entityId: userId,
    ip,
    meta: { previousStage: existing?.stage ?? 'idle' },
  });

  return deadManStatus(ctx, userId);
}

/* -------------------------------------------------------------------------- */
/* The sweep                                                                  */
/* -------------------------------------------------------------------------- */

export interface SweepResult {
  warned: string[];
  graced: string[];
  fired: string[];
}

/**
 * Advance every enabled switch to the stage its silence has earned.
 *
 * Idempotent, and safe to run as often as you like: each user's stage is derived from
 * elapsed time rather than from how many times this has run, and a stage is only ever
 * written when it changes. The scheduler in `index.ts` calls it daily; the tests call it
 * after moving the clock, which is the same thing without the waiting.
 */
export function evaluateDeadManSwitches(ctx: AppContext): SweepResult {
  const result: SweepResult = { warned: [], graced: [], fired: [] };
  const now = ctx.now().getTime();

  const rows = ctx.db
    .select()
    .from(deadManSwitch)
    .where(and(eq(deadManSwitch.enabled, true), ne(deadManSwitch.stage, 'fired')))
    .all();

  for (const row of rows) {
    const silentMs = now - lastActiveAt(ctx, row);
    const windowMs = row.inactivityDays * DAY_MS;

    if (silentMs >= windowMs) {
      if (row.stage !== 'grace') {
        setStage(ctx, row, 'grace', { graceStartedAt: isoNow(ctx.now()) });
        recordAudit(ctx, {
          actorUserId: null,
          action: 'deadman.grace_started',
          entityType: 'dead_man_switch',
          entityId: row.userId,
          meta: { graceDays: row.graceDays },
        });
        result.graced.push(row.userId);
        continue;
      }

      const graceStartedAt = Date.parse(row.graceStartedAt ?? isoNow(ctx.now()));
      if (now - graceStartedAt >= row.graceDays * DAY_MS) {
        fire(ctx, row);
        result.fired.push(row.userId);
      }
      continue;
    }

    // Below the window, the stage is a pure function of how long the silence has run — in
    // both directions. That is what makes SECURITY-MODEL.md's promise true: an owner who
    // signs in during the grace period cancels it by signing in, without having to find a
    // button, because the next sweep sees a fresh `last_active_at` and steps back down.
    const due = WARNING_STAGES.find((warning) => silentMs >= windowMs * warning.at);
    const target: DeadManStage = due?.stage ?? 'idle';
    if (target === row.stage) continue;

    setStage(ctx, row, target, { graceStartedAt: null });

    if (isEscalation(row.stage, target)) {
      recordAudit(ctx, {
        actorUserId: null,
        action: 'deadman.warned',
        entityType: 'dead_man_switch',
        entityId: row.userId,
        meta: { stage: target, daysSilent: Math.floor(silentMs / DAY_MS) },
      });
      result.warned.push(row.userId);
    } else {
      recordAudit(ctx, {
        actorUserId: null,
        action: 'deadman.cancelled',
        entityType: 'dead_man_switch',
        entityId: row.userId,
        meta: { from: row.stage, to: target, reason: 'activity' },
      });
    }
  }

  return result;
}

/**
 * Release every sealed escrow this owner holds.
 *
 * The one moment in the application where data moves without a person asking for it, so it
 * is written down three times over: an audit row per escrow from `releaseEscrow`, one for
 * the firing itself, and `fired_at` on the switch so the owner sees it if they return.
 */
function fire(ctx: AppContext, row: DeadManSwitchRow): void {
  const escrows = sealedEscrows(ctx, row.userId);
  for (const escrow of escrows) {
    releaseEscrow(ctx, row.userId, escrow.nomineeId, 'deadman', null);
  }

  setStage(ctx, row, 'fired', { firedAt: isoNow(ctx.now()) });

  recordAudit(ctx, {
    actorUserId: null,
    action: 'deadman.fired',
    entityType: 'dead_man_switch',
    entityId: row.userId,
    meta: { released: escrows.length, inactivityDays: row.inactivityDays },
  });
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The later of an explicit check-in and ordinary authentication.
 *
 * Reading only the check-in would nag somebody who signs in every day; reading only
 * `last_active_at` would give no way for a person who rarely opens the app to say they are
 * fine. The maximum of the two is the honest answer to "is this person still around".
 */
function lastActiveAt(ctx: AppContext, row: DeadManSwitchRow): number {
  const user = ctx.db
    .select({ lastActiveAt: users.lastActiveAt })
    .from(users)
    .where(eq(users.id, row.userId))
    .get();

  return Math.max(
    Date.parse(row.lastCheckinAt),
    user?.lastActiveAt ? Date.parse(user.lastActiveAt) : 0,
  );
}

function isEscalation(from: DeadManStage, to: DeadManStage): boolean {
  return STAGE_ORDER.indexOf(to) > STAGE_ORDER.indexOf(from);
}

function setStage(
  ctx: AppContext,
  row: DeadManSwitchRow,
  stage: DeadManStage,
  extra: Partial<DeadManSwitchRow> = {},
): void {
  ctx.db
    .update(deadManSwitch)
    .set({ stage, updatedAt: isoNow(ctx.now()), ...extra })
    .where(eq(deadManSwitch.userId, row.userId))
    .run();
}

function switchRow(ctx: AppContext, userId: string): DeadManSwitchRow | undefined {
  return ctx.db.select().from(deadManSwitch).where(eq(deadManSwitch.userId, userId)).get();
}

/** What the status reads for somebody who has never configured the switch. */
function defaults(ctx: AppContext, userId: string): DeadManSwitchRow {
  const now = isoNow(ctx.now());
  return {
    userId,
    enabled: false,
    inactivityDays: 90,
    graceDays: 7,
    lastCheckinAt: now,
    stage: 'idle',
    graceStartedAt: null,
    firedAt: null,
    updatedAt: now,
  };
}
