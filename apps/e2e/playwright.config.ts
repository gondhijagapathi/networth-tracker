/**
 * End-to-end configuration.
 *
 * The suite starts a **real API and a real web server against a throwaway database**, on
 * ports that do not collide with a development instance, and tears the whole directory down
 * afterwards. That is deliberate: an E2E run that touches `data/networth.db` would be a
 * test suite that can destroy somebody's actual net worth history, and this one exercises
 * backup and restore.
 *
 * It is not part of `npm test`. Vitest already covers the API and the pure logic in a couple
 * of seconds; this covers the seam nothing else can — a browser, a service worker, real
 * cookies, real WebCrypto — and it costs a browser download to run. `npm run test:e2e`.
 */

import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API_PORT = 4310;
const WEB_PORT = 5310;

/**
 * A fresh directory per run, exported so the spec can point the CLI at the same instance.
 *
 * Created here rather than in a fixture because `webServer` below needs it before any test
 * has started, and a path in the environment is the only channel those two share.
 */
const workspace = process.env.E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'networth-e2e-'));

const env = {
  NODE_ENV: 'development',
  API_PORT: String(API_PORT),
  API_HOST: '127.0.0.1',
  CORS_ORIGIN: `http://localhost:${WEB_PORT}`,
  DATABASE_PATH: join(workspace, 'networth.db'),
  UPLOAD_DIR: join(workspace, 'uploads'),
  BACKUP_DIR: join(workspace, 'backups'),
  JWT_ACCESS_SECRET: 'e2e-access-secret-at-least-32-characters-long',
  JWT_REFRESH_SECRET: 'e2e-refresh-secret-at-least-32-characters-long',
  SECRET_ENCRYPTION_KEY: 'e2e-encryption-key-at-least-32-characters-long',
  BOOTSTRAP_INVITE_CODE: 'E2E-BOOTSTRAP-CODE-0001',
  COOKIE_SECURE: 'false',
  // No nightly job during a test run: it would race the assertions about what is on disk.
  BACKUP_CRON: '',
  STOCK_PRICE_PROVIDER: 'manual',
};

export default defineConfig({
  testDir: './tests',
  // The happy path is one long ordered journey — register, add assets, back up, restore —
  // so it runs as a single serial file rather than as parallel independent cases.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    // One browser. Three would triple the runtime to re-test the same server, and the
    // rendering differences that remain between engines are not what this suite is for.
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: [
    {
      command: 'npm run dev -w @networth/api',
      cwd: '../..',
      port: API_PORT,
      env,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      timeout: 60_000,
    },
    {
      command: 'npm run dev -w @networth/web',
      cwd: '../..',
      port: WEB_PORT,
      env: { WEB_PORT: String(WEB_PORT), API_PORT: String(API_PORT) },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});

export { workspace, API_PORT, WEB_PORT };
