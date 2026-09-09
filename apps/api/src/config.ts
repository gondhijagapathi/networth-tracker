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
  /**
   * Parsed as a word, not coerced. `z.coerce.boolean()` is `Boolean(value)`, under which
   * the string `'false'` is `true` — so the literal line in `.env.example` would have
   * turned the flag on, and the production guard below could never have fired. An
   * unrecognised value is a boot-time error rather than a guess, because both guesses are
   * wrong: `true` breaks a plain-HTTP install with silently dropped cookies, and `false`
   * ships a session cookie without the `Secure` flag.
   */
  COOKIE_SECURE: z
    .enum(['true', 'false'], { message: "COOKIE_SECURE must be exactly 'true' or 'false'" })
    .default('false')
    .transform((value) => value === 'true'),

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

  /* --- Mail ------------------------------------------------------------- */

  /**
   * The SMTP server. Empty means this instance sends no mail at all — every message is
   * recorded as `suppressed` rather than dropped, so the absence is visible in the admin
   * screen instead of being a mystery.
   *
   * `SMTP_HOST` alone is what turns mail on. Everything else below is either optional or
   * derived, and the cross-checks after parsing catch the combinations that would fail at
   * the first send rather than at boot.
   */
  SMTP_HOST: blankAsUndefined(z.string().min(1).optional()),
  SMTP_PORT: z.coerce.number().int().positive().max(65535).default(587),
  SMTP_USER: blankAsUndefined(z.string().min(1).optional()),
  /**
   * For Gmail this is a sixteen-character App Password, never the account password — Google
   * has not accepted the latter over SMTP since 2022. Google displays it in four spaced
   * groups (`abcd efgh ijkl mnop`) and people paste it that way, so the spaces are stripped
   * below rather than left to fail as a wrong password.
   */
  SMTP_PASS: blankAsUndefined(z.string().min(1).optional()),
  /**
   * The `From` address. Defaults to `SMTP_USER`, which is what Gmail requires anyway: it
   * rewrites — or refuses — a `From` that is neither the authenticated account nor an alias
   * verified on it, and a silently rewritten sender is a confusing thing to debug.
   */
  SMTP_FROM: blankAsUndefined(z.string().min(1).optional()),
  /**
   * Implicit TLS from the first byte, as on port 465. Left unset it follows the port, which
   * is right for every common provider: 465 is implicit TLS, 587 is STARTTLS.
   */
  SMTP_SECURE: blankAsUndefined(
    z
      .enum(['true', 'false'], { message: "SMTP_SECURE must be exactly 'true' or 'false'" })
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
  ),

  /**
   * The URL a person types to reach this installation, used to build the links in outgoing
   * mail — a reset link, an invite link, a check-in link.
   *
   * This cannot be derived from the request that triggered the mail: a dead-man warning is
   * sent by a timer with no request behind it, and trusting a `Host` header would let a
   * caller decide where a password-reset link points. So it is configured, and it defaults
   * to the first `CORS_ORIGIN` because that is already the origin the browser talks from.
   */
  APP_BASE_URL: blankAsUndefined(z.url({ message: 'APP_BASE_URL must be a full URL' }).optional()),
});

/**
 * An unset variable and one present but empty mean the same thing to an operator, and a
 * commented-out `SMTP_HOST=` line should read as "off" rather than as a validation error.
 */
function blankAsUndefined<T extends z.ZodType>(inner: T): z.ZodType<z.output<T> | undefined> {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    inner,
  ) as z.ZodType<z.output<T> | undefined>;
}

/** Values in `.env.example`. Running with any of these in production is a hard failure. */
const PLACEHOLDER_MARKERS = ['replace-me', 'change-me'];

/**
 * The SMTP settings, resolved.
 *
 * Present only when this instance can actually send: `SMTP_HOST` is set and the credential
 * questions have been answered. Everything downstream tests `config.mail === null` for
 * "mail is off" rather than re-deriving it from four environment variables.
 */
export interface MailConfig {
  host: string;
  port: number;
  /** Implicit TLS (465) rather than STARTTLS (587). */
  secure: boolean;
  auth: { user: string; pass: string } | null;
  /** Already includes the display name, e.g. `Net Worth <you@gmail.com>`. */
  from: string;
}

