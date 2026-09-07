/**
 * What each asset type asks for, and how to get it in and out of a form.
 *
 * A form field is a string; the API takes integer paise, basis points and millionths. This
 * module is the one place that conversion happens, in both directions, so a create form and
 * an edit form cannot disagree about what "7.1" means.
 *
 * The specs are data rather than JSX because the nine forms differ only in their fields.
 * The alternative — nine hand-written forms — is nine places to forget that a rate is
 * stored in basis points.
 */

import {
  AREA_UNITS,
  BANK_ACCOUNT_TYPES,
  COMPOUNDING_FREQUENCIES,
  DEPOSIT_KINDS,
  INSURANCE_KINDS,
  LIABILITY_KINDS,
  METALS,
  METAL_FORMS,
  MICRO,
  NPS_TIERS,
  OTHER_ASSET_KINDS,
  PAYOUT_MODES,
  PREMIUM_FREQUENCIES,
  PROPERTY_KINDS,
  RETIREMENT_KINDS,
  fromMicro,
  parseAmount,
  toMicro,
  type AssetType,
} from '@networth/shared';

/**
 * How a value is carried between the input and the wire.
 *
 * `money`, `rate`, `micro` and `grams` all render as a plain number and store as a scaled
 * integer — which is exactly the confusion this type exists to make impossible.
 */
export type FieldKind =
  'text' | 'date' | 'money' | 'rate' | 'micro' | 'grams' | 'integer' | 'boolean' | 'select';

export interface FieldSpec {
  name: string;
  label: string;
  kind: FieldKind;
  options?: readonly string[];
  hint?: string;
  required?: boolean;
  /** Only shown when the detail's discriminator matches — SGB dates, NPS tiers. */
  onlyWhen?: { field: string; equals: readonly string[] };
}

