/**
 * Vault endpoints.
 *
 * The test client plays the browser: it encrypts, posts ciphertext, reads it back and
 * decrypts. That shape is the point — it makes "the server cannot read this" a property the
 * suite demonstrates rather than a comment in a file.
 *
 * Four claims are worth having tests for, and they are the four this file is organised
 * around: a round trip survives, a wrong passphrase fails, a plaintext-shaped payload is
 * refused at the door, and no other user can reach any of it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestInstance,
  registerAdmin,
  registerMember,
  type TestClient,
  type TestInstance,
} from './harness.js';
import {
  decrypt,
  decryptBytes,
  encrypt,
  encryptBytes,
  randomKey,
  unwrapKey,
  vaultSetup,
  wrapKey,
} from './vaultCrypto.js';

let instance: TestInstance;
let owner: TestClient;

beforeEach(async () => {
  instance = createTestInstance();
  owner = await registerAdmin(instance);
});

afterEach(() => {
  instance.close();
});

/** Set the vault up and return the data key the "browser" holds. */
async function setUpVault(client: TestClient) {
  const setup = await vaultSetup();
  const response = await client.post('/api/vault', setup.body);
  expect(response.status).toBe(201);
  return setup;
}

/** Post one encrypted item and return the server's record of it. */
async function addItem(client: TestClient, dek: CryptoKey, payload: unknown, assetId?: string) {
  const response = await client.post('/api/vault/items', {
    kind: 'bank_login',
    ...(assetId === undefined ? {} : { assetId }),
    payload: await encrypt(dek, JSON.stringify(payload)),
  });
  expect(response.status).toBe(201);
  return response.body.item as { id: string; payload: { v: number; iv: string; ct: string } };
}

describe('vault setup', () => {
  it('reports an uninitialised vault without handing out key material', async () => {
    const response = await owner.get('/api/vault');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ initialised: false, itemCount: 0, documentCount: 0 });
    expect(response.body.keys).toBeNull();
  });

  it('stores key material and never a verifier', async () => {
    await setUpVault(owner);

    const status = await owner.get('/api/vault');
    expect(status.body.initialised).toBe(true);
    // Even after setup, the status route carries no keys: retrieval is metered separately.
    expect(status.body.keys).toBeNull();

    const stored = instance.sqlite
      .prepare('SELECT * FROM vault_keys WHERE user_id = ?')
      .get(owner.user!.id) as Record<string, string>;

    // Whatever is in this row, none of it may be usable without the passphrase. The columns
    // are asserted by name so that adding a "password_check" column later fails here.
    expect(Object.keys(stored).sort()).toEqual([
      'created_at',
      'kdf_params',
      'kdf_salt',
      'public_key_jwk',
      'updated_at',
      'user_id',
      'wrapped_dek',
      'wrapped_private_key',
    ]);
  });

  it('refuses to create a second vault over the first', async () => {
    await setUpVault(owner);
    const setup = await vaultSetup();
    const response = await owner.post('/api/vault', setup.body);
    expect(response.status).toBe(409);
  });

  it('hands back key material on unlock, and that material opens the vault', async () => {
    const { kek, dek } = await setUpVault(owner);
    const item = await addItem(owner, dek, { label: 'HDFC netbanking', secret: 'hunter2' });

    const unlock = await owner.post('/api/vault/unlock');
    expect(unlock.status).toBe(200);

    const recovered = await unwrapKey(kek, unlock.body.keys.wrappedDek);
    expect(await decrypt(recovered, item.payload)).toContain('hunter2');
  });

  it('fails to unwrap under the wrong passphrase', async () => {
    await setUpVault(owner);
    const unlock = await owner.post('/api/vault/unlock');

    // A different derived key is exactly what a wrong passphrase produces. GCM's tag is
    // what rejects it, in the browser — the server was never asked and never knew.
    const wrongKek = await randomKey();
    await expect(unwrapKey(wrongKek, unlock.body.keys.wrappedDek)).rejects.toThrow();
  });
});

