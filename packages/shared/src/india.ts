/**
 * India-specific contracts, rates and classification.
 *
 * `docs/INDIA-NOTES.md` is the prose; this is the executable half of it. Three features
 * live here, and they are together because they share one thing — the Indian financial
 * year — and because a household reads them in one sitting: *what have I not nominated,
 * what is due next, and what will this cost me in tax.*
 *
 * ### Everything here is an estimate, and says so
 *
 * Not a disclaimer bolted on for safety. Tax rates change with every Budget, thresholds
 * differ by regime and by age, and this application does not know somebody's slab, their
 * residency, or whose name a health policy is in. What it *can* do is arithmetic on the
 * portfolio it holds and show its working, which is enough to answer "should I sell this
 * before or after March" and nowhere near enough to file a return on. Every response
 * carries the rates it used and the financial year it used them for, so the numbers can be
 * checked rather than believed.
 *
 * ### Rates live in one table per financial year
 *
 * As INDIA-NOTES.md promises: "rates and thresholds are kept in one configuration module
 * per FY so a Budget change is a data edit rather than a code change". {@link TAX_RATES} is
 * that module. A year with no entry uses the most recent one that is not in the future, and
 * the response says it did — so the February after a Budget shows figures that are visibly
 * last year's rather than silently wrong ones.
 */

import { z } from 'zod';
import { isoDateSchema, type AssetType } from './assets.js';
import type { AssetClass } from './analytics.js';
import type { Paise } from './money.js';

/* -------------------------------------------------------------------------- */
/* Rates                                                                      */
/* -------------------------------------------------------------------------- */

export interface TaxRates {
  /** The April this set took effect in. */
  fyStartYear: number;
  /** Long-term capital gains on listed equity and equity mutual funds. */
  ltcgEquityRateBps: number;
  /** The annual exemption applied to equity LTCG before any tax is due. */
  ltcgEquityExemptPaise: Paise;
  stcgEquityRateBps: number;
  /** Property, gold, unlisted shares: long-term, without indexation since July 2024. */
  ltcgOtherRateBps: number;
  section80CLimitPaise: Paise;
  /** Health premium for self, spouse and children. */
  section80DSelfPaise: Paise;
  /** The same, when the eldest insured is a senior citizen. */
  section80DSelfSeniorPaise: Paise;
  /** Bank and post-office interest, above which the payer deducts TDS. */
  fdTdsThresholdPaise: Paise;
  fdTdsThresholdSeniorPaise: Paise;
  fdTdsRateBps: number;
  /** Below which a PPF account is treated as dormant for the year. */
  ppfMinimumPaise: Paise;
  ssyMinimumPaise: Paise;
}

/**
 * Rates by financial year, oldest first.
 *
 * Two entries, and the gap between them is the point: FY 2024-25 is when the Budget of July
 * 2024 reset the capital-gains regime — 12.5% long-term across the board with no indexation,
 * 20% short-term on equity, and a ₹1.25 lakh exemption. FY 2025-26 raised the TDS thresholds
 * on interest. Anything earlier is deliberately absent rather than guessed at: this
 * application was written after both, and a table claiming to know FY 2019-20's rules would
 * be inventing them.
 *
 * The mid-year boundary in FY 2024-25 (the old regime applied until 22 July 2024) is not
 * modelled. These figures value *unrealized* positions as of today, so the rate that matters
 * is the one in force now, and a household selling into the old regime has already sold.
 */
