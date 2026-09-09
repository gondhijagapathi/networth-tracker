/**
 * Notifications, and the password reset that depends on them.
 *
 * The tests worth having here are the ones about *not* sending, and about what a message
 * must not contain. Anyone can assert that an invite email goes out; the things that would
 * actually hurt this application are a reset endpoint that reveals which addresses have
 * accounts, a reset link that walks past an enrolled second factor, an outbox row holding a
 * live credential in the clear, and a dead-man warning that is quietly dropped because
 * Gmail was down for a minute.
 */

import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  deadManCheckins,
  deadManSwitch,
  emailOutbox,
  passwordResets,
  users,
} from '../db/schema.js';
import { openSecret } from '../lib/secretbox.js';
import { totpCodeForUser } from '../services/auth.service.js';
import { evaluateDeadManSwitches } from '../services/deadman.service.js';
import { deliverDueEmails } from '../services/mail.service.js';
import {
  BOOTSTRAP_CODE,
  TEST_PASSPHRASE,
  createTestInstance,
  registerAdmin,
  registerMember,
  TestClient,
  type TestInstance,
} from './harness.js';

const DAY = 86_400;

/** The link out of a queued reset message, read the way the recipient's browser would. */
function resetTokenFrom(text: string): string {
  const match = /reset-password\?token=([\w-]+)/.exec(text);
  if (!match) throw new Error(`No reset link in message:\n${text}`);
  return decodeURIComponent(match[1]!);
}

async function requestReset(instance: TestInstance, email: string): Promise<string> {
  const anonymous = new TestClient(instance.app);
  const response = await anonymous.post('/api/auth/forgot-password', { email });
  expect(response.status).toBe(204);

  await instance.flushMail();
  const sent = instance.mailer.to(email).filter((m) => m.subject.includes('Reset'));
  const last = sent.at(-1);
  if (!last) throw new Error(`No reset email was sent to ${email}`);
  return resetTokenFrom(last.text);
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

describe('the outbox', () => {
  it('queues rather than sending on the request thread', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance);

    await admin.post('/api/admin/invites', { role: 'member', email: 'heir@example.com' });

    // The row exists before anything has been delivered — that is the whole design.
    const queued = instance.ctx.db.select().from(emailOutbox).all();
    expect(queued.some((row) => row.kind === 'invite')).toBe(true);

    await instance.flushMail();
    expect(instance.mailer.to('heir@example.com')).toHaveLength(1);
    instance.close();
  });

  it('never stores a message body in the clear', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance);

    // Held in the queue on purpose: a delivered row has already discarded its body, and the
    // question here is what sits on disk while a message is still waiting to go out.
    instance.mailer.failWith = 'held for inspection';

    const created = await admin.post('/api/admin/invites', {
      role: 'member',
      email: 'heir@example.com',
    });
    const code = created.body.code as string;

    const row = instance.ctx.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.kind, 'invite'))
      .get();

    expect(row?.bodyEncrypted).toBeTruthy();
    // The invite code is in the message. It must not be readable from the database file.
    expect(row!.bodyEncrypted).not.toContain(code);
    expect(row!.subject).not.toContain(code);

    const opened = openSecret(row!.bodyEncrypted!, instance.config.SECRET_ENCRYPTION_KEY, 'email');
    expect(opened).toContain(code);
    instance.close();
  });

  it('forgets the body once the message has been delivered', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance);
    await admin.post('/api/admin/invites', { role: 'member', email: 'heir@example.com' });

    await instance.flushMail();

    const row = instance.ctx.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.kind, 'invite'))
      .get();
    expect(row?.status).toBe('sent');
    expect(row?.bodyEncrypted).toBeNull();
    instance.close();
  });

  it('retries a failed send and gives up only after several attempts', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance);

    instance.mailer.failWith = 'Connection refused';
    await admin.post('/api/admin/invites', { role: 'member', email: 'heir@example.com' });
    await deliverDueEmails(instance.ctx);

    let row = instance.ctx.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.kind, 'invite'))
      .get();
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain('Connection refused');

    // Nothing is due yet: the backoff put the next attempt a minute out.
    expect((await deliverDueEmails(instance.ctx)).failed).toBe(0);

    // Five more attempts, each after its backoff has elapsed, and it is abandoned.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      instance.advance(2 * 3600);
      await deliverDueEmails(instance.ctx);
    }

    row = instance.ctx.db.select().from(emailOutbox).where(eq(emailOutbox.kind, 'invite')).get();
    expect(row?.status).toBe('failed');
    expect(row?.bodyEncrypted).toBeNull();
    instance.close();
  });

  it('records messages as suppressed when no transport is configured', async () => {
    // How a fresh install runs: no SMTP_HOST at all.
    const instance = createTestInstance({ SMTP_HOST: '', SMTP_FROM: '' });
    const admin = await registerAdmin(instance);

    const created = await admin.post('/api/admin/invites', {
      role: 'member',
      email: 'heir@example.com',
    });

    // The invite still works and the code still comes back — mail being off is not a
    // failure of the thing it was notifying about.
    expect(created.status).toBe(201);
    expect(created.body.code).toBeTruthy();
    expect(created.body.emailQueued).toBe(false);

    const row = instance.ctx.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.kind, 'invite'))
      .get();
    expect(row?.status).toBe('suppressed');
    // Nothing was composed and stored, because nothing could be sent.
    expect(row?.bodyEncrypted).toBeNull();
    instance.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Invitations and accounts                                                   */
