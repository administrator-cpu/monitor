import { expect, test as base, type Page } from '@playwright/test';

const PASSWORD = process.env.E2E_PASSWORD ?? 'e2e test passphrase 1';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Username').fill('owner');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}

// One sign-in for the whole file: the login limiter allows 20 attempts per 10 minutes per address.
let shared: Page;
const test = base;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => {
  shared = await (await browser.newContext({ baseURL: process.env.E2E_ORIGIN ?? 'http://127.0.0.1:3100' })).newPage();
  await signIn(shared);
});
test.afterAll(async () => {
  await shared.context().close();
});

test('the overview shows gateway, database and application totals', async () => {
  const page = shared;
  await page.goto('/');
  const strip = page.getByTestId('edge-strip');
  await expect(strip).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('ov-nginx-rps')).not.toHaveText('—', { timeout: 30_000 });
  await expect(page.getByTestId('ov-mongo-status')).toHaveText('Up', { timeout: 30_000 });
  await expect(page.getByTestId('ov-sockets')).toHaveText('47', { timeout: 30_000 }); // 30 + 12 + 5 sockets across three tenants
});

test('the Nginx page attributes traffic to the service and lists the rest as unattributed', async () => {
  const page = shared;
  await page.goto('/');
  await page.getByRole('link', { name: 'Nginx' }).first().click();
  await expect(page.getByRole('heading', { name: 'Nginx', level: 1 })).toBeVisible();
  await expect(page.getByTestId('nginx-conn')).toHaveText('12', { timeout: 20_000 });
  const table = page.getByTestId('nginx-services');
  await expect(table).toContainText('chatty', { timeout: 30_000 });
  await expect(table).toContainText('Unattributed');
  await expect(page.getByTestId('nginx-status-down')).toHaveCount(0);
  // History: the range buttons change the resolution note.
  const panel = page.getByTestId('history-panel');
  await expect(panel.getByTestId('history-step')).toContainText('One point per');
  await panel.getByRole('button', { name: '7 days' }).click();
  await expect(panel.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByTestId('history-step')).toContainText('min', { timeout: 15_000 });
});

test('the MongoDB page shows health, never raw query values, and recent slow queries', async () => {
  const page = shared;
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByRole('link', { name: 'MongoDB' }).first().click();
  await expect(page.getByTestId('mongo-status')).toHaveText('Up', { timeout: 20_000 });
  await expect(page.getByTestId('mongo-conn')).not.toHaveText('—');
  const slow = page.getByTestId('mongo-slow');
  await expect(slow).toContainText('app.orders', { timeout: 90_000 });
  await expect(slow).toContainText('COLLSCAN');
  await expect(slow).toContainText('customerEmail'); // field names are kept...
  await expect(page.locator('body')).not.toContainText('someone@example.com'); // ...values never are
});

test('the service page shows the application layer: lag, sockets, users and tenants', async () => {
  const page = shared;
  await page.goto('/');
  await page.getByTestId('svc-chatty').click({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'chatty' })).toBeVisible();
  await expect(page.getByTestId('agent-tiles')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('app-sockets')).toHaveText('47');
  await expect(page.getByTestId('app-lag')).toContainText('ms');
  const tenants = page.getByTestId('tenant-table');
  await expect(tenants).toContainText('acme', { timeout: 20_000 });
  await expect(tenants).toContainText('globex');
  await expect(tenants).toContainText('initech');
  await expect(page.getByTestId('svc-traffic-now')).not.toContainText('no requests', { timeout: 30_000 });

  await tenants.getByRole('button', { name: '24 h history' }).first().click();
  // Tenant rows are stored once a minute, so right after start there is either a chart or the "not yet" note.
  await expect(page.getByTestId('tenant-history').or(page.getByText('No history stored for this tenant yet'))).toBeVisible({ timeout: 15_000 });

  // The agent flag is set by the first report; the other service has none.
  await page.goto('/services');
  await page.getByRole('link', { name: /crasher/ }).first().click();
  await expect(page.getByTestId('agent-none')).toBeVisible({ timeout: 20_000 });
});

test('host history, incident timeline and the Windows events note', async () => {
  const page = shared;
  await page.goto('/');
  await page.getByRole('link', { name: 'Host' }).first().click();
  const panel = page.getByTestId('history-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('history-step')).toContainText('One point per', { timeout: 20_000 });
  await expect(page.getByTestId('incident-timeline')).toBeVisible();
  await expect(page.getByTestId('windows-events')).toContainText('Windows host only');
});

test('log search finds lines across a time range, refuses a dangerous pattern and is audited', async () => {
  const page = shared;
  await page.goto('/');
  await page.getByRole('link', { name: 'Log search' }).click();
  await expect(page.getByRole('heading', { name: 'Log search' })).toBeVisible();

  await page.getByTestId('search-go').click();
  await expect(page.locator('.banner.crit')).toContainText('Choose at least one service');

  await page.getByLabel('chatty', { exact: true }).check();
  await page.getByTestId('search-query').fill('chatty line');
  await page.getByTestId('search-go').click();
  const results = page.getByTestId('search-results');
  await expect(results).toContainText('chatty line', { timeout: 20_000 });
  await expect(results.getByRole('heading')).toContainText('match');

  // Context lines and a regular expression.
  await page.getByLabel('Context lines').selectOption('2');
  await page.getByLabel('Regular expression').check();
  await page.getByTestId('search-query').fill('chatty error \\d+');
  await page.getByLabel('Stream').selectOption('err');
  await page.getByTestId('search-go').click();
  await expect(results).toContainText('chatty error', { timeout: 20_000 });

  // A pattern that could run for ages is refused with an explanation.
  await page.getByTestId('search-query').fill('(a+)+$');
  await page.getByTestId('search-go').click();
  await expect(page.locator('.banner.crit')).toContainText('repeated group');
  await expect(results).toHaveCount(0);

  // Admins can see the searches in the audit log (filters recorded, results not).
  await page.goto('/admin/audit');
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  await expect(page.locator('body')).toContainText('log_search', { timeout: 15_000 });
  await expect(page.locator('body')).not.toContainText('chatty line 1');
});
