import { z } from 'zod';

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
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('30d'),
  COOKIE_SECURE: z.coerce.boolean().default(false),

  BOOTSTRAP_INVITE_CODE: z.string().min(8).optional(),

  BACKUP_CRON: z.string().default('0 2 * * *'),
  BACKUP_RETENTION: z.coerce.number().int().positive().default(14),

  AMFI_NAV_URL: z.url().default('https://portal.amfiindia.com/spages/NAVAll.txt'),
  NAV_REFRESH_CRON: z.string().default('30 20 * * 1-5'),
  STOCK_PRICE_PROVIDER: z.enum(['manual', 'yahoo']).default('manual'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
  }
  return parsed.data;
}
