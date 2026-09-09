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
 *   - **Warnings are delivered, and also recorded.** Each stage change queues an email to
 *     the owner and writes an audit row, and the app raises a banner they see on their next
 *     visit. The email is the part that matters: this feature's whole premise is somebody
 *     who is not opening the app, so a warning that only exists inside the app is a warning
 *     nobody reads. On an instance with no SMTP configured the message is recorded as
 *     `suppressed` in the outbox and the banner is all there is — which the admin screen
 *     says out loud rather than leaving the operator to assume otherwise.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import {
  uuidv7,
  type CheckInPrompt,
  type ConfigureDeadManBody,
  type DeadManStage,
  type DeadManStatus,
} from '@networth/shared';
import type { AppContext } from '../context.js';
import {
  deadManCheckins,
  deadManSwitch,
  users,
  type DeadManCheckinRow,
  type DeadManSwitchRow,
} from '../db/schema.js';
import { deadManFiredEmail, deadManGraceEmail, deadManWarningEmail } from '../lib/mailTemplates.js';
import { badRequest } from '../lib/errors.js';
import { isoIn, isoNow } from '../lib/time.js';
import { recordAudit } from './audit.service.js';
import { queueEmail } from './mail.service.js';
import { releaseEscrow, sealedEscrows } from './nominee.service.js';

const DAY_MS = 86_400_000;

/**
 * How long an emailed check-in link stays good.
 *
 * Thirty days, which is longer than the gap between any warning and the stage after it for
 * the shortest window the schema permits, and short enough that a link left in an inbox
 * goes stale rather than accumulating. Every warning carries a freshly issued one, so a
 * person who ignores three emails and acts on the fourth is still fine.
 */
const CHECKIN_TOKEN_TTL_SECONDS = 30 * 86_400;

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
/* Checking in from an email                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Mint a link that says "I am still here" without signing anybody in.
 *
 * This exists because the feature's own premise undermines it. The switch measures people
 * who have stopped opening the app; telling those people to open the app is asking for the
 * behaviour whose absence is the whole signal. So the warning carries the answer with it.
 *
 * What the token can do is exactly one thing: reset this user's clock. It reads nothing,
 * grants no session, and is useless for anything else — which is what makes it reasonable
 * to put in an email at all.
 */
export function issueCheckInToken(ctx: AppContext, userId: string, stage: DeadManStage): string {
  const now = ctx.now();
  const token = randomBytes(32).toString('base64url');

  ctx.db
    .insert(deadManCheckins)
    .values({
      id: uuidv7(now.getTime()),
      userId,
      tokenHash: hashCheckInToken(token, ctx.config.SECRET_ENCRYPTION_KEY),
      stage,
      expiresAt: isoIn(CHECKIN_TOKEN_TTL_SECONDS, now),
      usedAt: null,
      createdAt: isoNow(now),
    })
    .run();

  return token;
}

/**
 * What the check-in page shows before anybody presses anything.
 *
 * Read-only, and that is not a detail — it is the reason this endpoint is separate from the
 * one below. See {@link consumeCheckInToken}.
 */
export function describeCheckInToken(ctx: AppContext, token: string): CheckInPrompt {
  const found = liveCheckIn(ctx, token);
  if (!found) {
    return { valid: false, name: null, stage: null, daysUntilRelease: null, alreadyFired: false };
  }

  const status = deadManStatus(ctx, found.row.userId);
  return {
    valid: true,
    name: found.name,
    stage: status.stage,
    daysUntilRelease: status.daysUntilRelease,
    alreadyFired: status.firedAt !== null,
  };
}

/**
 * Spend the token and reset the clock.
 *
 * **This is deliberately not what following the link does.** Mail providers and corporate
 * security appliances fetch every URL in a message before a human sees it — Gmail does it,
 * Outlook's Safe Links does it, and so does every antivirus gateway in between. If arriving
 * at the link were enough, a scanner would check the owner in on the morning of each
 * warning, the switch would never advance, and the escrows would never release. The feature
 * would fail in the one direction it must not: silently, and only for somebody who has died.
 *
 * So the link opens a page and a person presses a button, which is this. A prefetcher
 * issues the GET and stops there. It is the same reasoning that makes fetching an escrowed
 * key a POST, and it is worth more here, because nobody is left to notice the mistake.
 */
