/**
 * Asset contracts shared by the API and the web client.
 *
 * `assets` is a base row plus exactly one typed detail row, so every schema here comes in
 * two halves: the fields every asset has (name, institution, nomination, ownership) and the
 * fields only a fixed deposit or a land record has. The create schema is a discriminated
 * union on `type`, which means one `createAssetSchema.parse(body)` validates the pairing —
 * a `deposit` carrying `bank_account` detail fails at the door rather than at the insert.
 *
 * The browser uses these for instant feedback; the server re-parses every body with the
 * same schema and trusts nothing the client claims to have checked.
 */

import { z } from 'zod';
import { MAX_PAISE } from './money.js';

/* -------------------------------------------------------------------------- */
/* Enumerations                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every kind of thing this app tracks, liabilities included.
 *
 * A loan is an `assets` row with `type: 'liability'` and a `liabilities` detail row. That
 * looks odd written down and is right in practice: a home loan has an institution, a
 * nomination status, documents, transactions (the EMIs) and a balance history, and every
 * one of those is machinery the base table already has. Net worth subtracts the liability
 * rows rather than storing negative values — see {@link isLiabilityType}.
 */
export const ASSET_TYPES = [
  'bank_account',
  'deposit',
  'holding',
  'insurance_policy',
  'property',
  'retirement_account',
  'precious_metal',
  'other_asset',
  'liability',
] as const;
export const assetTypeSchema = z.enum(ASSET_TYPES);
export type AssetType = z.infer<typeof assetTypeSchema>;

/** Assets are closed or archived, never deleted: history and past valuations outlive them. */
export const ASSET_STATUSES = ['active', 'closed', 'archived'] as const;
export const assetStatusSchema = z.enum(ASSET_STATUSES);
export type AssetStatus = z.infer<typeof assetStatusSchema>;

export const BANK_ACCOUNT_TYPES = ['savings', 'current', 'salary', 'nre', 'nro', 'fcnr'] as const;

/** The small-savings and term-deposit alphabet soup, as an Indian saver actually holds it. */
export const DEPOSIT_KINDS = ['fd', 'rd', 'ppf', 'ssy', 'nsc', 'kvp', 'mis', 'scss'] as const;

export const COMPOUNDING_FREQUENCIES = [
  'monthly',
  'quarterly',
  'half_yearly',
  'yearly',
  'maturity',
  'simple',
] as const;

export const PAYOUT_MODES = [
  'cumulative',
  'monthly',
  'quarterly',
  'half_yearly',
  'yearly',
] as const;

export const INSTRUMENT_KINDS = ['mf', 'equity', 'etf', 'bond'] as const;

export const INSURANCE_KINDS = ['term', 'endowment', 'ulip', 'money_back', 'health'] as const;

export const PREMIUM_FREQUENCIES = [
  'monthly',
  'quarterly',
  'half_yearly',
  'yearly',
  'single',
] as const;

export const PROPERTY_KINDS = ['land', 'plot', 'flat', 'house', 'commercial'] as const;

/** Land is measured in whatever the local sub-registrar uses; all of these appear on deeds. */
export const AREA_UNITS = ['sqft', 'sqyd', 'sqm', 'acre', 'cent', 'guntha', 'hectare'] as const;

export const RETIREMENT_KINDS = ['epf', 'vpf', 'nps'] as const;

export const NPS_TIERS = ['tier_1', 'tier_2'] as const;

export const METAL_FORMS = ['physical', 'digital', 'sgb', 'jewellery'] as const;

export const METALS = ['gold', 'silver', 'platinum'] as const;

export const OTHER_ASSET_KINDS = [
  'crypto',
  'esop',
  'rsu',
  'chit',
  'loan_given',
  'vehicle',
] as const;

export const LIABILITY_KINDS = [
  'home',
  'car',
  'personal',
  'education',
  'gold',
  'credit_card',
  'loan_against',
  'business',
] as const;