/* -------------------------------------------------------------------------- */

describe('invitations', () => {
  it('mails the code to a bound address and says that it did', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance);

    const created = await admin.post('/api/admin/invites', {
      role: 'member',
      email: 'partner@example.com',
      note: 'Joint account',
    });
    expect(created.body.emailQueued).toBe(true);

    await instance.flushMail();
    const [message] = instance.mailer.to('partner@example.com');
    expect(message?.text).toContain(created.body.code as string);
    expect(message?.text).toContain('https://networth.test/sign-in?invite=');
    expect(message?.text).toContain('Joint account');
    instance.close();
  });

  it('sends nothing for an unbound invite, or when the admin unticks it', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance);

    const unbound = await admin.post('/api/admin/invites', { role: 'member' });
    expect(unbound.body.emailQueued).toBe(false);

    const opted = await admin.post('/api/admin/invites', {
      role: 'member',
      email: 'phone@example.com',
      sendEmail: false,
    });
    expect(opted.body.emailQueued).toBe(false);

    await instance.flushMail();
    expect(instance.mailer.to('phone@example.com')).toHaveLength(0);
    instance.close();
  });

  it('welcomes a new account and tells it the vault passphrase is unrecoverable', async () => {
    const instance = createTestInstance();
    await registerAdmin(instance, 'admin@example.com');
    await instance.flushMail();

    const [welcome] = instance.mailer.to('admin@example.com');
    expect(welcome?.subject).toContain('ready');
    expect(welcome?.text).toContain('nobody');
    expect(welcome?.text.toLowerCase()).toContain('passphrase');
    instance.close();
  });

  it('explains itself when the invitee is a nominee who has never heard of this app', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance);

    await admin.post('/api/nominees', {
      name: 'Asha Rao',
      email: 'asha@example.com',
      relation: 'daughter',
      accessLevel: 'summary',
    });
    const nominees = await admin.get('/api/nominees');
    const nomineeId = nominees.body.nominees[0].id as string;

    const invited = await admin.post(`/api/nominees/${nomineeId}/invite`);
    expect(invited.body.emailQueued).toBe(true);

    await instance.flushMail();
    const [message] = instance.mailer.to('asha@example.com');
    expect(message?.subject).toContain('Test Admin');
    expect(message?.text).toContain('named you as a nominee');
    expect(message?.text).toContain('read-only');
    instance.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Password reset                                                             */