export type Config = z.infer<typeof schema> & {
  /** `ACCESS_TOKEN_TTL` parsed to seconds, so nothing downstream re-parses a string. */
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  /** Null when this instance has no mail transport. See {@link MailConfig}. */
  mail: MailConfig | null;
  /** `APP_BASE_URL` or the first CORS origin, without a trailing slash. */
  appBaseUrl: string;
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

  const mail = resolveMail(value, problems);

  if (problems.length > 0) throw configError(problems);

  return {
    ...value,
    accessTokenTtlSeconds,
    refreshTokenTtlSeconds,
    mail,
    // A trailing slash here becomes a double slash in every emailed link, which some mail
    // clients then decline to linkify at all.
    appBaseUrl: (value.APP_BASE_URL ?? firstCorsOrigin(value.CORS_ORIGIN)).replace(/\/+$/, ''),
  };
}

/** The origin the browser talks from, which is the best guess at where a link should point. */
function firstCorsOrigin(corsOrigin: string): string {
  return corsOrigin.split(',')[0]?.trim() || 'http://localhost:5173';
}

/**
 * Turn the SMTP variables into a transport, or into nothing.
 *
 * The checks here are the ones worth failing at boot: a half-configured transport is
 * indistinguishable from a working one until the first message needs to go out, and the
 * first message that needs to go out may well be a dead-man warning nobody is watching for.
 */
function resolveMail(value: z.infer<typeof schema>, problems: string[]): MailConfig | null {
  const host = value.SMTP_HOST;
  if (host === undefined) {
    // A password with no host is a line somebody edited and expected to work.
    if (value.SMTP_USER !== undefined || value.SMTP_PASS !== undefined) {
      problems.push('SMTP_USER/SMTP_PASS are set but SMTP_HOST is not — mail would not be sent');
    }
    return null;
  }

  const user = value.SMTP_USER;
  // Gmail App Passwords are shown in four spaced groups and get pasted that way. Stripping
  // whitespace is safe for any provider — a password whose meaning depends on a leading
  // space is not a password anyone typed on purpose — and it turns the single commonest
  // setup failure into a non-event.
  const pass = value.SMTP_PASS?.replace(/\s+/g, '');

  if ((user === undefined) !== (pass === undefined)) {
    problems.push('SMTP_USER and SMTP_PASS must be set together, or neither');
  }

  const from = value.SMTP_FROM ?? user;
  if (from === undefined) {
    problems.push('SMTP_FROM is required when SMTP_HOST is set and SMTP_USER is not');
  }

  if (isGmail(host)) {
    if (user === undefined) {
      problems.push('Gmail requires SMTP_USER and SMTP_PASS (a 16-character App Password)');
    } else if (pass !== undefined && pass.length !== 16) {
      // Not fatal — Workspace accounts can use OAuth-issued credentials of other lengths —
      // but wrong often enough to be worth saying out loud at boot.
      problems.push(
        'SMTP_PASS does not look like a Gmail App Password (16 characters once spaces are ' +
          'removed). Google stopped accepting account passwords over SMTP in May 2022.',
      );
    }
  }

  return {
    host,
    port: value.SMTP_PORT,
    // 465 is implicit TLS; 587 and 25 negotiate it with STARTTLS, which nodemailer does on
    // its own when `secure` is false. Getting this backwards hangs the connection rather
    // than failing it, which is a miserable thing to debug.
    secure: value.SMTP_SECURE ?? value.SMTP_PORT === 465,
    auth: user !== undefined && pass !== undefined ? { user, pass } : null,
    from: withDisplayName(from ?? ''),
  };
}

function isGmail(host: string): boolean {
  return /(^|\.)(gmail|googlemail)\.com$/i.test(host.trim());
}

/**
 * Give a bare address a display name.
 *
 * `Net Worth <you@gmail.com>` reads as a household's own tracker in an inbox; a naked
 * Gmail address reads as a person, and is more likely to be replied to than acted on.
 * An address the operator has already given a name to is left exactly as written.
 */
function withDisplayName(from: string): string {
  return from.includes('<') ? from : `Net Worth <${from}>`;
}

function configError(problems: string[]): Error {
  const list = problems.map((p) => `  - ${p}`).join('\n');
  return new Error(`Invalid environment configuration:\n${list}\n\nSee .env.example.`);
}