export const TRANSACTION_TYPES = [
  'buy',
  'sell',
  'sip',
  'dividend',
  'interest',
  'deposit',
  'withdrawal',
  'premium',
  'emi',
] as const;
export const transactionTypeSchema = z.enum(TRANSACTION_TYPES);
export type TransactionType = z.infer<typeof transactionTypeSchema>;

/** Where a number came from. `computed` is the accrual engine, not a quoted price. */
export const VALUATION_SOURCES = ['manual', 'amfi', 'yahoo', 'computed'] as const;
export const valuationSourceSchema = z.enum(VALUATION_SOURCES);
export type ValuationSource = z.infer<typeof valuationSourceSchema>;

/** What a grantee may see. Read-only in every case — a grant never confers writes. */
export const ACCESS_SCOPES = ['summary', 'full', 'vault'] as const;
export const accessScopeSchema = z.enum(ACCESS_SCOPES);
export type AccessScope = z.infer<typeof accessScopeSchema>;

/** Liabilities are subtracted from net worth rather than stored as negative values. */
export function isLiabilityType(type: AssetType): boolean {
  return type === 'liability';
}

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * An amount of money, in paise. Never a float, never a string, never rupees.
 *
 * The bound is the safe-integer limit rather than an opinion about wealth: past it,
 * addition stops being exact and a net worth tracker that cannot add is not one.
 */
export const paiseSchema = z.number().int('Amounts are whole paise').min(-MAX_PAISE).max(MAX_PAISE);

/** Balances, principals and premiums: real amounts that cannot be less than nothing. */
export const nonNegativePaiseSchema = paiseSchema.nonnegative('Amount cannot be negative');

/**
 * Percentages are stored as basis points — hundredths of a percent, as integers.
 *
 * A 33.33% ownership split is `3333`. Storing it as `0.3333` would put a float in the one
 * calculation (whose share of this flat is whose) that most needs to add back to exactly
 * one hundred percent.
 */
export const bpsSchema = z.number().int('Use basis points, not a fraction').min(0).max(10_000);

/** Interest rates, also in basis points: 7.1% p.a. is `710`. Capped well above any lender. */
export const rateBpsSchema = z.number().int().min(0).max(100_000);

/** Quantities scaled by a million — see `quantity.ts`. */
export const microSchema = z.number().int('Scale the value by 1,000,000 before sending');

export const positiveMicroSchema = microSchema.nonnegative();

/** A calendar date, `YYYY-MM-DD`. Instants are only ever produced by the server. */
export const isoDateSchema = z.iso.date('Use a YYYY-MM-DD date');

export const labelSchema = z.string().trim().min(1, 'This is required').max(120, 'Too long');

export const optionalLabelSchema = z
  .string()
  .trim()
  .max(120, 'Too long')
  .optional()
  .transform((value) => (value === '' ? undefined : value));

export const notesSchema = z.string().trim().max(2_000, 'Notes are limited to 2000 characters');

/**
 * An account, policy or folio number, masked to its last four digits.
 *
 * SECURITY-MODEL.md is explicit that full numbers belong in the vault and never in a plain
 * column, so this masks rather than rejects: whatever the client sends, what reaches the
 * database has already lost everything but the tail. Doing it here — in the schema both
 * sides parse — means no route can forget, and a client bug cannot leak a full number into
 * a backup.
 */
export const maskedNumberSchema = z
  .string()
  .trim()
  .max(60, 'Too long')
  .transform(maskIdentifier)
  .optional();

/** Replace every digit but the last four with `X`, leaving separators intact. */
export function maskIdentifier(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return value;

  let remaining = digits.length - 4;
  return value.replace(/\d/g, (digit) => (remaining-- > 0 ? 'X' : digit));
}

/** IFSC is eleven characters, fifth always `0`. Worth validating: it routes real money. */
export const ifscSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC looks like HDFC0001234')
  .optional();

export const tagsSchema = z
  .array(z.string().trim().min(1).max(30))
  .max(20, 'Twenty tags is plenty')
  .transform((tags) => [...new Set(tags)]);

