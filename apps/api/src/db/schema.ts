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
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

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
    /** Drives the dead-man switch; written on every successful authentication. */
    lastActiveAt: text('last_active_at'),
    /**
     * Bumped every time this account's sessions are revoked wholesale — a password change,
     * a password reset, an admin locking the account.
     *
     * Refresh tokens are rows and can be marked revoked; the access token is a stateless
     * JWT that would otherwise keep working for its full fifteen minutes no matter what the
     * database says. Each access token carries the epoch it was minted under, and
     * `requireAuth` rejects any that no longer matches — which is what makes "changing your
     * password signs you out everywhere" true immediately rather than eventually.
     *
     * A counter rather than a timestamp on purpose. A timestamp has to be compared with a
     * tolerance, because `iat` has only whole-second resolution, and that tolerance is a
     * window in which a revoked token still works. An integer is exact.
     */
    sessionEpoch: integer('session_epoch').notNull().default(0),
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

/* -------------------------------------------------------------------------- */
/* households                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A household is two or more users who have each consented to a merged view. The tables
 * exist from P2 because `access_grants` — which every scoped read consults — points at
 * them; the invite and consent flow itself arrives in P6.
 */
export const households = sqliteTable('households', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdByUserId: text('created_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  createdAt: text('created_at').notNull().default(nowUtc),
  updatedAt: text('updated_at').notNull().default(nowUtc),
});

export const householdMembers = sqliteTable(
  'household_members',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'partner', 'member'] })
      .notNull()
      .default('member'),
    /** How much of this member's data the rest of the household sees. */
    shareMode: text('share_mode', { enum: ['full', 'summary', 'none'] })
      .notNull()
      .default('none'),
    /** Sharing needs both sides: the inviter's offer and the invitee's acceptance. */
    consentedAt: text('consented_at'),
    acceptedAt: text('accepted_at'),
    createdAt: text('created_at').notNull().default(nowUtc),
    updatedAt: text('updated_at').notNull().default(nowUtc),
  },
  (table) => [
    uniqueIndex('household_members_unique').on(table.householdId, table.userId),
    index('household_members_user_idx').on(table.userId),
    check('household_members_role_check', sql`${table.role} in ('owner', 'partner', 'member')`),
    check(
      'household_members_share_mode_check',
      sql`${table.shareMode} in ('full', 'summary', 'none')`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* nominees                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * An heir. `nomineeUserId` stays null until they accept an invite and register, so a
 * nomination can be recorded for someone who does not yet have an account — which is the
 * normal case when the record is created.
 */
export const nominees = sqliteTable(
  'nominees',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    nomineeUserId: text('nominee_user_id').references(() => users.id, { onDelete: 'set null' }),
    email: text('email'),
    name: text('name').notNull(),
    relation: text('relation'),
    /** Intended share, in basis points. Nothing enforces that an owner's shares total 100%. */
    sharePercentBps: integer('share_percent_bps').notNull().default(0),
    accessLevel: text('access_level', { enum: ['summary', 'full', 'vault'] })
      .notNull()
      .default('summary'),
    status: text('status', { enum: ['invited', 'accepted', 'revoked'] })
      .notNull()
      .default('invited'),
    invitedAt: text('invited_at'),
    acceptedAt: text('accepted_at'),
    createdAt: text('created_at').notNull().default(nowUtc),
    updatedAt: text('updated_at').notNull().default(nowUtc),
  },
  (table) => [
    index('nominees_owner_idx').on(table.ownerUserId, table.status),
    index('nominees_user_idx').on(table.nomineeUserId),
    check('nominees_access_level_check', sql`${table.accessLevel} in ('summary', 'full', 'vault')`),
    check('nominees_status_check', sql`${table.status} in ('invited', 'accepted', 'revoked')`),
  ],
);

/* -------------------------------------------------------------------------- */
/* access grants                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The one table every scoped read consults.
 *
 * Household membership and nominee acceptance both *write* rows here rather than being
 * queried directly at read time, so the permission check stays a single indexed lookup and
 * there is exactly one place to audit for "who can see my data".
 *
 * A grant is read-only in every case. There is no scope that confers writes, and nothing
 * in the codebase resolves one into a write path.
 */
export const accessGrants = sqliteTable(
  'access_grants',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    granteeUserId: text('grantee_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['summary', 'full', 'vault'] })
      .notNull()
      .default('summary'),
    /** Which mechanism created this grant, so revoking that mechanism can find its rows. */
    source: text('source', { enum: ['household', 'nominee', 'manual'] })
      .notNull()
      .default('manual'),
    sourceId: text('source_id'),
    grantedAt: text('granted_at').notNull().default(nowUtc),
    expiresAt: text('expires_at'),
    revokedAt: text('revoked_at'),
  },
  (table) => [
    index('access_grants_grantee_idx').on(table.granteeUserId, table.scope),
    index('access_grants_owner_idx').on(table.ownerUserId),
    check('access_grants_scope_check', sql`${table.scope} in ('summary', 'full', 'vault')`),
    check('access_grants_source_check', sql`${table.source} in ('household', 'nominee', 'manual')`),
  ],
);

/* -------------------------------------------------------------------------- */
/* assets                                                                     */
/* -------------------------------------------------------------------------- */

const ASSET_TYPE_LIST = sql`('bank_account', 'deposit', 'holding', 'insurance_policy', 'property', 'retirement_account', 'precious_metal', 'other_asset', 'liability')`;

/**
 * The base row behind every tracked thing, liabilities included.
 *
 * Each `type` has exactly one detail row in the matching table, keyed on this id. The base
 * table carries what every asset has in common — and, crucially, `nomineeRegistered`, the
 * single boolean the whole nomination-hygiene feature is built on.
 */
export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type', {
      enum: [
        'bank_account',
        'deposit',
        'holding',
        'insurance_policy',
        'property',
        'retirement_account',
        'precious_metal',
        'other_asset',
        'liability',
      ],
    }).notNull(),
    name: text('name').notNull(),
    institution: text('institution'),
    /** Defaults false: an unrecorded nomination is the dangerous case, and the honest one. */
    nomineeRegistered: integer('nominee_registered', { mode: 'boolean' }).notNull().default(false),
    /** This owner's share, in basis points. 10000 is sole ownership. */
    ownershipBps: integer('ownership_bps').notNull().default(10_000),
    jointWith: text('joint_with'),
    status: text('status', { enum: ['active', 'closed', 'archived'] })
      .notNull()
      .default('active'),
    openedOn: text('opened_on'),
    closedOn: text('closed_on'),
    /** JSON array of strings. Small enough that a join table would cost more than it saves. */
    tags: text('tags').notNull().default('[]'),
    notes: text('notes'),
    createdAt: text('created_at').notNull().default(nowUtc),
    updatedAt: text('updated_at').notNull().default(nowUtc),
  },
  (table) => [
    // The asset list and every scoped read start here.
    index('assets_owner_idx').on(table.ownerUserId, table.status, table.type),
    // The nomination dashboard: "what is at risk", per owner.
    index('assets_nomination_idx').on(table.ownerUserId, table.nomineeRegistered),
    check('assets_type_check', sql`${table.type} in ${ASSET_TYPE_LIST}`),
    check('assets_status_check', sql`${table.status} in ('active', 'closed', 'archived')`),
    check('assets_ownership_check', sql`${table.ownershipBps} between 0 and 10000`),
  ],
);

