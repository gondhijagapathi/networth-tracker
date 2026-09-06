/**
 * Asset CRUD, valuations and transactions.
 *
 * The round-trip test at the top is the one that matters most: every asset type is created
 * through the API and read back, and the detail it comes back with must equal the detail it
 * went in with. Nine types, nine detail tables and one mapping layer is exactly the shape of
 * code where a mistyped column name goes unnoticed until somebody's land record loses its
 * survey number.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASSET_TYPES } from '@networth/shared';
import {
  createTestInstance,
  registerAdmin,
  sampleAssetBody,
  type TestClient,
  type TestInstance,
} from './harness.js';

let instance: TestInstance;
let owner: TestClient;
let instrumentId: string;

beforeEach(async () => {
  instance = createTestInstance();
  owner = await registerAdmin(instance);
  const response = await owner.post('/api/instruments', {
    kind: 'mf',
    name: 'Parag Parikh Flexi Cap Fund',
    amfiSchemeCode: '122639',
    isin: 'INF879O01027',
  });
  instrumentId = response.body.instrument.id as string;
});

afterEach(() => {
  instance.close();
});

describe('creating assets', () => {
  it.each(ASSET_TYPES)('round-trips a %s through create and read', async (type) => {
    const body = sampleAssetBody(type, { instrumentId });

    const created = await owner.post('/api/assets', body);
    expect(created.status, created.text).toBe(201);
    expect(created.body.asset.type).toBe(type);

    const read = await owner.get(`/api/assets/${created.body.asset.id}`);
    expect(read.status).toBe(200);
    // The detail that comes back is what the schema produced, defaults included, so this
    // compares against the created response rather than the request body.
    expect(read.body.asset.detail).toEqual(created.body.asset.detail);
    expect(read.body.asset.name).toBe(body.name);
  });

  it('records the opening value as the first valuation', async () => {
    const created = await owner.post('/api/assets', {
      ...sampleAssetBody('deposit'),
      valuePaise: 5_10_000_00,
      valueAsOf: '2026-04-01',
    });

    expect(created.body.asset.latestValue).toEqual({
      valuePaise: 5_10_000_00,
      asOf: '2026-04-01',
      source: 'manual',
    });
  });

  it('defaults nomineeRegistered to false rather than assuming safety', async () => {
    const created = await owner.post('/api/assets', sampleAssetBody('property'));
    expect(created.body.asset.nomineeRegistered).toBe(false);
  });

  it('masks an account number down to its last four digits', async () => {
    const created = await owner.post('/api/assets', sampleAssetBody('bank_account'));
    expect(created.body.asset.detail.accountNumber).toBe('XXXXXXXXXX6789');

    // Not just in the response — the column itself never holds the full number.
    const stored = instance.sqlite
      .prepare<[], { account_number_masked: string }>(
        'SELECT account_number_masked FROM bank_accounts',
      )
      .get();
    expect(stored?.account_number_masked).toBe('XXXXXXXXXX6789');
  });

  it('rejects detail that belongs to a different asset type', async () => {
    const response = await owner.post('/api/assets', {
      name: 'Confused',
      type: 'deposit',
      detail: { accountType: 'savings', ifsc: 'HDFC0001234' },
    });
    expect(response.status).toBe(400);
  });

  it('rejects a maturity date before the deposit started', async () => {
    const response = await owner.post('/api/assets', {
      ...sampleAssetBody('deposit'),
      detail: {
        kind: 'fd',
        principalPaise: 1_00_000_00,
        rateBps: 700,
        startedOn: '2026-01-01',
        maturesOn: '2025-01-01',
      },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.details).toHaveProperty('detail.maturesOn');
  });

  it('rejects a holding that points at no instrument', async () => {
    const response = await owner.post('/api/assets', {
      ...sampleAssetBody('holding'),
      detail: { instrumentId: '0192f3a0-0000-7000-8000-000000000000', units: 1_000_000 },
    });
    expect(response.status).toBe(400);
  });

  it('refuses an ownership share above one hundred percent', async () => {
    const response = await owner.post('/api/assets', {
      ...sampleAssetBody('property'),
      ownershipBps: 10_001,
    });
    expect(response.status).toBe(400);
  });
});

describe('updating assets', () => {
  it('merges a partial detail into what is stored', async () => {
    const created = await owner.post('/api/assets', sampleAssetBody('deposit'));
    const id = created.body.asset.id as string;

    const updated = await owner.patch(`/api/assets/${id}`, {
      nomineeRegistered: true,
      detail: { rateBps: 725 },
    });

    expect(updated.status, updated.text).toBe(200);
    expect(updated.body.asset.nomineeRegistered).toBe(true);
    expect(updated.body.asset.detail.rateBps).toBe(725);
    // Everything not mentioned survives the merge.
    expect(updated.body.asset.detail.principalPaise).toBe(5_00_000_00);
    expect(updated.body.asset.detail.startedOn).toBe('2025-04-01');
  });

  it('re-validates the whole detail, not just the fields sent', async () => {
    const created = await owner.post('/api/assets', sampleAssetBody('liability'));
    const id = created.body.asset.id as string;

    // Legal on its own; illegal against the principal already stored.
    const response = await owner.patch(`/api/assets/${id}`, {
      detail: { outstandingPaise: 99_00_000_00 },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.details).toHaveProperty('outstandingPaise');
  });

  it('archives rather than deletes, keeping the valuation history', async () => {
    const created = await owner.post('/api/assets', sampleAssetBody('deposit'));
    const id = created.body.asset.id as string;

    const archived = await owner.delete(`/api/assets/${id}`);
    expect(archived.status).toBe(200);
    expect(archived.body.asset.status).toBe('archived');

    const read = await owner.get(`/api/assets/${id}`);
    expect(read.status).toBe(200);
    expect(read.body.asset.latestValue.valuePaise).toBe(10_000_00);
  });
});

describe('listing assets', () => {
  beforeEach(async () => {
    for (const type of ASSET_TYPES) {
      await owner.post('/api/assets', sampleAssetBody(type, { instrumentId }));
    }
  });

  it('returns everything the caller owns', async () => {
    const response = await owner.get('/api/assets');
    expect(response.body.total).toBe(ASSET_TYPES.length);
  });

  it('filters by type', async () => {
    const response = await owner.get('/api/assets?type=property');
    expect(response.body.assets).toHaveLength(1);
    expect(response.body.assets[0].type).toBe('property');
  });

  it('searches name and institution without treating input as a wildcard', async () => {
    await owner.post('/api/assets', {
      ...sampleAssetBody('property'),
      name: '100% owned plot',
    });

    const literal = await owner.get('/api/assets?q=100%25');
    expect(literal.body.assets).toHaveLength(1);
    expect(literal.body.assets[0].name).toBe('100% owned plot');
  });

  it('sorts by latest value', async () => {
    const response = await owner.get('/api/assets?sort=value&order=desc&limit=3');
    const values = response.body.assets.map(
      (asset: { latestValue: { valuePaise: number } }) => asset.latestValue.valuePaise,
    );
    expect(values).toEqual([...values].sort((a: number, b: number) => b - a));
  });

  it('paginates without losing the total', async () => {
    const response = await owner.get('/api/assets?limit=2&offset=0');
    expect(response.body.assets).toHaveLength(2);
    expect(response.body.total).toBe(ASSET_TYPES.length);
  });

  it('counts by type and status for the filter chips', async () => {
    const response = await owner.get('/api/assets/counts');
    expect(response.body.counts).toHaveLength(ASSET_TYPES.length);
  });
});

describe('valuations', () => {
  let assetId: string;

  beforeEach(async () => {
    const created = await owner.post('/api/assets', sampleAssetBody('property'));
    assetId = created.body.asset.id as string;
  });

  it('appends rather than overwrites', async () => {
    await owner.post(`/api/assets/${assetId}/valuations`, {
      asOf: '2026-06-30',
      valuePaise: 45_00_000_00,
    });
    await owner.post(`/api/assets/${assetId}/valuations`, {
      asOf: '2026-09-30',
      valuePaise: 47_00_000_00,
    });

    const history = await owner.get(`/api/assets/${assetId}/valuations`);
    // Two appended plus the opening value the asset was created with.
    expect(history.body.valuations).toHaveLength(3);
    expect(history.body.valuations[0].asOf).toBe('2026-09-30');
  });

  it('lets a same-day correction win over what it corrected', async () => {
    await owner.post(`/api/assets/${assetId}/valuations`, {
      asOf: '2026-09-30',
      valuePaise: 45_00_000_00,
    });
    instance.advance(60);
    await owner.post(`/api/assets/${assetId}/valuations`, {
      asOf: '2026-09-30',
      valuePaise: 46_00_000_00,
    });

    const read = await owner.get(`/api/assets/${assetId}`);
    expect(read.body.asset.latestValue.valuePaise).toBe(46_00_000_00);
  });

  it('will not accept a source the client made up', async () => {
    const response = await owner.post(`/api/assets/${assetId}/valuations`, {
      asOf: '2026-09-30',
      valuePaise: 1,
      source: 'amfi',
    });
    expect(response.status).toBe(400);
  });
});

describe('transactions', () => {
  let assetId: string;

  beforeEach(async () => {
    const created = await owner.post('/api/assets', sampleAssetBody('holding', { instrumentId }));
    assetId = created.body.asset.id as string;
  });

  it('records a purchase and returns it in date order', async () => {
    await owner.post(`/api/assets/${assetId}/transactions`, {
      date: '2026-05-01',
      type: 'sip',
      units: 100_000_000,
      amountPaise: 10_000_00,
      priceMicro: 100_000_000,
    });
    await owner.post(`/api/assets/${assetId}/transactions`, {
      date: '2026-04-01',
      type: 'buy',
      units: 50_000_000,
      amountPaise: 5_000_00,
      priceMicro: 100_000_000,
    });

    const list = await owner.get(`/api/assets/${assetId}/transactions`);
    expect(list.body.transactions.map((t: { date: string }) => t.date)).toEqual([
      '2026-04-01',
      '2026-05-01',
    ]);
  });

  it('insists that a sell carries negative units', async () => {
    const response = await owner.post(`/api/assets/${assetId}/transactions`, {
      date: '2026-05-01',
      type: 'sell',
      units: 100_000_000,
      amountPaise: 10_000_00,
    });
    expect(response.status).toBe(400);
    expect(response.body.error.details).toHaveProperty('units');
  });

  it('re-checks the whole row when only the type is edited', async () => {
    const created = await owner.post(`/api/assets/${assetId}/transactions`, {
      date: '2026-05-01',
      type: 'buy',
      units: 100_000_000,
      amountPaise: 10_000_00,
    });

    const response = await owner.patch(
      `/api/assets/${assetId}/transactions/${created.body.transaction.id}`,
      { type: 'sell' },
    );
    expect(response.status).toBe(400);
  });

  it('deletes a transaction and writes it to the audit log', async () => {
    const created = await owner.post(`/api/assets/${assetId}/transactions`, {
      date: '2026-05-01',
      type: 'buy',
      units: 100_000_000,
      amountPaise: 10_000_00,
    });
    const transactionId = created.body.transaction.id as string;

    const deleted = await owner.delete(`/api/assets/${assetId}/transactions/${transactionId}`);
    expect(deleted.status).toBe(204);

    const list = await owner.get(`/api/assets/${assetId}/transactions`);
    expect(list.body.transactions).toHaveLength(0);

    // A deleted transaction leaves no other trace, which is exactly why it is audited.
    const audit = instance.sqlite
      .prepare<[], { entity_id: string }>(
        "SELECT entity_id FROM audit_log WHERE action = 'transaction.deleted'",
      )
      .get();
    expect(audit?.entity_id).toBe(transactionId);
  });

  it('refuses a transaction id belonging to another asset', async () => {
    const other = await owner.post('/api/assets', sampleAssetBody('deposit'));
    const created = await owner.post(`/api/assets/${assetId}/transactions`, {
      date: '2026-05-01',
      type: 'buy',
      units: 100_000_000,
      amountPaise: 10_000_00,
    });

    const response = await owner.delete(
      `/api/assets/${other.body.asset.id}/transactions/${created.body.transaction.id}`,
    );
    expect(response.status).toBe(404);
  });
});

describe('instruments', () => {
  it('returns the existing row rather than creating a duplicate', async () => {
    const again = await owner.post('/api/instruments', {
      kind: 'mf',
      name: 'Parag Parikh Flexi Cap Fund (Direct)',
      amfiSchemeCode: '122639',
    });

    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.instrument.id).toBe(instrumentId);
  });

  it('finds a scheme by code, ISIN or name', async () => {
    for (const query of ['122639', 'INF879O01027', 'Parag']) {
      const response = await owner.get(`/api/instruments?q=${query}`);
      expect(response.body.instruments, query).toHaveLength(1);
    }
  });

  it('refuses an instrument with nothing to look it up by', async () => {
    const response = await owner.post('/api/instruments', { kind: 'equity', name: 'Mystery Ltd' });
    expect(response.status).toBe(400);
  });
});