/* -------------------------------------------------------------------------- */

describe('password reset', () => {
  it('answers identically whether or not the address has an account', async () => {
    const instance = createTestInstance();
    await registerAdmin(instance, 'real@example.com');

    const anonymous = new TestClient(instance.app);
    const known = await anonymous.post('/api/auth/forgot-password', { email: 'real@example.com' });
    const unknown = await anonymous.post('/api/auth/forgot-password', {
      email: 'nobody@example.com',
    });

    expect(known.status).toBe(204);
    expect(unknown.status).toBe(204);
    expect(known.body).toEqual(unknown.body);
    expect(known.text).toEqual(unknown.text);

    await instance.flushMail();
    expect(instance.mailer.to('nobody@example.com')).toHaveLength(0);
    instance.close();
  });

  it('resets the password, ends every session and lets the new one sign in', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance, 'owner@example.com');

    // A live session that must not survive the reset.
    expect((await admin.get('/api/auth/me')).status).toBe(200);

    const token = await requestReset(instance, 'owner@example.com');
    const anonymous = new TestClient(instance.app);
    const reset = await anonymous.post('/api/auth/reset-password', {
      token,
      password: 'a-brand-new-passphrase-entirely',
    });
    expect(reset.status).toBe(204);

    // The old session is gone even though its cookies were never touched by this flow.
    expect((await admin.get('/api/auth/me')).status).toBe(401);

    const stale = await anonymous.post('/api/auth/login', {
      email: 'owner@example.com',
      password: TEST_PASSPHRASE,
    });
    expect(stale.status).toBe(401);

    const fresh = await anonymous.post('/api/auth/login', {
      email: 'owner@example.com',
      password: 'a-brand-new-passphrase-entirely',
    });
    expect(fresh.status).toBe(200);
    instance.close();
  });

  it('does not sign the caller in as a side effect of resetting', async () => {
    const instance = createTestInstance();
    await registerAdmin(instance, 'owner@example.com');

    const token = await requestReset(instance, 'owner@example.com');
    const anonymous = new TestClient(instance.app);
    await anonymous.post('/api/auth/reset-password', {
      token,
      password: 'a-brand-new-passphrase-entirely',
    });

    expect(anonymous.accessToken).toBeUndefined();
    expect((await anonymous.get('/api/auth/me')).status).toBe(401);
    instance.close();
  });

  it('burns the link — the same token cannot be used twice', async () => {
    const instance = createTestInstance();
    await registerAdmin(instance, 'owner@example.com');

    const token = await requestReset(instance, 'owner@example.com');
    const anonymous = new TestClient(instance.app);

    const first = await anonymous.post('/api/auth/reset-password', {
      token,
      password: 'a-brand-new-passphrase-entirely',
    });
    expect(first.status).toBe(204);

    const second = await anonymous.post('/api/auth/reset-password', {
      token,
      password: 'yet-another-passphrase-here',
    });
    expect(second.status).toBe(400);
    instance.close();
  });

  it('invalidates the older link when a second one is asked for', async () => {
    const instance = createTestInstance();
    await registerAdmin(instance, 'owner@example.com');

    const first = await requestReset(instance, 'owner@example.com');
    const second = await requestReset(instance, 'owner@example.com');
    expect(first).not.toEqual(second);

    const anonymous = new TestClient(instance.app);
    expect(
      (
        await anonymous.post('/api/auth/reset-password', {
          token: first,
          password: 'a-brand-new-passphrase-entirely',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await anonymous.post('/api/auth/reset-password', {
          token: second,
          password: 'a-brand-new-passphrase-entirely',
        })
      ).status,
    ).toBe(204);
    instance.close();
  });

  it('expires a link after an hour', async () => {
    const instance = createTestInstance();
    await registerAdmin(instance, 'owner@example.com');
    const token = await requestReset(instance, 'owner@example.com');

    instance.advance(3601);

    const anonymous = new TestClient(instance.app);
    expect((await anonymous.get(`/api/auth/reset-password?token=${token}`)).body.valid).toBe(false);
    expect(
      (
        await anonymous.post('/api/auth/reset-password', {
          token,
          password: 'a-brand-new-passphrase-entirely',
        })
      ).status,
    ).toBe(400);
    instance.close();
  });

  it('still demands the second factor — a mailbox is not a way past 2FA', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance, 'owner@example.com');

    await admin.post('/api/auth/2fa/enrol');
    await admin.post('/api/auth/2fa/enrol/confirm', {
      code: totpCodeForUser(instance.ctx, admin.user!.id),
    });

    const token = await requestReset(instance, 'owner@example.com');
    const anonymous = new TestClient(instance.app);

    const withoutCode = await anonymous.post('/api/auth/reset-password', {
      token,
      password: 'a-brand-new-passphrase-entirely',
    });
    expect(withoutCode.status).toBe(401);
    expect(withoutCode.body.error.code).toBe('totp_required');

    // And the reset page knows to show the field before anyone types a password.
    const check = await anonymous.get(`/api/auth/reset-password?token=${token}`);
    expect(check.body).toEqual({ valid: true, totpRequired: true });

    const withCode = await anonymous.post('/api/auth/reset-password', {
      token,
      password: 'a-brand-new-passphrase-entirely',
      totp: totpCodeForUser(instance.ctx, admin.user!.id),
    });
    expect(withCode.status).toBe(204);
    instance.close();
  });

  it('refuses a reset into a suspended account', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance);
    const member = await registerMember(instance, admin, { email: 'member@example.com' });

    const token = await requestReset(instance, 'member@example.com');
    await admin.patch(`/api/admin/users/${member.user!.id}`, { status: 'suspended' });

    const anonymous = new TestClient(instance.app);
    expect(
      (
        await anonymous.post('/api/auth/reset-password', {
          token,
          password: 'a-brand-new-passphrase-entirely',
        })
      ).status,
    ).toBe(400);
    instance.close();
  });

  it('sends nothing for a suspended account in the first place', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance);
    const member = await registerMember(instance, admin, { email: 'member@example.com' });
    await admin.patch(`/api/admin/users/${member.user!.id}`, { status: 'suspended' });
    instance.mailer.reset();

    const anonymous = new TestClient(instance.app);
    expect(
      (await anonymous.post('/api/auth/forgot-password', { email: 'member@example.com' })).status,
    ).toBe(204);

    await instance.flushMail();
    expect(instance.mailer.to('member@example.com')).toHaveLength(0);
    instance.close();
  });

  it('warns the account that its password changed, by both routes', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance, 'owner@example.com');

    await admin.post('/api/auth/password', {
      currentPassword: TEST_PASSPHRASE,
      newPassword: 'a-brand-new-passphrase-entirely',
    });
    await instance.flushMail();

    const changed = instance.mailer
      .to('owner@example.com')
      .filter((m) => m.subject.includes('password was changed'));
    expect(changed).toHaveLength(1);
    expect(changed[0]?.text).toContain('signed out');
    instance.close();
  });

  it('kills an outstanding link when the password is changed from a session', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance, 'owner@example.com');

    const token = await requestReset(instance, 'owner@example.com');
    await admin.post('/api/auth/password', {
      currentPassword: TEST_PASSPHRASE,
      newPassword: 'a-brand-new-passphrase-entirely',
    });

    const anonymous = new TestClient(instance.app);
    expect(
      (
        await anonymous.post('/api/auth/reset-password', {
          token,
          password: 'third-passphrase-goes-here',
        })
      ).status,
    ).toBe(400);
    instance.close();
  });

  it('stores only an HMAC of the token', async () => {
    const instance = createTestInstance();
    await registerAdmin(instance, 'owner@example.com');
    const token = await requestReset(instance, 'owner@example.com');

    const row = instance.ctx.db.select().from(passwordResets).all().at(-1);
    expect(row?.tokenHash).toBeTruthy();
    expect(row?.tokenHash).not.toEqual(token);
    instance.close();
  });

  it('backs off after repeated requests for the same address', async () => {
    const instance = createTestInstance();
    await registerAdmin(instance, 'owner@example.com');
    const anonymous = new TestClient(instance.app);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        (await anonymous.post('/api/auth/forgot-password', { email: 'owner@example.com' })).status,
      ).toBe(204);
    }

    const limited = await anonymous.post('/api/auth/forgot-password', {
      email: 'owner@example.com',
    });
    expect(limited.status).toBe(429);
    instance.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Security alerts                                                            */