/* -------------------------------------------------------------------------- */
/* asset detail tables                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Detail rows share their asset's primary key and cascade with it, so an asset can never
 * be half-deleted and a detail row can never be orphaned.
 */
const assetIdKey = () =>
  text('asset_id')
    .primaryKey()
    .references(() => assets.id, { onDelete: 'cascade' });

export const bankAccounts = sqliteTable(
  'bank_accounts',
  {
    assetId: assetIdKey(),
    /** Masked before it ever reaches here — see `maskedNumberSchema` in @networth/shared. */
    accountNumberMasked: text('account_number_masked'),
    ifsc: text('ifsc'),
    branch: text('branch'),
    cif: text('cif'),
    accountType: text('account_type', {
      enum: ['savings', 'current', 'salary', 'nre', 'nro', 'fcnr'],
    })
      .notNull()
      .default('savings'),
  },
  (table) => [
    check(
      'bank_accounts_type_check',
      sql`${table.accountType} in ('savings', 'current', 'salary', 'nre', 'nro', 'fcnr')`,
    ),
  ],
);

export const deposits = sqliteTable(
  'deposits',
  {
    assetId: assetIdKey(),
    kind: text('kind', { enum: ['fd', 'rd', 'ppf', 'ssy', 'nsc', 'kvp', 'mis', 'scss'] }).notNull(),
    accountNumberMasked: text('account_number_masked'),
    principalPaise: integer('principal_paise').notNull().default(0),
    /** Per-instalment contribution for RD, PPF and SSY; zero for a one-shot FD. */
    installmentPaise: integer('installment_paise').notNull().default(0),
    /** Basis points: 7.10% p.a. is 710. */
    rateBps: integer('rate_bps').notNull().default(0),
    compounding: text('compounding', {
      enum: ['monthly', 'quarterly', 'half_yearly', 'yearly', 'maturity', 'simple'],
    })
      .notNull()
      .default('quarterly'),
    payoutMode: text('payout_mode', {
      enum: ['cumulative', 'monthly', 'quarterly', 'half_yearly', 'yearly'],
    })
      .notNull()
      .default('cumulative'),
    startedOn: text('started_on').notNull(),
    maturesOn: text('matures_on'),
    autoRenew: integer('auto_renew', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    // The maturity calendar in P9 reads this across every deposit.
    index('deposits_matures_idx').on(table.maturesOn),
    check(
      'deposits_kind_check',
      sql`${table.kind} in ('fd', 'rd', 'ppf', 'ssy', 'nsc', 'kvp', 'mis', 'scss')`,
    ),
    check(
      'deposits_compounding_check',
      sql`${table.compounding} in ('monthly', 'quarterly', 'half_yearly', 'yearly', 'maturity', 'simple')`,
    ),
    check(
      'deposits_payout_check',
      sql`${table.payoutMode} in ('cumulative', 'monthly', 'quarterly', 'half_yearly', 'yearly')`,
    ),
  ],
);

/**
 * The tradable things a holding can be in — schemes, shares, ETFs and bonds.
 *
 * Global reference data, not owned by anyone: two users holding the same fund point at one
 * row, so a single NAV import revalues both. The AMFI ingest in P7 upserts on
 * `amfi_scheme_code`, which is why that index is unique.
 */
export const instruments = sqliteTable(
  'instruments',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['mf', 'equity', 'etf', 'bond'] }).notNull(),
    name: text('name').notNull(),
    amfiSchemeCode: text('amfi_scheme_code'),
    isin: text('isin'),
    symbol: text('symbol'),
    exchange: text('exchange', { enum: ['nse', 'bse', 'none'] })
      .notNull()
      .default('none'),
    amc: text('amc'),
    category: text('category'),
    createdAt: text('created_at').notNull().default(nowUtc),
    updatedAt: text('updated_at').notNull().default(nowUtc),
  },
  (table) => [
    // SQLite treats NULLs as distinct in a unique index, so an equity with no AMFI code and
    // a fund with no symbol both coexist happily under these.
    uniqueIndex('instruments_amfi_idx').on(table.amfiSchemeCode),
    uniqueIndex('instruments_isin_idx').on(table.isin),
    index('instruments_symbol_idx').on(table.symbol),
    index('instruments_name_idx').on(table.name),
    check('instruments_kind_check', sql`${table.kind} in ('mf', 'equity', 'etf', 'bond')`),
    check('instruments_exchange_check', sql`${table.exchange} in ('nse', 'bse', 'none')`),
  ],
);

