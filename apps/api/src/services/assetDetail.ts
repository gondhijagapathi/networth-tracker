/**
 * The mapping between an asset's typed detail and its detail table.
 *
 * Nine asset types, nine tables, one switch in each direction. It is repetitive on purpose:
 * a generic column-mapping layer would have to be told the shape of every type anyway, and
 * it would do it in a form the compiler could not check. Here, adding a column to
 * `deposits` without teaching this file about it fails to compile.
 *
 * `TypedDetail` is the pairing of a type with *its* detail, which is what makes the switch
 * narrow properly: inside `case 'deposit'`, `detail` is a `DepositDetail` and nothing else.
 */

import { eq } from 'drizzle-orm';
import type { AssetDetail, AssetType } from '@networth/shared';
import type { Db } from '../db/client.js';
import {
  bankAccounts,
  deposits,
  holdings,
  insurancePolicies,
  liabilities,
  otherAssets,
  preciousMetals,
  properties,
  retirementAccounts,
  type AssetRow,
} from '../db/schema.js';

/** A type and the detail that belongs to it, correlated so a switch can narrow both. */
export type TypedDetail = {
  [K in AssetType]: { type: K; detail: AssetDetail[K] };
}[AssetType];

type Writer = Pick<Db, 'insert' | 'update'>;
type Reader = Pick<Db, 'select'>;

/** SQLite has no `undefined`; an absent optional field is a NULL column. */
const orNull = <T>(value: T | undefined): T | null => value ?? null;

/** ...and on the way back out, a NULL column is an absent optional field. */
const orUndefined = <T>(value: T | null): T | undefined => value ?? undefined;

const jsonOrNull = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value);

function parseJson<T>(value: string | null): T | undefined {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    // A column this app always writes as JSON can still be corrupted by a restore or a
    // manual fix. Losing one optional field beats a 500 on the whole asset.
    return undefined;
  }
}

/**
 * Insert or replace the detail row for an asset.
 *
 * Update writes every column rather than a diff, because the caller has already merged its
 * partial into the stored detail and re-validated the whole thing. Cross-field rules — a
 * maturity date after its start, an outstanding balance within its principal — are only
 * meaningful about a complete object, so a complete object is what gets written.
 */