export const TAX_RATES: readonly TaxRates[] = [
  {
    fyStartYear: 2024,
    ltcgEquityRateBps: 1_250,
    ltcgEquityExemptPaise: 1_25_000_00,
    stcgEquityRateBps: 2_000,
    ltcgOtherRateBps: 1_250,
    section80CLimitPaise: 1_50_000_00,
    section80DSelfPaise: 25_000_00,
    section80DSelfSeniorPaise: 50_000_00,
    fdTdsThresholdPaise: 40_000_00,
    fdTdsThresholdSeniorPaise: 50_000_00,
    fdTdsRateBps: 1_000,
    ppfMinimumPaise: 500_00,
    ssyMinimumPaise: 250_00,
  },
  {
    fyStartYear: 2025,
    ltcgEquityRateBps: 1_250,
    ltcgEquityExemptPaise: 1_25_000_00,
    stcgEquityRateBps: 2_000,
    ltcgOtherRateBps: 1_250,
    section80CLimitPaise: 1_50_000_00,
    section80DSelfPaise: 25_000_00,
    section80DSelfSeniorPaise: 50_000_00,
    // Raised by the Budget of February 2025, from ₹40,000 and ₹50,000.
    fdTdsThresholdPaise: 50_000_00,
    fdTdsThresholdSeniorPaise: 1_00_000_00,
    fdTdsRateBps: 1_000,
    ppfMinimumPaise: 500_00,
    ssyMinimumPaise: 250_00,
  },
];

/**
 * The rates for a financial year, and whether they are really that year's.
 *
 * `carriedForward` is true when the table has nothing for the year asked about and the most
 * recent earlier entry was used instead. The UI shows that as "using FY 2025-26 rates",
 * which is the honest thing to say in the months after a Budget nobody has encoded yet.
 */
export function taxRatesFor(fyStartYear: number): { rates: TaxRates; carriedForward: boolean } {
  const applicable = TAX_RATES.filter((entry) => entry.fyStartYear <= fyStartYear);
  const rates = applicable.at(-1) ?? TAX_RATES[0]!;
  return { rates, carriedForward: rates.fyStartYear !== fyStartYear };
}

/**
 * Debt mutual funds bought on or after this date are taxed at slab, whatever the holding
 * period, with no indexation. Before it, the old long-term treatment survives — which is
 * why the purchase date has to be modelled rather than assumed.
 */
export const DEBT_MF_SLAB_FROM = '2023-04-01';

/* -------------------------------------------------------------------------- */
/* Capital gains                                                              */
/* -------------------------------------------------------------------------- */

/**
 * How a gain is taxed.
 *
 * `slab` is not a rate this application can apply — it depends on income it has never been
 * told — so those entries report the gain and leave the tax null rather than inventing a
 * number. That is the difference between a useful estimate and a misleading one.
 */
export const GAIN_TREATMENTS = [
  'equity_ltcg',
  'equity_stcg',
  'other_ltcg',
  'other_stcg',
  'slab',
  'exempt',
] as const;
export type GainTreatment = (typeof GAIN_TREATMENTS)[number];

export const GAIN_TREATMENT_LABELS: Record<GainTreatment, string> = {
  equity_ltcg: 'Equity, long term',
  equity_stcg: 'Equity, short term',
  other_ltcg: 'Long term',
  other_stcg: 'Short term',
  slab: 'Taxed at your slab',
  exempt: 'Exempt',
};

/** What the treatment rules need to know about a position. */
export interface TaxableHolding {
  assetType: AssetType;
  assetClass: AssetClass;
  /** A holding's instrument kind, when there is one. */
  instrumentKind?: 'mf' | 'equity' | 'etf' | 'bond' | null;
  /** When it was bought — the earliest cashflow, or the day the record opened. */
  acquiredOn: string;
  /** Whole months held, computed by the caller against the reporting date. */
  monthsHeld: number;
}

/**
 * Which bucket a gain falls in.
 *
 * The rules, in the order they actually apply:
 *
 *   - **Sovereign gold bonds held to maturity are exempt.** The one genuinely tax-free
 *     capital gain an ordinary household holds, and worth saying out loud because most
 *     people do not know it.
 *   - **A debt fund bought since April 2023 is slab income**, whatever the holding period.
 *   - **Equity and equity funds turn long-term at twelve months**; everything else at
 *     twenty-four.
 *   - **EPF, PPF, SSY and insurance are not capital gains at all.** Their maturity proceeds
 *     are exempt under the sections that govern them, so they are excluded rather than
 *     reported as a zero.
 */