/** One price per instrument per day. The composite key is what makes an import idempotent. */
export const instrumentPrices = sqliteTable(
  'instrument_prices',
  {
    instrumentId: text('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    /** Micro-rupees: AMFI publishes NAV to four decimals and we keep all of them. */
    priceMicro: integer('price_micro').notNull(),
    source: text('source', { enum: ['manual', 'amfi', 'yahoo', 'computed'] })
      .notNull()
      .default('manual'),
    createdAt: text('created_at').notNull().default(nowUtc),
  },
  (table) => [
    primaryKey({ columns: [table.instrumentId, table.date] }),
    index('instrument_prices_lookup_idx').on(table.instrumentId, table.date),
    check(
      'instrument_prices_source_check',
      sql`${table.source} in ('manual', 'amfi', 'yahoo', 'computed')`,
    ),
  ],
);

export const holdings = sqliteTable(
  'holdings',
  {
    assetId: assetIdKey(),
    /** Restricted rather than cascaded: deleting a scheme must not delete someone's units. */
    instrumentId: text('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'restrict' }),
    /** Units scaled by a million — 1.5 units is 1500000. */
    units: integer('units').notNull().default(0),
    /** Weighted average cost per unit, in micro-rupees. */
    avgCostMicro: integer('avg_cost_micro').notNull().default(0),
    folioNumberMasked: text('folio_number_masked'),
    sipAmountPaise: integer('sip_amount_paise'),
    sipDay: integer('sip_day'),
    dematAccountMasked: text('demat_account_masked'),
  },
  (table) => [
    index('holdings_instrument_idx').on(table.instrumentId),
    check(
      'holdings_sip_day_check',
      sql`${table.sipDay} is null or ${table.sipDay} between 1 and 28`,
    ),
  ],
);

export const insurancePolicies = sqliteTable(
  'insurance_policies',
  {
    assetId: assetIdKey(),
    policyNumberMasked: text('policy_number_masked'),
    insurer: text('insurer').notNull(),
    plan: text('plan'),
    kind: text('kind', { enum: ['term', 'endowment', 'ulip', 'money_back', 'health'] }).notNull(),
    sumAssuredPaise: integer('sum_assured_paise').notNull().default(0),
    premiumPaise: integer('premium_paise').notNull().default(0),
    premiumFrequency: text('premium_frequency', {
      enum: ['monthly', 'quarterly', 'half_yearly', 'yearly', 'single'],
    })
      .notNull()
      .default('yearly'),
    nextDueOn: text('next_due_on'),
    startedOn: text('started_on'),
    maturesOn: text('matures_on'),
  },
  (table) => [
    index('insurance_due_idx').on(table.nextDueOn),
    check(
      'insurance_kind_check',
      sql`${table.kind} in ('term', 'endowment', 'ulip', 'money_back', 'health')`,
    ),
    check(
      'insurance_frequency_check',
      sql`${table.premiumFrequency} in ('monthly', 'quarterly', 'half_yearly', 'yearly', 'single')`,
    ),
  ],
);

/**
 * Immovable property.
 *
 * The identifier columns look like bureaucratic clutter and are the entire point: an heir
 * with a survey number, a khata and the sub-registrar's office can trace a title. An heir
 * with "the land in Kolar" cannot.
 */
export const properties = sqliteTable(
  'properties',
  {
    assetId: assetIdKey(),
    kind: text('kind', { enum: ['land', 'plot', 'flat', 'house', 'commercial'] }).notNull(),
    address: text('address'),
    surveyNumber: text('survey_number'),
    khataNumber: text('khata_number'),
    pattaNumber: text('patta_number'),
    registrationDocNumber: text('registration_doc_number'),
    subRegistrarOffice: text('sub_registrar_office'),
    /** Area scaled by a million, in `area_unit`s. */
    areaMicro: integer('area_micro'),
    areaUnit: text('area_unit', {
      enum: ['sqft', 'sqyd', 'sqm', 'acre', 'cent', 'guntha', 'hectare'],
    })
      .notNull()
      .default('sqft'),
    /** The circle rate stamp duty is charged on — not what it would fetch on the market. */
    guidelineValuePaise: integer('guideline_value_paise'),
    coOwners: text('co_owners'),
  },
  (table) => [
    check(
      'properties_kind_check',
      sql`${table.kind} in ('land', 'plot', 'flat', 'house', 'commercial')`,
    ),
    check(
      'properties_area_unit_check',
      sql`${table.areaUnit} in ('sqft', 'sqyd', 'sqm', 'acre', 'cent', 'guntha', 'hectare')`,
    ),
  ],
);

export const retirementAccounts = sqliteTable(
  'retirement_accounts',
  {
    assetId: assetIdKey(),
    kind: text('kind', { enum: ['epf', 'vpf', 'nps'] }).notNull(),
    uanMasked: text('uan_masked'),
    memberIdMasked: text('member_id_masked'),
    pranMasked: text('pran_masked'),
    tier: text('tier', { enum: ['tier_1', 'tier_2'] }),
    /** NPS allocation as JSON, e.g. `{"E":50,"C":30,"G":20}`. */
    schemeMix: text('scheme_mix'),
    /** EPF splits the balance by contributor, and a claim needs both halves. */
    employeeBalancePaise: integer('employee_balance_paise').notNull().default(0),
    employerBalancePaise: integer('employer_balance_paise').notNull().default(0),
    rateBps: integer('rate_bps'),
  },
  (table) => [
    check('retirement_kind_check', sql`${table.kind} in ('epf', 'vpf', 'nps')`),
    check(
      'retirement_tier_check',
      sql`${table.tier} is null or ${table.tier} in ('tier_1', 'tier_2')`,
    ),
  ],
);

export const preciousMetals = sqliteTable(
  'precious_metals',
  {
    assetId: assetIdKey(),
    form: text('form', { enum: ['physical', 'digital', 'sgb', 'jewellery'] }).notNull(),
    metal: text('metal', { enum: ['gold', 'silver', 'platinum'] })
      .notNull()
      .default('gold'),
    /** Milligrams: jewellery bills are written to a tenth of a gram. */
    weightMilligrams: integer('weight_milligrams').notNull().default(0),
    purity: text('purity'),
    makingChargesPaise: integer('making_charges_paise').notNull().default(0),
    sgbMaturesOn: text('sgb_matures_on'),
    /** JSON array of `MM-DD` coupon dates for a sovereign gold bond. */
    sgbInterestDates: text('sgb_interest_dates'),
  },
  (table) => [
    check(
      'precious_metals_form_check',
      sql`${table.form} in ('physical', 'digital', 'sgb', 'jewellery')`,
    ),
    check('precious_metals_metal_check', sql`${table.metal} in ('gold', 'silver', 'platinum')`),
  ],
);

/**
 * The long tail: crypto, ESOPs, RSUs, chit funds, money lent, vehicles.
 *
 * `detail` is JSON because these have almost nothing in common, but it is not unvalidated —
 * `otherAssetDetailSchema` is a discriminated union on `kind`, and nothing writes this
 * column without going through it.
 */
export const otherAssets = sqliteTable(
  'other_assets',
  {
    assetId: assetIdKey(),
    kind: text('kind', {
      enum: ['crypto', 'esop', 'rsu', 'chit', 'loan_given', 'vehicle'],
    }).notNull(),
    detail: text('detail').notNull().default('{}'),
  },
  (table) => [
    check(
      'other_assets_kind_check',
      sql`${table.kind} in ('crypto', 'esop', 'rsu', 'chit', 'loan_given', 'vehicle')`,
    ),
  ],
);

/**
 * What is owed. Stored as a positive `outstanding_paise`; net worth subtracts these rows
 * rather than storing a negative balance, so "total borrowings" needs no sign gymnastics.
 */
export const liabilities = sqliteTable(
  'liabilities',
  {
    assetId: assetIdKey(),
    kind: text('kind', {
      enum: [
        'home',
        'car',
        'personal',
        'education',
        'gold',
        'credit_card',
        'loan_against',
        'business',
      ],
    }).notNull(),
    lender: text('lender').notNull(),
    accountNumberMasked: text('account_number_masked'),
    principalPaise: integer('principal_paise').notNull().default(0),
    outstandingPaise: integer('outstanding_paise').notNull().default(0),
    rateBps: integer('rate_bps').notNull().default(0),
    emiPaise: integer('emi_paise').notNull().default(0),
    tenureMonths: integer('tenure_months'),
    nextDueOn: text('next_due_on'),
    startedOn: text('started_on'),
    endsOn: text('ends_on'),
  },
  (table) => [
    index('liabilities_due_idx').on(table.nextDueOn),
    check(
      'liabilities_kind_check',
      sql`${table.kind} in ('home', 'car', 'personal', 'education', 'gold', 'credit_card', 'loan_against', 'business')`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* movement and value                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Every movement of money or units. This is what cost basis and XIRR are computed from, so
 * a transaction is signed: a `sell` carries negative units, a `buy` positive.
 */
export const transactions = sqliteTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    assetId: text('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    type: text('type', {
      enum: [
        'buy',
        'sell',
        'sip',
        'dividend',
        'interest',
        'deposit',
        'withdrawal',
        'premium',
        'emi',
      ],
    }).notNull(),
    /** Scaled by a million, signed. Null for a purely cash movement such as an EMI. */
    units: integer('units'),
    amountPaise: integer('amount_paise').notNull(),
    /** Per-unit price in micro-rupees, as transacted rather than as quoted. */
    priceMicro: integer('price_micro'),
    chargesPaise: integer('charges_paise').notNull().default(0),
    notes: text('notes'),
    createdAt: text('created_at').notNull().default(nowUtc),
    updatedAt: text('updated_at').notNull().default(nowUtc),
  },
  (table) => [
    // Cashflow assembly for XIRR reads exactly this order.
    index('transactions_asset_date_idx').on(table.assetId, table.date),
    check(
      'transactions_type_check',
      sql`${table.type} in ('buy', 'sell', 'sip', 'dividend', 'interest', 'deposit', 'withdrawal', 'premium', 'emi')`,
    ),
  ],
);

/**
 * What an asset was worth, on a date, according to somebody.
 *
 * **Append-only.** Nothing in the codebase updates or deletes a row here. A correction is a
 * new row with a later `created_at`, which is why the net-worth chart is real history
 * rather than a reconstruction, and why a bad price import can be reasoned about after the
 * fact instead of having silently overwritten the truth.
 */
export const valuations = sqliteTable(
  'valuations',
  {
    id: text('id').primaryKey(),
    assetId: text('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    asOf: text('as_of').notNull(),
    valuePaise: integer('value_paise').notNull(),
    source: text('source', { enum: ['manual', 'amfi', 'yahoo', 'computed'] })
      .notNull()
      .default('manual'),
    notes: text('notes'),
    createdAt: text('created_at').notNull().default(nowUtc),
  },
  (table) => [
    // "Latest value per asset" and the history chart are the same index read two ways.
    index('valuations_asset_idx').on(table.assetId, table.asOf),
    check(
      'valuations_source_check',
      sql`${table.source} in ('manual', 'amfi', 'yahoo', 'computed')`,
    ),
  ],
);

/**
 * Uploaded files, always encrypted.
 *
 * P2 declared this table with plaintext `filename` and `mime` columns and an `encrypted`
 * flag, on the assumption that some documents would not need the vault. P4 removes the
 * choice: every file this app stores is a financial document, so the filename and the type
 * are encrypted along with the bytes and there is no flag to get wrong. Nothing had ever
 * written a row, so the migration rebuilds the table rather than carrying dead columns.
 *
 * The ciphertext on disk carries its own twelve-byte IV as a prefix, which means a restored
 * backup needs nothing from this database to be decryptable except the owner's vault key.
 */
export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assetId: text('asset_id').references(() => assets.id, { onDelete: 'set null' }),
    /** JSON `{v, iv, ct}` over `{filename, mime}`. Even the name of the file is private. */
    meta: text('meta').notNull(),
    /** Length of the stored ciphertext, IV and GCM tag included. */
    sizeBytes: integer('size_bytes').notNull(),
    /** Path relative to `UPLOAD_DIR`; the file itself never lives in the database. */
    storagePath: text('storage_path').notNull(),
    /** Of the ciphertext as written, so a corrupted blob is detected before it is decrypted. */
    sha256: text('sha256').notNull(),
    createdAt: text('created_at').notNull().default(nowUtc),
  },
  (table) => [
    index('documents_owner_idx').on(table.ownerUserId),
    index('documents_asset_idx').on(table.assetId),
    check('documents_meta_check', sql`json_extract(${table.meta}, '$.ct') is not null`),
    check('documents_size_check', sql`${table.sizeBytes} > 0`),
  ],
);

/* -------------------------------------------------------------------------- */
/* vault                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The key material one user's vault is opened with.
 *
 * Every column here is either public by design or useless without a passphrase this server
 * never sees. There is deliberately no verifier column: checking a passphrase happens when
 * the AES-GCM tag on `wrapped_dek` authenticates, in the browser. A server-side verifier
 * would hand anyone who copied this file a free oracle to grind against.
 *
 * Encrypted values are stored as the JSON envelope `{v, iv, ct}` rather than split across
 * columns, so the format version travels with the ciphertext into a backup and out again.
 */
export const vaultKeys = sqliteTable(
  'vault_keys',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Per-user Argon2id salt, base64url. Public; its job is to defeat shared rainbow tables. */
    kdfSalt: text('kdf_salt').notNull(),
    /** JSON `{algorithm, memoryKib, iterations, parallelism}` — the client's choice, stored verbatim. */
    kdfParams: text('kdf_params').notNull(),
    /** The AES-256 data key, wrapped under the key derived from the vault passphrase. */
    wrappedDek: text('wrapped_dek').notNull(),
    /** RSA-OAEP public JWK. Plaintext, so an owner can wrap a key to a nominee who is offline. */
    publicKeyJwk: text('public_key_jwk').notNull(),
    /** PKCS#8 private key, wrapped under the same derived key. */
    wrappedPrivateKey: text('wrapped_private_key').notNull(),
    createdAt: text('created_at').notNull().default(nowUtc),
    updatedAt: text('updated_at').notNull().default(nowUtc),
  },
  (table) => [
    // A row that is not a well-formed envelope could only come from something other than
    // this application writing the file, and it would fail at unwrap time with no
    // explanation. Fail at the insert instead.
    check('vault_keys_dek_check', sql`json_extract(${table.wrappedDek}, '$.ct') is not null`),
    check(
      'vault_keys_private_check',
      sql`json_extract(${table.wrappedPrivateKey}, '$.ct') is not null`,
    ),
  ],
);

