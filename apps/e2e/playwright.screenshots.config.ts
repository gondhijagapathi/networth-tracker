/**
 * Screenshots for the README.
 *
 * A separate config rather than a tagged test, because it wants different settings: a device
 * scale factor of two so the images are legible on a retina display, a fixed viewport so
 * they crop consistently, and no retries — a screenshot that needed a retry is a screenshot
 * of something intermittent.
 *
 * It reuses the same throwaway servers as the happy path, so `npm run screenshots` is
 * self-contained: `npm run screenshots -w @networth/e2e`.
 */

import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config.js';

export default defineConfig({
  ...base,
  testDir: './screenshots',
  reporter: [['list']],
  retries: 0,
  projects: [
    {
      name: 'capture',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: 'dark',
      },
    },
  ],
});