/* -------------------------------------------------------------------------- */
/* Detail schemas — one per asset type                                        */
/* -------------------------------------------------------------------------- */

export const bankAccountDetailSchema = z.object({
  accountNumber: maskedNumberSchema,
  ifsc: ifscSchema,
  branch: optionalLabelSchema,
  /** The bank's own customer id — useful when claiming across several accounts. */
  cif: maskedNumberSchema,
  accountType: z.enum(BANK_ACCOUNT_TYPES).default('savings'),
});
export type BankAccountDetail = z.infer<typeof bankAccountDetailSchema>;

export const depositDetailSchema = z
  .object({
    kind: z.enum(DEPOSIT_KINDS),
    accountNumber: maskedNumberSchema,
    principalPaise: nonNegativePaiseSchema,
    /** Recurring contribution for RD, PPF and SSY. Zero for a one-shot FD. */
    installmentPaise: nonNegativePaiseSchema.default(0),
    rateBps: rateBpsSchema,
    compounding: z.enum(COMPOUNDING_FREQUENCIES).default('quarterly'),
    payoutMode: z.enum(PAYOUT_MODES).default('cumulative'),
    startedOn: isoDateSchema,
    maturesOn: isoDateSchema.optional(),
    autoRenew: z.boolean().default(false),
  })
  .refine((d) => d.maturesOn === undefined || d.maturesOn >= d.startedOn, {
    message: 'Maturity cannot be before the start date',
    path: ['maturesOn'],
  });
export type DepositDetail = z.infer<typeof depositDetailSchema>;

export const holdingDetailSchema = z.object({
  /** An `instruments` row. Created from the AMFI catalogue in P7, or by hand before that. */
  instrumentId: z.uuid('Pick an instrument'),
  units: positiveMicroSchema,
  /** Weighted average purchase price per unit, in micro-rupees. Drives cost basis. */
  avgCostMicro: positiveMicroSchema.default(0),
  folioNumber: maskedNumberSchema,
  sipAmountPaise: nonNegativePaiseSchema.optional(),
  /** Day of the month the SIP debits. Capped at 28 so it exists in February. */
  sipDay: z.number().int().min(1).max(28).optional(),
  dematAccount: maskedNumberSchema,
});
export type HoldingDetail = z.infer<typeof holdingDetailSchema>;

export const insurancePolicyDetailSchema = z.object({
  policyNumber: maskedNumberSchema,
  insurer: labelSchema,
  plan: optionalLabelSchema,
  kind: z.enum(INSURANCE_KINDS),
  sumAssuredPaise: nonNegativePaiseSchema,
  premiumPaise: nonNegativePaiseSchema,
  premiumFrequency: z.enum(PREMIUM_FREQUENCIES).default('yearly'),
  nextDueOn: isoDateSchema.optional(),
  startedOn: isoDateSchema.optional(),
  maturesOn: isoDateSchema.optional(),
});
export type InsurancePolicyDetail = z.infer<typeof insurancePolicyDetailSchema>;

export const propertyDetailSchema = z.object({
  kind: z.enum(PROPERTY_KINDS),
  address: z.string().trim().max(400).optional(),
  /** The identifiers a claim actually needs; without them an heir starts from nothing. */
  surveyNumber: optionalLabelSchema,
  khataNumber: optionalLabelSchema,
  pattaNumber: optionalLabelSchema,
  registrationDocNumber: optionalLabelSchema,
  subRegistrarOffice: optionalLabelSchema,
  /** Area scaled by a million, so 1200.5 sq ft is `1_200_500_000`. */
  areaMicro: positiveMicroSchema.optional(),
  areaUnit: z.enum(AREA_UNITS).default('sqft'),
  /** The state's circle rate — what stamp duty is computed on, not what it would sell for. */
  guidelineValuePaise: nonNegativePaiseSchema.optional(),
  coOwners: z.string().trim().max(400).optional(),
});
export type PropertyDetail = z.infer<typeof propertyDetailSchema>;

