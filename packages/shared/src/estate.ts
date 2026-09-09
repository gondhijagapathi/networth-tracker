/**
 * Estate contracts: nominees, key escrow, the dead-man switch and the claim kit.
 *
 * This is the half of the application that exists because Indian households lose wealth
 * they already own — deposits nobody knew about, shares that drift to the IEPF, policies
 * that lapse unclaimed. Knowing what you own is the first job; this is the second.
 *
 * The escrow schemas describe ciphertext only, exactly as the vault ones do: an owner wraps
 * their data key to a nominee's public key in the browser, and the server stores an opaque
 * blob it cannot open. What the server *does* own is the release decision — which is why
 * every transition here is a state machine with an audit row, rather than a boolean.
 */

import { z } from 'zod';
import { emailSchema } from './auth.js';
import { isoDateSchema } from './assets.js';
import { wrappedKeySchema } from './vault.js';

/* -------------------------------------------------------------------------- */
/* Nominees                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How much of an estate a nominee sees *before* release.
 *
 * `summary` is totals and allocation; `full` is every asset with its detail; `vault` adds
 * the encrypted items — which are still unreadable until an escrow is released, because the
 * access level governs the API and the escrow governs the cryptography. Both must agree
 * before an heir can read a password, and that is on purpose.
 */
export const NOMINEE_ACCESS_LEVELS = ['summary', 'full', 'vault'] as const;
export const nomineeAccessLevelSchema = z.enum(NOMINEE_ACCESS_LEVELS);
export type NomineeAccessLevel = z.infer<typeof nomineeAccessLevelSchema>;

export const NOMINEE_STATUSES = ['invited', 'accepted', 'revoked'] as const;
export const nomineeStatusSchema = z.enum(NOMINEE_STATUSES);
export type NomineeStatus = z.infer<typeof nomineeStatusSchema>;

/** Basis points, so a one-third share is 3333 rather than a float that never sums to 100. */
export const sharePercentBpsSchema = z.coerce
  .number()
  .int('Share must be a whole number of basis points')
  .min(0)
  .max(10_000, 'A share cannot exceed 100%');

export const createNomineeSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  /** Optional until you want them to log in — a nomination can be recorded for anyone. */
  email: emailSchema.optional(),
  relation: z.string().trim().max(40).optional(),
  sharePercentBps: sharePercentBpsSchema.default(0),
  accessLevel: nomineeAccessLevelSchema.default('summary'),
});
export type CreateNomineeBody = z.infer<typeof createNomineeSchema>;

export const updateNomineeSchema = createNomineeSchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });
export type UpdateNomineeBody = z.infer<typeof updateNomineeSchema>;

/** Wrap the owner's data key to this nominee's public key. Browser-side, always. */
export const sealEscrowSchema = z.strictObject({
  /** The DEK under RSA-OAEP with the nominee's public key. Opaque to the server. */
  wrappedDek: wrappedKeySchema,
  /** Fingerprint of the key it was wrapped to, so a rotated key is detectable. */
  publicKeyFingerprint: z.string().trim().min(16).max(128),
});
export type SealEscrowBody = z.infer<typeof sealEscrowSchema>;

export const ESCROW_STATES = ['sealed', 'released', 'revoked'] as const;
export const escrowStateSchema = z.enum(ESCROW_STATES);
export type EscrowState = z.infer<typeof escrowStateSchema>;

/** Why an escrow opened. `owner` is a deliberate act; `deadman` is an absence of one. */
export const ESCROW_RELEASE_REASONS = ['owner', 'deadman'] as const;
export type EscrowReleaseReason = (typeof ESCROW_RELEASE_REASONS)[number];

export interface NomineeRecord {
  id: string;
  name: string;
  email: string | null;
  relation: string | null;
  sharePercentBps: number;
  accessLevel: NomineeAccessLevel;
  status: NomineeStatus;
  /** Set once they have registered and their account is linked to this nomination. */
  nomineeUserId: string | null;
  /** True when that account has set up a vault, so there is a key to wrap to. */
  hasPublicKey: boolean;
  escrow: EscrowSummary | null;
  invitedAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
}

export interface EscrowSummary {
  id: string;
  state: EscrowState;
  releaseReason: EscrowReleaseReason | null;
  publicKeyFingerprint: string;
  createdAt: string;
  releasedAt: string | null;
}

/** One estate an heir has been named in, as the nominee themselves sees it. */
export interface EstateSummary {
  ownerUserId: string;
  ownerName: string;
  ownerEmail: string;
  relation: string | null;
  sharePercentBps: number;
  accessLevel: NomineeAccessLevel;
  /** `sealed` means the vault is visible as ciphertext and openable by nobody but the owner. */
  escrowState: EscrowState | null;
  /** Present only once released — this is the wrapped key an heir unwraps with their own. */
  wrappedDek: string | null;
  releasedAt: string | null;
}

