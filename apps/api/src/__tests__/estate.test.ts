/**
 * Nominees, escrow, and the dead-man switch.
 *
 * The end-to-end path this file walks is the one the whole application exists for: an owner
 * names an heir, the heir gets an account, the owner wraps their data key to the heir's
 * public key, the key sits sealed, and then — either by the owner's decision or by ninety
 * days of silence — it opens and the heir reads a password they could not read yesterday.
 *
 * Everything else here is an assertion that it does *not* happen any other way.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateDeadManSwitches } from '../services/deadman.service.js';
import {
  createTestInstance,
  registerAdmin,
  type TestClient,
  type TestInstance,
} from './harness.js';
import {
  decrypt,
  encrypt,
  unwrapWithPrivateKey,
  vaultSetup,
  wrapToPublicKey,
  type TestKeypair,
} from './vaultCrypto.js';

const DAY = 86_400;

let instance: TestInstance;
let owner: TestClient;

beforeEach(async () => {
  // Long-lived tokens, because this file moves the clock by months. Signing back in after
  // every jump would work, and would also reset `last_active_at` — the very thing the
  // dead-man switch measures — so the act of observing the switch would keep cancelling it.
  instance = createTestInstance({ ACCESS_TOKEN_TTL: '400d', REFRESH_TOKEN_TTL: '500d' });
  owner = await registerAdmin(instance);
});

afterEach(() => {
  instance.close();
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

interface Estate {
  /** The heir's signed-in client. */
  heir: TestClient;
  heirKeys: TestKeypair;
  nomineeId: string;
  /** The owner's data key, as their browser holds it. */
  dek: CryptoKey;
  itemId: string;
}

/**
 * The full setup: an owner with a vault and one secret, an heir with an account and a
 * keypair, and a sealed escrow between them.
 */
async function establishEstate(
  options: { accessLevel?: 'summary' | 'full' | 'vault' } = {},
): Promise<Estate> {
  const ownerVault = await vaultSetup();
  await owner.post('/api/vault', ownerVault.body);

  const item = await owner.post('/api/vault/items', {
    kind: 'bank_login',
    payload: await encrypt(ownerVault.dek, JSON.stringify({ label: 'HDFC', secret: 'hunter2' })),
  });

  const created = await owner.post('/api/nominees', {
    name: 'Priya',
    email: 'priya@example.com',
    relation: 'spouse',
    accessLevel: options.accessLevel ?? 'vault',
  });
  expect(created.status).toBe(201);
  const nomineeId = created.body.nominee.id as string;

  const invited = await owner.post(`/api/nominees/${nomineeId}/invite`);
  expect(invited.status).toBe(201);

  const heir = new (await import('./harness.js')).TestClient(instance.app);
  const registration = await heir.post('/api/auth/register', {
    inviteCode: invited.body.code,
    email: 'priya@example.com',
    name: 'Priya',
    password: 'correct-horse-battery-staple',
  });
  expect(registration.status).toBe(201);
  heir.user = registration.body.user;

  const heirVault = await vaultSetup();
  expect((await heir.post('/api/vault', heirVault.body)).status).toBe(201);

  return {
    heir,
    heirKeys: heirVault.keypair,
    nomineeId,
    dek: ownerVault.dek,
    itemId: item.body.item.id as string,
  };
}

/** The owner's browser wrapping their data key to the heir's public key, and sealing it. */
async function sealFor(estate: Estate) {
  const key = await owner.get(`/api/nominees/${estate.nomineeId}/public-key`);
  expect(key.status).toBe(200);

  const { publicKeyFingerprint } = await import('@networth/shared');
  const response = await owner.post(`/api/nominees/${estate.nomineeId}/escrow`, {
    wrappedDek: await wrapToPublicKey(key.body.publicKeyJwk, estate.dek),
    publicKeyFingerprint: await publicKeyFingerprint(key.body.publicKeyJwk),
  });
  expect(response.status).toBe(201);
  return response.body.escrow as { state: string };
}

/* -------------------------------------------------------------------------- */
/* Nominations                                                                */
/* -------------------------------------------------------------------------- */

