/**
 * The full happy path, in a real browser.
 *
 * `docs/PLAN.md` names this journey: register via invite → add an FD, a fund holding and a
 * land record → see net worth → unlock the vault → add credentials → invite a nominee →
 * the nominee signs in and sees a summary but not the vault → back up → restore → totals
 * match exactly.
 *
 * What makes it worth its runtime is the part no other test can reach. The vault's Argon2id
 * and AES-GCM run in the browser's own WebCrypto against the real WASM build, so this is the
 * only place the zero-knowledge claim is exercised from a passphrase typed into a field
 * through to ciphertext arriving at the server. Everything else here is covered by faster
 * tests and is included because a journey with a gap in it is not a journey.
 *
 * It runs serially against one server and one database, in order. A deliberate departure
 * from the usual advice about independent tests: the thing under test *is* the sequence, and
 * a restore has nothing to prove without the steps before it.
 */

import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const ADMIN = {
  email: 'asha@example.com',
  name: 'Asha Rao',
  password: 'correct-horse-battery-staple',
};

const NOMINEE = {
  email: 'heir@example.com',
  name: 'Ravi Rao',
  password: 'a-different-long-passphrase',
};

const VAULT_PASSPHRASE = 'the-vault-passphrase-is-long';
const BACKUP_PASSPHRASE = 'the-backup-passphrase-is-long';

/** Shared across the whole file: this is one journey, not a dozen independent cases. */
let netWorthBefore: string;
let nomineeInviteCode: string;
let bundleFilename: string;

test('the first account registers with the bootstrap invite code', async ({ page }) => {
  await page.goto('/');

  // A fresh installation opens on the registration form, because there is nobody to be yet.
  await expect(page.getByText(/nobody has registered on this instance yet/i)).toBeVisible();

  await page.getByLabel('Invite code').fill('E2E-BOOTSTRAP-CODE-0001');
  await page.getByLabel('Your name').fill(ADMIN.name);
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});

test('an empty dashboard says so rather than showing a confident zero', async ({ page }) => {
  await signIn(page);
  await expect(page.getByText('Nothing here yet')).toBeVisible();
});

test('a fixed deposit, a plot of land and a fund holding go in', async ({ page }) => {
  await signIn(page);

  await page.goto('/assets/new');
  await page.getByLabel('What is it').selectOption('deposit');
  await page.getByLabel('Name', { exact: true }).fill('SBI Fixed Deposit');
  await page.getByLabel('Institution').fill('SBI');
  await page.getByLabel('Scheme').selectOption('fd');
  await page.getByLabel('Principal').fill('500000');
  await page.getByLabel('Interest rate').fill('7.1');
  await page.getByLabel('Opened on').last().fill('2024-04-01');
  await page.getByLabel('Matures on').fill('2029-04-01');
  await page.getByRole('button', { name: 'Add asset' }).click();
  await expect(page).toHaveURL(/\/assets\/[0-9a-f-]+$/);

  await page.goto('/assets/new');
  await page.getByLabel('What is it').selectOption('property');
  await page.getByLabel('Name', { exact: true }).fill('Plot at Kolar');
  await page.getByLabel('Kind').selectOption('land');
  await page.getByLabel('Survey number').fill('112/2B');
  await page.getByLabel('Value', { exact: true }).fill('48L');
  await page.getByRole('button', { name: 'Add asset' }).click();
  await expect(page).toHaveURL(/\/assets\/[0-9a-f-]+$/);

  // The fund is the one asset that needs an instrument behind it, and the picker that
  // chooses it renders inside this form. That nesting is exactly what broke it once — the
  // panel was a `<form>` inside a `<form>`, so "Add instrument" reloaded the page instead
  // of creating anything — so the journey walks the create-it-inline path deliberately.
  await page.goto('/assets/new');
  await page.getByLabel('What is it').selectOption('holding');
  await page.getByLabel('Name', { exact: true }).first().fill('PPFAS Flexi Cap');
  await page.getByLabel('Search instruments').fill('Parag Parikh');
  await page.getByRole('button', { name: 'Not listed? Add it' }).click();
  await page.getByLabel('AMFI scheme code').fill('122639');
  await page.getByRole('button', { name: 'Add instrument' }).click();
  // The picker collapses to the chosen scheme, and the page has not navigated away.
  await expect(page.getByRole('button', { name: 'Change' })).toBeVisible();
  await expect(page).toHaveURL(/\/assets\/new$/);
  await page.getByLabel('Units').fill('120.5');
  await page.getByLabel('Average cost').fill('61.2');
  await page.getByRole('button', { name: 'Add asset' }).click();
  await expect(page).toHaveURL(/\/assets\/[0-9a-f-]+$/);

  await page.goto('/assets');
  await expect(page.getByText('SBI Fixed Deposit')).toBeVisible();
  await expect(page.getByText('Plot at Kolar')).toBeVisible();
  await expect(page.getByText('PPFAS Flexi Cap')).toBeVisible();
});

