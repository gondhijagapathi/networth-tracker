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
 * Uploaded files. The table lands with the schema in P2; encrypted upload and download
 * arrive with the vault in P4, which is why `encrypted` exists but nothing sets it yet.
 */
export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assetId: text('asset_id').references(() => assets.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** Path relative to `UPLOAD_DIR`; the file itself never lives in the database. */
    storagePath: text('storage_path').notNull(),
    sha256: text('sha256').notNull(),
    encrypted: integer('encrypted', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().default(nowUtc),
  },
  (table) => [
    index('documents_owner_idx').on(table.ownerUserId),
    index('documents_asset_idx').on(table.assetId),
  ],
);

/* -------------------------------------------------------------------------- */
/* row types                                                                  */
/* -------------------------------------------------------------------------- */

export type UserRow = typeof users.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
export type AccessGrantRow = typeof accessGrants.$inferSelect;
export type InstrumentRow = typeof instruments.$inferSelect;
export type TransactionRow = typeof transactions.$inferSelect;
export type ValuationRow = typeof valuations.$inferSelect;