export const retirementAccountDetailSchema = z.object({
  kind: z.enum(RETIREMENT_KINDS),
  /** EPF: the twelve-digit UAN and the member id it maps to. */
  uan: maskedNumberSchema,
  memberId: maskedNumberSchema,
  /** NPS: the PRAN and which tier this row is. */
  pran: maskedNumberSchema,
  tier: z.enum(NPS_TIERS).optional(),
  /** NPS scheme allocation, e.g. `{"E":50,"C":30,"G":20}` as whole percents. */
  schemeMix: z.record(z.string().max(20), z.number().min(0).max(100)).optional(),
  employeeBalancePaise: nonNegativePaiseSchema.default(0),
  employerBalancePaise: nonNegativePaiseSchema.default(0),
  rateBps: rateBpsSchema.optional(),
});
export type RetirementAccountDetail = z.infer<typeof retirementAccountDetailSchema>;

export const preciousMetalDetailSchema = z.object({
  form: z.enum(METAL_FORMS),
  metal: z.enum(METALS).default('gold'),
  /** Milligrams: jewellery is weighed to a tenth of a gram and SGBs to the gram. */
  weightMilligrams: z.number().int().nonnegative(),
  /** `24K`, `22K`, `916`, `999` — whatever the bill says. */
  purity: optionalLabelSchema,
  makingChargesPaise: nonNegativePaiseSchema.default(0),
  sgbMaturesOn: isoDateSchema.optional(),
  /** The two `MM-DD` dates an SGB pays its 2.5% coupon on. */
  sgbInterestDates: z
    .array(z.string().regex(/^\d{2}-\d{2}$/, 'Use MM-DD'))
    .max(2)
    .optional(),
});
export type PreciousMetalDetail = z.infer<typeof preciousMetalDetailSchema>;

/**
 * The long tail, typed per kind rather than left as free JSON.
 *
 * "Free-form" in the data model means the *column* is JSON; it does not mean unvalidated.
 * A discriminated union keeps an RSU grant from quietly storing a chit fund's fields.
 */
export const otherAssetDetailSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('crypto'),
    symbol: labelSchema,
    quantityMicro: positiveMicroSchema,
    wallet: optionalLabelSchema,
  }),
  z.object({
    kind: z.literal('esop'),
    company: labelSchema,
    grantedOn: isoDateSchema.optional(),
    grantedUnits: positiveMicroSchema,
    vestedUnits: positiveMicroSchema.default(0),
    strikePaise: nonNegativePaiseSchema.default(0),
  }),
  z.object({
    kind: z.literal('rsu'),
    company: labelSchema,
    grantedOn: isoDateSchema.optional(),
    grantedUnits: positiveMicroSchema,
    vestedUnits: positiveMicroSchema.default(0),
  }),
  z.object({
    kind: z.literal('chit'),
    organiser: labelSchema,
    chitValuePaise: nonNegativePaiseSchema,
    monthlyPaise: nonNegativePaiseSchema,
    months: z.number().int().min(1).max(120),
    startedOn: isoDateSchema.optional(),
  }),
  z.object({
    kind: z.literal('loan_given'),
    borrower: labelSchema,
    principalPaise: nonNegativePaiseSchema,
    rateBps: rateBpsSchema.default(0),
    dueOn: isoDateSchema.optional(),
  }),
  z.object({
    kind: z.literal('vehicle'),
    make: optionalLabelSchema,
    model: optionalLabelSchema,
    registrationNumber: optionalLabelSchema,
    purchasedOn: isoDateSchema.optional(),
    purchasePaise: nonNegativePaiseSchema.default(0),
  }),
]);
export type OtherAssetDetail = z.infer<typeof otherAssetDetailSchema>;