export function writeDetail(
  db: Writer,
  assetId: string,
  typed: TypedDetail,
  mode: 'insert' | 'update',
): void {
  switch (typed.type) {
    case 'bank_account': {
      const d = typed.detail;
      const values = {
        assetId,
        accountNumberMasked: orNull(d.accountNumber),
        ifsc: orNull(d.ifsc),
        branch: orNull(d.branch),
        cif: orNull(d.cif),
        accountType: d.accountType,
      };
      if (mode === 'insert') db.insert(bankAccounts).values(values).run();
      else db.update(bankAccounts).set(values).where(eq(bankAccounts.assetId, assetId)).run();
      return;
    }

    case 'deposit': {
      const d = typed.detail;
      const values = {
        assetId,
        kind: d.kind,
        accountNumberMasked: orNull(d.accountNumber),
        principalPaise: d.principalPaise,
        installmentPaise: d.installmentPaise,
        rateBps: d.rateBps,
        compounding: d.compounding,
        payoutMode: d.payoutMode,
        startedOn: d.startedOn,
        maturesOn: orNull(d.maturesOn),
        autoRenew: d.autoRenew,
      };
      if (mode === 'insert') db.insert(deposits).values(values).run();
      else db.update(deposits).set(values).where(eq(deposits.assetId, assetId)).run();
      return;
    }

    case 'holding': {
      const d = typed.detail;
      const values = {
        assetId,
        instrumentId: d.instrumentId,
        units: d.units,
        avgCostMicro: d.avgCostMicro,
        folioNumberMasked: orNull(d.folioNumber),
        sipAmountPaise: orNull(d.sipAmountPaise),
        sipDay: orNull(d.sipDay),
        dematAccountMasked: orNull(d.dematAccount),
      };
      if (mode === 'insert') db.insert(holdings).values(values).run();
      else db.update(holdings).set(values).where(eq(holdings.assetId, assetId)).run();
      return;
    }

    case 'insurance_policy': {
      const d = typed.detail;
      const values = {
        assetId,
        policyNumberMasked: orNull(d.policyNumber),
        insurer: d.insurer,
        plan: orNull(d.plan),
        kind: d.kind,
        sumAssuredPaise: d.sumAssuredPaise,
        premiumPaise: d.premiumPaise,
        premiumFrequency: d.premiumFrequency,
        nextDueOn: orNull(d.nextDueOn),
        startedOn: orNull(d.startedOn),
        maturesOn: orNull(d.maturesOn),
      };
      if (mode === 'insert') db.insert(insurancePolicies).values(values).run();
      else
        db.update(insurancePolicies)
          .set(values)
          .where(eq(insurancePolicies.assetId, assetId))
          .run();
      return;
    }

    case 'property': {
      const d = typed.detail;
      const values = {
        assetId,
        kind: d.kind,
        address: orNull(d.address),
        surveyNumber: orNull(d.surveyNumber),
        khataNumber: orNull(d.khataNumber),
        pattaNumber: orNull(d.pattaNumber),
        registrationDocNumber: orNull(d.registrationDocNumber),
        subRegistrarOffice: orNull(d.subRegistrarOffice),
        areaMicro: orNull(d.areaMicro),
        areaUnit: d.areaUnit,
        guidelineValuePaise: orNull(d.guidelineValuePaise),
        coOwners: orNull(d.coOwners),
      };
      if (mode === 'insert') db.insert(properties).values(values).run();
      else db.update(properties).set(values).where(eq(properties.assetId, assetId)).run();
      return;
    }

    case 'retirement_account': {
      const d = typed.detail;
      const values = {
        assetId,
        kind: d.kind,
        uanMasked: orNull(d.uan),
        memberIdMasked: orNull(d.memberId),
        pranMasked: orNull(d.pran),
        tier: orNull(d.tier),
        schemeMix: jsonOrNull(d.schemeMix),
        employeeBalancePaise: d.employeeBalancePaise,
        employerBalancePaise: d.employerBalancePaise,
        rateBps: orNull(d.rateBps),
      };
      if (mode === 'insert') db.insert(retirementAccounts).values(values).run();
      else
        db.update(retirementAccounts)
          .set(values)
          .where(eq(retirementAccounts.assetId, assetId))
          .run();
      return;
    }

    case 'precious_metal': {
      const d = typed.detail;
      const values = {
        assetId,
        form: d.form,
        metal: d.metal,
        weightMilligrams: d.weightMilligrams,
        purity: orNull(d.purity),
        makingChargesPaise: d.makingChargesPaise,
        sgbMaturesOn: orNull(d.sgbMaturesOn),
        sgbInterestDates: jsonOrNull(d.sgbInterestDates),
      };
      if (mode === 'insert') db.insert(preciousMetals).values(values).run();
      else db.update(preciousMetals).set(values).where(eq(preciousMetals.assetId, assetId)).run();
      return;
    }

    case 'other_asset': {
      const d = typed.detail;
      // `kind` is duplicated into its own column so the long tail stays queryable — "every
      // RSU grant" should not mean reading and parsing every JSON blob in the table.
      const values = { assetId, kind: d.kind, detail: JSON.stringify(d) };
      if (mode === 'insert') db.insert(otherAssets).values(values).run();
      else db.update(otherAssets).set(values).where(eq(otherAssets.assetId, assetId)).run();
      return;
    }

    case 'liability': {
      const d = typed.detail;
      const values = {
        assetId,
        kind: d.kind,
        lender: d.lender,
        accountNumberMasked: orNull(d.accountNumber),
        principalPaise: d.principalPaise,
        outstandingPaise: d.outstandingPaise,
        rateBps: d.rateBps,
        emiPaise: d.emiPaise,
        tenureMonths: orNull(d.tenureMonths),
        nextDueOn: orNull(d.nextDueOn),
        startedOn: orNull(d.startedOn),
        endsOn: orNull(d.endsOn),
      };
      if (mode === 'insert') db.insert(liabilities).values(values).run();
      else db.update(liabilities).set(values).where(eq(liabilities.assetId, assetId)).run();
      return;
    }
  }
}

/**
 * Read an asset's detail back into the shape the schemas describe.
 *
 * The result round-trips: feeding it back through `assetDetailSchemas[type]` parses clean,
 * which is what lets an update merge a partial into the stored detail and re-validate the
 * whole object before writing it.
 *
 * A missing detail row is a corrupted database rather than an empty state — the two rows
 * are written in one transaction and cascade together — so it fails loudly.
 */