/* -------------------------------------------------------------------------- */
/* Dead-man switch                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The stages an absence passes through.
 *
 * Warnings exist so that the switch never fires as a surprise. `grace` is the last window
 * in which one ordinary sign-in cancels everything; after it, sealed escrows open and the
 * heirs named against them can read the vault.
 */
export const DEAD_MAN_STAGES = [
  'idle',
  'warned_50',
  'warned_75',
  'warned_90',
  'grace',
  'fired',
] as const;
export const deadManStageSchema = z.enum(DEAD_MAN_STAGES);
export type DeadManStage = z.infer<typeof deadManStageSchema>;

export const DEAD_MAN_STAGE_LABELS: Record<DeadManStage, string> = {
  idle: 'Active',
  warned_50: 'First reminder sent',
  warned_75: 'Second reminder sent',
  warned_90: 'Final reminder sent',
  grace: 'Grace period — sign in to cancel',
  fired: 'Released to nominees',
};

/**
 * Ninety days of silence is the default, with a week of grace on the end.
 *
 * The floor is thirty days, not seven: this switch hands an heir the keys to everything,
 * and a fortnight's holiday without a laptop must not be able to trigger it.
 */
export const configureDeadManSchema = z
  .object({
    enabled: z.boolean(),
    inactivityDays: z.coerce.number().int().min(30, 'Use at least 30 days').max(730).default(90),
    graceDays: z.coerce.number().int().min(1).max(90).default(7),
  })
  .refine((body) => body.graceDays < body.inactivityDays, {
    message: 'The grace period must be shorter than the inactivity window',
    path: ['graceDays'],
  });
export type ConfigureDeadManBody = z.infer<typeof configureDeadManSchema>;

export interface DeadManStatus {
  enabled: boolean;
  inactivityDays: number;
  graceDays: number;
  lastCheckinAt: string;
  stage: DeadManStage;
  /** When the grace period began. Null unless `stage` is `grace` or later. */
  graceStartedAt: string | null;
  firedAt: string | null;
  /** Days of silence remaining before the next stage. Negative is never returned. */
  daysUntilGrace: number;
  daysUntilRelease: number | null;
  /** How many nominees would receive a key if it fired right now. */
  sealedEscrowCount: number;
}

/* -------------------------------------------------------------------------- */
/* Check-in links                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The token in a "still there?" link, as emailed with a dead-man warning.
 *
 * Random and opaque; the bounds check the shape, not the value.
 */
export const checkInTokenSchema = z
  .string()
  .trim()
  .min(20, 'That check-in link is not valid')
  .max(200, 'That check-in link is not valid');

export const checkInSchema = z.object({ token: checkInTokenSchema });
export type CheckInBody = z.infer<typeof checkInSchema>;

/**
 * What the check-in page learns before it draws its button.
 *
 * Enough to be worth clicking and no more. The name is included because a page asking you
 * to confirm you are alive, naming no account, is indistinguishable from a phishing
 * attempt — and whoever holds this token took it out of that person's own inbox.
 *
 * Note what is absent: any figure, any asset, any nominee's name. This page is reachable
 * with nothing but a link, so it says only that a switch exists and when it would fire.
 */
export interface CheckInPrompt {
  valid: boolean;
  name: string | null;
  stage: DeadManStage | null;
  /** Days until the escrows open, when the grace period has already started. */
  daysUntilRelease: number | null;
  /** True when the switch has already fired. Checking in cannot undo that. */
  alreadyFired: boolean;
}

/* -------------------------------------------------------------------------- */
/* Claim kit                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What an heir has to do, per institution, to actually take possession.
 *
 * This table is the reason the app exists. It is reference data rather than logic — the
 * forms the EPFO and LIC and the depositories actually ask for — and it lives in the shared
 * package so the printable kit renders in the browser, next to the vault plaintext it is
 * merged with, and never round-trips through the server.
 *
 * Amounts and thresholds are stated as of FY 2025-26 and will drift; INDIA-NOTES.md carries
 * the citations and the review date.
 */
export interface ClaimProcedure {
  /** Who the heir approaches. */
  authority: string;
  forms: string[];
  documents: string[];
  notes: string[];
}

const COMMON_DOCUMENTS = [
  'Death certificate (original plus attested copies)',
  'Claimant KYC — PAN and Aadhaar',
  'Cancelled cheque or bank passbook of the claimant',
];