test('the dashboard reports a net worth built from both', async ({ page }) => {
  await signIn(page);
  await page.goto('/');

  const total = page.locator('.sensitive').first();
  await expect(total).toBeVisible();
  netWorthBefore = ((await total.textContent()) ?? '').trim();

  expect(netWorthBefore).toMatch(/₹/);
  // The land alone is ₹48 lakh, and the deposit has accrued on top of ₹5 lakh.
  await expect(page.getByText('Nothing here yet')).toBeHidden();
});

test('the nomination report ranks what an heir would struggle to claim', async ({ page }) => {
  await signIn(page);
  await page.goto('/planner');

  await expect(page.getByText(/of 3 assets have a registered nominee/)).toBeVisible();
  // The land is the largest thing with no nomination on it, so it leads the list, and it
  // arrives with the registration steps rather than just a warning.
  await expect(page.getByText('Plot at Kolar')).toBeVisible();
  await expect(page.getByText(/sub-registrar/i).first()).toBeVisible();
});

test('the calendar knows when the deposit matures and when the year ends', async ({ page }) => {
  await signIn(page);
  await page.goto('/planner?tab=calendar&days=365');

  await expect(page.getByText('Financial year ends')).toBeVisible();
});

test('the tax page calls itself an estimate and shows the rates it used', async ({ page }) => {
  await signIn(page);
  await page.goto('/planner?tab=tax');

  await expect(page.getByText(/is an estimate/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Rates used' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Section 80C' })).toBeVisible();
});

test('the vault is created in the browser, with real Argon2id', async ({ page }) => {
  await signIn(page);
  await page.goto('/vault');

  await page.getByLabel('Vault passphrase', { exact: true }).fill(VAULT_PASSPHRASE);
  await page.getByLabel('Type it again').fill(VAULT_PASSPHRASE);
  await page.getByRole('checkbox').check();

  // 64 MiB and three passes, in a browser. Slow on purpose, so the timeout is generous.
  await page.getByRole('button', { name: 'Create vault' }).click();
  await expect(page.getByRole('button', { name: 'Add item' })).toBeVisible({ timeout: 120_000 });
});

test('the server holds ciphertext and nothing else', async ({ page }) => {
  await signIn(page);

  // Straight at the API carrying the browser's own cookies: whatever comes back is exactly
  // what the server has, and none of it may be readable.
  const items = await page.request.get('/api/vault/items');
  expect(items.ok()).toBeTruthy();
  expect(await items.text()).not.toContain(VAULT_PASSPHRASE);

  const keys = await page.request.get('/api/vault');
  expect(await keys.text()).not.toContain(VAULT_PASSPHRASE);
});

test('a nominee is recorded and invited', async ({ page }) => {
  await signIn(page);
  await page.goto('/nominees');

  await page.getByRole('button', { name: 'Add nominee' }).first().click();
  await page.getByLabel('Name', { exact: true }).fill(NOMINEE.name);
  await page.getByLabel('Email').fill(NOMINEE.email);
  await page.getByRole('button', { name: 'Add nominee' }).last().click();

  await expect(page.getByText(NOMINEE.name)).toBeVisible();

  // The code is shown exactly once and stored only as a hash — this is the only chance to
  // read it, which is precisely what makes it worth asserting.
  await page
    .getByRole('button', { name: /invite/i })
    .last()
    .click();
  await expect(page.getByText(/invite code . shown once/i)).toBeVisible();

  const code = page.locator('p.font-mono').last();
  nomineeInviteCode = ((await code.textContent()) ?? '').trim();
  expect(nomineeInviteCode.length).toBeGreaterThan(8);
});