export const liabilityDetailSchema = z
  .object({
    kind: z.enum(LIABILITY_KINDS),
    lender: labelSchema,
    accountNumber: maskedNumberSchema,
    principalPaise: nonNegativePaiseSchema,
    outstandingPaise: nonNegativePaiseSchema,
    rateBps: rateBpsSchema,
    emiPaise: nonNegativePaiseSchema.default(0),
    tenureMonths: z.number().int().min(0).max(600).optional(),
    nextDueOn: isoDateSchema.optional(),
    startedOn: isoDateSchema.optional(),
    endsOn: isoDateSchema.optional(),
  })
  .refine((d) => d.outstandingPaise <= d.principalPaise || d.kind === 'credit_card', {
    // A revolving card can owe more than it was "sanctioned"; a term loan cannot.
    message: 'Outstanding cannot exceed the sanctioned principal',
    path: ['outstandingPaise'],
  });
export type LiabilityDetail = z.infer<typeof liabilityDetailSchema>;

/** Every detail schema, keyed by the type it belongs to. */
export const assetDetailSchemas = {
  bank_account: bankAccountDetailSchema,
  deposit: depositDetailSchema,
  holding: holdingDetailSchema,
  insurance_policy: insurancePolicyDetailSchema,
  property: propertyDetailSchema,
  retirement_account: retirementAccountDetailSchema,
  precious_metal: preciousMetalDetailSchema,
  other_asset: otherAssetDetailSchema,
  liability: liabilityDetailSchema,
} as const satisfies Record<AssetType, z.ZodType>;

export type AssetDetail = {
  bank_account: BankAccountDetail;
  deposit: DepositDetail;
  holding: HoldingDetail;
  insurance_policy: InsurancePolicyDetail;
  property: PropertyDetail;
  retirement_account: RetirementAccountDetail;
  precious_metal: PreciousMetalDetail;
  other_asset: OtherAssetDetail;
  liability: LiabilityDetail;
};

/* -------------------------------------------------------------------------- */
/* Asset bodies                                                               */
/* -------------------------------------------------------------------------- */

const assetBaseFields = {
  name: labelSchema,
  institution: optionalLabelSchema,
  /**
   * The flag the entire nomination dashboard hangs on. It defaults to *false* deliberately:
   * an unset nomination is the common, dangerous case, and defaulting to "registered" would
   * make the dashboard report a safety the household does not have.
   */
  nomineeRegistered: z.boolean().default(false),
  ownershipBps: bpsSchema.default(10_000),
  jointWith: optionalLabelSchema,
  status: assetStatusSchema.default('active'),
  openedOn: isoDateSchema.optional(),
  closedOn: isoDateSchema.optional(),
  tags: tagsSchema.default([]),
  notes: notesSchema.optional(),
};

/**
 * Create an asset: base fields, the matching detail, and optionally what it is worth today.
 *
 * `valuePaise` is a convenience that writes the first `valuations` row in the same
 * transaction — an asset created without a value would otherwise be invisible on the
 * dashboard until someone remembered to value it.
 */
const openingValueFields = {
  valuePaise: paiseSchema.optional(),
  valueAsOf: isoDateSchema.optional(),
};

/**
 * Written out one member at a time rather than mapped over `ASSET_TYPES`: a mapped union
 * infers `detail` as "one of the nine detail types" for every member, which is exactly the
 * pairing this union exists to enforce.
 */
export const createAssetSchema = z.discriminatedUnion('type', [
  z.object({
    ...assetBaseFields,
    ...openingValueFields,
    type: z.literal('bank_account'),
    detail: bankAccountDetailSchema,
  }),
  z.object({
    ...assetBaseFields,
    ...openingValueFields,
    type: z.literal('deposit'),
    detail: depositDetailSchema,
  }),
  z.object({
    ...assetBaseFields,
    ...openingValueFields,
    type: z.literal('holding'),
    detail: holdingDetailSchema,
  }),
  z.object({
    ...assetBaseFields,
    ...openingValueFields,
    type: z.literal('insurance_policy'),
    detail: insurancePolicyDetailSchema,
  }),
  z.object({
    ...assetBaseFields,
    ...openingValueFields,
    type: z.literal('property'),
    detail: propertyDetailSchema,
  }),
  z.object({
    ...assetBaseFields,
    ...openingValueFields,
    type: z.literal('retirement_account'),
    detail: retirementAccountDetailSchema,
  }),
  z.object({
    ...assetBaseFields,
    ...openingValueFields,
    type: z.literal('precious_metal'),
    detail: preciousMetalDetailSchema,
  }),
  z.object({
    ...assetBaseFields,
    ...openingValueFields,
    type: z.literal('other_asset'),
    detail: otherAssetDetailSchema,
  }),
  z.object({
    ...assetBaseFields,
    ...openingValueFields,
    type: z.literal('liability'),
    detail: liabilityDetailSchema,
  }),
]);
export type CreateAssetBody = z.infer<typeof createAssetSchema>;

