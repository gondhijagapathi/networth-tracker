import { z } from 'zod';
import { parseCron } from './lib/cron.js';
import { parseDuration } from './lib/time.js';

/**
 * Environment configuration, validated once at boot.
 *
 * The app refuses to start on a bad config rather than failing at the first request —
 * a tracker that silently runs with a default JWT secret is worse than one that won't run.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default('127.0.0.1'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  DATABASE_PATH: z.string().default('./data/networth.db'),
  UPLOAD_DIR: z.string().default('./data/uploads'),
  BACKUP_DIR: z.string().default('./data/backups'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  /**
   * Encrypts server-readable secrets at rest — the TOTP seed today, provider credentials
   * later. Separate from the JWT secrets so those can be rotated (invalidating sessions,
   * which is recoverable) without destroying every enrolled second factor, which is not.
   */
  SECRET_ENCRYPTION_KEY: z.string().min(32, 'SECRET_ENCRYPTION_KEY must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('30d'),
  COOKIE_SECURE: z.coerce.boolean().default(false),

  BOOTSTRAP_INVITE_CODE: z.string().min(8).optional(),

  /** A 5-field cron expression, or empty to disable the nightly backup entirely. */
  BACKUP_CRON: z.string().default('0 2 * * *'),
  BACKUP_RETENTION: z.coerce.number().int().positive().default(14),
  /**
   * The passphrase the nightly bundle is sealed with.
   *
   * Optional, and the scheduled backup does not run without it — writing an unencrypted
   * snapshot of every account in the household to disk because nobody set a variable is not
   * a default this application is willing to have. `BACKUP.md` says so, and `scheduleOf` in
   * `backup.service.ts` reports the schedule as inactive rather than pretending otherwise.
   */
  BACKUP_PASSPHRASE: z.preprocess(
    // An unset variable and one present but empty mean the same thing to an operator, and
    // a length rule that rejected `BACKUP_PASSPHRASE=` would be a confusing way to say so.
    (value) => (value === '' ? undefined : value),
    z.string().min(12, 'BACKUP_PASSPHRASE must be at least 12 characters').optional(),
  ),

  AMFI_NAV_URL: z.url().default('https://portal.amfiindia.com/spages/NAVAll.txt'),
  NAV_REFRESH_CRON: z.string().default('30 20 * * 1-5'),
  STOCK_PRICE_PROVIDER: z.enum(['manual', 'yahoo']).default('manual'),
});

/** Values in `.env.example`. Running with any of these in production is a hard failure. */
const PLACEHOLDER_MARKERS = ['replace-me', 'change-me'];

export type Config = z.infer<typeof schema> & {
  /** `ACCESS_TOKEN_TTL` parsed to seconds, so nothing downstream re-parses a string. */
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw configError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`),
    );
  }

  const value = parsed.data;
  const problems: string[] = [];

  // Reusing one secret for both tokens means a leaked access secret also mints refresh
  // tokens — the short access lifetime would stop protecting anything.
  if (value.JWT_ACCESS_SECRET === value.JWT_REFRESH_SECRET) {
    problems.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values');
  }
  if (value.SECRET_ENCRYPTION_KEY === value.JWT_ACCESS_SECRET) {
    problems.push('SECRET_ENCRYPTION_KEY must differ from JWT_ACCESS_SECRET');
  }

  if (value.NODE_ENV === 'production') {
    for (const [key, secret] of Object.entries({
      JWT_ACCESS_SECRET: value.JWT_ACCESS_SECRET,
      JWT_REFRESH_SECRET: value.JWT_REFRESH_SECRET,
      SECRET_ENCRYPTION_KEY: value.SECRET_ENCRYPTION_KEY,
      BOOTSTRAP_INVITE_CODE: value.BOOTSTRAP_INVITE_CODE ?? '',
    })) {
      if (PLACEHOLDER_MARKERS.some((marker) => secret.includes(marker))) {
        problems.push(`${key} still holds its .env.example placeholder`);
      }
    }
    if (!value.COOKIE_SECURE) {
      problems.push('COOKIE_SECURE must be true in production — cookies carry the session');
    }
  }

  let accessTokenTtlSeconds = 0;
  let refreshTokenTtlSeconds = 0;
  try {
    accessTokenTtlSeconds = parseDuration(value.ACCESS_TOKEN_TTL);
  } catch (error) {
    problems.push(`ACCESS_TOKEN_TTL: ${(error as Error).message}`);
  }
  try {
    refreshTokenTtlSeconds = parseDuration(value.REFRESH_TOKEN_TTL);
  } catch (error) {
    problems.push(`REFRESH_TOKEN_TTL: ${(error as Error).message}`);
  }

  // Cron expressions are checked here rather than at their first tick: a typo in
  // `NAV_REFRESH_CRON` should stop the process at boot, not fire a TypeError at 20:30.
  for (const [key, expression] of Object.entries({
    NAV_REFRESH_CRON: value.NAV_REFRESH_CRON,
    BACKUP_CRON: value.BACKUP_CRON,
  })) {
    if (expression.trim() === '') continue;
    try {
      parseCron(expression);
    } catch (error) {
      problems.push(`${key}: ${(error as Error).message}`);
    }
  }

  if (accessTokenTtlSeconds > 0 && refreshTokenTtlSeconds > 0) {
    if (accessTokenTtlSeconds >= refreshTokenTtlSeconds) {
      problems.push('ACCESS_TOKEN_TTL must be shorter than REFRESH_TOKEN_TTL');
    }
  }

  if (problems.length > 0) throw configError(problems);

  return { ...value, accessTokenTtlSeconds, refreshTokenTtlSeconds };
}

function configError(problems: string[]): Error {
  const list = problems.map((p) => `  - ${p}`).join('\n');
  return new Error(`Invalid environment configuration:\n${list}\n\nSee .env.example.`);
}