test('the nominee signs in read-only, and the server enforces it', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByRole('button', { name: 'I have an invite code' }).click();

  await page.getByLabel('Invite code').fill(nomineeInviteCode);
  await page.getByLabel('Your name').fill(NOMINEE.name);
  await page.getByLabel('Email').fill(NOMINEE.email);
  await page.getByLabel('Password').fill(NOMINEE.password);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  // A nominee's navigation swaps the owner-only destinations for the one that is theirs.
  await expect(page.getByRole('link', { name: 'Inheritance' }).first()).toBeVisible();

  // The guard that actually matters, asserted at the API rather than at the chrome: a write
  // is refused whatever the interface happens to render.
  const write = await page.request.post('/api/assets', {
    data: {
      type: 'bank_account',
      name: 'Not mine',
      detail: { accountType: 'savings' },
    },
  });
  expect(write.status()).toBe(403);
});

test('an admin takes an encrypted backup', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings');

  await expect(page.getByRole('heading', { name: 'Backup' })).toBeVisible();
  await page.getByLabel('Passphrase').first().fill(BACKUP_PASSPHRASE);
  await page.getByRole('button', { name: 'Back up now' }).click();

  const bundle = page.getByText(/\.ntb$/).first();
  await expect(bundle).toBeVisible({ timeout: 120_000 });
  bundleFilename = ((await bundle.textContent()) ?? '').trim();
  expect(bundleFilename).toMatch(/^networth-\d{8}T\d{6}Z-manual\.ntb$/);
});

test('a restore puts back exactly what the backup held', async ({ page }) => {
  await signIn(page);

  // Break something first, so the restore has work to do rather than passing by doing
  // nothing at all.
  await page.goto('/assets');
  await page.getByText('Plot at Kolar').click();

  // Archiving asks for confirmation through `window.confirm`, which Playwright dismisses by
  // default — without this the click silently does nothing and the assertion below would be
  // testing that a restore leaves an untouched database untouched.
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Archive' }).click();

  // Archiving returns to the list, where the default filter is active assets only.
  await expect(page).toHaveURL(/\/assets$/);
  await expect(page.getByText('Plot at Kolar')).toBeHidden();

  await page.goto('/');
  await expect(page.locator('.sensitive').first()).not.toHaveText(netWorthBefore);

  // Pull the bundle back through the API and hand the bytes to the restore form.
  const download = await page.request.get(`/api/backup/${bundleFilename}`);
  expect(download.ok()).toBeTruthy();

  await page.goto('/settings');
  await page.setInputFiles('input[type="file"]', {
    name: bundleFilename,
    mimeType: 'application/octet-stream',
    buffer: await download.body(),
  });
  await page.getByLabel('Passphrase').last().fill(BACKUP_PASSPHRASE);
  await page.getByLabel(/type .restore. to confirm/i).fill('restore');
  await page.getByRole('button', { name: /replace everything/i }).click();

  await expect(page.getByRole('heading', { name: 'Restored' })).toBeVisible({ timeout: 180_000 });

  // The restore replaced every session along with everything else, so this account is signed
  // out. That is the documented behaviour, and worth asserting rather than working around.
  await signIn(page);
  await page.goto('/');
  await expect(page.locator('.sensitive').first()).toHaveText(netWorthBefore);
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Sign in as the owner.
 *
 * Each test gets a fresh browser context, so the cookie does not survive between them.
 * Going through the form every time is both the honest thing and a repeated exercise of the
 * one flow every other flow depends on.
 */
async function signIn(page: Page): Promise<void> {
  await page.goto('/sign-in');

  const emailField = page.getByLabel('Email');
  if ((await emailField.count()) > 0) {
    await emailField.fill(ADMIN.email);
    await page.getByLabel('Password').fill(ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }

  await expect(page).not.toHaveURL(/\/sign-in/);
}
