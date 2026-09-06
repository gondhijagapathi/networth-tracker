/**
 * Demo data.
 *
 * `npm run db:seed -- --email you@example.com` fills an existing account with a household's
 * worth of assets: a salary account, a fixed deposit, PPF, a fund holding with two years of
 * SIPs, a term policy, a plot of land, EPF, sovereign gold bonds and a home loan. Enough to
 * make the dashboard, the allocation chart and the nomination report say something, without
 * inventing a person.
 *
 * Three deliberate properties:
 *
 *   - It seeds an **existing** user rather than creating one. There is no code path in this
 *     application that makes an account without consuming an invite, and a seed script is
 *     not the place to introduce the first one.
 *   - Every row it writes carries the `demo` tag, and it refuses to run twice, so it cannot
 *     quietly double someone's net worth.
 *   - It refuses to run against `NODE_ENV=production` at all.
 */

import { eq, sql } from 'drizzle-orm';
import { createAssetSchema, uuidv7, type AssetType, type CreateAssetBody } from '@networth/shared';
import { loadConfig } from '../config.js';
import { createContext } from '../context.js';
import { assets, instruments, transactions, users, valuations } from './schema.js';
import { createDb } from './client.js';
import { runMigrations } from './migrate.js';
import { createAsset } from '../services/asset.service.js';
import type { Scope } from '../repos/scope.js';

const DEMO_TAG = 'demo';

