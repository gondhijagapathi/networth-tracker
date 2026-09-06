/**
 * Cross-user isolation.
 *
 * The test this whole phase is built to pass: **user B gets a 404 on every one of user A's
 * assets**, on every endpoint, for every asset type. Not a 403 — existence itself is
 * private, and a 403 would confirm that the id being probed belongs to somebody.
 *
 * The rest of the file pins down the exceptions to that rule, because a permission system
 * with no way in is easy and useless: a grant makes rows readable, never writable; a summary
 * grant stops short of detail; and revoking or expiring a grant closes the door immediately.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASSET_TYPES, uuidv7, type AccessScope, type AssetType } from '@networth/shared';
import { accessGrants } from '../db/schema.js';
import { isoIn, isoNow } from '../lib/time.js';
import {
  TestClient,
  createEveryAssetType,
  createTestInstance,
  registerAdmin,
  registerMember,
  sampleAssetBody,
  type TestInstance,
} from './harness.js';

let instance: TestInstance;
let admin: TestClient;
let alice: TestClient;
let bob: TestClient;
let aliceAssets: Record<AssetType, { id: string }>;

beforeEach(async () => {
  instance = createTestInstance();
  admin = await registerAdmin(instance);
  alice = await registerMember(instance, admin, { email: 'alice@example.com', name: 'Alice' });
  bob = await registerMember(instance, admin, { email: 'bob@example.com', name: 'Bob' });
  aliceAssets = await createEveryAssetType(alice);
});

afterEach(() => {
  instance.close();
});

/** Insert a grant directly: the flows that create these arrive in P5 and P6. */
function grant(scope: AccessScope, options: { expiresAt?: string; revokedAt?: string } = {}): void {
  instance.ctx.db
    .insert(accessGrants)
    .values({
      id: uuidv7(),
      ownerUserId: alice.user!.id,
      granteeUserId: bob.user!.id,
      scope,
      source: 'manual',
      grantedAt: isoNow(instance.ctx.now()),
      expiresAt: options.expiresAt ?? null,
      revokedAt: options.revokedAt ?? null,
    })
    .run();
}

describe('a stranger sees nothing', () => {
  it.each(ASSET_TYPES)("returns 404 on every endpoint of another user's %s", async (type) => {
    const { id } = aliceAssets[type];

    expect((await bob.get(`/api/assets/${id}`)).status).toBe(404);
    expect((await bob.patch(`/api/assets/${id}`, { name: 'Mine now' })).status).toBe(404);
    expect((await bob.delete(`/api/assets/${id}`)).status).toBe(404);
    expect((await bob.get(`/api/assets/${id}/valuations`)).status).toBe(404);
    expect(
      (await bob.post(`/api/assets/${id}/valuations`, { asOf: '2026-09-06', valuePaise: 1 }))
        .status,
    ).toBe(404);
    expect((await bob.get(`/api/assets/${id}/transactions`)).status).toBe(404);
    expect(
      (
        await bob.post(`/api/assets/${id}/transactions`, {
          date: '2026-09-06',
          type: 'interest',
          amountPaise: 1,
        })
      ).status,
    ).toBe(404);
  });

  it("keeps another user's assets out of the list and the counts", async () => {
    const list = await bob.get('/api/assets');
    expect(list.body.total).toBe(0);

    const counts = await bob.get('/api/assets/counts');
    expect(counts.body.counts).toEqual([]);
  });

  it('gives an admin no more access to a member than anyone else has', async () => {
    // Admin is an operational role: it decides who may sign in, not who owns what.
    expect((await admin.get(`/api/assets/${aliceAssets.deposit.id}`)).status).toBe(404);
    expect((await admin.get('/api/assets')).body.total).toBe(0);
  });

  it('turns away an unauthenticated caller before anything else', async () => {
    const anonymous = new TestClient(instance.app);
    expect((await anonymous.get('/api/assets')).status).toBe(401);
    expect((await anonymous.get(`/api/assets/${aliceAssets.property.id}`)).status).toBe(401);
  });
});