/**
 * Update the base row. The detail half is parsed separately, against the schema for the
 * type already stored — `type` is not updatable, because changing it would orphan one
 * detail row and require inventing another.
 */
export const updateAssetSchema = z.object({
  name: labelSchema.optional(),
  institution: optionalLabelSchema,
  nomineeRegistered: z.boolean().optional(),
  ownershipBps: bpsSchema.optional(),
  jointWith: optionalLabelSchema,
  status: assetStatusSchema.optional(),
  openedOn: isoDateSchema.optional(),
  closedOn: isoDateSchema.optional(),
  tags: tagsSchema.optional(),
  notes: notesSchema.optional(),
  /** Partial detail, validated by the server against the stored type. */
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateAssetBody = z.infer<typeof updateAssetSchema>;

/** List filters. Everything is optional; the default is "my active assets, newest first". */
export const assetQuerySchema = z.object({
  type: assetTypeSchema.optional(),
  status: assetStatusSchema.optional(),
  /** Free-text over name and institution. */
  q: z.string().trim().max(120).optional(),
  tag: z.string().trim().max(30).optional(),
  nomineeRegistered: z.stringbool().optional(),
  sort: z.enum(['created', 'name', 'value']).default('created'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type AssetQuery = z.infer<typeof assetQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Transactions and valuations                                                */
/* -------------------------------------------------------------------------- */

export const createTransactionSchema = z
  .object({
    date: isoDateSchema,
    type: transactionTypeSchema,
    /** Signed: a `sell` carries negative units. Absent for cash-only movements. */
    units: microSchema.optional(),
    amountPaise: paiseSchema,
    priceMicro: positiveMicroSchema.optional(),
    chargesPaise: nonNegativePaiseSchema.default(0),
    notes: notesSchema.optional(),
  })
  .refine((t) => t.type !== 'buy' || (t.units ?? 0) > 0, {
    message: 'A buy needs a positive number of units',
    path: ['units'],
  })
  .refine((t) => t.type !== 'sell' || (t.units ?? 0) < 0, {
    // Sign, not the type name, is what the cost-basis and XIRR maths reads.
    message: 'A sell needs a negative number of units',
    path: ['units'],
  });
export type CreateTransactionBody = z.infer<typeof createTransactionSchema>;

/**
 * Fill in the instalments of a standing monthly instruction that were never typed in.
 *
 * A SIP running for four years is forty-eight identical `sip` rows, and nobody enters those
 * by hand — so without this the honest thing to record is one lump sum, which prices every
 * instalment as if it were paid on the first day and reports an XIRR that is simply wrong.
 * The window is closed at both ends and the instalment amount is one number, because a SIP
 * whose amount changed half way through is two backfills, not a schedule with a history.
 */
export const backfillSipSchema = z
  .object({
    /** The instalment, not the total: what leaves the bank each month. */
    amountPaise: nonNegativePaiseSchema.refine((value) => value > 0, 'Enter the monthly amount'),
    /** Capped at 28 so the date exists in February, same as `sipDay`. */
    day: z.number().int().min(1).max(28),
    from: isoDateSchema,
    /** Defaults to today on the server, which is the common case for a running SIP. */
    to: isoDateSchema.optional(),
    chargesPaise: nonNegativePaiseSchema.default(0),
  })
  .refine((body) => body.to === undefined || body.to >= body.from, {
    message: 'The end date cannot be before the start',
    path: ['to'],
  });
export type BackfillSipBody = z.infer<typeof backfillSipSchema>;

export const updateTransactionSchema = z.object({
  date: isoDateSchema.optional(),
  type: transactionTypeSchema.optional(),
  units: microSchema.optional(),
  amountPaise: paiseSchema.optional(),
  priceMicro: positiveMicroSchema.optional(),
  chargesPaise: nonNegativePaiseSchema.optional(),
  notes: notesSchema.optional(),
});
export type UpdateTransactionBody = z.infer<typeof updateTransactionSchema>;

/**
 * Append a valuation.
 *
 * There is no update or delete counterpart, by design: `valuations` is the history the net
 * worth chart is drawn from, and a correction is a new row, not an edit to the past.
 */
export const createValuationSchema = z.object({
  asOf: isoDateSchema,
  valuePaise: paiseSchema,
  /** Clients may only claim `manual`; the providers set the rest server-side. */
  source: z.literal('manual').default('manual'),
  notes: notesSchema.optional(),
});
export type CreateValuationBody = z.infer<typeof createValuationSchema>;

/* -------------------------------------------------------------------------- */
/* Instruments                                                                */
/* -------------------------------------------------------------------------- */

export const createInstrumentSchema = z
  .object({
    kind: z.enum(INSTRUMENT_KINDS),
    name: labelSchema,
    /** AMFI's scheme code is the join key for the NAV import in P7. */
    amfiSchemeCode: z
      .string()
      .trim()
      .regex(/^\d{4,8}$/, 'AMFI scheme codes are digits')
      .optional(),
    isin: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/, 'ISIN looks like INF204K01K15')
      .optional(),
    symbol: z.string().trim().toUpperCase().max(30).optional(),
    exchange: z.enum(['nse', 'bse', 'none']).default('none'),
    amc: optionalLabelSchema,
    category: optionalLabelSchema,
  })
  .refine((i) => i.amfiSchemeCode !== undefined || i.isin !== undefined || i.symbol !== undefined, {
    // An instrument nothing can be looked up by is one no price provider will ever refresh.
    message: 'Give at least one of AMFI code, ISIN or symbol',
    path: ['amfiSchemeCode'],
  });
export type CreateInstrumentBody = z.infer<typeof createInstrumentSchema>;

export const instrumentQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  kind: z.enum(INSTRUMENT_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type InstrumentQuery = z.infer<typeof instrumentQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Response shapes                                                            */
/* -------------------------------------------------------------------------- */

export interface AssetSummary {
  id: string;
  ownerUserId: string;
  type: AssetType;
  name: string;
  institution: string | null;
  nomineeRegistered: boolean;
  ownershipBps: number;
  jointWith: string | null;
  status: AssetStatus;
  openedOn: string | null;
  closedOn: string | null;
  tags: string[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  /** Most recent `valuations` row, or null for an asset nobody has valued yet. */
  latestValue: { valuePaise: number; asOf: string; source: ValuationSource } | null;
  /** True when this row belongs to someone else and is visible through a grant. */
  shared: boolean;
}

export interface AssetRecord<T extends AssetType = AssetType> extends AssetSummary {
  type: T;
  detail: AssetDetail[T];
}

export interface TransactionRecord {
  id: string;
  assetId: string;
  date: string;
  type: TransactionType;
  units: number | null;
  amountPaise: number;
  priceMicro: number | null;
  chargesPaise: number;
  notes: string | null;
  createdAt: string;
}

export interface ValuationRecord {
  id: string;
  assetId: string;
  asOf: string;
  valuePaise: number;
  source: ValuationSource;
  notes: string | null;
  createdAt: string;
}

export interface InstrumentRecord {
  id: string;
  kind: (typeof INSTRUMENT_KINDS)[number];
  name: string;
  amfiSchemeCode: string | null;
  isin: string | null;
  symbol: string | null;
  exchange: string;
  amc: string | null;
  category: string | null;
  latestPrice: { priceMicro: number; date: string; source: ValuationSource } | null;
}