describe('nominations', () => {
  it('becomes a live grant when the heir registers', async () => {
    const estate = await establishEstate({ accessLevel: 'full' });

    const nominee = await owner.get(`/api/nominees/${estate.nomineeId}`);
    expect(nominee.body.nominee.status).toBe('accepted');
    expect(nominee.body.nominee.nomineeUserId).toBe(estate.heir.user!.id);
    expect(nominee.body.nominee.hasPublicKey).toBe(true);

    // The estate is readable through the ordinary asset endpoints, which is the point of
    // routing nominee access through `access_grants` rather than a parallel read path.
    await owner.post('/api/assets', {
      type: 'bank_account',
      name: 'Salary account',
      valuePaise: 500_000_00,
      detail: { accountNumber: '50100123456789', accountType: 'savings' },
    });

    const assets = await estate.heir.get('/api/assets');
    expect(assets.body.assets).toHaveLength(1);
    expect(assets.body.assets[0].name).toBe('Salary account');
  });

  it('refuses every write from a nominee account', async () => {
    const estate = await establishEstate({ accessLevel: 'full' });
    const asset = await owner.post('/api/assets', {
      type: 'bank_account',
      name: 'Salary account',
      detail: { accountNumber: '50100123456789', accountType: 'savings' },
    });

    expect(
      (await estate.heir.patch(`/api/assets/${asset.body.asset.id}`, { name: 'Mine now' })).status,
    ).toBe(403);
    expect((await estate.heir.delete(`/api/assets/${asset.body.asset.id}`)).status).toBe(403);
    expect((await estate.heir.post('/api/nominees', { name: 'Someone' })).status).toBe(403);
  });

  it('stops a summary nominee short of the detail', async () => {
    const estate = await establishEstate({ accessLevel: 'summary' });
    const asset = await owner.post('/api/assets', {
      type: 'insurance_policy',
      name: 'LIC Jeevan Anand',
      valuePaise: 200_000_00,
      detail: {
        policyNumber: '123456789',
        insurer: 'LIC',
        kind: 'endowment',
        sumAssuredPaise: 10_00_000_00,
        premiumPaise: 24_000_00,
        premiumFrequency: 'yearly',
      },
    });

    expect((await estate.heir.get('/api/assets')).body.assets).toHaveLength(1);
    expect((await estate.heir.get(`/api/assets/${asset.body.asset.id}`)).status).toBe(403);
    expect((await estate.heir.get('/api/estate/claim-kit?ownerId=' + owner.user!.id)).status).toBe(
      403,
    );
  });

  it('refuses to nominate yourself', async () => {
    const response = await owner.post('/api/nominees', {
      name: 'Me',
      email: owner.user!.email,
    });
    expect(response.status).toBe(400);
  });

  it('narrows access the moment the level is lowered', async () => {
    const estate = await establishEstate({ accessLevel: 'full' });
    const asset = await owner.post('/api/assets', {
      type: 'bank_account',
      name: 'Salary account',
      detail: { accountNumber: '50100123456789', accountType: 'savings' },
    });

    expect((await estate.heir.get(`/api/assets/${asset.body.asset.id}`)).status).toBe(200);

    await owner.patch(`/api/nominees/${estate.nomineeId}`, { accessLevel: 'summary' });
    expect((await estate.heir.get(`/api/assets/${asset.body.asset.id}`)).status).toBe(403);
  });

  it('closes everything on revocation', async () => {
    const estate = await establishEstate();
    await sealFor(estate);
    await owner.post(`/api/nominees/${estate.nomineeId}/release`);

    await owner.post('/api/assets', {
      type: 'bank_account',
      name: 'Salary account',
      detail: { accountNumber: '50100123456789', accountType: 'savings' },
    });
    expect((await estate.heir.get('/api/assets')).body.assets).toHaveLength(1);

    const revoked = await owner.delete(`/api/nominees/${estate.nomineeId}`);
    expect(revoked.body.nominee.status).toBe('revoked');

    expect((await estate.heir.get('/api/assets')).body.assets).toHaveLength(0);
    expect((await estate.heir.get('/api/estate')).body.estates).toHaveLength(0);
    expect((await estate.heir.post(`/api/estate/${owner.user!.id}/key`)).status).toBe(403);
  });
});

/* -------------------------------------------------------------------------- */
/* Escrow                                                                     */
/* -------------------------------------------------------------------------- */