const VAULT_ITEM_KIND_LIST = sql`('bank_login', 'card', 'demat', 'policy', 'locker', 'credential', 'document_location', 'instruction', 'note')`;

/**
 * One encrypted secret.
 *
 * `kind` and `asset_id` are in the clear and everything else is not — a documented leak
 * (docs/SECURITY-MODEL.md) that buys the ability to say "this deposit has two vault items"
 * on a locked screen. The label, the username and the secret are all inside `payload`.
 */
export const vaultItems = sqliteTable(
  'vault_items',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assetId: text('asset_id').references(() => assets.id, { onDelete: 'set null' }),
    kind: text('kind', {
      enum: [
        'bank_login',
        'card',
        'demat',
        'policy',
        'locker',
        'credential',
        'document_location',
        'instruction',
        'note',
      ],
    }).notNull(),
    /** JSON `{v, iv, ct}`. The server has no key that opens it and no code path that tries. */
    payload: text('payload').notNull(),
    createdAt: text('created_at').notNull().default(nowUtc),
    updatedAt: text('updated_at').notNull().default(nowUtc),
  },
  (table) => [
    index('vault_items_owner_idx').on(table.ownerUserId, table.kind),
    index('vault_items_asset_idx').on(table.assetId),
    check('vault_items_kind_check', sql`${table.kind} in ${VAULT_ITEM_KIND_LIST}`),
    check('vault_items_payload_check', sql`json_extract(${table.payload}, '$.ct') is not null`),
  ],
);