export function treatmentFor(holding: TaxableHolding): GainTreatment {
  if (holding.assetType === 'precious_metal') {
    // Only an SGB is exempt, and only on redemption; the caller flags that by classifying
    // physical gold and jewellery the same way it always has.
    return holding.monthsHeld >= 24 ? 'other_ltcg' : 'other_stcg';
  }

  if (
    holding.assetType === 'deposit' ||
    holding.assetType === 'retirement_account' ||
    holding.assetType === 'insurance_policy' ||
    holding.assetType === 'bank_account'
  ) {
    // Interest, not gain. It is income taxed as it accrues, which the interest section of
    // the report handles; counting it here would tax the same rupee twice.
    return 'exempt';
  }

  const isEquityFund = holding.instrumentKind === 'mf' && holding.assetClass === 'equity';
  const isListedEquity = holding.instrumentKind === 'equity' || holding.instrumentKind === 'etf';

  if (holding.assetClass === 'debt' && holding.instrumentKind === 'mf') {
    return holding.acquiredOn >= DEBT_MF_SLAB_FROM ? 'slab' : 'other_ltcg';
  }

  if (isEquityFund || isListedEquity || holding.assetClass === 'equity') {
    return holding.monthsHeld >= 12 ? 'equity_ltcg' : 'equity_stcg';
  }

  return holding.monthsHeld >= 24 ? 'other_ltcg' : 'other_stcg';
}