describe('a grant opens reads and nothing else', () => {
  it("makes the owner's assets visible, flagged as shared", async () => {
    grant('full');

    const list = await bob.get('/api/assets');
    expect(list.body.total).toBe(ASSET_TYPES.length);
    expect(list.body.assets.every((asset: { shared: boolean }) => asset.shared)).toBe(true);

    const read = await bob.get(`/api/assets/${aliceAssets.property.id}`);
    expect(read.status).toBe(200);
    expect(read.body.asset.detail.khataNumber).toBe('K-4471');
  });

  it.each(ASSET_TYPES)('still refuses every write to a shared %s', async (type) => {
    grant('full');
    const { id } = aliceAssets[type];

    // A grant is read-only in every case. Refused as a 404 exactly like an unshared asset:
    // to a writer, an asset they may not write does not exist.
    expect((await bob.patch(`/api/assets/${id}`, { name: 'Mine now' })).status).toBe(404);
    expect((await bob.delete(`/api/assets/${id}`)).status).toBe(404);
    expect(
      (await bob.post(`/api/assets/${id}/valuations`, { asOf: '2026-09-06', valuePaise: 1 }))
        .status,
    ).toBe(404);
  });

  it('stops a summary grant short of the detail', async () => {
    grant('summary');

    const list = await bob.get('/api/assets');
    expect(list.body.total).toBe(ASSET_TYPES.length);
    // The value is the point of a summary; the policy number is not part of it.
    expect(list.body.assets[0].latestValue.valuePaise).toBe(10_000_00);

    const read = await bob.get(`/api/assets/${aliceAssets.insurance_policy.id}`);
    // 403 rather than 404 here, and only here: this caller has already seen the asset in
    // their own list, so pretending it does not exist would confuse rather than conceal.
    expect(read.status).toBe(403);
  });

  it('widens to the broadest grant when two exist', async () => {
    grant('summary');
    grant('full');
    expect((await bob.get(`/api/assets/${aliceAssets.deposit.id}`)).status).toBe(200);
  });

  it('closes the moment a grant is revoked', async () => {
    grant('full', { revokedAt: isoNow(instance.ctx.now()) });

    expect((await bob.get('/api/assets')).body.total).toBe(0);
    expect((await bob.get(`/api/assets/${aliceAssets.deposit.id}`)).status).toBe(404);
  });

  it('closes when a grant expires, without anything having to sweep it', async () => {
    // Well inside the access token's own lifetime, so what expires here is the grant and
    // nothing else — an expired session would produce the same empty list for the wrong
    // reason, which is why the status is asserted too.
    grant('full', { expiresAt: isoIn(60, instance.ctx.now()) });
    expect((await bob.get('/api/assets')).body.total).toBe(ASSET_TYPES.length);

    instance.advance(61);
    const after = await bob.get('/api/assets');
    expect(after.status).toBe(200);
    expect(after.body.total).toBe(0);
  });

  it('never lets a grant to somebody else reach a third party', async () => {
    grant('full');
    const carol = await registerMember(instance, admin, {
      email: 'carol@example.com',
      name: 'Carol',
    });
    expect((await carol.get('/api/assets')).body.total).toBe(0);
  });
});

describe('nominee accounts are read-only', () => {
  let nominee: TestClient;

  beforeEach(async () => {
    nominee = await registerMember(instance, admin, {
      email: 'heir@example.com',
      name: 'Heir',
      role: 'nominee',
    });
  });

  it('refuses every write, including to rows they would own', async () => {
    // Not a scoping question: this asset would belong to the nominee themselves, and it is
    // still refused. A nominee reads an estate; it never writes one.
    const response = await nominee.post('/api/assets', sampleAssetBody('deposit'));
    expect(response.status).toBe(403);
    expect(response.body.error.message).toMatch(/read-only/i);
  });

  it('refuses writes to an asset shared with them', async () => {
    instance.ctx.db
      .insert(accessGrants)
      .values({
        id: uuidv7(),
        ownerUserId: alice.user!.id,
        granteeUserId: nominee.user!.id,
        scope: 'full',
        source: 'nominee',
        grantedAt: isoNow(instance.ctx.now()),
      })
      .run();

    const { id } = aliceAssets.property;
    expect((await nominee.get(`/api/assets/${id}`)).status).toBe(200);
    expect((await nominee.patch(`/api/assets/${id}`, { name: 'Mine' })).status).toBe(403);
    expect((await nominee.delete(`/api/assets/${id}`)).status).toBe(403);
  });

  it('still allows reads', async () => {
    expect((await nominee.get('/api/assets')).status).toBe(200);
    expect((await nominee.get('/api/instruments?q=Test')).status).toBe(200);
  });
});