const t = (name: string, label: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({
  name,
  label,
  kind: 'text',
  ...extra,
});

const select = (
  name: string,
  label: string,
  options: readonly string[],
  extra: Partial<FieldSpec> = {},
): FieldSpec => ({ name, label, kind: 'select', options, required: true, ...extra });

const money = (name: string, label: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({
  name,
  label,
  kind: 'money',
  hint: '₹5,00,000 · 12.5L · 1.2 Cr',
  ...extra,
});

const rate = (name: string, label: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({
  name,
  label,
  kind: 'rate',
  hint: 'Per cent a year, e.g. 7.1',
  ...extra,
});

const date = (name: string, label: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({
  name,
  label,
  kind: 'date',
  ...extra,
});

/** The masked-number hint appears wherever an account or policy number is asked for. */
const MASKED = 'Stored masked — only the last four digits are kept.';

export const DETAIL_FIELDS: Record<AssetType, FieldSpec[]> = {
  bank_account: [
    select('accountType', 'Account type', BANK_ACCOUNT_TYPES),
    t('accountNumber', 'Account number', { hint: MASKED }),
    t('ifsc', 'IFSC', { hint: 'Eleven characters, like HDFC0001234' }),
    t('branch', 'Branch'),
    t('cif', 'Customer ID', { hint: MASKED }),
  ],

  deposit: [
    select('kind', 'Scheme', DEPOSIT_KINDS),
    t('accountNumber', 'Account number', { hint: MASKED }),
    money('principalPaise', 'Principal', { required: true }),
    money('installmentPaise', 'Recurring instalment', {
      hint: 'For an RD, PPF or SSY. Leave blank for a one-off deposit.',
    }),
    rate('rateBps', 'Interest rate', { required: true }),
    select('compounding', 'Compounding', COMPOUNDING_FREQUENCIES),
    select('payoutMode', 'Interest', PAYOUT_MODES, {
      hint: 'MIS and SCSS pay interest out; everything else compounds it.',
    }),
    date('startedOn', 'Opened on', { required: true }),
    date('maturesOn', 'Matures on'),
    { name: 'autoRenew', label: 'Renews automatically on maturity', kind: 'boolean' },
  ],

  holding: [
    // The instrument is picked with a search box rather than typed, so it is not a spec.
    { name: 'units', label: 'Units', kind: 'micro', required: true, hint: 'Up to six decimals' },
    { name: 'avgCostMicro', label: 'Average cost per unit', kind: 'micro', hint: 'In rupees' },
    t('folioNumber', 'Folio number', { hint: MASKED }),
    t('dematAccount', 'Demat account', { hint: MASKED }),
    money('sipAmountPaise', 'SIP amount'),
    { name: 'sipDay', label: 'SIP date', kind: 'integer', hint: '1–28' },
  ],

  insurance_policy: [
    t('insurer', 'Insurer', { required: true }),
    select('kind', 'Kind', INSURANCE_KINDS),
    t('plan', 'Plan'),
    t('policyNumber', 'Policy number', { hint: MASKED }),
    money('sumAssuredPaise', 'Sum assured', { required: true }),
    money('premiumPaise', 'Premium', { required: true }),
    select('premiumFrequency', 'Paid', PREMIUM_FREQUENCIES),
    date('nextDueOn', 'Next due'),
    date('startedOn', 'Started'),
    date('maturesOn', 'Matures'),
  ],

  property: [
    select('kind', 'Kind', PROPERTY_KINDS),
    t('address', 'Address'),
    // Bureaucratic clutter until somebody has to trace a title with it.
    t('surveyNumber', 'Survey number'),
    t('khataNumber', 'Khata number'),
    t('pattaNumber', 'Patta number'),
    t('registrationDocNumber', 'Registration document'),
    t('subRegistrarOffice', 'Sub-registrar office'),
    { name: 'areaMicro', label: 'Area', kind: 'micro' },
    select('areaUnit', 'Measured in', AREA_UNITS),
    money('guidelineValuePaise', 'Guideline value', {
      hint: 'The circle rate stamp duty is charged on, not the market price.',
    }),
    t('coOwners', 'Co-owners'),
  ],

  retirement_account: [
    select('kind', 'Scheme', RETIREMENT_KINDS),
    t('uan', 'UAN', { hint: MASKED, onlyWhen: { field: 'kind', equals: ['epf', 'vpf'] } }),
    t('memberId', 'Member ID', {
      hint: MASKED,
      onlyWhen: { field: 'kind', equals: ['epf', 'vpf'] },
    }),
    t('pran', 'PRAN', { hint: MASKED, onlyWhen: { field: 'kind', equals: ['nps'] } }),
    select('tier', 'Tier', NPS_TIERS, {
      required: false,
      onlyWhen: { field: 'kind', equals: ['nps'] },
    }),
    money('employeeBalancePaise', 'Employee balance'),
    money('employerBalancePaise', 'Employer balance'),
    rate('rateBps', 'Interest rate'),
  ],

  precious_metal: [
    select('metal', 'Metal', METALS),
    select('form', 'Form', METAL_FORMS),
    { name: 'weightMilligrams', label: 'Weight in grams', kind: 'grams', required: true },
    t('purity', 'Purity', { hint: '24K, 22K, 916, 999 — whatever the bill says' }),
    money('makingChargesPaise', 'Making charges'),
    date('sgbMaturesOn', 'Redemption date', { onlyWhen: { field: 'form', equals: ['sgb'] } }),
  ],

  other_asset: [select('kind', 'Kind', OTHER_ASSET_KINDS)],

  liability: [
    select('kind', 'Kind', LIABILITY_KINDS),
    t('lender', 'Lender', { required: true }),
    t('accountNumber', 'Account number', { hint: MASKED }),
    money('principalPaise', 'Sanctioned amount', { required: true }),
    money('outstandingPaise', 'Outstanding', { required: true }),
    rate('rateBps', 'Interest rate', { required: true }),
    money('emiPaise', 'EMI'),
    { name: 'tenureMonths', label: 'Tenure in months', kind: 'integer' },
    date('nextDueOn', 'Next due'),
    date('startedOn', 'Started'),
    date('endsOn', 'Ends'),
  ],
};

/** The long tail is a discriminated union, so its fields depend on the kind chosen. */
export const OTHER_ASSET_FIELDS: Record<string, FieldSpec[]> = {
  crypto: [
    t('symbol', 'Symbol', { required: true }),
    { name: 'quantityMicro', label: 'Quantity', kind: 'micro', required: true },
    t('wallet', 'Wallet'),
  ],
  esop: [
    t('company', 'Company', { required: true }),
    date('grantedOn', 'Granted on'),
    { name: 'grantedUnits', label: 'Options granted', kind: 'micro', required: true },
    { name: 'vestedUnits', label: 'Vested', kind: 'micro' },
    money('strikePaise', 'Strike price'),
  ],
  rsu: [
    t('company', 'Company', { required: true }),
    date('grantedOn', 'Granted on'),
    { name: 'grantedUnits', label: 'Units granted', kind: 'micro', required: true },
    { name: 'vestedUnits', label: 'Vested', kind: 'micro' },
  ],
  chit: [
    t('organiser', 'Organiser', { required: true }),
    money('chitValuePaise', 'Chit value', { required: true }),
    money('monthlyPaise', 'Monthly contribution', { required: true }),
    { name: 'months', label: 'Months', kind: 'integer', required: true },
    date('startedOn', 'Started'),
  ],
  loan_given: [
    t('borrower', 'Borrower', { required: true }),
    money('principalPaise', 'Principal', { required: true }),
    rate('rateBps', 'Interest rate'),
    date('dueOn', 'Due on'),
  ],
  vehicle: [
    t('make', 'Make'),
    t('model', 'Model'),
    t('registrationNumber', 'Registration number'),
    date('purchasedOn', 'Purchased on'),
    money('purchasePaise', 'Purchase price'),
  ],
};

/* -------------------------------------------------------------------------- */
/* Conversion                                                                 */
/* -------------------------------------------------------------------------- */

/** A form value on its way to the API. Returns `undefined` for anything left blank. */
export function encodeField(spec: FieldSpec, raw: string | boolean): unknown {
  if (spec.kind === 'boolean') return raw === true || raw === 'on';

  const value = String(raw).trim();
  if (value === '') return undefined;

  switch (spec.kind) {
    // Accepts what an Indian user actually types: "1,23,456.78", "₹5000", "12.5L".
    case 'money':
      return parseAmount(value);
    // Rates are stored in basis points: 7.1% is 710.
    case 'rate':
      return Math.round(Number(value) * 100);
    case 'micro':
      return toMicro(Number(value));
    case 'grams':
      return Math.round(Number(value) * 1000);
    case 'integer':
      return Math.round(Number(value));
    default:
      return value;
  }
}

/** And on the way back into a form, for editing. */
export function decodeField(spec: FieldSpec, value: unknown): string | boolean {
  if (spec.kind === 'boolean') return value === true;
  if (value === null || value === undefined) return '';

  switch (spec.kind) {
    case 'money':
      return (Number(value) / 100).toString();
    case 'rate':
      return (Number(value) / 100).toString();
    case 'micro':
      return fromMicro(Number(value)).toString();
    case 'grams':
      return (Number(value) / 1000).toString();
    default:
      return String(value);
  }
}

/** Average cost is a per-unit price in micro-rupees; the form asks for it in rupees. */
export const microRupeesFromRupees = (rupees: number): number => Math.round(rupees * MICRO);