export const CLAIM_PROCEDURES: Record<string, ClaimProcedure> = {
  bank_account: {
    authority: 'The branch that holds the account',
    forms: ['Form DA-1 (nominee claim)', 'Form DA-2 (no nomination, with sureties)'],
    documents: [...COMMON_DOCUMENTS, 'Original passbook or statement', 'Cheque book, if issued'],
    notes: [
      'With a registered nomination the branch settles on DA-1 alone; without one, banks ask for an indemnity and sureties, and above their own threshold a succession certificate.',
      'A deposit untouched for ten years moves to the RBI DEA Fund and is searched for at the UDGAM portal.',
    ],
  },
  deposit: {
    authority: 'The issuing bank branch, or the post office for small-savings schemes',
    forms: ['Form DA-1', 'Post office claim Form SB-84 / NC-32 for POSB schemes'],
    documents: [...COMMON_DOCUMENTS, 'Original deposit receipt or passbook'],
    notes: [
      'PPF and SSY are claimed at the office that holds the account, not at any branch.',
      'A PPF account of a deceased subscriber is closed and paid out; it cannot be continued by the nominee.',
    ],
  },
  holding: {
    authority: 'The RTA (CAMS or KFintech) for mutual funds; the DP for a demat account',
    forms: [
      'Transmission request form T3 (mutual funds)',
      'Transmission request form TRF-1 with annexures (demat)',
    ],
    documents: [
      ...COMMON_DOCUMENTS,
      'Client master list of the claimant demat account',
      'Notarised indemnity where the value exceeds the RTA threshold',
    ],
    notes: [
      'Units transmit to the nominee’s own folio or demat account; they are not paid out in cash.',
      'Shares with no claim for seven years are transferred to the IEPF and are recovered by a separate claim to the IEPF Authority.',
    ],
  },
  insurance_policy: {
    authority: 'The servicing branch of the insurer',
    forms: [
      'Claim form 3783 (claimant statement)',
      'Form 3801 (medical attendant certificate, where applicable)',
    ],
    documents: [
      ...COMMON_DOCUMENTS,
      'Original policy document',
      'Assignment or nomination endorsement',
    ],
    notes: [
      'A term policy is worth nothing while the life assured is alive and everything afterwards — it belongs in the kit even though it carries no asset value.',
      'Claims within three years of issue are investigated more closely; keep the proposal papers.',
    ],
  },
  property: {
    authority: 'The sub-registrar office and the local municipal or panchayat body',
    forms: ['Mutation / khata transfer application', 'Legal heir certificate application'],
    documents: [
      'Death certificate',
      'Registered sale deed and the latest encumbrance certificate',
      'Legal heir or succession certificate',
      'Latest property tax receipt',
    ],
    notes: [
      'Property does not pass by nomination. It passes by will or by succession law, and the mutation entry is what the revenue record recognises.',
    ],
  },
  retirement_account: {
    authority: 'EPFO for EPF, the NPS CRA and the POP for NPS',
    forms: ['EPF Form 20 (provident fund)', 'Form 10D (pension)', 'NPS withdrawal form 303'],
    documents: [
      ...COMMON_DOCUMENTS,
      'UAN or PRAN',
      'Employer attestation where the UAN is not seeded',
    ],
    notes: [
      'An e-nomination filed on the EPFO member portal settles a claim online; without one the claim is manual and slow.',
    ],
  },
  precious_metal: {
    authority: 'The bank or RTA for SGBs; whoever physically holds the metal otherwise',
    forms: ['Transmission form for sovereign gold bonds'],
    documents: [...COMMON_DOCUMENTS, 'Bond holding certificate or demat statement'],
    notes: [
      'Physical gold has no register and no nomination. It is claimed by possession, which is exactly why its location belongs in the vault.',
    ],
  },
  other_asset: {
    authority: 'Depends on the asset — the exchange, the employer, or the counterparty',
    forms: [],
    documents: [...COMMON_DOCUMENTS],
    notes: [
      'Crypto held in self-custody passes only if the heir can reach the seed phrase. Nothing else recovers it.',
      'Unvested ESOPs usually lapse on death; vested ones are exercised by the estate within the plan’s window.',
    ],
  },
  liability: {
    authority: 'The lender',
    forms: ['Loan closure or takeover application'],
    documents: [
      'Death certificate',
      'Loan account statement',
      'Insurance policy covering the loan, if any',
    ],
    notes: [
      'A liability is not inherited personally — it is settled from the estate — but a secured loan blocks transfer of the asset until it is closed.',
      'Check for loan protection cover before the heirs pay anything out of pocket.',
    ],
  },
};

/** One asset, as it appears in the printable kit. */
export interface ClaimKitEntry {
  assetId: string;
  name: string;
  type: string;
  institution: string | null;
  /** Masked, exactly as it is stored. The full number is in the vault. */
  reference: string | null;
  valuePaise: number;
  nomineeRegistered: boolean;
  procedure: ClaimProcedure;
  /** Ids of the vault items linked to this asset, for the browser to decrypt and merge. */
  vaultItemIds: string[];
}

export interface ClaimKitResponse {
  owner: { id: string; name: string; email: string };
  generatedAt: string;
  entries: ClaimKitEntry[];
  nominees: Array<Pick<NomineeRecord, 'name' | 'relation' | 'sharePercentBps' | 'email'>>;
  totals: {
    assetPaise: number;
    liabilityPaise: number;
    netPaise: number;
    unnominatedPaise: number;
  };
}

/** Referenced by the maturity calendar in P9; declared here so both phases agree. */
export const claimKitQuerySchema = z.object({
  ownerId: z.string().trim().max(64).optional(),
  asOf: isoDateSchema.optional(),
});
export type ClaimKitQuery = z.infer<typeof claimKitQuerySchema>;