/* -------------------------------------------------------------------------- */
/* vault escrow                                                               */
/* -------------------------------------------------------------------------- */

/**
 * An owner's data key, wrapped to a nominee's public key and held sealed.
 *
 * The server cannot open this and cannot create it — the wrapping happens in the owner's
 * browser while their vault is unlocked. What the server owns is the *release decision*,
 * and that is the reason this is a state machine with an audit trail rather than a column
 * on `nominees`: "when did this open, and what opened it" is the question that matters
 * after somebody has died.
 */
export const vaultEscrow = sqliteTable(
  'vault_escrow',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    nomineeId: text('nominee_id')
      .notNull()
      .references(() => nominees.id, { onDelete: 'cascade' }),
    /** Denormalised from `nominees` so a released escrow can be found by the heir directly. */
    granteeUserId: text('grantee_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The DEK under RSA-OAEP, base64url. Opaque bytes as far as this process is concerned. */
    wrappedDek: text('wrapped_dek').notNull(),
    /** Of the public key it was wrapped to, so a rotated key shows up as a stale escrow. */
    publicKeyFingerprint: text('public_key_fingerprint').notNull(),
    state: text('state', { enum: ['sealed', 'released', 'revoked'] })
      .notNull()
      .default('sealed'),
    releaseReason: text('release_reason', { enum: ['owner', 'deadman'] }),
    releasedAt: text('released_at'),
    revokedAt: text('revoked_at'),
    createdAt: text('created_at').notNull().default(nowUtc),
    updatedAt: text('updated_at').notNull().default(nowUtc),
  },
  (table) => [
    uniqueIndex('vault_escrow_nominee_unique').on(table.nomineeId),
    index('vault_escrow_owner_idx').on(table.ownerUserId, table.state),
    index('vault_escrow_grantee_idx').on(table.granteeUserId, table.state),
    check('vault_escrow_state_check', sql`${table.state} in ('sealed', 'released', 'revoked')`),
    check(
      'vault_escrow_reason_check',
      sql`${table.releaseReason} is null or ${table.releaseReason} in ('owner', 'deadman')`,
    ),
    // A released escrow without a reason or a timestamp is a row nobody could account for
    // later, which defeats the point of keeping the history at all.
    check(
      'vault_escrow_released_check',
      sql`(${table.state} <> 'released') or (${table.releasedAt} is not null and ${table.releaseReason} is not null)`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* dead-man switch                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Silence, measured.
 *
 * One row per user, created when they first configure it. `last_checkin_at` is bumped by
 * an explicit check-in *and* by ordinary authentication, because the honest signal is "this
 * person is still using their account", not "this person clicked the button".
 */
export const deadManSwitch = sqliteTable(
  'dead_man_switch',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    /** Days of silence before the grace period opens. Floor of 30 enforced by the schema. */
    inactivityDays: integer('inactivity_days').notNull().default(90),
    graceDays: integer('grace_days').notNull().default(7),
    lastCheckinAt: text('last_checkin_at').notNull().default(nowUtc),
    stage: text('stage', {
      enum: ['idle', 'warned_50', 'warned_75', 'warned_90', 'grace', 'fired'],
    })
      .notNull()
      .default('idle'),
    graceStartedAt: text('grace_started_at'),
    firedAt: text('fired_at'),
    updatedAt: text('updated_at').notNull().default(nowUtc),
  },
  (table) => [
    index('dead_man_switch_enabled_idx').on(table.enabled, table.stage),
    check(
      'dead_man_switch_stage_check',
      sql`${table.stage} in ('idle', 'warned_50', 'warned_75', 'warned_90', 'grace', 'fired')`,
    ),
    check('dead_man_switch_inactivity_check', sql`${table.inactivityDays} between 30 and 730`),
    check(
      'dead_man_switch_grace_check',
      sql`${table.graceDays} between 1 and 90 and ${table.graceDays} < ${table.inactivityDays}`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* password resets                                                            */
/* -------------------------------------------------------------------------- */

/**
 * An outstanding "forgot my password" link.
 *
 * Modelled on `refresh_tokens` and for the same reason: the token is an opaque random
 * value, only its HMAC is stored, and a row can be taken back. A JWT would be neither
 * revocable nor absent from a stolen database in any useful sense.
 *
 * Rows are kept after use rather than deleted. "This account's password was reset from
 * that address at that time" is exactly the history somebody will want if an account is
 * ever taken over, and a deleted row cannot tell them.
 */
export const passwordResets = sqliteTable(
  'password_resets',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** HMAC-SHA-256 of the emailed token under `SECRET_ENCRYPTION_KEY`. */
    tokenHash: text('token_hash').notNull().unique(),
    /** The address that asked, so a burst of requests has a shape when read back. */
    requestedIp: text('requested_ip'),
    expiresAt: text('expires_at').notNull(),
    usedAt: text('used_at'),
    /**
     * Set when a newer request, or the password changing by another route, made this link
     * moot. Distinct from `used_at`: one of them means somebody followed the link.
     */
    invalidatedAt: text('invalidated_at'),
    createdAt: text('created_at').notNull().default(nowUtc),
  },
  (table) => [index('password_resets_user_idx').on(table.userId, table.createdAt)],
);

/* -------------------------------------------------------------------------- */
/* email outbox                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Mail that has been composed but not yet handed to an SMTP server.
 *
 * Nothing in this application sends email on the request thread. A queued row is written
 * inside whatever transaction produced it and a background loop drains it, which buys three
 * things: an invite is not lost because Gmail was briefly unreachable, a slow SMTP
 * handshake cannot stall a login, and a dead-man warning — the one message that genuinely
 * matters and has no user waiting on it — is retried rather than dropped.
 *
 * `body_encrypted` is the whole rendered message, sealed with `SECRET_ENCRYPTION_KEY` the
 * same way a TOTP seed is. A pending row holds a live password-reset link or an unredeemed
 * invite code; storing those in the clear would undo the care taken to keep the same
 * secrets out of `invites` and `refresh_tokens`. It is cleared the moment the message is
 * accepted, so a delivered row keeps only its envelope.
 */
export const emailOutbox = sqliteTable(
  'email_outbox',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    toEmail: text('to_email').notNull(),
    /** Not a foreign key: mail goes to nominees and invitees who have no account yet. */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** In the clear. It names the event, never the secret — see the templates. */
    subject: text('subject').notNull(),
    /** Sealed JSON `{text, html}`. Null once sent, or once permanently failed. */
    bodyEncrypted: text('body_encrypted'),
    status: text('status', { enum: ['pending', 'sent', 'failed', 'suppressed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** Null for anything terminal. A pending row is due when this is in the past. */
    nextAttemptAt: text('next_attempt_at'),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull().default(nowUtc),
    sentAt: text('sent_at'),
  },
  (table) => [
    // The drain query is "pending rows that are due, oldest first", and it runs once a
    // minute forever.
    index('email_outbox_due_idx').on(table.status, table.nextAttemptAt),
    index('email_outbox_created_idx').on(table.createdAt),
    check(
      'email_outbox_status_check',
      sql`${table.status} in ('pending', 'sent', 'failed', 'suppressed')`,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* dead-man check-in links                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A "yes, I am still here" link, as emailed with a dead-man warning.
 *
 * The point of the whole feature is somebody who has stopped opening the app, so requiring
 * them to sign in to say they are alive asks for the exact behaviour whose absence is being
 * measured. This is the way out: the warning email carries a link, and following it resets
 * the clock without granting a session or reading anything.
 *
 * Structured like `password_resets` — opaque random value, only its HMAC stored, single use,
 * expiring — with one difference that matters more here than anywhere else in the schema:
 * **following the link is not what checks you in.** Mail providers and corporate security
 * appliances fetch the links in a message before a human ever sees it. If a `GET` performed
 * the check-in, a link scanner would keep a dead owner's switch alive indefinitely and the
 * escrows would never release. So the link opens a page, and a human presses a button. The
 * same reasoning is why `POST /estate/:ownerId/key` is a POST.
 */
export const deadManCheckins = sqliteTable(
  'deadman_checkins',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** HMAC-SHA-256 of the emailed token under `SECRET_ENCRYPTION_KEY`. */
    tokenHash: text('token_hash').notNull().unique(),
    /** The stage whose email carried this, so the audit trail says which nudge worked. */
    stage: text('stage').notNull(),
    expiresAt: text('expires_at').notNull(),
    usedAt: text('used_at'),
    createdAt: text('created_at').notNull().default(nowUtc),
  },
  (table) => [index('deadman_checkins_user_idx').on(table.userId, table.createdAt)],
);

/* -------------------------------------------------------------------------- */
/* row types                                                                  */
/* -------------------------------------------------------------------------- */

export type UserRow = typeof users.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
export type AccessGrantRow = typeof accessGrants.$inferSelect;
export type HouseholdRow = typeof households.$inferSelect;
export type HouseholdMemberRow = typeof householdMembers.$inferSelect;
export type InstrumentRow = typeof instruments.$inferSelect;
export type InstrumentPriceRow = typeof instrumentPrices.$inferSelect;
export type TransactionRow = typeof transactions.$inferSelect;
export type ValuationRow = typeof valuations.$inferSelect;
export type VaultKeyRow = typeof vaultKeys.$inferSelect;
export type VaultItemRow = typeof vaultItems.$inferSelect;
export type VaultEscrowRow = typeof vaultEscrow.$inferSelect;
export type DeadManSwitchRow = typeof deadManSwitch.$inferSelect;
export type NomineeRow = typeof nominees.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type PasswordResetRow = typeof passwordResets.$inferSelect;
export type EmailOutboxRow = typeof emailOutbox.$inferSelect;
export type DeadManCheckinRow = typeof deadManCheckins.$inferSelect;