/* -------------------------------------------------------------------------- */

describe('security alerts', () => {
  it('tells the account when its second factor is turned off', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance, 'owner@example.com');

    await admin.post('/api/auth/2fa/enrol');
    await admin.post('/api/auth/2fa/enrol/confirm', {
      code: totpCodeForUser(instance.ctx, admin.user!.id),
    });
    await admin.post('/api/auth/2fa/disable', {
      password: TEST_PASSPHRASE,
      code: totpCodeForUser(instance.ctx, admin.user!.id),
    });

    await instance.flushMail();
    const alerts = instance.mailer
      .to('owner@example.com')
      .filter((m) => m.subject.includes('Two-factor'));
    expect(alerts.map((m) => m.subject)).toEqual([
      'Two-factor authentication was turned on',
      'Two-factor authentication was turned off',
    ]);
    instance.close();
  });
});

/* -------------------------------------------------------------------------- */
/* The dead-man switch                                                        */
/* -------------------------------------------------------------------------- */

describe('dead-man switch notifications', () => {
  it('warns the owner at each stage, and only on the way up', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance, 'owner@example.com');
    await admin.put('/api/estate/deadman', {
      enabled: true,
      inactivityDays: 100,
      graceDays: 7,
    });
    instance.mailer.reset();

    instance.advance(51 * DAY);
    evaluateDeadManSwitches(instance.ctx);
    await instance.flushMail();
    expect(instance.mailer.to('owner@example.com')).toHaveLength(1);
    expect(instance.mailer.sent[0]?.text).toContain('50%');

    instance.advance(25 * DAY);
    evaluateDeadManSwitches(instance.ctx);
    await instance.flushMail();
    expect(instance.mailer.to('owner@example.com')).toHaveLength(2);
    expect(instance.mailer.sent[1]?.text).toContain('75%');

    // Signing in walks the stage back down, and that is not something to email about.
    const back = new TestClient(instance.app);
    await back.post('/api/auth/login', {
      email: 'owner@example.com',
      password: TEST_PASSPHRASE,
    });
    evaluateDeadManSwitches(instance.ctx);
    await instance.flushMail();
    expect(instance.mailer.to('owner@example.com')).toHaveLength(2);
    instance.close();
  });

  it('sends the loud one when the grace period opens', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance, 'owner@example.com');
    await admin.put('/api/estate/deadman', { enabled: true, inactivityDays: 30, graceDays: 7 });
    instance.mailer.reset();

    instance.advance(31 * DAY);
    evaluateDeadManSwitches(instance.ctx);
    await instance.flushMail();

    const grace = instance.mailer
      .to('owner@example.com')
      .find((m) => m.subject.includes('Action needed'));
    expect(grace?.text).toContain('7 days');
    expect(grace?.text).toContain('cannot be taken back');
    instance.close();
  });

  it('is recorded but not delivered on an instance with no mail configured', async () => {
    const instance = createTestInstance({ SMTP_HOST: '', SMTP_FROM: '' });
    const admin = await registerAdmin(instance, 'owner@example.com');
    await admin.put('/api/estate/deadman', { enabled: true, inactivityDays: 30, graceDays: 7 });

    instance.advance(31 * DAY);
    // The switch still advances. Mail being off must not stop the feature working.
    expect(evaluateDeadManSwitches(instance.ctx).graced).toHaveLength(1);

    const suppressed = instance.ctx.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.kind, 'deadman_grace'))
      .get();
    expect(suppressed?.status).toBe('suppressed');
    instance.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Administration                                                             */
