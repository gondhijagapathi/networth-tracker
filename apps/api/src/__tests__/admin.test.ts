/**
 * Admin user and invite management.
 *
 * Two things are being pinned down here. The obvious one: only admins get in. The less
 * obvious one, asserted at the bottom: admin is an *operational* role. An admin can decide
 * who may sign in, and cannot read or write anyone's finances — the escrow and nominee
 * guarantees in P5 depend on that line holding.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PublicUser } from '@networth/shared';
import { generateInviteCode } from '../services/invite.service.js';
import {
  TEST_PASSPHRASE,
  TestClient,
  createTestInstance,
  issueInvite,
  registerAdmin,
  registerMember,
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

describe('access', () => {
  it('turns away an unauthenticated caller', async () => {
    expect((await new TestClient(instance.app).get('/api/admin/users')).status).toBe(401);
  });

  it('turns away a member', async () => {
    const member = await registerMember(instance, admin);
    expect((await member.get('/api/admin/users')).status).toBe(403);
  });

  it('turns away a nominee', async () => {
    const nominee = await registerMember(instance, admin, {
      email: 'heir@example.com',
      role: 'nominee',
    });
    expect((await nominee.get('/api/admin/users')).status).toBe(403);
  });
});

describe('invites', () => {
  it('returns the code exactly once and stores only its hash', async () => {
    const response = await admin.post('/api/admin/invites', { role: 'member' });
    expect(response.status).toBe(201);

    const code = response.body.code as string;
    expect(code).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);

    // The listing shows the invite but never the code.
    const listed = await admin.get('/api/admin/invites');
    expect(JSON.stringify(listed.body)).not.toContain(code);
  });

  it('draws invite code characters uniformly from its alphabet', () => {
    const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
    const counts = new Map<string, number>();

    for (let i = 0; i < 2_000; i += 1) {
      for (const character of generateInviteCode().replace(/-/g, '')) {
        counts.set(character, (counts.get(character) ?? 0) + 1);
      }
    }

    // Every letter appears, and none is favoured. Reducing a random byte modulo 30 would
    // hand the first sixteen letters an extra 12.5% of the draws, which over 40,000
    // characters is far outside the spread sampling noise can produce.
    expect([...counts.keys()].sort().join('')).toBe([...alphabet].sort().join(''));

    const expected = (2_000 * 20) / alphabet.length;
    for (const [character, count] of counts) {
      expect(Math.abs(count - expected) / expected, `skew on ${character}`).toBeLessThan(0.1);
    }
  });

  it('records who consumed an invite', async () => {
    const member = await registerMember(instance, admin);

    const invites = (await admin.get('/api/admin/invites')).body.invites as {
      consumedByUserId: string | null;
      consumedAt: string | null;
    }[];
    const consumed = invites.filter((invite) => invite.consumedAt !== null);

    // The bootstrap invite plus the member's.
    expect(consumed).toHaveLength(2);
    expect(consumed.map((invite) => invite.consumedByUserId)).toContain(member.user!.id);
  });

  it('refuses to invite an email that already has an account', async () => {
    const response = await admin.post('/api/admin/invites', { email: admin.user!.email });
    expect(response.status).toBe(409);
  });

  it('withdraws an unused invite without deleting the record', async () => {
    const code = await issueInvite(admin);
    const invites = (await admin.get('/api/admin/invites')).body.invites as {
      id: string;
      consumedAt: string | null;
    }[];
    const pending = invites.find((invite) => invite.consumedAt === null)!;

    expect((await admin.delete(`/api/admin/invites/${pending.id}`)).status).toBe(204);

    const attempt = await new TestClient(instance.app).post('/api/auth/register', {
      inviteCode: code,
      email: 'toolate@example.com',
      name: 'Too Late',
      password: TEST_PASSPHRASE,
    });
    expect(attempt.status).toBe(400);

    // The history survives the withdrawal.
    expect((await admin.get('/api/admin/invites')).body.invites.length).toBe(invites.length);
  });

  it('will not withdraw an invite that has already been used', async () => {
    await registerMember(instance, admin);
    const invites = (await admin.get('/api/admin/invites')).body.invites as {
      id: string;
      consumedAt: string | null;
    }[];
    const used = invites.find((invite) => invite.consumedAt !== null)!;

    expect((await admin.delete(`/api/admin/invites/${used.id}`)).status).toBe(409);
  });
});

describe('user management', () => {
  it('lists every account without exposing credentials', async () => {
    await registerMember(instance, admin);
    const response = await admin.get('/api/admin/users');

    expect(response.status).toBe(200);
    expect(response.body.users).toHaveLength(2);
    expect(JSON.stringify(response.body)).not.toMatch(/passwordHash|argon2|totpSecret/i);
  });

  it('suspends an account and cuts its sessions immediately', async () => {
    const member = await registerMember(instance, admin);
    expect((await member.get('/api/auth/me')).status).toBe(200);

    const response = await admin.patch(`/api/admin/users/${member.user!.id}`, {
      status: 'suspended',
    });
    expect(response.status).toBe(200);
    expect((response.body.user as PublicUser).status).toBe('suspended');

    // The access token has not expired, so this is the database check in `requireAuth`
    // doing its job rather than the token running out.
    expect((await member.get('/api/auth/me')).status).toBe(403);
    expect((await member.post('/api/auth/refresh')).status).toBe(401);

    const retry = await new TestClient(instance.app).post('/api/auth/login', {
      email: member.user!.email,
      password: TEST_PASSPHRASE,
    });
    expect(retry.status).toBe(403);
  });

  it('reactivates a suspended account', async () => {
    const member = await registerMember(instance, admin);
    await admin.patch(`/api/admin/users/${member.user!.id}`, { status: 'suspended' });
    await admin.patch(`/api/admin/users/${member.user!.id}`, { status: 'active' });

    const client = new TestClient(instance.app);
    const login = await client.post('/api/auth/login', {
      email: member.user!.email,
      password: TEST_PASSPHRASE,
    });
    expect(login.status).toBe(200);
  });

  it('changes a role, and the new role applies on the next request', async () => {
    const member = await registerMember(instance, admin);
    expect((await member.get('/api/admin/users')).status).toBe(403);

    await admin.patch(`/api/admin/users/${member.user!.id}`, { role: 'admin' });

    // No re-login: `requireAuth` reads the role from the database, not from the token.
    expect((await member.get('/api/admin/users')).status).toBe(200);
  });

  it('revokes every session for a user on request', async () => {
    const member = await registerMember(instance, admin);
    const phone = new TestClient(instance.app);
    await phone.post('/api/auth/login', {
      email: member.user!.email,
      password: TEST_PASSPHRASE,
    });

    const response = await admin.post(`/api/admin/users/${member.user!.id}/revoke-sessions`);
    expect(response.status).toBe(200);
    expect(response.body.revoked).toBe(2);

    expect((await member.post('/api/auth/refresh')).status).toBe(401);
    expect((await phone.post('/api/auth/refresh')).status).toBe(401);
  });

  it('404s on a user that does not exist', async () => {
    const response = await admin.patch('/api/admin/users/01890000-0000-7000-8000-000000000000', {
      status: 'suspended',
    });
    expect(response.status).toBe(404);
  });
});

describe('lockout guards', () => {
  it('will not let an admin suspend themselves', async () => {
    const response = await admin.patch(`/api/admin/users/${admin.user!.id}`, {
      status: 'suspended',
    });
    expect(response.status).toBe(409);
  });

  it('will not let an admin drop their own admin role', async () => {
    const response = await admin.patch(`/api/admin/users/${admin.user!.id}`, { role: 'member' });
    expect(response.status).toBe(409);
  });

  it('will not suspend the last remaining admin', async () => {
    const second = await registerMember(instance, admin, {
      email: 'admin2@example.com',
      role: 'admin',
    });

    // Two admins: demoting one is fine.
    expect(
      (await admin.patch(`/api/admin/users/${second.user!.id}`, { role: 'member' })).status,
    ).toBe(200);

    // Back to one. Now the guard bites, whoever asks.
    const promoted = await registerMember(instance, admin, {
      email: 'admin3@example.com',
      role: 'admin',
    });
    expect(
      (await promoted.patch(`/api/admin/users/${admin.user!.id}`, { status: 'suspended' })).status,
    ).toBe(200);
  });
});

describe('scope of the admin role', () => {
  it('gives admins no endpoint that reads another account beyond its profile', async () => {
    const member = await registerMember(instance, admin);

    // The only per-user reads an admin has are the listing and the profile it contains.
    const listed = (await admin.get('/api/admin/users')).body.users as PublicUser[];
    const entry = listed.find((user) => user.id === member.user!.id)!;

    expect(Object.keys(entry).sort()).toEqual([
      'createdAt',
      'email',
      'id',
      'lastActiveAt',
      'name',
      'role',
      'status',
      'totpEnabled',
    ]);
  });

  it('gives admins no way to set another account password', async () => {
    const member = await registerMember(instance, admin);
    const response = await admin.post(`/api/admin/users/${member.user!.id}/password`, {
      newPassword: 'an-admin-chosen-password',
    });
    expect(response.status).toBe(404);
  });
});