/** The rate a treatment attracts, or null where this application cannot know it. */
export function rateForTreatment(treatment: GainTreatment, rates: TaxRates): number | null {
  switch (treatment) {
    case 'equity_ltcg':
      return rates.ltcgEquityRateBps;
    case 'equity_stcg':
      return rates.stcgEquityRateBps;
    case 'other_ltcg':
      return rates.ltcgOtherRateBps;
    // Short-term on anything but equity, and debt fund gains, are added to income.
    case 'other_stcg':
    case 'slab':
    case 'exempt':
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Section 80C and 80D                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Where an 80C rupee came from.
 *
 * Only the sources this application can see. Tuition fees, stamp duty on a house purchase
 * and five-year tax-saver FDs are all eligible and none of them is modelled here, which is
 * why the bucket reports what it found rather than claiming to be complete.
 */
export const DEDUCTION_SOURCES = [
  'ppf',
  'ssy',
  'nsc',
  'elss',
  'life_insurance',
  'home_loan_principal',
  'epf',
] as const;
export type DeductionSource = (typeof DEDUCTION_SOURCES)[number];

export const DEDUCTION_SOURCE_LABELS: Record<DeductionSource, string> = {
  ppf: 'PPF contributions',
  ssy: 'Sukanya Samriddhi deposits',
  nsc: 'NSC purchases',
  elss: 'ELSS investments',
  life_insurance: 'Life insurance premium',
  home_loan_principal: 'Home loan principal',
  epf: 'EPF employee contribution',
};

export interface DeductionEntry {
  assetId: string;
  name: string;
  source: DeductionSource;
  amountPaise: Paise;
  /**
   * True when the figure is modelled rather than recorded — a home loan's principal split
   * out of an EMI, or a PPF contribution taken from the schedule because no transaction was
   * entered. The UI marks these, because they are the ones worth checking against a
   * statement before anybody files anything.
   */
  estimated: boolean;
}

/* -------------------------------------------------------------------------- */
/* Nomination hygiene                                                         */
/* -------------------------------------------------------------------------- */

export interface NominationProcedure {
  /** Who registers the nomination — not always who holds the asset. */
  authority: string;
  /** What to actually do, in order, in the words the institution uses. */
  steps: string[];
}

/**
 * How to register a nomination, per asset type.
 *
 * The claim kit in `estate.ts` tells an heir how to claim; this tells the owner how to make
 * that claim easy, and it is the cheaper half by an enormous margin. Registering a nominee
 * is free and takes minutes at every institution below. Not doing it is what turns an estate
 * into a succession-certificate case, which is measured in years.
 */
export const NOMINATION_PROCEDURES: Record<AssetType, NominationProcedure> = {
  bank_account: {
    authority: 'The branch, or net banking',
    steps: [
      'Open net banking or the bank app and look for "Nomination" under service requests.',
      'Or submit Form DA-1 at the branch with the nominee’s name, date of birth and address.',
      'Ask for the acknowledgement and check the passbook — a registered nomination is printed on it.',
    ],
  },
  deposit: {
    authority: 'The issuing bank, or the post office for small savings',
    steps: [
      'A deposit does not inherit the nomination on the savings account it was funded from — register it separately.',
      'Bank deposits: Form DA-1 at the branch.',
      'Post office (NSC, KVP, MIS, SCSS, PPF, SSY): Form SB-84 at the office holding the account.',
    ],
  },
  holding: {
    authority: 'The RTA for funds, the depository participant for shares',
    steps: [
      'Mutual funds: register per folio at CAMS or KFintech online, or through the AMC’s own portal.',
      'Demat: submit the DP’s nomination form, or complete it online — SEBI requires every account to either nominate or record an opt-out.',
      'A folio can carry up to three nominees with a percentage each; unspecified shares default to equal.',
    ],
  },
  insurance_policy: {
    authority: 'The insurer',
    steps: [
      'Submit the insurer’s nomination change form with the policy document.',
      'Ask for the endorsement — a nomination is only registered once it is endorsed on the policy.',
      'Under section 39, a beneficial nominee (spouse, child, parent) receives the proceeds as owner rather than as trustee.',
    ],
  },
  property: {
    authority: 'The society or the sub-registrar; a will does the real work',
    steps: [
      'A co-operative housing society records a nominee for the share certificate — file the society’s nomination form.',
      'Land and independent houses have no nomination register. A registered will, and joint ownership, are what make transmission straightforward.',
      'Keep the sale deed, khata or patta and the latest tax receipt together — an heir needs all three.',
    ],
  },
  retirement_account: {
    authority: 'EPFO for EPF, the CRA for NPS',
    steps: [
      'EPF: file the e-nomination on the EPFO member portal — it needs an Aadhaar-linked UAN and takes about ten minutes.',
      'NPS: update the nomination in the CRA portal, or through the point of presence. Tier I and Tier II are nominated separately.',
      'EPF nomination also decides who receives the pension and the EDLI insurance, which is why it matters more than most.',
    ],
  },
  precious_metal: {
    authority: 'The issuer, for anything held in an account',
    steps: [
      'Sovereign gold bonds: nominate through the demat account or with the receiving office if held in RBI records.',
      'Digital gold: the platform’s own nomination, if it offers one.',
      'Physical gold has no register. Record where it is kept in the vault, and name it in a will.',
    ],
  },
  other_asset: {
    authority: 'Varies — most of these have no register at all',
    steps: [
      'Crypto, chit funds and money lent to relatives cannot be nominated. A will is the only instrument that works.',
      'Vehicles: transfer relies on Form 31 and the RC; keep the papers with the estate documents.',
      'Record the details in the vault so an heir knows the asset exists — for these, that is most of the battle.',
    ],
  },
  liability: {
    authority: 'Not applicable',
    steps: [
      'A loan is not nominated. It is a claim against the estate, and heirs inherit the debt with the asset.',
      'Check whether the loan carries credit life insurance — many home loans do, and it repays the balance on death.',
    ],
  },
};

/* -------------------------------------------------------------------------- */
/* Calendar                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What kind of thing is due.
 *
 * Ordered by how much it costs to miss: a lapsed policy and a dormant PPF account are
 * expensive mistakes made by forgetting, which is precisely what a calendar is for.
 */
export const CALENDAR_KINDS = [
  'deposit_maturity',
  'ppf_minimum',
  'ssy_minimum',
  'insurance_premium',
  'rd_installment',
  'sip_debit',
  'emi_due',
  'loan_ends',
  'sgb_interest',
  'sgb_maturity',
  'fy_end',
] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];

export const CALENDAR_KIND_LABELS: Record<CalendarKind, string> = {
  deposit_maturity: 'Deposit matures',
  ppf_minimum: 'PPF minimum deposit',
  ssy_minimum: 'SSY minimum deposit',
  insurance_premium: 'Premium due',
  rd_installment: 'RD instalment',
  sip_debit: 'SIP debit',
  emi_due: 'EMI due',
  loan_ends: 'Loan ends',
  sgb_interest: 'SGB interest',
  sgb_maturity: 'SGB matures',
  fy_end: 'Financial year ends',
};

/** How much it costs to miss this one. Drives nothing but the colour of a dot. */
export type CalendarSeverity = 'info' | 'action' | 'critical';

export interface CalendarEvent {
  date: string;
  kind: CalendarKind;
  title: string;
  /** Null for events that belong to the year rather than to an asset. */
  assetId: string | null;
  assetName: string | null;
  /** What lands or is owed on the day, where that is knowable. */
  amountPaise: Paise | null;
  severity: CalendarSeverity;
  /** Why this matters, in one line, for the household that has never met this rule. */
  note?: string;
}

/* -------------------------------------------------------------------------- */
/* Response shapes                                                            */
/* -------------------------------------------------------------------------- */

export interface NominationEntry {
  assetId: string;
  name: string;
  type: AssetType;
  institution: string | null;
  valuePaise: Paise;
  procedure: NominationProcedure;
}

export interface NominationReport {
  asOf: string;
  /** Every asset, so "7 of 23" can be stated rather than implied. */
  totalAssets: number;
  nominatedCount: number;
  /** Assets with no registered nomination, largest first. */
  atRisk: NominationEntry[];
  atRiskPaise: Paise;
  coveredPaise: Paise;
  /** Where the unnominated value sits, so a single afternoon can fix the worst of it. */
  byInstitution: Array<{ institution: string; count: number; valuePaise: Paise }>;
}

export interface CalendarResponse {
  from: string;
  to: string;
  events: CalendarEvent[];
}

export interface GainEntry {
  assetId: string;
  name: string;
  assetClass: AssetClass;
  acquiredOn: string;
  monthsHeld: number;
  treatment: GainTreatment;
  investedPaise: Paise;
  valuePaise: Paise;
  gainPaise: Paise;
}

export interface GainBucket {
  treatment: GainTreatment;
  gainPaise: Paise;
  /** After the annual exemption, where one applies. */
  taxablePaise: Paise;
  rateBps: number | null;
  /** Null where the rate depends on a slab this application does not know. */
  estimatedTaxPaise: Paise | null;
  assetCount: number;
}

export interface InterestEntry {
  assetId: string;
  name: string;
  institution: string | null;
  accruedPaise: Paise;
  kind: string;
  /** True for PPF and SSY, whose interest is exempt under section 10. */
  exempt: boolean;
}

/**
 * Interest income for the year, grouped the way TDS is actually applied — per payer.
 *
 * The threshold is per bank, not per deposit and not per household, which is exactly the
 * detail that surprises people holding four FDs at one branch.
 */
export interface InterestReport {
  /** Everything that accrued, exempt interest included. */
  totalAccruedPaise: Paise;
  /**
   * The part that is actually income.
   *
   * PPF and SSY interest is exempt under section 10, so leading with the gross figure would
   * put a number on screen that nobody owes tax on directly above a per-payer breakdown that
   * excludes it — two totals that do not reconcile, on a tax page. This is the one the UI
   * leads with; the exempt remainder is stated separately rather than hidden.
   */
  taxableAccruedPaise: Paise;
  exemptAccruedPaise: Paise;
  entries: InterestEntry[];
  byPayer: Array<{
    institution: string;
    accruedPaise: Paise;
    thresholdPaise: Paise;
    crossesThreshold: boolean;
    estimatedTdsPaise: Paise;
  }>;
  /** True when any payer crosses, which is when Form 15G or 15H becomes worth filing. */
  form15Advisable: boolean;
}

export interface DeductionBucket {
  section: '80C' | '80D';
  limitPaise: Paise;
  claimedPaise: Paise;
  /** What is left before the limit, floored at zero. */
  headroomPaise: Paise;
  entries: DeductionEntry[];
}

export interface FinancialYearReport {
  financialYear: { label: string; assessmentYear: string; start: string; end: string };
  asOf: string;
  daysLeft: number;
  rates: TaxRates;
  /** True when the rates are carried forward from an earlier year — say so in the UI. */
  ratesCarriedForward: boolean;
  gains: { entries: GainEntry[]; buckets: GainBucket[]; estimatedTaxPaise: Paise };
  interest: InterestReport;
  deductions: DeductionBucket[];
}

/* -------------------------------------------------------------------------- */
/* Query contracts                                                            */
/* -------------------------------------------------------------------------- */

/** Ninety days, per PLAN.md. A quarter is far enough to act and near enough to care. */
export const DEFAULT_CALENDAR_DAYS = 90;

export const calendarQuerySchema = z.object({
  from: isoDateSchema.optional(),
  days: z.coerce.number().int().min(1).max(400).default(DEFAULT_CALENDAR_DAYS),
});
export type CalendarQuery = z.infer<typeof calendarQuerySchema>;

export const nominationQuerySchema = z.object({
  asOf: isoDateSchema.optional(),
});
export type NominationQuery = z.infer<typeof nominationQuerySchema>;

export const financialYearQuerySchema = z.object({
  /** The April the year starts in. Defaults to the one we are in. */
  fy: z.coerce.number().int().min(2000).max(2100).optional(),
  asOf: isoDateSchema.optional(),
  /** Raises the 80D limit and the TDS threshold. The app cannot know it, so it is asked. */
  senior: z.stringbool().default(false),
});
export type FinancialYearQuery = z.infer<typeof financialYearQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Pool gains into buckets and apply the annual exemption.
 *
 * The exemption is a property of the *year*, not of a holding: ₹1.25 lakh of equity
 * long-term gain is free across the whole portfolio, once. Applying it per asset — which is
 * the obvious mistake — would under-report the tax of anybody holding more than one fund.
 *
 * Losses inside a bucket net against gains in the same bucket, which is what set-off does.
 * Losses carried across buckets, or across years, are not modelled: that depends on what was
 * realised and when, and this is a report about what is still held.
 */
export function bucketGains(entries: readonly GainEntry[], rates: TaxRates): GainBucket[] {
  const pooled = new Map<GainTreatment, { gainPaise: number; assetCount: number }>();

  for (const entry of entries) {
    const bucket = pooled.get(entry.treatment) ?? { gainPaise: 0, assetCount: 0 };
    bucket.gainPaise += entry.gainPaise;
    bucket.assetCount += 1;
    pooled.set(entry.treatment, bucket);
  }

  return [...pooled.entries()]
    .map(([treatment, bucket]) => {
      const exemption = treatment === 'equity_ltcg' ? rates.ltcgEquityExemptPaise : 0;
      const taxablePaise = Math.max(0, bucket.gainPaise - exemption);
      const rateBps = rateForTreatment(treatment, rates);

      return {
        treatment,
        gainPaise: bucket.gainPaise,
        taxablePaise,
        rateBps,
        estimatedTaxPaise: rateBps === null ? null : Math.round((taxablePaise * rateBps) / 10_000),
        assetCount: bucket.assetCount,
      };
    })
    .sort((a, b) => b.gainPaise - a.gainPaise);
}

/**
 * What a deposit's interest attracts in TDS.
 *
 * TDS is deducted on the *whole* interest once the threshold is crossed, not on the excess —
 * a detail that makes the difference between a ₹0 deduction and a ₹5,100 one on either side
 * of a rupee, and the reason Form 15G and 15H exist at all.
 */
export function estimateTds(accruedPaise: Paise, thresholdPaise: Paise, rateBps: number): Paise {
  if (accruedPaise <= thresholdPaise) return 0;
  return Math.round((accruedPaise * rateBps) / 10_000);
}