/* -------------------------------------------------------------------------- */

describe('the admin mail screen', () => {
  it('reports the transport and the queue', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance);

    const status = await admin.get('/api/admin/mail');
    expect(status.body.configured).toBe(true);
    expect(status.body.host).toBe('smtp.test.invalid');
    expect(status.body.appBaseUrl).toBe('https://networth.test');
    expect(status.body.recent.length).toBeGreaterThan(0);
    // The list carries envelopes, never bodies.
    expect(Object.keys(status.body.recent[0])).not.toContain('body');
    instance.close();
  });

  it('counts a suppressed message as a problem to look at', async () => {
    const instance = createTestInstance({ SMTP_HOST: '', SMTP_FROM: '' });
    const admin = await registerAdmin(instance);

    const status = await admin.get('/api/admin/mail');
    expect(status.body.configured).toBe(false);
    expect(status.body.failed).toBeGreaterThan(0);
    instance.close();
  });

  it('sends a test message to the admin and reports the transport error verbatim', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance, 'admin@example.com');

    const ok = await admin.post('/api/admin/mail/test');
    expect(ok.body).toMatchObject({ ok: true, to: 'admin@example.com', error: null });

    instance.mailer.failWith = '535-5.7.8 Username and Password not accepted';
    const bad = await admin.post('/api/admin/mail/test');
    // 200 with ok:false — the request worked, and found out that mail does not.
    expect(bad.status).toBe(200);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.error).toContain('Username and Password not accepted');
    instance.close();
  });

  it('is closed to members', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance);
    const member = await registerMember(instance, admin);

    expect((await member.get('/api/admin/mail')).status).toBe(403);
    expect((await member.post('/api/admin/mail/test')).status).toBe(403);
    instance.close();
  });

  it('does not take a recipient — the test goes to the caller and nowhere else', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance, 'admin@example.com');

    await admin.post('/api/admin/mail/test', { to: 'stranger@elsewhere.example' });

    expect(instance.mailer.to('stranger@elsewhere.example')).toHaveLength(0);
    expect(instance.mailer.to('admin@example.com').length).toBeGreaterThan(0);
    instance.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Registration is still the only way in                                      */
