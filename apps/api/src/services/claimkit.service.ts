/**
 * The claim kit.
 *
 * This is the artefact the whole application exists to produce: a document an heir can take
 * to a bank counter. It pairs every asset with the institution that holds it, the forms that
 * institution actually asks for, and the ids of the vault items that unlock it — and it
 * stops exactly there.
 *
 * **The server assembles the skeleton; the browser fills in the flesh.** Nothing here reads
 * a vault item's contents, because nothing here can. The response carries `vaultItemIds`,
 * and the printable page decrypts those items locally and merges them in while the vault is
 * unlocked. That is why the kit is printed from the browser rather than rendered to a PDF
 * on the server: a server-rendered PDF would require the server to hold the plaintext, and
 * the moment it does, the zero-knowledge claim in SECURITY-MODEL.md becomes false.
 */

import { eq } from 'drizzle-orm';
import {
  CLAIM_PROCEDURES,
  isLiabilityType,
  type ClaimKitEntry,
  type ClaimKitResponse,
  type ClaimProcedure,
} from '@networth/shared';
import type { AppContext } from '../context.js';
import { nominees, users } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { isoNow } from '../lib/time.js';
import { loadPortfolio, type AssetFacts } from '../repos/analytics.repo.js';
import { assertCanSeeDetail, type Scope } from '../repos/scope.js';
import { recordAudit } from './audit.service.js';
import { readDetail } from './assetDetail.js';
import { valuePortfolio } from './valuation.service.js';
import { vaultItemIdsByAsset } from './vault.service.js';

/** Assets whose detail carries an identifying number, and where that number lives. */
const REFERENCE_FIELDS = [
  'accountNumber',
  'policyNumber',
  'folioNumber',
  'dematAccount',
  'registrationNumber',
  'uan',
  'pran',
  'certificateNumber',
] as const;

export function claimKit(
  ctx: AppContext,
  scope: Scope,
  options: { ownerId?: string; asOf?: string; ip?: string | null } = {},
): ClaimKitResponse {
  const ownerId = options.ownerId ?? scope.userId;

  // A kit is a detail read of somebody's entire estate, so it needs the same permission a
  // single asset's detail page does — a `summary` nominee gets totals on their portal and
  // no claim kit at all.
  if (!scope.readableOwnerIds.includes(ownerId)) throw notFound('No such household');
  assertCanSeeDetail(scope, ownerId);

  const owner = ctx.db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, ownerId))
    .get();
  if (!owner) throw notFound('No such household');

  const asOf = options.asOf ?? isoNow(ctx.now()).slice(0, 10);
  const data = loadPortfolio(ctx, scope);

  const mine = new Map<string, AssetFacts>();
  for (const facts of data.assets) {
    if (facts.asset.ownerUserId === ownerId && facts.asset.status !== 'archived') {
      mine.set(facts.asset.id, facts);
    }
  }

  const valued = valuePortfolio(data, scope, asOf).filter((asset) => mine.has(asset.assetId));
  // The kit is read on a bad day by somebody in a hurry: biggest first, so the accounts
  // worth the trouble of a succession certificate are at the top of the printout.
  valued.sort((a, b) => b.valuePaise - a.valuePaise);

  const vaultItems = vaultItemIdsByAsset(ctx, ownerId);

  let assetPaise = 0;
  let liabilityPaise = 0;
  let unnominatedPaise = 0;

  const entries: ClaimKitEntry[] = valued.map((asset) => {
    const facts = mine.get(asset.assetId)!;

    if (isLiabilityType(asset.type)) liabilityPaise += asset.valuePaise;
    else {
      assetPaise += asset.valuePaise;
      // Value at risk: what an heir would have to prove a claim to the hard way. Liabilities
      // are excluded because nobody has to chase a loan they did not take out.
      if (!asset.nomineeRegistered) unnominatedPaise += asset.valuePaise;
    }

    return {
      assetId: asset.assetId,
      name: asset.name,
      type: asset.type,
      institution: asset.institution,
      reference: referenceOf(ctx, facts),
      valuePaise: asset.valuePaise,
      nomineeRegistered: asset.nomineeRegistered,
      procedure: procedureFor(asset.type),
      vaultItemIds: vaultItems.get(asset.assetId) ?? [],
    };
  });

  const named = ctx.db
    .select({
      name: nominees.name,
      email: nominees.email,
      relation: nominees.relation,
      accessLevel: nominees.accessLevel,
      status: nominees.status,
    })
    .from(nominees)
    .where(eq(nominees.ownerUserId, ownerId))
    .all()
    .filter((row) => row.status !== 'revoked');

  recordAudit(ctx, {
    actorUserId: scope.userId,
    action: 'claimkit.generated',
    entityType: 'user',
    entityId: ownerId,
    ip: options.ip ?? null,
    meta: { entries: entries.length, forSelf: ownerId === scope.userId },
  });

  return {
    owner,
    generatedAt: isoNow(ctx.now()),
    entries,
    nominees: named.map((row) => ({
      name: row.name,
      email: row.email,
      relation: row.relation,
    })),
    totals: {
      assetPaise,
      liabilityPaise,
      netPaise: assetPaise - liabilityPaise,
      unnominatedPaise,
    },
  };
}

/**
 * How this kind of asset is claimed.
 *
 * A missing entry is a bug rather than a blank page: the heir is told to approach the
 * institution and ask, which is what they would have to do anyway, and the printout does
 * not simply omit the asset.
 */
function procedureFor(type: string): ClaimProcedure {
  return (
    CLAIM_PROCEDURES[type] ?? {
      authority: 'The institution named on the account',
      forms: [],
      documents: ['Death certificate', 'Claimant KYC — PAN and Aadhaar'],
      notes: [
        'No standard procedure is recorded for this asset type. Ask the institution what it needs.',
      ],
    }
  );
}

/**
 * The masked identifier that tells an heir which account this is.
 *
 * Masked, because that is how it is stored — the full number is a vault item, and pairing
 * the two is the browser's job at print time. Even the last four digits are enough to match
 * a printout against a passbook, which is all this field is for.
 */
function referenceOf(ctx: AppContext, facts: AssetFacts): string | null {
  const detail = readDetail(ctx.db, facts.asset) as Record<string, unknown>;
  for (const field of REFERENCE_FIELDS) {
    const value = detail[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}
