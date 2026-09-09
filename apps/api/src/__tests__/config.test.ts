import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

/**
 * A valid production environment, which each test then makes invalid in exactly one way.
 * The three secrets must differ from one another, so they are three distinct fillers rather
 * than the same string repeated.
 */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    JWT_ACCESS_SECRET: 'access'.padEnd(48, 'a'),
    JWT_REFRESH_SECRET: 'refresh'.padEnd(48, 'b'),
    SECRET_ENCRYPTION_KEY: 'encryption'.padEnd(48, 'c'),
    BOOTSTRAP_INVITE_CODE: 'first-admin-code',
    COOKIE_SECURE: 'true',
    ...overrides,
  };
}

describe('COOKIE_SECURE', () => {
  /**
   * The regression this file exists for. `z.coerce.boolean()` is `Boolean(value)`, so every
   * non-empty string — including `'false'`, which `.env.example` ships — came out `true`.
   * That made the production guard below unreachable and turned the `Secure` flag on for
   * plain-HTTP installs, where the browser then drops the session cookie and login silently
   * does nothing.
   */
  it("reads 'false' as false rather than coercing it to true", () => {
    const config = loadConfig(env({ NODE_ENV: 'development', COOKIE_SECURE: 'false' }));
    expect(config.COOKIE_SECURE).toBe(false);
  });

  it("reads 'true' as true", () => {
    expect(loadConfig(env()).COOKIE_SECURE).toBe(true);
  });

  it('defaults to false when unset', () => {
    const bare = env({ NODE_ENV: 'development' });
    delete bare.COOKIE_SECURE;
    expect(loadConfig(bare).COOKIE_SECURE).toBe(false);
  });

  it('refuses a value that is neither word, rather than guessing at it', () => {
    for (const value of ['1', '0', 'yes', 'no', 'TRUE', '']) {
      expect(() => loadConfig(env({ COOKIE_SECURE: value }))).toThrow(/COOKIE_SECURE/);
    }
  });

  it('refuses to start in production without it, since the session lives in the cookie', () => {
    expect(() => loadConfig(env({ COOKIE_SECURE: 'false' }))).toThrow(
      /COOKIE_SECURE must be true in production/,
    );
  });

  it('allows it to be off outside production, where there is no TLS to carry it', () => {
    expect(loadConfig(env({ NODE_ENV: 'development', COOKIE_SECURE: 'false' })).NODE_ENV).toBe(
      'development',
    );
  });
});

describe('loadConfig', () => {
  it('accepts a well-formed production environment', () => {
    const config = loadConfig(env());
    expect(config.NODE_ENV).toBe('production');
    expect(config.accessTokenTtlSeconds).toBe(900);
    expect(config.refreshTokenTtlSeconds).toBe(2_592_000);
  });

  it('refuses reused secrets, so a leaked access secret cannot mint refresh tokens', () => {
    const shared = 'shared'.padEnd(48, 'x');
    expect(() =>
      loadConfig(env({ JWT_ACCESS_SECRET: shared, JWT_REFRESH_SECRET: shared })),
    ).toThrow(/must be different values/);
  });

  it('refuses a .env.example placeholder left in production', () => {
    expect(() =>
      loadConfig(env({ JWT_ACCESS_SECRET: 'replace-me-openssl-rand-base64-48-aaaaaaaa' })),
    ).toThrow(/placeholder/);
  });

  it('refuses an access token that outlives its refresh token', () => {
    expect(() => loadConfig(env({ ACCESS_TOKEN_TTL: '60d' }))).toThrow(
      /ACCESS_TOKEN_TTL must be shorter/,
    );
  });

  it('refuses a malformed cron expression at boot rather than at its first tick', () => {
    expect(() => loadConfig(env({ BACKUP_CRON: '99 * * * *' }))).toThrow(/BACKUP_CRON/);
  });

  it('treats an empty BACKUP_CRON as "disabled" rather than malformed', () => {
    expect(loadConfig(env({ BACKUP_CRON: '' })).BACKUP_CRON).toBe('');
  });

  it('treats an empty BACKUP_PASSPHRASE the same as an unset one', () => {
    expect(loadConfig(env({ BACKUP_PASSPHRASE: '' })).BACKUP_PASSPHRASE).toBeUndefined();
  });
});