describe('vault items', () => {
  it('round-trips a secret through the API unchanged', async () => {
    const { dek } = await setUpVault(owner);
    const secret = { label: 'ICICI', username: 'jaga', secret: 'p@ssw0rd', notes: 'locker 44' };

    const created = await addItem(owner, dek, secret);
    const fetched = await owner.get(`/api/vault/items/${created.id}`);

    expect(JSON.parse(await decrypt(dek, fetched.body.item.payload))).toEqual(secret);
  });

  it('stores nothing but the kind and the link in the clear', async () => {
    const { dek } = await setUpVault(owner);
    const created = await addItem(owner, dek, { label: 'SBI', secret: 'correct-horse' });

    const row = instance.sqlite
      .prepare('SELECT * FROM vault_items WHERE id = ?')
      .get(created.id) as Record<string, unknown>;

    expect(row.kind).toBe('bank_login');
    expect(JSON.stringify(row)).not.toContain('correct-horse');
    expect(JSON.stringify(row)).not.toContain('SBI');
  });

  it('updates and deletes', async () => {
    const { dek } = await setUpVault(owner);
    const created = await addItem(owner, dek, { label: 'old' });

    const updated = await owner.patch(`/api/vault/items/${created.id}`, {
      payload: await encrypt(dek, JSON.stringify({ label: 'new' })),
    });
    expect(updated.status).toBe(200);
    expect(await decrypt(dek, updated.body.item.payload)).toContain('new');

    expect((await owner.delete(`/api/vault/items/${created.id}`)).status).toBe(204);
    expect((await owner.get(`/api/vault/items/${created.id}`)).status).toBe(404);
  });

  it('refuses an item before the vault exists', async () => {
    const dek = await randomKey();
    const response = await owner.post('/api/vault/items', {
      kind: 'note',
      payload: await encrypt(dek, 'anything'),
    });
    expect(response.status).toBe(400);
  });

  it('links an item to an asset the caller owns, and to nobody else’s', async () => {
    const { dek } = await setUpVault(owner);
    const asset = await owner.post('/api/assets', {
      type: 'bank_account',
      name: 'Salary account',
      detail: { accountNumber: '50100123456789', accountType: 'savings' },
    });

    const linked = await addItem(owner, dek, { label: 'login' }, asset.body.asset.id as string);
    expect(
      (await owner.get(`/api/vault/items?assetId=${asset.body.asset.id}`)).body.items,
    ).toHaveLength(1);
    expect(linked.id).toBeTruthy();

    const stranger = await registerMember(instance, owner, { email: 'other@example.com' });
    const theirSetup = await vaultSetup();
    await stranger.post('/api/vault', theirSetup.body);

    const response = await stranger.post('/api/vault/items', {
      kind: 'bank_login',
      assetId: asset.body.asset.id,
      payload: await encrypt(theirSetup.dek, 'x'),
    });
    // Not a 403: confirming that somebody else's asset id exists is itself a leak.
    expect(response.status).toBe(404);
  });
});

