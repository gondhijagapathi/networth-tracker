/**
 * End-to-end authentication tests.
 *
 * These run against the real stack — real migrations, real Argon2id, real JWTs — because
 * the properties worth asserting here are emergent: that a rotated token is dead, that
 * replaying one kills its family, that suspension takes effect before the access token
 * would have expired anyway.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_CODE,
  TEST_PASSPHRASE,
  TestClient,
  createTestInstance,
  issueInvite,
  registerAdmin,
  registerMember,
  type TestInstance,
} from './harness.js';

let instance: TestInstance;

beforeEach(() => {
  instance = createTestInstance();
});

afterEach(() => {
  instance.close();
});

describe('bootstrap', () => {
  it('reports that a fresh instance needs its first account', async () => {
    const client = new TestClient(instance.app);
    const response = await client.get('/api/auth/bootstrap');
    expect(response.status).toBe(200);
    expect(response.body.bootstrapRequired).toBe(true);
  });

  it('creates the first account as an admin and stops advertising bootstrap', async () => {
    const admin = await registerAdmin(instance);
    expect(admin.user?.role).toBe('admin');

    const response = await new TestClient(instance.app).get('/api/auth/bootstrap');
    expect(response.body.bootstrapRequired).toBe(false);
  });

  it('refuses to redeem the bootstrap code twice', async () => {
    await registerAdmin(instance);

    const second = await new TestClient(instance.app).post('/api/auth/register', {
      inviteCode: BOOTSTRAP_CODE,
      email: 'second@example.com',
      name: 'Second',
      password: TEST_PASSPHRASE,
    });

    expect(second.status).toBe(400);
    expect(second.body.error.message).toMatch(/not valid/i);
  });
});

describe('registration', () => {
  it('requires a valid invite code', async () => {
    const response = await new TestClient(instance.app).post('/api/auth/register', {
      inviteCode: 'TOTALLY-MADE-UP-CODE',
      email: 'nobody@example.com',
      name: 'Nobody',
      password: TEST_PASSPHRASE,
    });
    expect(response.status).toBe(400);
  });

  it('enforces the password policy with field-level detail', async () => {
    const response = await new TestClient(instance.app).post('/api/auth/register', {
      inviteCode: BOOTSTRAP_CODE,
      email: 'admin@example.com',
      name: 'Admin',
      password: 'short',
    });
    expect(response.status).toBe(400);
    expect(response.body.error.details.password).toBeDefined();
  });

  it('rejects a password containing the email local part', async () => {
    const response = await new TestClient(instance.app).post('/api/auth/register', {
      inviteCode: BOOTSTRAP_CODE,
      email: 'jagapathi@example.com',
      name: 'Jag',
      password: 'my-jagapathi-password',
    });
    expect(response.status).toBe(400);
    expect(response.body.error.details.password).toBeDefined();
  });

  it('honours the role carried by the invite', async () => {
    const admin = await registerAdmin(instance);
    const nominee = await registerMember(instance, admin, {
      email: 'heir@example.com',
      role: 'nominee',
    });
    expect(nominee.user?.role).toBe('nominee');
  });

  it('will not let an email-bound invite create a different account', async () => {
    const admin = await registerAdmin(instance);
    const code = await issueInvite(admin, { email: 'intended@example.com' });

    const response = await new TestClient(instance.app).post('/api/auth/register', {
      inviteCode: code,
      email: 'someone.else@example.com',
      name: 'Interloper',
      password: TEST_PASSPHRASE,
    });
    expect(response.status).toBe(400);
  });

  it('rejects an expired invite', async () => {
    const admin = await registerAdmin(instance);
    const code = await issueInvite(admin, { expiresInDays: 1 });

    instance.advance(2 * 86400);

    const response = await new TestClient(instance.app).post('/api/auth/register', {
      inviteCode: code,
      email: 'late@example.com',
      name: 'Late',
      password: TEST_PASSPHRASE,
    });
    expect(response.status).toBe(400);
  });

  it('accepts an invite code regardless of case and grouping dashes', async () => {
    const admin = await registerAdmin(instance);
    const code = await issueInvite(admin);

    const response = await new TestClient(instance.app).post('/api/auth/register', {
      inviteCode: code.toLowerCase().replace(/-/g, ' '),
      email: 'retyped@example.com',
      name: 'Retyped',
      password: TEST_PASSPHRASE,
    });
    expect(response.status).toBe(201);
  });

  it('refuses a duplicate email', async () => {
    const admin = await registerAdmin(instance, 'admin@example.com');
    const code = await issueInvite(admin);

    const response = await new TestClient(instance.app).post('/api/auth/register', {
      inviteCode: code,
      email: 'admin@example.com',
      name: 'Duplicate',
      password: TEST_PASSPHRASE,
    });
    expect(response.status).toBe(409);
  });
});

describe('login', () => {
  it('signs a registered user in and returns their profile', async () => {
    const admin = await registerAdmin(instance);
    const client = new TestClient(instance.app);

    const response = await client.post('/api/auth/login', {
      email: admin.user!.email,
      password: TEST_PASSPHRASE,
    });

    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe('admin@example.com');
    expect(client.accessToken).toBeDefined();
    expect(client.refreshToken).toBeDefined();
    expect(client.csrfToken).toBeDefined();
  });

  it('gives an identical answer for a wrong password and an unknown account', async () => {
    await registerAdmin(instance);

    const wrongPassword = await new TestClient(instance.app).post('/api/auth/login', {
      email: 'admin@example.com',
      password: 'definitely-not-the-password',
    });
    const unknownEmail = await new TestClient(instance.app).post('/api/auth/login', {
      email: 'ghost@example.com',
      password: 'definitely-not-the-password',
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(unknownEmail.body).toEqual(wrongPassword.body);
  });

  it('never returns the password hash', async () => {
    const admin = await registerAdmin(instance);
    const response = await admin.get('/api/auth/me');
    expect(JSON.stringify(response.body)).not.toMatch(/argon2|passwordHash/i);
  });
});

describe('access tokens', () => {
  it('rejects an unauthenticated request for the current user', async () => {
    const response = await new TestClient(instance.app).get('/api/auth/me');
    expect(response.status).toBe(401);
  });

  it('stops accepting an access token once it expires', async () => {
    const admin = await registerAdmin(instance);
    expect((await admin.get('/api/auth/me')).status).toBe(200);

    instance.advance(16 * 60);

    expect((await admin.get('/api/auth/me')).status).toBe(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const admin = await registerAdmin(instance);
    const other = createTestInstance({
      JWT_ACCESS_SECRET: 'a-completely-different-secret-32-characters',
    });
    const impostor = await registerAdmin(other);

    admin.setCookie('nt_access', impostor.accessToken!);
    expect((await admin.get('/api/auth/me')).status).toBe(401);

    other.close();
  });
});

describe('refresh rotation', () => {
  it('issues a new refresh token and retires the old one', async () => {
    const admin = await registerAdmin(instance);
    const original = admin.refreshToken!;

    const response = await admin.post('/api/auth/refresh');
    expect(response.status).toBe(200);
    expect(admin.refreshToken).not.toBe(original);

    // The rotated token still works for ordinary requests.
    expect((await admin.get('/api/auth/me')).status).toBe(200);
  });

  it('revokes the whole family when a retired token is replayed', async () => {
    const admin = await registerAdmin(instance);
    const stolen = admin.refreshToken!;

    await admin.post('/api/auth/refresh');
    const legitimate = admin.refreshToken!;

    // An attacker replays the token they captured before the rotation.
    const attacker = new TestClient(instance.app);
    attacker.setCookie('nt_refresh', stolen);
    attacker.setCookie('nt_csrf', admin.csrfToken!);
    expect((await attacker.post('/api/auth/refresh')).status).toBe(401);

    // Detection burns the family, so the real client is signed out too — the safe
    // failure, since we cannot tell which of the two is the impostor.
    admin.setCookie('nt_refresh', legitimate);
    expect((await admin.post('/api/auth/refresh')).status).toBe(401);
  });

  it('rejects a refresh token that has passed its expiry', async () => {
    const admin = await registerAdmin(instance);
    instance.advance(31 * 86400);
    expect((await admin.post('/api/auth/refresh')).status).toBe(401);
  });

  it('does not extend the family beyond the original grant', async () => {
    const admin = await registerAdmin(instance);

    // Refresh repeatedly over the life of the session…
    for (let day = 0; day < 29; day += 1) {
      instance.advance(86400);
      expect((await admin.post('/api/auth/refresh')).status).toBe(200);
    }

    // …then step past the thirty-day grant. Rotation must not have renewed it.
    instance.advance(2 * 86400);
    expect((await admin.post('/api/auth/refresh')).status).toBe(401);
  });

  it('rejects a refresh attempt with no cookie at all', async () => {
    const response = await new TestClient(instance.app).post('/api/auth/refresh');
    expect(response.status).toBe(401);
  });
});

describe('logout', () => {
  it('clears cookies and kills the session family', async () => {
    const admin = await registerAdmin(instance);
    const refreshBeforeLogout = admin.refreshToken!;

    const response = await admin.post('/api/auth/logout');
    expect(response.status).toBe(204);
    expect(admin.refreshToken).toBeUndefined();
    expect(admin.accessToken).toBeUndefined();

    const replay = new TestClient(instance.app);
    replay.setCookie('nt_refresh', refreshBeforeLogout);
    expect((await replay.post('/api/auth/refresh')).status).toBe(401);
  });

  it('succeeds even with no session, so a stale client can always clear itself', async () => {
    const response = await new TestClient(instance.app).post('/api/auth/logout');
    expect(response.status).toBe(204);
  });
});

describe('sessions', () => {
  it('lists one entry per device and marks the current one', async () => {
    const admin = await registerAdmin(instance);

    const secondDevice = new TestClient(instance.app);
    await secondDevice.post('/api/auth/login', {
      email: admin.user!.email,
      password: TEST_PASSPHRASE,
      deviceLabel: 'Phone',
    });

    const response = await admin.get('/api/auth/sessions');
    expect(response.status).toBe(200);
    expect(response.body.sessions).toHaveLength(2);
    expect(response.body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(
      response.body.sessions.map((s: { deviceLabel: string | null }) => s.deviceLabel),
    ).toContain('Phone');
  });

  it('collapses a rotated session to a single device entry', async () => {
    const admin = await registerAdmin(instance);
    await admin.post('/api/auth/refresh');
    await admin.post('/api/auth/refresh');

    const response = await admin.get('/api/auth/sessions');
    expect(response.body.sessions).toHaveLength(1);
  });

  it('lets a user sign one device out without touching the others', async () => {
    const admin = await registerAdmin(instance);
    const phone = new TestClient(instance.app);
    await phone.post('/api/auth/login', {
      email: admin.user!.email,
      password: TEST_PASSPHRASE,
      deviceLabel: 'Phone',
    });

    const sessions = (await admin.get('/api/auth/sessions')).body.sessions as {
      id: string;
      current: boolean;
    }[];
    const other = sessions.find((s) => !s.current)!;

    expect((await admin.delete(`/api/auth/sessions/${other.id}`)).status).toBe(204);
    expect((await phone.post('/api/auth/refresh')).status).toBe(401);
    expect((await admin.get('/api/auth/me')).status).toBe(200);
  });

  it("will not let one user revoke another user's session", async () => {
    const admin = await registerAdmin(instance);
    const member = await registerMember(instance, admin);

    const adminSessions = (await admin.get('/api/auth/sessions')).body.sessions as { id: string }[];
    const response = await member.delete(`/api/auth/sessions/${adminSessions[0]!.id}`);

    // 404 rather than 403: whether that session exists is not the member's business.
    expect(response.status).toBe(404);
    expect((await admin.get('/api/auth/me')).status).toBe(200);
  });
});

describe('password change', () => {
  it('requires the current password', async () => {
    const admin = await registerAdmin(instance);
    const response = await admin.post('/api/auth/password', {
      currentPassword: 'not-the-current-password',
      newPassword: 'a-brand-new-passphrase-here',
    });
    expect(response.status).toBe(400);
    expect(response.body.error.details.currentPassword).toBeDefined();
  });

  it('signs every device out, including the one that made the change', async () => {
    const admin = await registerAdmin(instance);
    const phone = new TestClient(instance.app);
    await phone.post('/api/auth/login', { email: admin.user!.email, password: TEST_PASSPHRASE });

    const response = await admin.post('/api/auth/password', {
      currentPassword: TEST_PASSPHRASE,
      newPassword: 'a-brand-new-passphrase-here',
    });
    expect(response.status).toBe(204);

    expect((await phone.post('/api/auth/refresh')).status).toBe(401);

    const fresh = new TestClient(instance.app);
    expect(
      (
        await fresh.post('/api/auth/login', {
          email: admin.user!.email,
          password: 'a-brand-new-passphrase-here',
        })
      ).status,
    ).toBe(200);
  });
});

describe('CSRF', () => {
  it('rejects a mutating request that omits the double-submit header', async () => {
    const admin = await registerAdmin(instance);
    const response = await admin.post('/api/auth/refresh', undefined, { omitCsrf: true });
    expect(response.status).toBe(403);
  });

  it('rejects a header that does not match the cookie', async () => {
    const admin = await registerAdmin(instance);
    const response = await admin.post('/api/auth/refresh', undefined, {
      csrfToken: 'not-the-real-token',
    });
    expect(response.status).toBe(403);
  });

  it('does not require a token on safe methods', async () => {
    const admin = await registerAdmin(instance);
    expect((await admin.get('/api/auth/me')).status).toBe(200);
  });
});

describe('rate limiting', () => {
  it('backs off after repeated failures and reports Retry-After', async () => {
    await registerAdmin(instance);
    const client = new TestClient(instance.app);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await client.post('/api/auth/login', {
        email: 'admin@example.com',
        password: 'wrong-password-here',
      });
      expect(response.status).toBe(401);
    }

    const limited = await client.post('/api/auth/login', {
      email: 'admin@example.com',
      password: 'wrong-password-here',
    });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('lets a legitimate user back in once the backoff elapses', async () => {
    await registerAdmin(instance);
    const client = new TestClient(instance.app);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await client.post('/api/auth/login', {
        email: 'admin@example.com',
        password: 'wrong-password-here',
      });
    }

    instance.advance(60);

    const response = await client.post('/api/auth/login', {
      email: 'admin@example.com',
      password: TEST_PASSPHRASE,
    });
    expect(response.status).toBe(200);
  });

  it('throttles invite guessing during registration', async () => {
    const client = new TestClient(instance.app);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await client.post('/api/auth/register', {
        inviteCode: `GUESS-CODE-${attempt}`,
        email: `guess${attempt}@example.com`,
        name: 'Guesser',
        password: TEST_PASSPHRASE,
      });
      expect(response.status).toBe(400);
    }

    const limited = await client.post('/api/auth/register', {
      inviteCode: 'GUESS-CODE-AGAIN',
      email: 'guess9@example.com',
      name: 'Guesser',
      password: TEST_PASSPHRASE,
    });
    expect(limited.status).toBe(429);
  });
});
