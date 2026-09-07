/**
 * An asset's own fields, per type.
 *
 * Nine types, nine layouts, one switch — the same shape the server uses to read and write
 * them, and repetitive for the same reason: a generic renderer would have to be told about
 * every field anyway, and it would do it in a form the compiler could not check.
 *
 * What is shown is chosen for a *claim*, not for a summary. A survey number, a khata and a
 * sub-registrar office look like bureaucratic clutter until somebody has to trace a title
 * with them; an heir who has "the land in Kolar" and nothing else has nothing.
 */

import {
  MICRO,
  formatINR,
  fromMicro,
  type AssetDetail,
  type AssetRecord,
  type AssetType,
} from '@networth/shared';
import { formatDate } from '../../lib/format.js';

/**
 * `AssetRecord` carries `type` and `detail` as independent properties, so a switch on the
 * first does not narrow the second. Correlating them here is what lets each branch below
 * see the detail that actually belongs to it.
 */
type Narrowed = { [K in AssetType]: { type: K; detail: AssetDetail[K] } }[AssetType];

interface Row {
  label: string;
  value: string;
}

export function DetailPanel({ asset }: { asset: AssetRecord }) {
  const rows = rowsFor(asset as unknown as Narrowed);
  if (rows.length === 0) return null;

  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
      {rows.map((row) => (
        <div key={row.label} className="min-w-0">
          <dt className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {row.label}
          </dt>
          <dd className="mt-0.5 truncate text-sm" title={row.value}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Drop anything empty, so a sparse asset renders as a short list rather than a grid of dashes. */
function compact(rows: Array<Row | null>): Row[] {
  return rows.filter((row): row is Row => row !== null && row.value !== '' && row.value !== '—');
}

const text = (label: string, value: string | null | undefined): Row | null =>
  value === null || value === undefined || value === '' ? null : { label, value };

const money = (label: string, paise: number | null | undefined): Row | null =>
  paise === null || paise === undefined
    ? null
    : { label, value: formatINR(paise, { paise: false }) };

/** Basis points are how rates are stored; nobody reads them that way. */
const rate = (label: string, bps: number | null | undefined): Row | null =>
  bps === null || bps === undefined || bps === 0
    ? null
    : { label, value: `${(bps / 100).toFixed(2)}% p.a.` };

const date = (label: string, iso: string | null | undefined): Row | null =>
  iso === null || iso === undefined ? null : { label, value: formatDate(iso) };

const humanise = (value: string): string =>
  value.replace(/_/g, ' ').replace(/^./, (character) => character.toUpperCase());

function rowsFor(asset: Narrowed): Row[] {
  switch (asset.type) {
    case 'bank_account': {
      const d = asset.detail;
      return compact([
        text('Account type', humanise(d.accountType)),
        text('Account number', d.accountNumber),
        text('IFSC', d.ifsc),
        text('Branch', d.branch),
        text('Customer ID', d.cif),
      ]);
    }

    case 'deposit': {
      const d = asset.detail;
      return compact([
        text('Scheme', d.kind.toUpperCase()),
        text('Account number', d.accountNumber),
        money('Principal', d.principalPaise),
        d.installmentPaise > 0 ? money('Instalment', d.installmentPaise) : null,
        rate('Interest', d.rateBps),
        text('Compounding', humanise(d.compounding)),
        d.payoutMode === 'cumulative' ? null : text('Interest paid', humanise(d.payoutMode)),
        date('Opened', d.startedOn),
        date('Matures', d.maturesOn),
        d.autoRenew ? text('On maturity', 'Renews automatically') : null,
      ]);
    }

    case 'holding': {
      const d = asset.detail;
      return compact([
        // Units are stored scaled by a million; four decimals is what a statement shows.
        text('Units', fromMicro(d.units).toFixed(4)),
        d.avgCostMicro > 0
          ? text('Average cost', formatINR(Math.round((d.avgCostMicro / MICRO) * 100)))
          : null,
        text('Folio', d.folioNumber),
        text('Demat account', d.dematAccount),
        d.sipAmountPaise === undefined ? null : money('SIP', d.sipAmountPaise),
        d.sipDay === undefined ? null : text('SIP date', `${d.sipDay} of each month`),
      ]);
    }

    case 'insurance_policy': {
      const d = asset.detail;
      return compact([
        text('Insurer', d.insurer),
        text('Plan', d.plan),
        text('Kind', humanise(d.kind)),
        text('Policy number', d.policyNumber),
        money('Sum assured', d.sumAssuredPaise),
        money('Premium', d.premiumPaise),
        text('Paid', humanise(d.premiumFrequency)),
        date('Next due', d.nextDueOn),
        date('Started', d.startedOn),
        date('Matures', d.maturesOn),
      ]);
    }

    case 'property': {
      const d = asset.detail;
      return compact([
        text('Kind', humanise(d.kind)),
        text('Address', d.address),
        // The identifiers a claim actually needs.
        text('Survey number', d.surveyNumber),
        text('Khata number', d.khataNumber),
        text('Patta number', d.pattaNumber),
        text('Registration document', d.registrationDocNumber),
        text('Sub-registrar', d.subRegistrarOffice),
        d.areaMicro === undefined
          ? null
          : text('Area', `${fromMicro(d.areaMicro).toLocaleString('en-IN')} ${d.areaUnit}`),
        money('Guideline value', d.guidelineValuePaise),
        text('Co-owners', d.coOwners),
      ]);
    }

    case 'retirement_account': {
      const d = asset.detail;
      return compact([
        text('Scheme', d.kind.toUpperCase()),
        text('UAN', d.uan),
        text('Member ID', d.memberId),
        text('PRAN', d.pran),
        d.tier === undefined ? null : text('Tier', humanise(d.tier)),
        // EPF splits the balance by contributor, and a claim needs both halves.
        money('Employee balance', d.employeeBalancePaise),
        money('Employer balance', d.employerBalancePaise),
        rate('Interest', d.rateBps),
        d.schemeMix === undefined
          ? null
          : text(
              'Scheme mix',
              Object.entries(d.schemeMix)
                .map(([key, value]) => `${key} ${value}%`)
                .join(' · '),
            ),
      ]);
    }

    case 'precious_metal': {
      const d = asset.detail;
      return compact([
        text('Metal', humanise(d.metal)),
        text('Form', humanise(d.form)),
        text('Weight', `${(d.weightMilligrams / 1000).toFixed(3)} g`),
        text('Purity', d.purity),
        d.makingChargesPaise > 0 ? money('Making charges', d.makingChargesPaise) : null,
        date('SGB matures', d.sgbMaturesOn),
        d.sgbInterestDates === undefined
          ? null
          : text('Coupon dates', d.sgbInterestDates.join(' and ')),
      ]);
    }

    case 'other_asset':
      return compact(otherRows(asset.detail));

    case 'liability': {
      const d = asset.detail;
      return compact([
        text('Kind', humanise(d.kind)),
        text('Lender', d.lender),
        text('Account number', d.accountNumber),
        money('Sanctioned', d.principalPaise),
        money('Outstanding', d.outstandingPaise),
        rate('Interest', d.rateBps),
        d.emiPaise > 0 ? money('EMI', d.emiPaise) : null,
        d.tenureMonths === undefined ? null : text('Tenure', `${d.tenureMonths} months`),
        date('Next due', d.nextDueOn),
        date('Started', d.startedOn),
        date('Ends', d.endsOn),
      ]);
    }
  }
}

function otherRows(detail: AssetDetail['other_asset']): Array<Row | null> {
  switch (detail.kind) {
    case 'crypto':
      return [
        text('Symbol', detail.symbol),
        text('Quantity', fromMicro(detail.quantityMicro).toString()),
        text('Wallet', detail.wallet),
      ];
    case 'esop':
      return [
        text('Company', detail.company),
        date('Granted', detail.grantedOn),
        text('Granted', fromMicro(detail.grantedUnits).toString()),
        text('Vested', fromMicro(detail.vestedUnits).toString()),
        money('Strike price', detail.strikePaise),
      ];
    case 'rsu':
      return [
        text('Company', detail.company),
        date('Granted', detail.grantedOn),
        text('Granted', fromMicro(detail.grantedUnits).toString()),
        text('Vested', fromMicro(detail.vestedUnits).toString()),
      ];
    case 'chit':
      return [
        text('Organiser', detail.organiser),
        money('Chit value', detail.chitValuePaise),
        money('Monthly', detail.monthlyPaise),
        text('Months', String(detail.months)),
        date('Started', detail.startedOn),
      ];
    case 'loan_given':
      return [
        text('Borrower', detail.borrower),
        money('Principal', detail.principalPaise),
        rate('Interest', detail.rateBps),
        date('Due', detail.dueOn),
      ];
    case 'vehicle':
      return [
        text('Make', detail.make),
        text('Model', detail.model),
        text('Registration', detail.registrationNumber),
        date('Purchased', detail.purchasedOn),
        money('Purchase price', detail.purchasePaise),
      ];
  }
}