function argValue(name: string): string | undefined {
  const prefixed = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefixed));
  if (inline) return inline.slice(prefixed.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const config = loadConfig();

if (config.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data into a production database.');
  process.exit(1);
}

const email = argValue('email')?.trim().toLowerCase();
if (!email) {
  console.error('Usage: npm run db:seed -- --email you@example.com');
  process.exit(1);
}

const { db, sqlite, close } = createDb(config.DATABASE_PATH);
runMigrations(sqlite);
const ctx = createContext(config, db, sqlite);

try {
  const user = db.select().from(users).where(eq(users.email, email)).get();
  if (!user) {
    console.error(`No account for ${email}. Register through the app first, then seed it.`);
    process.exit(1);
  }

  const existing = db
    .select({ count: sql<number>`count(*)` })
    .from(assets)
    .where(
      sql`${assets.ownerUserId} = ${user.id} and exists (select 1 from json_each(${assets.tags}) where value = ${DEMO_TAG})`,
    )
    .get();

  if ((existing?.count ?? 0) > 0) {
    console.error(`${email} already has demo data. Remove it before seeding again.`);
    process.exit(1);
  }

  // The seed writes through the ordinary schema and service, so it exercises the same
  // validation, masking and transaction boundaries a real request does. A fixture that takes
  // a shortcut around the rules is a fixture that stops resembling production.
  const scope: Scope = {
    userId: user.id,
    role: user.role,
    readableOwnerIds: [user.id],
    grants: new Map(),
  };

  const fund = {
    id: uuidv7(),
    kind: 'mf' as const,
    name: 'Parag Parikh Flexi Cap Fund - Direct Growth',
    amfiSchemeCode: '122639',
    isin: 'INF879O01027',
    symbol: null,
    exchange: 'none' as const,
    amc: 'PPFAS Mutual Fund',
    category: 'Equity: Flexi Cap',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.insert(instruments).values(fund).onConflictDoNothing().run();

  const bodies: CreateAssetBody[] = [
    body('bank_account', {
      name: 'Salary account',
      institution: 'HDFC Bank',
      nomineeRegistered: true,
      valuePaise: 2_45_000_00,
      detail: {
        accountNumber: '50100234567890',
        ifsc: 'HDFC0001234',
        branch: 'Indiranagar',
        accountType: 'salary',
      },
    }),
    body('deposit', {
      name: '5-year tax saver FD',
      institution: 'SBI',
      valuePaise: 5_38_000_00,
      detail: {
        kind: 'fd',
        principalPaise: 5_00_000_00,
        rateBps: 715,
        compounding: 'quarterly',
        startedOn: '2024-04-15',
        maturesOn: '2029-04-15',
      },
    }),
    body('deposit', {
      name: 'PPF',
      institution: 'SBI',
      nomineeRegistered: true,
      valuePaise: 12_80_000_00,
      detail: {
        kind: 'ppf',
        principalPaise: 10_50_000_00,
        installmentPaise: 1_50_000_00,
        rateBps: 710,
        compounding: 'yearly',
        startedOn: '2018-04-05',
        maturesOn: '2033-04-05',
      },
    }),
    body('holding', {
      name: 'Parag Parikh Flexi Cap',
      institution: 'Zerodha Coin',
      valuePaise: 8_92_000_00,
      detail: {
        instrumentId: fund.id,
        units: 12_450_000_000,
        avgCostMicro: 58_400_000,
        folioNumber: '10234567/89',
        sipAmountPaise: 25_000_00,
        sipDay: 5,
      },
    }),
    body('insurance_policy', {
      name: 'Term cover',
      institution: 'LIC',
      nomineeRegistered: true,
      valuePaise: 0,
      detail: {
        policyNumber: '987654321',
        insurer: 'LIC',
        plan: 'Tech Term',
        kind: 'term',
        sumAssuredPaise: 2_00_00_000_00,
        premiumPaise: 28_500_00,
        premiumFrequency: 'yearly',
        nextDueOn: '2027-01-15',
        startedOn: '2020-01-15',
        maturesOn: '2055-01-15',
      },
    }),
    body('property', {
      name: 'Plot at Kolar',
      valuePaise: 48_00_000_00,
      detail: {
        kind: 'plot',
        address: 'Survey 112/2B, Vemgal Hobli, Kolar',
        surveyNumber: '112/2B',
        khataNumber: 'K-4471',
        subRegistrarOffice: 'Kolar',
        areaMicro: 1_200_000_000,
        areaUnit: 'sqft',
        guidelineValuePaise: 32_00_000_00,
      },
    }),
    body('retirement_account', {
      name: 'EPF',
      institution: 'EPFO',
      valuePaise: 14_70_000_00,
      detail: {
        kind: 'epf',
        uan: '100234567890',
        employeeBalancePaise: 7_35_000_00,
        employerBalancePaise: 7_35_000_00,
        rateBps: 825,
      },
    }),
    body('precious_metal', {
      name: 'Sovereign gold bonds',
      institution: 'RBI',
      valuePaise: 3_10_000_00,
      detail: {
        form: 'sgb',
        metal: 'gold',
        weightMilligrams: 40_000,
        purity: '999',
        sgbMaturesOn: '2031-08-05',
        sgbInterestDates: ['02-05', '08-05'],
      },
    }),
    body('other_asset', {
      name: 'Vested RSUs',
      institution: 'Employer',
      valuePaise: 6_40_000_00,
      detail: {
        kind: 'rsu',
        company: 'Employer Inc',
        grantedOn: '2023-07-01',
        grantedUnits: 400_000_000,
        vestedUnits: 200_000_000,
      },
    }),
    body('liability', {
      name: 'Home loan',
      institution: 'HDFC',
      valuePaise: 32_60_000_00,
      detail: {
        kind: 'home',
        lender: 'HDFC',
        accountNumber: '600123456789',
        principalPaise: 45_00_000_00,
        outstandingPaise: 32_60_000_00,
        rateBps: 865,
        emiPaise: 41_500_00,
        tenureMonths: 240,
        nextDueOn: '2026-10-05',
        startedOn: '2021-10-05',
      },
    }),
  ];

  const created = bodies.map((asset) => createAsset(ctx, scope, asset, null));
  const holding = created.find((asset) => asset.type === 'holding');

  if (holding) {
    // Two years of monthly SIPs, so XIRR and the cost-basis work in P3 have real cashflows
    // to chew on rather than a single lump sum.
    const rows = sipHistory(holding.id, 24);
    db.insert(transactions).values(rows).run();
  }

  // A year of month-end net worth marks on the plot, so the history chart has a line.
  const plot = created.find((asset) => asset.type === 'property');
  if (plot) {
    db.insert(valuations)
      .values(appreciation(plot.id, 42_00_000_00, 48_00_000_00, 12))
      .run();
  }

  // eslint-disable-next-line no-console
  console.log(`Seeded ${created.length} demo assets for ${email}.`);
} finally {
  close();
}

/**
 * Build a create body by parsing it, exactly as a request body is parsed.
 *
 * Not a cast. `createAssetSchema` is where account numbers get masked and where defaults
 * are filled in, so a seed that skipped it would write rows this application could not have
 * produced — full account numbers in plain columns, among other things — and would quietly
 * stop being a fixture that resembles production.
 */
function body(type: AssetType, rest: Record<string, unknown>): CreateAssetBody {
  return createAssetSchema.parse({ type, tags: [DEMO_TAG], ...rest });
}

function sipHistory(assetId: string, months: number) {
  const rows = [];
  const start = new Date();
  start.setUTCMonth(start.getUTCMonth() - months);

  for (let month = 0; month < months; month += 1) {
    const date = new Date(start);
    date.setUTCMonth(start.getUTCMonth() + month);
    // A NAV that wanders instead of climbing in a straight line: an XIRR over a perfectly
    // smooth series is a number that proves nothing.
    const nav = 55 + month * 0.35 + Math.sin(month) * 1.8;
    const amountPaise = 25_000_00;
    rows.push({
      id: uuidv7(Date.now() + month),
      assetId,
      date: date.toISOString().slice(0, 10),
      type: 'sip' as const,
      units: Math.round((amountPaise / 100 / nav) * 1_000_000),
      amountPaise,
      priceMicro: Math.round(nav * 1_000_000),
      chargesPaise: 0,
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  return rows;
}

function appreciation(assetId: string, from: number, to: number, months: number) {
  const step = Math.round((to - from) / months);
  const rows = [];

  for (let month = 1; month <= months; month += 1) {
    const date = new Date();
    date.setUTCMonth(date.getUTCMonth() - (months - month));
    rows.push({
      id: uuidv7(Date.now() + month),
      assetId,
      asOf: date.toISOString().slice(0, 10),
      valuePaise: from + step * month,
      source: 'manual' as const,
      notes: null,
      createdAt: new Date().toISOString(),
    });
  }
  return rows;
}