export function consumeCheckInToken(
  ctx: AppContext,
  token: string,
  ip: string | null,
): DeadManStatus {
  const found = liveCheckIn(ctx, token);
  if (!found) {
    throw badRequest(
      'That check-in link is no longer valid. Links expire after 30 days and work once — ' +
        'sign in instead, which resets the clock just the same.',
    );
  }

  ctx.db
    .update(deadManCheckins)
    .set({ usedAt: isoNow(ctx.now()) })
    .where(eq(deadManCheckins.id, found.row.id))
    .run();

  // Recorded as its own action. "They answered the email" and "they signed in" are both
  // evidence of a living owner, but only one of them says the warning did its job.
  recordAudit(ctx, {
    actorUserId: found.row.userId,
    action: 'deadman.checkin_emailed',
    entityType: 'dead_man_switch',
    entityId: found.row.userId,
    ip,
    meta: { stage: found.row.stage },
  });

  return checkIn(ctx, found.row.userId, ip);
}

/** The row and the owner's name, if this token is real, unused, unexpired and usable. */
function liveCheckIn(
  ctx: AppContext,
  token: string,
): { row: DeadManCheckinRow; name: string } | null {
  const row = ctx.db
    .select()
    .from(deadManCheckins)
    .where(eq(deadManCheckins.tokenHash, hashCheckInToken(token, ctx.config.SECRET_ENCRYPTION_KEY)))
    .get();

  if (!row) return null;
  if (row.usedAt !== null) return null;
  if (Date.parse(row.expiresAt) <= ctx.now().getTime()) return null;

  const user = ctx.db
    .select({ name: users.name, status: users.status })
    .from(users)
    .where(eq(users.id, row.userId))
    .get();

  // A suspended account's switch is not something to keep alive from an inbox.
  if (!user || user.status !== 'active') return null;

  return { row, name: user.name };
}

/**
 * An HMAC rather than a bare hash, for the reason refresh and reset tokens use one:
 * somebody holding a copy of `networth.db` should not be able to test candidate tokens
 * offline without also holding the environment secret.
 */
function hashCheckInToken(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('base64url');
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
        notify(ctx, row.userId, 'grace', (owner, checkInToken) =>
          deadManGraceEmail(
            { baseUrl: ctx.config.appBaseUrl },
            {
              name: owner.name,
              graceDays: row.graceDays,
              sealedEscrowCount: sealedEscrows(ctx, row.userId).length,
              checkInToken,
            },
          ),
        );
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
      const daysSilent = Math.floor(silentMs / DAY_MS);
      recordAudit(ctx, {
        actorUserId: null,
        action: 'deadman.warned',
        entityType: 'dead_man_switch',
        entityId: row.userId,
        meta: { stage: target, daysSilent },
      });
      // Only on the way up. Stepping back down to `idle` because the owner signed in needs
      // no email — they are, by the evidence, reading their screen rather than their inbox.
      notify(ctx, row.userId, target, (owner, checkInToken) =>
        deadManWarningEmail(
          { baseUrl: ctx.config.appBaseUrl },
          {
            name: owner.name,
            percent: Math.round((due?.at ?? 0) * 100),
            daysSilent,
            daysUntilGrace: Math.max(0, Math.ceil((windowMs - silentMs) / DAY_MS)),
            sealedEscrowCount: sealedEscrows(ctx, row.userId).length,
            checkInToken,
          },
        ),
      );
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

  // The heirs were told by `releaseEscrow`, one message each. This one is the owner's, and
  // it is sent even though the premise of the feature is that they are not reading it: the
  // premise is a guess, and the cost of being wrong about it in this direction is that
  // somebody who was merely on a long trip finds out what happened while they were away.
  // No check-in link on this one. The escrows are open; a button promising to stop it would
  // be a lie, and the honest next step is to sign in and see what was released.
  notify(ctx, row.userId, null, (owner) =>
    deadManFiredEmail(
      { baseUrl: ctx.config.appBaseUrl },
      { name: owner.name, released: escrows.length, inactivityDays: row.inactivityDays },
    ),
  );
}

/**
 * Queue a message to the switch's owner.
 *
 * Wrapped because this runs inside the sweep, which runs on a timer with nobody watching.
 * A stage change that has already been written must not be undone — or worse, retried on
 * the next tick and written twice — because composing an email threw.
 */
function notify(
  ctx: AppContext,
  userId: string,
  /** The stage to mint a check-in link for, or null for a message that carries none. */
  checkInStage: DeadManStage | null,
  compose: (
    owner: { name: string; email: string },
    checkInToken: string,
  ) => Parameters<typeof queueEmail>[2],
): void {
  try {
    const owner = ctx.db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    if (!owner) return;
    // Minted per message, so the link in the most recent warning is always live even if the
    // person let the previous three go by — and not minted at all for a message that has no
    // link to put it in, which would otherwise leave a live token nobody was ever sent.
    const token = checkInStage === null ? '' : issueCheckInToken(ctx, userId, checkInStage);
    queueEmail(ctx, owner.email, compose(owner, token), { userId, immediate: false });
  } catch {
    // See the doc comment. The stage change stands.
  }
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
