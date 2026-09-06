/**
 * Database schema.
 *
 * Drizzle defines the tables here; the matching SQL lives in `apps/api/migrations/` and is
 * applied on boot. The two are kept in step by `db/__tests__/schema-drift.test.ts`, which
 * builds a database from the migrations and compares its real columns against this file.
 *
 * Conventions (see docs/DATA-MODEL.md):
 *   - Primary keys are UUIDv7 TEXT.
 *   - Instants are ISO-8601 UTC TEXT (`YYYY-MM-DDTHH:MM:SS.sssZ`); SQLite has no date type
 *     and a sortable string is the honest representation.
 *   - Booleans are INTEGER 0/1, exposed as `boolean` through Drizzle's mode.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const nowUtc = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/* -------------------------------------------------------------------------- */
/* users                                                                      */
/* -------------------------------------------------------------------------- */

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    /** Normalised to lowercase before it ever reaches this column. */
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    /** Argon2id PHC string — carries its own salt and parameters. */
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['admin', 'member', 'nominee'] })
      .notNull()
      .default('member'),
    status: text('status', { enum: ['active', 'suspended'] })
      .notNull()
      .default('active'),
    /**
     * TOTP shared secret, AES-256-GCM encrypted with a key derived from
     * `SECRET_ENCRYPTION_KEY`. A stolen database file does not yield working second
     * factors.
     */
    totpSecretEncrypted: text('totp_secret_encrypted'),
    /** Set only once enrolment has been confirmed with a live code. */
    totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
    /** Drives the dead-man switch in P5; written on every successful authentication. */
    lastActiveAt: text('last_active_at'),
    createdAt: text('created_at').notNull().default(nowUtc),
    updatedAt: text('updated_at').notNull().default(nowUtc),
  },
  (table) => [
    index('users_status_role_idx').on(table.status, table.role),
    // The application is not the only thing that will ever write this file — a restore or
    // a manual fix should not be able to invent a role SQLite will happily store.
    check('users_role_check', sql`${table.role} in ('admin', 'member', 'nominee')`),
    check('users_status_check', sql`${table.status} in ('active', 'suspended')`),
  ],
);

/* -------------------------------------------------------------------------- */
/* recovery codes                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Single-use TOTP recovery codes, stored as hashes. They are shown to the user exactly
 * once, at enrolment, and can never be read back — only matched against.
 */
export const recoveryCodes = sqliteTable(
  'recovery_codes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: text('used_at'),
    createdAt: text('created_at').notNull().default(nowUtc),
  },
  (table) => [index('recovery_codes_user_idx').on(table.userId)],
);

/* -------------------------------------------------------------------------- */
/* invites                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The only path to an account. There is no open signup and no code path that creates a
 * user without consuming one of these rows.
 */
export const invites = sqliteTable(
  'invites',
  {
    id: text('id').primaryKey(),
    /** SHA-256 of the code. The plaintext is shown to the admin once and never stored. */
    codeHash: text('code_hash').notNull().unique(),
    /** When set, only this address may redeem the invite. */
    email: text('email'),
    role: text('role', { enum: ['admin', 'member', 'nominee'] })
      .notNull()
      .default('member'),
    note: text('note'),
    /** Null for the bootstrap invite, which no user created. */
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    expiresAt: text('expires_at').notNull(),
    consumedAt: text('consumed_at'),
    consumedByUserId: text('consumed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: text('created_at').notNull().default(nowUtc),
  },
  (table) => [
    index('invites_email_idx').on(table.email),
    check('invites_role_check', sql`${table.role} in ('admin', 'member', 'nominee')`),
  ],
);

/* -------------------------------------------------------------------------- */
/* refresh tokens                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One row per issued refresh token. Tokens rotate on every use: the old row is revoked
 * and a new one issued within the same `familyId`.
 *
 * If a token that has already been rotated is presented again, it was either replayed by
 * an attacker or leaked from a stolen backup — either way the whole family is revoked,
 * which signs that device chain out everywhere.
 */
export const refreshTokens = sqliteTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Shared by every token descended from one login. Revoked as a unit on replay. */
    familyId: text('family_id').notNull(),
    /** HMAC-SHA-256 of the opaque token under `JWT_REFRESH_SECRET`. */
    tokenHash: text('token_hash').notNull().unique(),
    deviceLabel: text('device_label'),
    createdAt: text('created_at').notNull().default(nowUtc),
    lastUsedAt: text('last_used_at').notNull().default(nowUtc),
    expiresAt: text('expires_at').notNull(),
    revokedAt: text('revoked_at'),
    /** Set when this token was rotated, pointing at its successor. */
    replacedByTokenId: text('replaced_by_token_id'),
  },
  (table) => [
    index('refresh_tokens_user_idx').on(table.userId),
    index('refresh_tokens_family_idx').on(table.familyId),
  ],
);

/* -------------------------------------------------------------------------- */
/* settings                                                                   */
/* -------------------------------------------------------------------------- */

/** Per-user key/value preferences: theme, lakh-crore display, privacy blur, and so on. */
export const settings = sqliteTable(
  'settings',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    /** JSON-encoded so a preference can be a boolean, a string or an object. */
    value: text('value').notNull(),
    updatedAt: text('updated_at').notNull().default(nowUtc),
  },
  (table) => [primaryKey({ columns: [table.userId, table.key] })],
);

/* -------------------------------------------------------------------------- */
/* audit log                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Append-only record of security-relevant events. Rows are never updated or deleted; the
 * actor is nullable because failed logins have no authenticated actor.
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    ip: text('ip'),
    /** JSON blob of event-specific detail. Never contains credentials. */
    meta: text('meta'),
    at: text('at').notNull().default(nowUtc),
  },
  (table) => [
    index('audit_log_actor_idx').on(table.actorUserId, table.at),
    index('audit_log_action_idx').on(table.action, table.at),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
