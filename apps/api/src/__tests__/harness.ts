/**
 * Test harness.
 *
 * Each test gets its own in-memory database, migrated from the same committed SQL the
 * production boot path runs, and an app wired through `createApp`. Nothing is stubbed:
 * these tests exercise real Argon2id hashing, real JWT signing and real SQLite, because
 * the things most worth testing here — rotation, replay, isolation — live exactly in the
 * seams that a mock would paper over.
 *
 * The clock is injectable so token expiry can be tested by moving time rather than waiting
 * thirty days.
 */

import type { Express } from 'express';
import type Database from 'better-sqlite3';
import supertest from 'supertest';
import type { CreateInviteBody, PublicUser, Role } from '@networth/shared';
import { createApp } from '../app.js';
import { loadConfig, type Config } from '../config.js';
import { createContext, type AppContext } from '../context.js';
import { createDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { ensureBootstrapInvite } from '../services/invite.service.js';

export const BOOTSTRAP_CODE = 'BOOTSTRAP-TEST-CODE-0001';
/**
 * The credential every fixture account registers with.
 *
 * Long enough for `passwordSchema`, not derived from any test email, and a well-known
 * example string rather than anything that could be mistaken for a real secret.
 */
export const TEST_PASSPHRASE = 'correct-horse-battery-staple';

const BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters-long',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters-long',
  SECRET_ENCRYPTION_KEY: 'test-encryption-key-at-least-32-characters-long',
  BOOTSTRAP_INVITE_CODE: BOOTSTRAP_CODE,
  DATABASE_PATH: ':memory:',
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL: '30d',
};

export interface TestInstance {
  app: Express;
  ctx: AppContext;
  config: Config;
  sqlite: Database.Database;
  /** Move the injected clock forward. Everything time-dependent reads it. */
  advance: (seconds: number) => void;
  close: () => void;
}

export function createTestInstance(envOverrides: NodeJS.ProcessEnv = {}): TestInstance {
  const config = loadConfig({ ...BASE_ENV, ...envOverrides });
  const { db, sqlite, close } = createDb(':memory:');
  runMigrations(sqlite);

  let clock = Date.now();
  const ctx = createContext(config, db, sqlite, { now: () => new Date(clock) });

  ensureBootstrapInvite(ctx);

  return {
    app: createApp(ctx),
    ctx,
    config,
    sqlite,
    advance: (seconds) => {
      clock += seconds * 1000;
    },
    close,
  };
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A cookie-carrying client, the way a browser behaves.
 *
 * The CSRF token is echoed from the cookie into the `x-csrf-token` header on every
 * mutating call, which is exactly what the real front end does — so if the double-submit
 * check regresses, these tests notice.
 */
export class TestClient {
  private cookies = new Map<string, string>();
  user: PublicUser | null = null;

  constructor(private readonly app: Express) {}

  get csrfToken(): string | undefined {
    return this.cookies.get('nt_csrf');
  }

  get refreshToken(): string | undefined {
    return this.cookies.get('nt_refresh');
  }

  get accessToken(): string | undefined {
    return this.cookies.get('nt_access');
  }

  /** Overwrite a cookie, to simulate a stolen or stale credential. */
  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  clearCookies(): void {
    this.cookies.clear();
  }

  async get(path: string): Promise<supertest.Response> {
    return this.send('get', path);
  }

  async post(
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<supertest.Response> {
    return this.send('post', path, body, options);
  }

  async patch(
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<supertest.Response> {
    return this.send('patch', path, body, options);
  }

  async delete(path: string, options: RequestOptions = {}): Promise<supertest.Response> {
    return this.send('delete', path, undefined, options);
  }

  private async send(
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<supertest.Response> {
    let request = supertest(this.app)[method](path);

    const cookieHeader = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    if (cookieHeader) request = request.set('Cookie', cookieHeader);

    const csrf = options.csrfToken ?? this.csrfToken;
    if (csrf !== undefined && options.omitCsrf !== true) {
      request = request.set('x-csrf-token', csrf);
    }
    if (options.ip) request = request.set('X-Forwarded-For', options.ip);

    const response = body === undefined ? await request : await request.send(body as object);

    this.absorbCookies(response);
    return response;
  }

  /** Apply `Set-Cookie` the way a browser would, including clearing on an empty value. */
  private absorbCookies(response: supertest.Response): void {
    const header = response.headers['set-cookie'];
    if (!header) return;

    for (const raw of Array.isArray(header) ? header : [header]) {
      const [pair] = raw.split(';');
      const index = pair?.indexOf('=') ?? -1;
      if (index <= 0) continue;
      const name = pair!.slice(0, index);
      const value = pair!.slice(index + 1);
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

export interface RequestOptions {
  /** Send this instead of the stored CSRF token. */
  csrfToken?: string;
  /** Send no CSRF header at all. */
  omitCsrf?: boolean;
  /** Spoof a client address, for per-address rate-limit tests. */
  ip?: string;
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** Register the first admin using the bootstrap code. Returns a signed-in client. */
export async function registerAdmin(
  instance: TestInstance,
  email = 'admin@example.com',
): Promise<TestClient> {
  const client = new TestClient(instance.app);
  const response = await client.post('/api/auth/register', {
    inviteCode: BOOTSTRAP_CODE,
    email,
    name: 'Test Admin',
    password: TEST_PASSPHRASE,
  });
  if (response.status !== 201) {
    throw new Error(`Admin registration failed: ${response.status} ${response.text}`);
  }
  client.user = response.body.user as PublicUser;
  return client;
}

/** Have `admin` issue an invite and return the one-time code. */
export async function issueInvite(
  admin: TestClient,
  body: Partial<CreateInviteBody> = {},
): Promise<string> {
  const response = await admin.post('/api/admin/invites', { role: 'member', ...body });
  if (response.status !== 201) {
    throw new Error(`Invite creation failed: ${response.status} ${response.text}`);
  }
  return response.body.code as string;
}

/** Invite and register a member (or any role), returning a signed-in client. */
export async function registerMember(
  instance: TestInstance,
  admin: TestClient,
  options: { email?: string; name?: string; role?: Role; password?: string } = {},
): Promise<TestClient> {
  const email = options.email ?? 'member@example.com';
  const code = await issueInvite(admin, { role: options.role ?? 'member' });

  const client = new TestClient(instance.app);
  const response = await client.post('/api/auth/register', {
    inviteCode: code,
    email,
    name: options.name ?? 'Test Member',
    password: options.password ?? TEST_PASSPHRASE,
  });
  if (response.status !== 201) {
    throw new Error(`Member registration failed: ${response.status} ${response.text}`);
  }
  client.user = response.body.user as PublicUser;
  return client;
}
