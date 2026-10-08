import { expect, test, type Page } from '@playwright/test';

const PASSWORD = process.env.E2E_PASSWORD ?? 'e2e test passphrase 1';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Username').fill('owner');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('unauthenticated visitors are sent to the login screen', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('a wrong password shows a generic error and stays on login', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('owner');
  await page.getByLabel('Password').fill('definitely not the password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('login-error')).toHaveText('Invalid username or password.');
  await expect(page).toHaveURL(/\/login$/);
});

test('login, the overview is live, logout ends the session', async ({ page }) => {
  await signIn(page);

  await expect(page.getByTestId('connection-badge')).toHaveAttribute('data-state', 'live');
  await expect(page.getByTestId('cpu-value')).toContainText('%');
  await expect(page.getByRole('region', { name: 'Disks' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
});

test('host charts keep growing as live samples arrive', async ({ page }) => {
  await signIn(page);
  await page.goto('/host');
  const chart = page.getByRole('img', { name: 'CPU usage over the last 30 minutes' });
  await expect(chart.locator('canvas')).toBeVisible();
  const read = async () => Number(await chart.getAttribute('data-points'));
  const before = await read();
  // One new point per 2 s sample: wait for at least two more.
  await expect.poll(read, { timeout: 12_000 }).toBeGreaterThanOrEqual(before + 2);
});

test('reloading the host page shows charts already populated', async ({ page }) => {
  await signIn(page);
  await page.waitForTimeout(6000); // let the backend ring buffer collect a few samples
  await page.goto('/host');
  await expect(page.getByRole('heading', { name: 'Host' })).toBeVisible();
  const cpu = page.getByRole('img', { name: 'CPU usage over the last 30 minutes' });
  await expect(cpu.locator('canvas')).toBeVisible();

  await page.reload();
  const chart = page.getByRole('img', { name: 'CPU usage over the last 30 minutes' });
  await expect(chart.locator('canvas')).toBeVisible();
  // Within ~2 s of a reload the chart already holds history. Live pushes add only one point per
  // 2 s, so this many points can only have come from the backend's 30-minute ring buffer.
  await expect
    .poll(async () => Number(await chart.getAttribute('data-points')), { timeout: 2500 })
    .toBeGreaterThanOrEqual(4);
  await expect(page.getByRole('region', { name: 'Monitor health' })).toContainText(
    'Event loop lag',
  );
});

test('the admin can create an engineer, who cannot see admin pages', async ({ page, browser }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Users' }).first().click();
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();

  await page.getByRole('button', { name: 'New user' }).click();
  await page.getByLabel('Username').fill('alice');
  await page.getByLabel('Display name').fill('Alice Engineer');
  await page.getByLabel('Email').fill('alice@example.com');
  await page.getByLabel(/Temporary password/).fill('alice temporary passphrase');
  await page.getByRole('button', { name: 'Create user' }).click();
  await expect(page.getByTestId('user-alice')).toBeVisible();

  // Alice signs in, is forced to change her password, then has no admin navigation.
  const ctx = await browser.newContext();
  const alice = await ctx.newPage();
  await alice.goto('/login');
  await alice.getByLabel('Username').fill('alice');
  await alice.getByLabel('Password').fill('alice temporary passphrase');
  await alice.getByRole('button', { name: 'Sign in' }).click();
  await expect(alice.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await alice.getByLabel('Current password').fill('alice temporary passphrase');
  await alice.getByLabel(/^New password/).fill('alice chosen passphrase 2');
  await alice.getByLabel('Repeat new password').fill('alice chosen passphrase 2');
  await alice.getByRole('button', { name: 'Save password' }).click();
  await expect(alice.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(alice.getByRole('link', { name: 'Users' })).toHaveCount(0);
  await alice.goto('/admin/users');
  await expect(alice.getByRole('heading', { name: 'Overview' })).toBeVisible(); // bounced

  // Admin disables Alice: her live session ends without a reload.
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('user-alice').getByRole('button', { name: 'Disable' }).click();
  await expect(page.getByTestId('user-alice')).toContainText('disabled');
  await expect(alice).toHaveURL(/\/login$/, { timeout: 20_000 });
  await ctx.close();

  // The audit log recorded it.
  await page.getByRole('link', { name: 'Audit log' }).first().click();
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  await expect(page.locator('tbody').getByText('user_created').first()).toBeVisible();
  await expect(page.locator('tbody').getByText('login_failed').first()).toBeVisible();
});

test('a dropped live connection is shown as disconnected and recovers by itself', async ({
  page,
}) => {
  let block = false;
  const open: { close(o?: { code?: number }): void }[] = [];
  await page.routeWebSocket(/\/api\/v1\/ws/, (ws) => {
    if (block) {
      ws.close({ code: 1013 });
      return;
    }
    ws.connectToServer();
    open.push(ws);
  });

  await signIn(page);
  await expect(page.getByTestId('connection-badge')).toHaveAttribute('data-state', 'live');

  block = true;
  for (const ws of open) ws.close({ code: 1011 });
  await expect(page.getByTestId('connection-badge')).toHaveAttribute('data-state', 'down');
  await expect(page.getByTestId('connection-badge')).toContainText(/Disconnected|Connecting/);
  // Values are hidden rather than frozen at the last reading.
  await expect(page.getByText('Not receiving live data')).toBeVisible();
  await expect(page.getByTestId('cpu-value')).toContainText('—');

  block = false;
  await expect(page.getByTestId('connection-badge')).toHaveAttribute('data-state', 'live', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('cpu-value')).toContainText('%');
});

test('an unreachable API on page load shows a clear error and recovers on retry', async ({
  page,
  context,
}) => {
  await signIn(page);
  await context.route('**/api/v1/auth/me', (r) => r.abort());
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Cannot reach the monitor' })).toBeVisible();

  await context.unroute('**/api/v1/auth/me');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByTestId('connection-badge')).toHaveAttribute('data-state', 'live');
});

test.describe('phone width', () => {
  test.use({ viewport: { width: 375, height: 740 } });
  test('is usable with no horizontal scroll and a bottom tab bar', async ({ page }) => {
    await signIn(page);
    const tabbar = page.getByRole('navigation', { name: 'Primary' });
    await expect(tabbar).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await tabbar.getByRole('link', { name: 'Host' }).click();
    await expect(page.getByRole('heading', { name: 'Host' })).toBeVisible();
    const overflow2 = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow2).toBeLessThanOrEqual(0);
  });
});