describe('escrow', () => {
  it('will not seal to a key that is not the one on record', async () => {
    const estate = await establishEstate();
    const key = await owner.get(`/api/nominees/${estate.nomineeId}/public-key`);

    const response = await owner.post(`/api/nominees/${estate.nomineeId}/escrow`, {
      wrappedDek: await wrapToPublicKey(key.body.publicKeyJwk, estate.dek),
      publicKeyFingerprint: 'a'.repeat(43),
    });
    expect(response.status).toBe(400);
  });

  it('holds a sealed key back, and opens it on the owner’s word', async () => {
    const estate = await establishEstate();
    expect((await sealFor(estate)).state).toBe('sealed');

    // Sealed: visible as a state, and refused as a key.
    const before = await estate.heir.get('/api/estate');
    expect(before.body.estates[0]).toMatchObject({ escrowState: 'sealed', wrappedDek: null });
    expect((await estate.heir.post(`/api/estate/${owner.user!.id}/key`)).status).toBe(403);
    expect((await estate.heir.get(`/api/estate/${owner.user!.id}/items`)).status).toBe(403);

    const released = await owner.post(`/api/nominees/${estate.nomineeId}/release`);
    expect(released.body.escrow).toMatchObject({ state: 'released', releaseReason: 'owner' });

    // Released: the heir unwraps the data key with their own private key and reads a secret
    // that was unreadable to them one request ago.
    const key = await estate.heir.post(`/api/estate/${owner.user!.id}/key`);
    expect(key.status).toBe(200);

    const dek = await unwrapWithPrivateKey(estate.heirKeys.privateKey, key.body.wrappedDek);
    const items = await estate.heir.get(`/api/estate/${owner.user!.id}/items`);
    expect(await decrypt(dek, items.body.items[0].payload)).toContain('hunter2');
  });

  it('refuses vault items to a nominee whose access level stops short of the vault', async () => {
    const estate = await establishEstate({ accessLevel: 'full' });
    await sealFor(estate);
    await owner.post(`/api/nominees/${estate.nomineeId}/release`);

    // The escrow is open but the nomination never granted vault access. Both locks have to
    // be open, and this one is not.
    expect((await estate.heir.get(`/api/estate/${owner.user!.id}/items`)).status).toBe(403);
  });

  it('will not seal to a nominee who has not accepted or has no vault', async () => {
    const created = await owner.post('/api/nominees', {
      name: 'Unregistered',
      email: 'nobody@example.com',
      accessLevel: 'vault',
    });
    const response = await owner.post(`/api/nominees/${created.body.nominee.id}/escrow`, {
      wrappedDek: 'A'.repeat(342),
      publicKeyFingerprint: 'a'.repeat(43),
    });
    expect(response.status).toBe(400);
  });

  it('writes an audit row every time an escrowed key is read', async () => {
    const estate = await establishEstate();
    await sealFor(estate);
    await owner.post(`/api/nominees/${estate.nomineeId}/release`);

    await estate.heir.post(`/api/estate/${owner.user!.id}/key`);
    await estate.heir.post(`/api/estate/${owner.user!.id}/key`);

    const reads = instance.sqlite
      .prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'escrow.read'")
      .get() as { count: number };
    expect(reads.count).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Dead-man switch                                                            */
/* -------------------------------------------------------------------------- */

describe('the dead-man switch', () => {
  async function enable(inactivityDays = 90, graceDays = 7) {
    const response = await owner.put('/api/estate/deadman', {
      enabled: true,
      inactivityDays,
      graceDays,
    });
    expect(response.status).toBe(200);
    return response.body.deadman;
  }

  it('refuses a window short enough to trip on a holiday', async () => {
    expect(
      (await owner.put('/api/estate/deadman', { enabled: true, inactivityDays: 14, graceDays: 7 }))
        .status,
    ).toBe(400);
    expect(
      (await owner.put('/api/estate/deadman', { enabled: true, inactivityDays: 30, graceDays: 30 }))
        .status,
    ).toBe(400);
  });

  it('escalates through its warnings and then fires', async () => {
    const estate = await establishEstate();
    await sealFor(estate);
    await enable(90, 7);

    const stageNow = () => {
      evaluateDeadManSwitches(instance.ctx);
      return (
        instance.sqlite
          .prepare('SELECT stage FROM dead_man_switch WHERE user_id = ?')
          .get(owner.user!.id) as { stage: string }
      ).stage;
    };

    expect(stageNow()).toBe('idle');
    instance.advance(46 * DAY);
    expect(stageNow()).toBe('warned_50');
    instance.advance(23 * DAY);
    expect(stageNow()).toBe('warned_75');
    instance.advance(14 * DAY);
    expect(stageNow()).toBe('warned_90');

    instance.advance(10 * DAY);
    expect(stageNow()).toBe('grace');
    // Still sealed: the grace period is exactly the window in which nothing has happened yet.
    expect((await estate.heir.post(`/api/estate/${owner.user!.id}/key`)).status).toBe(403);

    instance.advance(8 * DAY);
    expect(stageNow()).toBe('fired');

    const key = await estate.heir.post(`/api/estate/${owner.user!.id}/key`);
    expect(key.status).toBe(200);
    const dek = await unwrapWithPrivateKey(estate.heirKeys.privateKey, key.body.wrappedDek);
    const items = await estate.heir.get(`/api/estate/${owner.user!.id}/items`);
    expect(await decrypt(dek, items.body.items[0].payload)).toContain('hunter2');

    const escrow = instance.sqlite
      .prepare('SELECT state, release_reason FROM vault_escrow WHERE owner_user_id = ?')
      .get(owner.user!.id) as { state: string; release_reason: string };
    expect(escrow).toEqual({ state: 'released', release_reason: 'deadman' });
  });

  it('is cancelled by a single check-in during the grace period', async () => {
    const estate = await establishEstate();
    await sealFor(estate);
    await enable(30, 7);

    instance.advance(31 * DAY);
    evaluateDeadManSwitches(instance.ctx);
    expect((await owner.get('/api/estate/deadman')).body.deadman.stage).toBe('grace');

    const cancelled = await owner.post('/api/estate/deadman/cancel');
    expect(cancelled.body.deadman.stage).toBe('idle');
    expect(cancelled.body.deadman.graceStartedAt).toBeNull();

    // Six days later — inside what would have been the grace window — nothing has fired.
    instance.advance(6 * DAY);
    evaluateDeadManSwitches(instance.ctx);
    expect((await owner.get('/api/estate/deadman')).body.deadman.stage).toBe('idle');
    expect((await estate.heir.post(`/api/estate/${owner.user!.id}/key`)).status).toBe(403);
  });

  it('does not fire while it is switched off', async () => {
    const estate = await establishEstate();
    await sealFor(estate);
    await owner.put('/api/estate/deadman', { enabled: false, inactivityDays: 30, graceDays: 7 });

    instance.advance(300 * DAY);
    const result = evaluateDeadManSwitches(instance.ctx);
    expect(result.fired).toEqual([]);
    expect((await estate.heir.post(`/api/estate/${owner.user!.id}/key`)).status).toBe(403);
  });

  it('counts silence from the moment it is switched on, not from before', async () => {
    await establishEstate();
    instance.advance(200 * DAY);

    await owner.put('/api/estate/deadman', { enabled: true, inactivityDays: 30, graceDays: 7 });
    const status = evaluateDeadManSwitches(instance.ctx);
    expect(status.graced).toEqual([]);
    expect((await owner.get('/api/estate/deadman')).body.deadman.stage).toBe('idle');
  });

  it('reports how long is left and how many keys are at stake', async () => {
    const estate = await establishEstate();
    await sealFor(estate);
    await enable(90, 7);

    instance.advance(30 * DAY);
    const status = (await owner.get('/api/estate/deadman')).body.deadman;
    expect(status.sealedEscrowCount).toBe(1);
    expect(status.daysUntilGrace).toBeGreaterThan(55);
    expect(status.daysUntilGrace).toBeLessThanOrEqual(60);
  });
});

/* -------------------------------------------------------------------------- */
/* Claim kit                                                                  */
/* -------------------------------------------------------------------------- */

describe('the claim kit', () => {
  it('pairs each asset with the forms its institution asks for', async () => {
    const ownerVault = await vaultSetup();
    await owner.post('/api/vault', ownerVault.body);

    const asset = await owner.post('/api/assets', {
      type: 'bank_account',
      name: 'HDFC savings',
      institution: 'HDFC Bank',
      valuePaise: 500_000_00,
      detail: { accountNumber: '50100123456789', accountType: 'savings' },
    });
    await owner.post('/api/vault/items', {
      kind: 'bank_login',
      assetId: asset.body.asset.id,
      payload: await encrypt(ownerVault.dek, JSON.stringify({ label: 'netbanking' })),
    });

    const kit = await owner.get('/api/estate/claim-kit');
    expect(kit.status).toBe(200);

    const entry = kit.body.entries[0];
    expect(entry.name).toBe('HDFC savings');
    // Masked, as it is stored. The full number is a vault item the browser merges in.
    expect(entry.reference).toContain('6789');
    expect(entry.procedure.forms).toContain('Form DA-1 (nominee claim)');
    expect(entry.vaultItemIds).toHaveLength(1);
    expect(kit.body.totals.unnominatedPaise).toBe(500_000_00);
  });

  it('carries no plaintext from the vault', async () => {
    const ownerVault = await vaultSetup();
    await owner.post('/api/vault', ownerVault.body);
    await owner.post('/api/vault/items', {
      kind: 'bank_login',
      payload: await encrypt(ownerVault.dek, JSON.stringify({ secret: 'hunter2' })),
    });

    const kit = await owner.get('/api/estate/claim-kit');
    expect(JSON.stringify(kit.body)).not.toContain('hunter2');
  });

  it('is available to an heir with full access, for their own estate only', async () => {
    const estate = await establishEstate({ accessLevel: 'full' });
    await owner.post('/api/assets', {
      type: 'deposit',
      name: 'SBI fixed deposit',
      valuePaise: 100_000_00,
      detail: {
        kind: 'fd',
        principalPaise: 100_000_00,
        rateBps: 710,
        compounding: 'quarterly',
        startedOn: '2025-04-01',
      },
    });

    const kit = await estate.heir.get(`/api/estate/claim-kit?ownerId=${owner.user!.id}`);
    expect(kit.status).toBe(200);
    expect(kit.body.entries).toHaveLength(1);
    expect(kit.body.nominees[0].name).toBe('Priya');

    expect(
      (await estate.heir.get('/api/estate/claim-kit?ownerId=00000000-0000-7000-8000-000000000000'))
        .status,
    ).toBe(404);
  });
});