describe('plaintext is refused at the door', () => {
  const cases: Array<[string, unknown]> = [
    ['a bare string', 'hunter2'],
    ['an object that looks like a secret', { label: 'HDFC', password: 'hunter2' }],
    ['an envelope with no ciphertext', { v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: '' }],
    [
      'an initialisation vector of the wrong length',
      { v: 1, iv: 'AAAA', ct: 'AAAAAAAAAAAAAAAAAAAAAA' },
    ],
    ['ciphertext shorter than a GCM tag', { v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAA' }],
    ['an unknown envelope version', { v: 2, iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAAAAAAAAAAAAAAAAAAAA' }],
    ['ciphertext that is not base64url', { v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'not base64!!' }],
  ];

  it.each(cases)('rejects %s', async (_label, payload) => {
    await setUpVault(owner);
    const response = await owner.post('/api/vault/items', { kind: 'note', payload });
    expect(response.status).toBe(400);
  });

  it('rejects an extra field alongside a valid envelope', async () => {
    const { dek } = await setUpVault(owner);
    const response = await owner.post('/api/vault/items', {
      kind: 'note',
      payload: { ...(await encrypt(dek, 'fine')), plaintext: 'not fine' },
    });
    expect(response.status).toBe(400);
  });
});

describe('unlock backoff', () => {
  it('backs off after repeated retrievals and forgets them once one succeeds', async () => {
    await setUpVault(owner);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await owner.post('/api/vault/unlock')).status).toBe(200);
    }
    expect((await owner.post('/api/vault/unlock')).status).toBe(429);

    // Time passes and the client reports that it got in; the budget resets.
    instance.advance(60);
    expect((await owner.post('/api/vault/unlock/confirm')).status).toBe(204);
    expect((await owner.post('/api/vault/unlock')).status).toBe(200);
  });
});

describe('rekey', () => {
  it('changes the wrapping without touching a single item', async () => {
    const { dek } = await setUpVault(owner);
    const item = await addItem(owner, dek, { label: 'PPF', secret: 'kept' });

    const newKek = await randomKey();
    const setup = await vaultSetup();
    const response = await owner.post('/api/vault/rekey', {
      kdfSalt: setup.body.kdfSalt,
      kdfParams: setup.body.kdfParams,
      wrappedDek: await wrapKey(newKek, dek),
      wrappedPrivateKey: setup.body.wrappedPrivateKey,
    });
    expect(response.status).toBe(200);

    const unlock = await owner.post('/api/vault/unlock');
    const recovered = await unwrapKey(newKek, unlock.body.keys.wrappedDek);

    // The same data key comes back out, so the item written before the passphrase changed
    // still opens. That is the whole reason a data key exists.
    const fetched = await owner.get(`/api/vault/items/${item.id}`);
    expect(await decrypt(recovered, fetched.body.item.payload)).toContain('kept');
  });
});

describe('encrypted documents', () => {
  const meta = (envelope: unknown) => Buffer.from(JSON.stringify(envelope)).toString('base64url');

  it('stores, lists, returns and deletes an encrypted file', async () => {
    const { dek } = await setUpVault(owner);
    const original = new TextEncoder().encode('%PDF-1.4 policy document');
    const blob = await encryptBytes(dek, original);

    const encryptedName = await encrypt(
      dek,
      JSON.stringify({ filename: 'policy.pdf', mime: 'application/pdf' }),
    );
    const upload = await uploadDocument(owner, blob, meta(encryptedName));
    expect(upload.status).toBe(201);

    const list = await owner.get('/api/vault/documents');
    expect(list.body.documents).toHaveLength(1);
    expect(await decrypt(dek, list.body.documents[0].meta)).toContain('policy.pdf');

    const content = await owner.get(`/api/vault/documents/${upload.body.document.id}/content`);
    expect(content.status).toBe(200);
    expect(await decryptBytes(dek, Buffer.from(content.body))).toEqual(original);

    expect((await owner.delete(`/api/vault/documents/${upload.body.document.id}`)).status).toBe(
      204,
    );
    expect((await owner.get('/api/vault/documents')).body.documents).toHaveLength(0);
  });

  it('refuses an upload that is too short to be ciphertext', async () => {
    const { dek } = await setUpVault(owner);
    const response = await uploadDocument(
      owner,
      Buffer.from('plain'),
      meta(await encrypt(dek, JSON.stringify({ filename: 'a.txt', mime: 'text/plain' }))),
    );
    expect(response.status).toBe(400);
  });

  it('refuses an upload with no encrypted metadata', async () => {
    const { dek } = await setUpVault(owner);
    const blob = await encryptBytes(dek, new TextEncoder().encode('hello'));
    const response = await uploadDocument(owner, blob, undefined);
    expect(response.status).toBe(400);
  });
});

describe('isolation', () => {
  it('never shows one user another user’s vault', async () => {
    const { dek } = await setUpVault(owner);
    const mine = await addItem(owner, dek, { label: 'mine', secret: 'private' });

    const stranger = await registerMember(instance, owner, { email: 'stranger@example.com' });
    const theirs = await vaultSetup();
    await stranger.post('/api/vault', theirs.body);

    expect((await stranger.get('/api/vault/items')).body.items).toHaveLength(0);
    expect((await stranger.get(`/api/vault/items/${mine.id}`)).status).toBe(404);
    expect((await stranger.patch(`/api/vault/items/${mine.id}`, { kind: 'note' })).status).toBe(
      404,
    );
    expect((await stranger.delete(`/api/vault/items/${mine.id}`)).status).toBe(404);

    // Their own vault is real and separate: this is isolation, not an empty database.
    expect((await stranger.get('/api/vault')).body.initialised).toBe(true);
  });
});

/**
 * Supertest's fluent builder does not fit the cookie-carrying client, so the one binary
 * upload in the suite is spelled out here rather than bent into it.
 */
async function uploadDocument(client: TestClient, blob: Buffer, metaHeader: string | undefined) {
  const supertest = (await import('supertest')).default;
  let request = supertest(instance.app)
    .post('/api/vault/documents')
    .set('Cookie', cookieHeader(client))
    .set('content-type', 'application/octet-stream');

  if (client.csrfToken) request = request.set('x-csrf-token', client.csrfToken);
  if (metaHeader !== undefined) request = request.set('x-vault-meta', metaHeader);

  return request.send(blob);
}

function cookieHeader(client: TestClient): string {
  return [
    `nt_access=${client.accessToken ?? ''}`,
    `nt_refresh=${client.refreshToken ?? ''}`,
    `nt_csrf=${client.csrfToken ?? ''}`,
  ].join('; ');
}