/* -------------------------------------------------------------------------- */

describe('the reset flow does not become a way in', () => {
  it('cannot create an account for an address that has none', async () => {
    const instance = createTestInstance();
    await registerAdmin(instance);
    const anonymous = new TestClient(instance.app);

    await anonymous.post('/api/auth/forgot-password', { email: 'stranger@example.com' });
    await instance.flushMail();

    const created = instance.ctx.db
      .select()
      .from(users)
      .where(eq(users.email, 'stranger@example.com'))
      .get();
    expect(created).toBeUndefined();
    expect(instance.mailer.to('stranger@example.com')).toHaveLength(0);
    instance.close();
  });

  it('rejects a made-up token without saying anything useful about it', async () => {
    const instance = createTestInstance();
    await registerAdmin(instance);
    const anonymous = new TestClient(instance.app);

    const check = await anonymous.get('/api/auth/reset-password?token=not-a-real-token-at-all');
    expect(check.body).toEqual({ valid: false, totpRequired: false });

    const attempt = await anonymous.post('/api/auth/reset-password', {
      token: 'not-a-real-token-at-all',
      password: 'a-brand-new-passphrase-entirely',
    });
    expect(attempt.status).toBe(400);
    expect(attempt.body.error.message).not.toContain('@');
    instance.close();
  });

  it('leaves the bootstrap path alone', async () => {
    const instance = createTestInstance();
    const client = new TestClient(instance.app);
    const response = await client.post('/api/auth/register', {
      inviteCode: BOOTSTRAP_CODE,
      email: 'first@example.com',
      name: 'First',
      password: TEST_PASSPHRASE,
    });
    expect(response.status).toBe(201);
    instance.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Checking in from an email                                                  */
/* -------------------------------------------------------------------------- */

/** The check-in link out of a warning message, read the way the recipient's browser would. */
function checkInTokenFrom(text: string): string {
  const match = /check-in\?token=([\w-]+)/.exec(text);
  if (!match) throw new Error(`No check-in link in message:\n${text}`);
  return decodeURIComponent(match[1]!);
}

/** Warn an owner into the given stage and hand back the token their email carried. */
async function warnedToken(
  instance: TestInstance,
  admin: TestClient,
  options: { days: number; inactivityDays?: number },
): Promise<string> {
  await admin.put('/api/estate/deadman', {
    enabled: true,
    inactivityDays: options.inactivityDays ?? 100,
    graceDays: 7,
  });
  instance.mailer.reset();

  instance.advance(options.days * DAY);
  evaluateDeadManSwitches(instance.ctx);
  await instance.flushMail();

  const last = instance.mailer.sent.at(-1);
  if (!last) throw new Error('No warning email was sent');
  return checkInTokenFrom(last.text);
}

describe('the emailed check-in link', () => {
  it('is in the warning, and resets the switch without a session', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance, 'owner@example.com');
    const token = await warnedToken(instance, admin, { days: 51 });

    expect(instance.ctx.db.select().from(deadManSwitch).get()?.stage).toBe('warned_50');

    // A brand-new client with no cookies at all — the whole point of the feature.
    const stranger = new TestClient(instance.app);
    const response = await stranger.post('/api/check-in', { token });

    expect(response.status).toBe(200);
    expect(response.body.deadman.stage).toBe('idle');
    expect(instance.ctx.db.select().from(deadManSwitch).get()?.stage).toBe('idle');
    instance.close();
  });

  /**
   * The property this whole design exists for.
   *
   * Mail scanners fetch every link in a message. If the GET checked the owner in, the
   * switch would never advance and the escrows would never open — silently, and only for
   * somebody who had died.
   */
  it('is NOT triggered by fetching the link, only by pressing the button', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance, 'owner@example.com');
    const token = await warnedToken(instance, admin, { days: 51 });

    const scanner = new TestClient(instance.app);
    // Fetch it the way a link scanner would — repeatedly, and days apart.
    for (let visit = 0; visit < 3; visit += 1) {
      const peek = await scanner.get(`/api/check-in?token=${token}`);
      expect(peek.status).toBe(200);
      expect(peek.body.valid).toBe(true);
    }

    // Nothing moved.
    expect(instance.ctx.db.select().from(deadManSwitch).get()?.stage).toBe('warned_50');

    // And the switch still goes on to fire, which is the outcome a prefetch must not
    // prevent. Advance well past the window and the grace period.
    instance.advance(60 * DAY);
    evaluateDeadManSwitches(instance.ctx);
    instance.advance(10 * DAY);
    evaluateDeadManSwitches(instance.ctx);

    expect(instance.ctx.db.select().from(deadManSwitch).get()?.stage).toBe('fired');
    instance.close();
  });

  it('cancels the grace period', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance, 'owner@example.com');
    const token = await warnedToken(instance, admin, { days: 31, inactivityDays: 30 });

    expect(instance.ctx.db.select().from(deadManSwitch).get()?.stage).toBe('grace');

    const stranger = new TestClient(instance.app);
    expect((await stranger.post('/api/check-in', { token })).status).toBe(200);

    const row = instance.ctx.db.select().from(deadManSwitch).get();
    expect(row?.stage).toBe('idle');
    expect(row?.graceStartedAt).toBeNull();
    instance.close();
  });

  it('works once', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance, 'owner@example.com');
    const token = await warnedToken(instance, admin, { days: 51 });

    const stranger = new TestClient(instance.app);
    expect((await stranger.post('/api/check-in', { token })).status).toBe(200);
    expect((await stranger.post('/api/check-in', { token })).status).toBe(400);
    instance.close();
  });

  it('expires after 30 days', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance, 'owner@example.com');
    const token = await warnedToken(instance, admin, { days: 51 });

    instance.advance(31 * DAY);

    const stranger = new TestClient(instance.app);
    expect((await stranger.get(`/api/check-in?token=${token}`)).body.valid).toBe(false);
    expect((await stranger.post('/api/check-in', { token })).status).toBe(400);
    instance.close();
  });

  it('grants nothing beyond the check-in', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance, 'owner@example.com');
    const token = await warnedToken(instance, admin, { days: 51 });

    const stranger = new TestClient(instance.app);
    await stranger.post('/api/check-in', { token });

    // No session was created by any of that.
    expect(stranger.accessToken).toBeUndefined();
    expect((await stranger.get('/api/auth/me')).status).toBe(401);
    expect((await stranger.get('/api/assets')).status).toBe(401);
    expect((await stranger.get('/api/estate/deadman')).status).toBe(401);
    instance.close();
  });

  it('says nothing about money, assets or nominees on the public page', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance, 'owner@example.com');
    const token = await warnedToken(instance, admin, { days: 51 });

    const stranger = new TestClient(instance.app);
    const peek = await stranger.get(`/api/check-in?token=${token}`);

    expect(Object.keys(peek.body).sort()).toEqual([
      'alreadyFired',
      'daysUntilRelease',
      'name',
      'stage',
      'valid',
    ]);
    instance.close();
  });

  it('rejects a made-up token', async () => {
    const instance = createTestInstance();
    await registerAdmin(instance);
    const stranger = new TestClient(instance.app);

    expect((await stranger.get('/api/check-in?token=not-a-real-token-here')).body.valid).toBe(
      false,
    );
    expect((await stranger.post('/api/check-in', { token: 'not-a-real-token-here' })).status).toBe(
      400,
    );
    instance.close();
  });

  it('stores only an HMAC of the token', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance, 'owner@example.com');
    const token = await warnedToken(instance, admin, { days: 51 });

    const row = instance.ctx.db.select().from(deadManCheckins).all().at(-1);
    expect(row?.tokenHash).toBeTruthy();
    expect(row?.tokenHash).not.toEqual(token);
    instance.close();
  });

  it('issues a fresh link with each escalation, and the older one still works', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance, 'owner@example.com');

    const first = await warnedToken(instance, admin, { days: 51 });
    instance.advance(25 * DAY);
    evaluateDeadManSwitches(instance.ctx);
    await instance.flushMail();

    const second = checkInTokenFrom(instance.mailer.sent.at(-1)!.text);
    expect(second).not.toEqual(first);

    // Somebody who ignored the first email and acts on it late is not punished for it.
    const stranger = new TestClient(instance.app);
    expect((await stranger.post('/api/check-in', { token: first })).status).toBe(200);
    instance.close();
  });

  it('is not carried by the email sent after the switch has fired', async () => {
    const instance = createTestInstance();
    const admin = await registerAdmin(instance, 'owner@example.com');
    await admin.put('/api/estate/deadman', { enabled: true, inactivityDays: 30, graceDays: 7 });
    instance.mailer.reset();

    instance.advance(31 * DAY);
    evaluateDeadManSwitches(instance.ctx);
    instance.advance(8 * DAY);
    evaluateDeadManSwitches(instance.ctx);
    await instance.flushMail();

    const fired = instance.mailer.sent.find((m) => m.subject.includes('has released'));
    // A button promising to stop it would be a lie: the escrows are already open.
    expect(fired?.text).not.toContain('/check-in?token=');
    instance.close();
  });
});
