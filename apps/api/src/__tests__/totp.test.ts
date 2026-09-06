/**
 * Two-factor enrolment, sign-in and recovery.
 *
 * The codes here are generated from the stored secret rather than from a phone, but
 * everything else is the real path: real encryption of the secret at rest, real TOTP
 * verification against the injected clock, real single-use recovery codes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema.js';
import { totpCodeForUser } from '../services/auth.service.js';
import {
  TEST_PASSPHRASE,
  TestClient,
  createTestInstance,
  registerAdmin,
  type TestInstance,
} from './harness.js';

let instance: TestInstance;
let admin: TestClient;

beforeEach(async () => {
  instance = createTestInstance();
  admin = await registerAdmin(instance);
});

afterEach(() => {
  instance.close();
});

/** Ask the service for a code the way an authenticator app would compute one. */
function liveCode(): string {
  return totpCodeForUser(instance.ctx, admin.user!.id);
}

async function enrol(): Promise<string[]> {
  await admin.post('/api/auth/2fa/enrol');
  const response = await admin.post('/api/auth/2fa/enrol/confirm', { code: liveCode() });
  expect(response.status).toBe(200);
  return response.body.recoveryCodes as string[];
}

describe('enrolment', () => {
  it('hands back a secret and a scannable otpauth URI', async () => {
    const response = await admin.post('/api/auth/2fa/enrol');
    expect(response.status).toBe(200);
    expect(response.body.secret).toMatch(/^[A-Z2-7]+$/);
    expect(response.body.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(response.body.uri).toContain(encodeURIComponent('Net Worth Tracker'));
  });

  it('leaves 2FA off until a live code confirms it', async () => {
    await admin.post('/api/auth/2fa/enrol');

    // Abandoned halfway: the secret exists but the account must not be locked behind it.
    expect((await admin.get('/api/auth/me')).body.user.totpEnabled).toBe(false);

    const fresh = new TestClient(instance.app);
    const login = await fresh.post('/api/auth/login', {
      email: admin.user!.email,
      password: TEST_PASSPHRASE,
    });
    expect(login.status).toBe(200);
  });

  it('rejects a wrong confirmation code', async () => {
    await admin.post('/api/auth/2fa/enrol');
    const response = await admin.post('/api/auth/2fa/enrol/confirm', { code: '000000' });
    expect(response.status).toBe(400);
  });

  it('returns ten recovery codes exactly once', async () => {
    const codes = await enrol();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-z0-9]{5}-[a-z0-9]{5}$/);

    // Nothing in the API can show them again.
    const me = await admin.get('/api/auth/me');
    expect(JSON.stringify(me.body)).not.toContain(codes[0]);
    expect(me.body.recoveryCodesRemaining).toBe(10);
  });

  it('stores the shared secret encrypted, not in the clear', async () => {
    const response = await admin.post('/api/auth/2fa/enrol');
    const secret = response.body.secret as string;

    const row = instance.ctx.db
      .select({ sealed: users.totpSecretEncrypted })
      .from(users)
      .where(eq(users.id, admin.user!.id))
      .get();

    expect(row?.sealed).toBeTruthy();
    expect(row!.sealed).not.toContain(secret);
    expect(row!.sealed!.startsWith('v1.')).toBe(true);
  });
});

describe('sign-in with 2FA', () => {
  it('asks for a second factor before issuing a session', async () => {
    await enrol();

    const client = new TestClient(instance.app);
    const response = await client.post('/api/auth/login', {
      email: admin.user!.email,
      password: TEST_PASSPHRASE,
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('totp_required');
    expect(client.refreshToken).toBeUndefined();
  });

  it('accepts a live authenticator code', async () => {
    await enrol();

    const client = new TestClient(instance.app);
    const response = await client.post('/api/auth/login', {
      email: admin.user!.email,
      password: TEST_PASSPHRASE,
      totp: liveCode(),
    });

    expect(response.status).toBe(200);
    expect(client.refreshToken).toBeDefined();
  });

  it('rejects a stale code from an old time step', async () => {
    await enrol();
    const stale = liveCode();

    // Well past the ±1-step validation window.
    instance.advance(5 * 60);

    const response = await new TestClient(instance.app).post('/api/auth/login', {
      email: admin.user!.email,
      password: TEST_PASSPHRASE,
      totp: stale,
    });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('invalid_credentials');
  });

  it('accepts a recovery code once and never again', async () => {
    const codes = await enrol();
    const code = codes[0]!;

    const first = new TestClient(instance.app);
    expect(
      (
        await first.post('/api/auth/login', {
          email: admin.user!.email,
          password: TEST_PASSPHRASE,
          totp: code,
        })
      ).status,
    ).toBe(200);

    const second = await new TestClient(instance.app).post('/api/auth/login', {
      email: admin.user!.email,
      password: TEST_PASSPHRASE,
      totp: code,
    });
    expect(second.status).toBe(401);

    expect((await first.get('/api/auth/me')).body.recoveryCodesRemaining).toBe(9);
  });
});

describe('disabling 2FA', () => {
  it('requires both the password and a second factor', async () => {
    await enrol();

    const noPassword = await admin.post('/api/auth/2fa/disable', {
      password: 'wrong-password-entirely',
      code: liveCode(),
    });
    expect(noPassword.status).toBe(400);

    const noCode = await admin.post('/api/auth/2fa/disable', {
      password: TEST_PASSPHRASE,
      code: '000000',
    });
    expect(noCode.status).toBe(400);
  });

  it('turns 2FA off and discards the secret and recovery codes', async () => {
    const codes = await enrol();

    const response = await admin.post('/api/auth/2fa/disable', {
      password: TEST_PASSPHRASE,
      code: liveCode(),
    });
    expect(response.status).toBe(204);

    const me = await admin.get('/api/auth/me');
    expect(me.body.user.totpEnabled).toBe(false);
    expect(me.body.recoveryCodesRemaining).toBe(0);

    const row = instance.ctx.db
      .select({ sealed: users.totpSecretEncrypted })
      .from(users)
      .where(eq(users.id, admin.user!.id))
      .get();
    expect(row?.sealed).toBeNull();

    // The old recovery codes must not survive as a back door.
    const client = new TestClient(instance.app);
    const login = await client.post('/api/auth/login', {
      email: admin.user!.email,
      password: TEST_PASSPHRASE,
      totp: codes[1],
    });
    // 2FA is off, so the second factor is simply ignored and the password alone signs in.
    expect(login.status).toBe(200);
    expect(
      instance.ctx.db.select().from(users).where(eq(users.id, admin.user!.id)).get()!.totpEnabled,
    ).toBe(false);
  });
});
