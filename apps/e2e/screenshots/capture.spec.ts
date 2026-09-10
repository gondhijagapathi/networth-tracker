/**
 * Capture the README's screenshots.
 *
 * Not a test — it asserts almost nothing and it writes files into `docs/screenshots/`. It
 * lives under Playwright because that is the only thing in this repository that can drive a
 * browser, and a screenshot generated from a script is a screenshot that can be regenerated
 * when the UI moves, rather than one that quietly ages into a lie.
 *
 * It registers its own account and seeds its own portfolio against the throwaway database
 * the config stands up, so the images show a household that looks real without any real
 * person's finances being anywhere near it.
 */

import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'screenshots');

const OWNER = {
  email: 'screenshots@example.com',
  name: 'Asha Rao',
  password: 'correct-horse-battery-staple',
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  mkdirSync(OUT, { recursive: true });
});

/**
 * Register on a fresh instance, or sign in to one that has already been set up.
 *
 * Each test gets its own browser context and therefore its own empty cookie jar, so every
 * one of them starts here.
 */
async function signIn(page: Page): Promise<void> {
  await page.goto('/sign-in');

  // Wait for the form to settle before touching it. Which form is shown depends on
  // `/auth/bootstrap`, which is answered a moment after the page renders — so reading the
  // fields before that lands can fill in the sign-in form and then watch it turn into the
  // registration one.
  const registerButton = page.getByRole('button', { name: 'Create account' });
  const signInButton = page.getByRole('button', { name: 'Sign in' });
  await expect(registerButton.or(signInButton)).toBeVisible();

  if ((await page.getByLabel('Invite code').count()) > 0) {
    await page.getByLabel('Invite code').fill('E2E-BOOTSTRAP-CODE-0001');
    await page.getByLabel('Your name').fill(OWNER.name);
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill(OWNER.password);
    await registerButton.click();
  } else {
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill(OWNER.password);
    await signInButton.click();
  }

  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

test('set up a household worth photographing', async ({ page }) => {
  await signIn(page);

  // A plausible Indian household: a salary account, a deposit, PPF, a fund, a flat, EPF,
  // gold and the home loan against the flat.
  const assets = [
    {
      type: 'bank_account',
      name: 'HDFC salary account',
      institution: 'HDFC Bank',
      value: '385000',
      nominated: true,
      detail: async () => {
        await page.getByLabel('Account number').fill('50100123456789');
        await page.getByLabel('IFSC').fill('HDFC0001234');
      },
    },
    {
      type: 'deposit',
      name: 'SBI fixed deposit',
      institution: 'SBI',
      value: '',
      nominated: true,
      detail: async () => {
        await page.getByLabel('Scheme').selectOption('fd');
        await page.getByLabel('Principal').fill('500000');
        await page.getByLabel('Interest rate').fill('7.15');
        await page.getByLabel('Opened on').last().fill('2024-04-15');
        await page.getByLabel('Matures on').fill('2029-04-15');
      },
    },
    {
      type: 'deposit',
      name: 'PPF',
      institution: 'SBI',
      value: '',
      nominated: true,
      detail: async () => {
        await page.getByLabel('Scheme').selectOption('ppf');
        await page.getByLabel('Principal').fill('900000');
        await page.getByLabel('Recurring instalment').fill('150000');
        await page.getByLabel('Interest rate').fill('7.1');
        await page.getByLabel('Compounding').selectOption('yearly');
        await page.getByLabel('Opened on').last().fill('2018-04-05');
      },
    },
    {
      type: 'property',
      name: 'Flat in Whitefield',
      institution: '',
      value: '9200000',
      nominated: false,
      detail: async () => {
        await page.getByLabel('Kind').selectOption('flat');
        await page.getByLabel('Khata number').fill('K-4471');
        await page.getByLabel('Sub-registrar office').fill('Whitefield');
      },
    },
    {
      type: 'retirement_account',
      name: 'EPF',
      institution: 'EPFO',
      value: '',
      nominated: false,
      detail: async () => {
        await page.getByLabel('Scheme').selectOption('epf');
        await page.getByLabel('Employee balance').fill('820000');
        await page.getByLabel('Employer balance').fill('650000');
      },
    },
    {
      type: 'precious_metal',
      name: 'Sovereign gold bonds',
      institution: 'RBI',
      value: '620000',
      nominated: false,
      detail: async () => {
        await page.getByLabel('Form').selectOption('sgb');
        await page.getByLabel('Weight in grams').fill('80');
      },
    },
    {
      type: 'liability',
      name: 'Home loan',
      institution: 'HDFC Bank',
      value: '',
      nominated: false,
      detail: async () => {
        await page.getByLabel('Kind').selectOption('home');
        await page.getByLabel('Lender').fill('HDFC Bank');
        await page.getByLabel('Sanctioned amount').fill('5000000');
        await page.getByLabel('Outstanding').fill('3260000');
        await page.getByLabel('Interest rate').fill('8.65');
        await page.getByLabel('EMI').fill('41500');
        await page.getByLabel('Next due').fill(nextMonth());
      },
    },
  ];

  for (const asset of assets) {
    await page.goto('/assets/new');
    await page.getByLabel('What is it').selectOption(asset.type);
    await page.getByLabel('Name', { exact: true }).fill(asset.name);
    if (asset.institution !== '') await page.getByLabel('Institution').fill(asset.institution);
    if (asset.value !== '') await page.getByLabel('Value', { exact: true }).fill(asset.value);
    if (asset.nominated) await page.getByLabel('A nominee is registered on this').check();
    await asset.detail();
    await page.getByRole('button', { name: 'Add asset' }).click();
    await expect(page).toHaveURL(/\/assets\/[0-9a-f-]+$/);
  }
});

test('dashboard', async ({ page }) => {
  await signIn(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  // The chart animates in; without this the capture is sometimes a half-drawn line.
  await page.waitForTimeout(1_200);
  await page.screenshot({ path: join(OUT, 'dashboard.png') });
});

test('nomination hygiene', async ({ page }) => {
  await signIn(page);
  await page.goto('/planner');
  await expect(page.getByText(/assets have a registered nominee/)).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'nomination.png') });
});

test('the tax year', async ({ page }) => {
  await signIn(page);
  await page.goto('/planner?tab=tax');
  await expect(page.getByRole('heading', { name: 'Rates used' })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'tax-year.png'), fullPage: true });
});

test('the due calendar', async ({ page }) => {
  await signIn(page);
  await page.goto('/planner?tab=calendar&days=365');
  await expect(page.getByText('Financial year ends')).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'calendar.png') });
});

test('assets on a phone', async ({ page }) => {
  await signIn(page);
  // The application is designed mobile-first, so one of the images should actually be one.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/assets');
  await expect(page.getByText('Flat in Whitefield')).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'assets-mobile.png') });
});

test('backup and restore', async ({ page }) => {
  await signIn(page);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Backup' })).toBeVisible();
  await page.getByLabel('Passphrase').first().fill('a-long-enough-backup-passphrase');
  await page.getByRole('button', { name: 'Back up now' }).click();
  await expect(page.getByText(/\.ntb$/).first()).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: join(OUT, 'backup.png'), fullPage: true });
});

/** The fifth of next month, for an EMI due date that is always in the future. */
function nextMonth(): string {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 5));
  return date.toISOString().slice(0, 10);
}