export function readDetail(db: Reader, asset: AssetRow): AssetDetail[AssetType] {
  switch (asset.type) {
    case 'bank_account': {
      const row = one(
        db.select().from(bankAccounts).where(eq(bankAccounts.assetId, asset.id)).get(),
        asset,
      );
      return {
        accountNumber: orUndefined(row.accountNumberMasked),
        ifsc: orUndefined(row.ifsc),
        branch: orUndefined(row.branch),
        cif: orUndefined(row.cif),
        accountType: row.accountType,
      };
    }

    case 'deposit': {
      const row = one(
        db.select().from(deposits).where(eq(deposits.assetId, asset.id)).get(),
        asset,
      );
      return {
        kind: row.kind,
        accountNumber: orUndefined(row.accountNumberMasked),
        principalPaise: row.principalPaise,
        installmentPaise: row.installmentPaise,
        rateBps: row.rateBps,
        compounding: row.compounding,
        payoutMode: row.payoutMode,
        startedOn: row.startedOn,
        maturesOn: orUndefined(row.maturesOn),
        autoRenew: row.autoRenew,
      };
    }

    case 'holding': {
      const row = one(
        db.select().from(holdings).where(eq(holdings.assetId, asset.id)).get(),
        asset,
      );
      return {
        instrumentId: row.instrumentId,
        units: row.units,
        avgCostMicro: row.avgCostMicro,
        folioNumber: orUndefined(row.folioNumberMasked),
        sipAmountPaise: orUndefined(row.sipAmountPaise),
        sipDay: orUndefined(row.sipDay),
        dematAccount: orUndefined(row.dematAccountMasked),
      };
    }

    case 'insurance_policy': {
      const row = one(
        db.select().from(insurancePolicies).where(eq(insurancePolicies.assetId, asset.id)).get(),
        asset,
      );
      return {
        policyNumber: orUndefined(row.policyNumberMasked),
        insurer: row.insurer,
        plan: orUndefined(row.plan),
        kind: row.kind,
        sumAssuredPaise: row.sumAssuredPaise,
        premiumPaise: row.premiumPaise,
        premiumFrequency: row.premiumFrequency,
        nextDueOn: orUndefined(row.nextDueOn),
        startedOn: orUndefined(row.startedOn),
        maturesOn: orUndefined(row.maturesOn),
      };
    }

    case 'property': {
      const row = one(
        db.select().from(properties).where(eq(properties.assetId, asset.id)).get(),
        asset,
      );
      return {
        kind: row.kind,
        address: orUndefined(row.address),
        surveyNumber: orUndefined(row.surveyNumber),
        khataNumber: orUndefined(row.khataNumber),
        pattaNumber: orUndefined(row.pattaNumber),
        registrationDocNumber: orUndefined(row.registrationDocNumber),
        subRegistrarOffice: orUndefined(row.subRegistrarOffice),
        areaMicro: orUndefined(row.areaMicro),
        areaUnit: row.areaUnit,
        guidelineValuePaise: orUndefined(row.guidelineValuePaise),
        coOwners: orUndefined(row.coOwners),
      };
    }

    case 'retirement_account': {
      const row = one(
        db.select().from(retirementAccounts).where(eq(retirementAccounts.assetId, asset.id)).get(),
        asset,
      );
      return {
        kind: row.kind,
        uan: orUndefined(row.uanMasked),
        memberId: orUndefined(row.memberIdMasked),
        pran: orUndefined(row.pranMasked),
        tier: orUndefined(row.tier),
        schemeMix: parseJson<Record<string, number>>(row.schemeMix),
        employeeBalancePaise: row.employeeBalancePaise,
        employerBalancePaise: row.employerBalancePaise,
        rateBps: orUndefined(row.rateBps),
      };
    }

    case 'precious_metal': {
      const row = one(
        db.select().from(preciousMetals).where(eq(preciousMetals.assetId, asset.id)).get(),
        asset,
      );
      return {
        form: row.form,
        metal: row.metal,
        weightMilligrams: row.weightMilligrams,
        purity: orUndefined(row.purity),
        makingChargesPaise: row.makingChargesPaise,
        sgbMaturesOn: orUndefined(row.sgbMaturesOn),
        sgbInterestDates: parseJson<string[]>(row.sgbInterestDates),
      };
    }

    case 'other_asset': {
      const row = one(
        db.select().from(otherAssets).where(eq(otherAssets.assetId, asset.id)).get(),
        asset,
      );
      // The JSON is the record; the `kind` column is a copy of the discriminator inside it.
      return (
        parseJson<AssetDetail['other_asset']>(row.detail) ??
        ({ kind: row.kind } as AssetDetail['other_asset'])
      );
    }

    case 'liability': {
      const row = one(
        db.select().from(liabilities).where(eq(liabilities.assetId, asset.id)).get(),
        asset,
      );
      return {
        kind: row.kind,
        lender: row.lender,
        accountNumber: orUndefined(row.accountNumberMasked),
        principalPaise: row.principalPaise,
        outstandingPaise: row.outstandingPaise,
        rateBps: row.rateBps,
        emiPaise: row.emiPaise,
        tenureMonths: orUndefined(row.tenureMonths),
        nextDueOn: orUndefined(row.nextDueOn),
        startedOn: orUndefined(row.startedOn),
        endsOn: orUndefined(row.endsOn),
      };
    }
  }
}

/** An asset without its detail row is a broken invariant, not a case to handle gracefully. */
function one<T>(row: T | undefined, asset: AssetRow): T {
  if (!row) {
    throw new Error(`Asset ${asset.id} of type ${asset.type} has no detail row`);
  }
  return row;
}
