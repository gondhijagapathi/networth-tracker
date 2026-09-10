/**
 * The shell's layout, in a real browser.
 *
 * Two regressions this file exists to catch, both of which look fine in a screenshot of the
 * top of the page and only appear once somebody scrolls or clicks:
 *
 *  - the desktop sidebar scrolling away with the content instead of staying pinned;
 *  - the dashboard tearing itself down to skeletons when a chart window changes, which reads
 *    as a full page reload.
 *
 * Geometry and continuity are the assertions, because neither bug changes any text.
 */

import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

/**
 * The same identity `happy-path.spec.ts` registers.
 *
 * Both files run against one instance and one database, and only the first account can use
 * the bootstrap invite code. Sharing the credentials lets either file be the one that
 * registers — whichever Playwright reaches first — instead of the second one failing to sign
 * in as somebody who was never created.
 */
const OWNER = {
  email: 'asha@example.com',
  name: 'Asha Rao',
  password: 'correct-horse-battery-staple',
};

/** Assets this file adds purely to make the page taller than the window. */
const FILLER = 20;

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

/** Register on a fresh instance, or sign in to one that is already set up. */
async function signIn(page: Page): Promise<void> {
  await page.goto('/sign-in');

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

/**
 * Enough assets that every page is taller than the window.
 *
 * Written through the API rather than the asset form: this file is about the frame, and
 * twenty trips through a multi-step form would be twenty chances to fail for a reason that
 * has nothing to do with the frame.
 */
async function seed(page: Page): Promise<void> {
  const listed = await page.request.get('/api/assets');
  expect(listed.ok(), await listed.text()).toBe(true);
  const existing = (await listed.json()) as { total: number };

  // Top up rather than assume an empty instance: this file may run after the happy path,
  // which leaves a few assets of its own behind.
  const wanted = FILLER - existing.total;
  if (wanted <= 0) return;

  // The API is a double-submit CSRF design: echo the readable cookie back in the header,
  // exactly as `apps/web/src/lib/api.ts` does.
  const cookies = await page.context().cookies();
  const csrf = cookies.find((cookie) => cookie.name === 'nt_csrf')?.value;
  expect(csrf, 'no nt_csrf cookie after signing in').toBeTruthy();

  for (let index = 0; index < wanted; index += 1) {
    const response = await page.request.post('/api/assets', {
      headers: { 'x-csrf-token': csrf! },
      data: {
        type: 'bank_account',
        name: `Layout filler ${index + 1}`,
        institution: 'HDFC Bank',
        valuePaise: (index + 1) * 100_000,
        valueAsOf: '2024-01-01',
        openedOn: '2024-01-01',
        detail: { accountType: 'savings' },
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
}

test('the desktop sidebar stays put while the content scrolls', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await signIn(page);
  await seed(page);

  await page.goto('/assets');
  await expect(page.getByRole('heading', { name: 'Assets' })).toBeVisible();

  const sidebar = page.locator('aside');
  const dashboardLink = sidebar.getByRole('link', { name: 'Dashboard' });
  await expect(dashboardLink).toBeVisible();

  const before = await dashboardLink.boundingBox();
  expect(before).not.toBeNull();

  // The page must actually scroll, or this test proves nothing.
  await page.mouse.wheel(0, 1200);
  await expect
    .poll(() => page.evaluate(() => window.scrollY), { timeout: 5000 })
    .toBeGreaterThan(200);

  const after = await dashboardLink.boundingBox();
  expect(after).not.toBeNull();

  // The link is in viewport coordinates, so "did not move" is the whole assertion.
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(2);
  await expect(dashboardLink).toBeInViewport();

  // And the sidebar covers the window rather than ending with the fold.
  const box = await sidebar.boundingBox();
  expect(box!.y).toBeLessThanOrEqual(1);
  expect(box!.height).toBeGreaterThanOrEqual(DESKTOP.height - 2);
});

test('a short window gives the sidebar its own scroll, not a clipped one', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 400 });
  await signIn(page);

  const sidebar = page.locator('aside');
  await expect(sidebar).toBeVisible();

  // Sign out sits at the foot of the sidebar; on a 400px window it is below the fold, and it
  // has to be reachable by scrolling the sidebar itself.
  const signOut = sidebar.getByRole('button', { name: 'Sign out' });
  await signOut.scrollIntoViewIfNeeded();
  await expect(signOut).toBeInViewport();
});

test('changing the chart window does not reload the dashboard', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await signIn(page);
  await seed(page);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Net worth over time' })).toBeVisible();

  // A value that only survives while the document does. If the page reloads — or React
  // remounts the tree from scratch — this is gone.
  await page.evaluate(() => {
    (window as unknown as { __alive?: number }).__alive = 1;
  });

  /*
   * Hold the refetch open.
   *
   * Against a local server the second request answers in a few milliseconds, so a teardown
   * to skeletons is real but too brief for any assertion to land on — the test would pass
   * on the broken build. One second of delay makes the in-flight state observable, which is
   * the state this test is about.
   */
  await page.route('**/api/analytics/dashboard*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.continue();
  });

  const header = page.getByRole('heading', { name: 'Dashboard' });
  const chartTitle = page.getByRole('heading', { name: 'Net worth over time' });

  await page.getByRole('button', { name: '6M', exact: true }).click();

  // Mid-flight: the page is still the page. Before the fix it was three skeletons here.
  await expect(header).toBeVisible({ timeout: 500 });
  await expect(chartTitle).toBeVisible({ timeout: 500 });
  const dashboard = page.locator('#main > div[aria-busy]');
  await expect(dashboard).toHaveAttribute('aria-busy', 'true');

  await page.unroute('**/api/analytics/dashboard*');
  await expect(dashboard).toHaveAttribute('aria-busy', 'false');
  await expect(chartTitle).toBeVisible();

  await expect(page.getByRole('button', { name: '6M', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  expect(await page.evaluate(() => (window as unknown as { __alive?: number }).__alive)).toBe(1);
});

test('the phone keeps its tab bar on screen and shows no sidebar', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await signIn(page);
  await seed(page);

  await page.goto('/assets');
  await expect(page.getByRole('heading', { name: 'Assets' })).toBeVisible();

  await expect(page.locator('aside')).toBeHidden();

  const tabs = page.locator('nav.fixed');
  const before = await tabs.boundingBox();

  await page.mouse.wheel(0, 1200);
  await expect
    .poll(() => page.evaluate(() => window.scrollY), { timeout: 5000 })
    .toBeGreaterThan(200);

  const after = await tabs.boundingBox();
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(2);

  // The tab bar sits on the bottom edge, and the content clears it rather than hiding under it.
  expect(after!.y + after!.height).toBeGreaterThanOrEqual(PHONE.height - 2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    PHONE.width,
  );
});
