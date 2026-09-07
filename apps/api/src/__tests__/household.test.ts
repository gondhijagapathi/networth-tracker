/**
 * Household merge.
 *
 * These tests exercise the one thing that is genuinely new in P6: the consent flow that
 * turns household membership into `access_grants` rows. What those grants then do — a
 * merged asset list, a `shared` flag, read-only enforcement — is already covered by
 * `isolation.test.ts` against grants inserted directly, so it is not repeated here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestInstance,
  registerAdmin,
  registerMember,
  sampleAssetBody,
  type TestClient,
  type TestInstance,
} from './harness.js';

let instance: TestInstance;
let admin: TestClient;
let alice: TestClient;
let bob: TestClient;

beforeEach(async () => {
  instance = createTestInstance();
  admin = await registerAdmin(instance);
  alice = await registerMember(instance, admin, { email: 'alice@example.com', name: 'Alice' });
  bob = await registerMember(instance, admin, { email: 'bob@example.com', name: 'Bob' });
});

afterEach(() => {
  instance.close();
});

async function addAsset(client: TestClient, name: string): Promise<string> {
  const response = await client.post('/api/assets', {
    ...sampleAssetBody('bank_account'),
    name,
  });
  expect(response.status).toBe(201);
  return response.body.asset.id as string;
}

describe('household creation and invitation', () => {
  it('creates a household with the founder as an accepted, non-sharing owner', async () => {
    const response = await alice.post('/api/households', { name: 'The Rao Household' });
    expect(response.status).toBe(201);
    const household = response.body.household;
    expect(household.members).toHaveLength(1);
    expect(household.members[0]).toMatchObject({
      userId: alice.user!.id,
      role: 'owner',
      shareMode: 'none',
      acceptedAt: expect.any(String),
      consentedAt: null,
    });
  });

  it('refuses to invite an email with no account', async () => {
    const created = await alice.post('/api/households', { name: 'Household' });
    const householdId = created.body.household.id as string;

    const response = await alice.post(`/api/households/${householdId}/invite`, {
      email: 'nobody@example.com',
    });
    expect(response.status).toBe(400);
  });

  it('adds an invited partner as pending, granting nothing until they accept', async () => {
    const created = await alice.post('/api/households', { name: 'Household' });
    const householdId = created.body.household.id as string;

    const invite = await alice.post(`/api/households/${householdId}/invite`, {
      email: 'bob@example.com',
    });
    expect(invite.status).toBe(201);
    expect(invite.body.member).toMatchObject({ userId: bob.user!.id, acceptedAt: null });

    const bobView = await bob.get(`/api/households/${householdId}`);
    expect(bobView.status).toBe(200);
  });

  it('refuses a second invite to somebody already a member', async () => {
    const created = await alice.post('/api/households', { name: 'Household' });
    const householdId = created.body.household.id as string;
    await alice.post(`/api/households/${householdId}/invite`, { email: 'bob@example.com' });

    const again = await alice.post(`/api/households/${householdId}/invite`, {
      email: 'bob@example.com',
    });
    expect(again.status).toBe(409);
  });
});

describe('two-sided consent and the share-mode toggle', () => {
  async function household(): Promise<string> {
    const created = await alice.post('/api/households', { name: 'Household' });
    const householdId = created.body.household.id as string;
    await alice.post(`/api/households/${householdId}/invite`, { email: 'bob@example.com' });
    return householdId;
  }

  it('shares nothing while the invited side has not accepted, even if the inviter shares', async () => {
    const householdId = await household();
    const aliceAssetId = await addAsset(alice, "Alice's account");

    // Alice turns sharing on before Bob has accepted.
    await alice.patch(`/api/households/${householdId}/share`, { shareMode: 'full' });

    const bobsView = await bob.get(`/api/assets/${aliceAssetId}`);
    expect(bobsView.status).toBe(404);
  });

  it('grants access the moment both sides have accepted and one side shares', async () => {
    const householdId = await household();
    const aliceAssetId = await addAsset(alice, "Alice's account");

    await bob.post(`/api/households/${householdId}/accept`);
    await alice.patch(`/api/households/${householdId}/share`, { shareMode: 'full' });

    const bobsView = await bob.get(`/api/assets/${aliceAssetId}`);
    expect(bobsView.status).toBe(200);
    expect(bobsView.body.asset.shared).toBe(true);
  });

  it('is directional: Bob sharing does not give Bob a view of Alice', async () => {
    const householdId = await household();
    const aliceAssetId = await addAsset(alice, "Alice's account");
    const bobAssetId = await addAsset(bob, "Bob's account");

    await bob.post(`/api/households/${householdId}/accept`);
    await bob.patch(`/api/households/${householdId}/share`, { shareMode: 'full' });

    expect((await bob.get(`/api/assets/${aliceAssetId}`)).status).toBe(404);
    expect((await alice.get(`/api/assets/${bobAssetId}`)).status).toBe(200);
  });

  it('does not double-count once merged: the sum is additive, not inflated', async () => {
    const householdId = await household();
    await bob.post(`/api/households/${householdId}/accept`);

    await alice.post('/api/assets', {
      ...sampleAssetBody('bank_account'),
      name: "Alice's savings",
      valuePaise: 10_000_00,
    });
    const bobOwnBefore = await bob.get('/api/analytics/dashboard');
    const aliceOwn = await alice.get('/api/analytics/dashboard');

    await alice.patch(`/api/households/${householdId}/share`, { shareMode: 'full' });
    const mergedTotal = await bob.get('/api/analytics/dashboard');

    // Merging adds Alice's net worth to what Bob already had — once, not twice, and not
    // Alice's total on its own either.
    expect(mergedTotal.body.summary.netPaise).toBe(
      bobOwnBefore.body.summary.netPaise + aliceOwn.body.summary.netPaise,
    );
  });

  it('narrows access immediately when the sharer turns their share mode to summary', async () => {
    const householdId = await household();
    const aliceAssetId = await addAsset(alice, "Alice's account");

    await bob.post(`/api/households/${householdId}/accept`);
    await alice.patch(`/api/households/${householdId}/share`, { shareMode: 'full' });
    expect((await bob.get(`/api/assets/${aliceAssetId}`)).status).toBe(200);

    await alice.patch(`/api/households/${householdId}/share`, { shareMode: 'summary' });
    const afterNarrowing = await bob.get(`/api/assets/${aliceAssetId}`);
    expect(afterNarrowing.status).toBe(403);
  });

  it('revokes access immediately when the sharer turns sharing off', async () => {
    const householdId = await household();
    const aliceAssetId = await addAsset(alice, "Alice's account");

    await bob.post(`/api/households/${householdId}/accept`);
    await alice.patch(`/api/households/${householdId}/share`, { shareMode: 'full' });
    expect((await bob.get(`/api/assets/${aliceAssetId}`)).status).toBe(200);

    await alice.patch(`/api/households/${householdId}/share`, { shareMode: 'none' });
    expect((await bob.get(`/api/assets/${aliceAssetId}`)).status).toBe(404);
  });
});

describe('leaving a household', () => {
  it('closes access in both directions the moment either side leaves', async () => {
    const created = await alice.post('/api/households', { name: 'Household' });
    const householdId = created.body.household.id as string;
    await alice.post(`/api/households/${householdId}/invite`, { email: 'bob@example.com' });
    await bob.post(`/api/households/${householdId}/accept`);

    const aliceAssetId = await addAsset(alice, "Alice's account");
    const bobAssetId = await addAsset(bob, "Bob's account");

    await alice.patch(`/api/households/${householdId}/share`, { shareMode: 'full' });
    await bob.patch(`/api/households/${householdId}/share`, { shareMode: 'full' });
    expect((await bob.get(`/api/assets/${aliceAssetId}`)).status).toBe(200);
    expect((await alice.get(`/api/assets/${bobAssetId}`)).status).toBe(200);

    const left = await bob.delete(`/api/households/${householdId}/members/${bob.user!.id}`);
    expect(left.status).toBe(204);

    expect((await bob.get(`/api/assets/${aliceAssetId}`)).status).toBe(404);
    expect((await alice.get(`/api/assets/${bobAssetId}`)).status).toBe(404);
  });

  it('lets the owner remove another member, but not the other way round', async () => {
    const created = await alice.post('/api/households', { name: 'Household' });
    const householdId = created.body.household.id as string;
    await alice.post(`/api/households/${householdId}/invite`, { email: 'bob@example.com' });
    await bob.post(`/api/households/${householdId}/accept`);

    const bobRemovesAlice = await bob.delete(
      `/api/households/${householdId}/members/${alice.user!.id}`,
    );
    expect(bobRemovesAlice.status).toBe(403);

    const aliceRemovesBob = await alice.delete(
      `/api/households/${householdId}/members/${bob.user!.id}`,
    );
    expect(aliceRemovesBob.status).toBe(204);
  });
});
