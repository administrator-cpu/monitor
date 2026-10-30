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

test('the overview shows the monitor itself and the summary row', async () => {
  const page = shared;
  await page.goto('/');
  const monitor = page.getByTestId('service-grid').getByTestId('svc-monitor');
  await expect(monitor).toContainText('Command Center (this monitor)', { timeout: 30_000 });
  await expect(page.getByTestId('monitor-tile-runs')).toHaveText('online · started by hand');
  const row = page.getByTestId('summary-row');
  for (const name of ['Alerts summary', 'Backups and certificates', 'GitHub and email']) {
    await expect(row.getByRole('region', { name })).toBeVisible();
  }
  // The test backend runs without BACKUP_DIR (off by default outside Windows).
  await expect(page.getByTestId('backup-status')).toHaveText('off (BACKUP_DIR)');
  await expect(page.getByTestId('github-status')).toBeVisible();
  await monitor.click();
  await expect(page.getByRole('heading', { name: 'Host' })).toBeVisible();
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

test('an admin adds a host; its agent enrolls once, reports, and is refused after a revoke (phase 11 M1)', async () => {
  const page = shared;
  const apiBase = process.env.E2E_API ?? 'http://127.0.0.1:4100';
  // /admin has no page of its own; it leads to the first admin page.
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin\/users$/);

  await page.goto('/admin/hosts');
  const title = page.getByRole('heading', { name: 'Hosts', level: 1 });
  await expect(title).toBeVisible();
  await expect(page.getByTestId('host-status-windows-vps')).toHaveText('this server');

  const titleTop = (await title.boundingBox())!.y;
  await page.getByRole('button', { name: 'Add host' }).click();
  // The form opens below the header; the header (and its title) stay where they were.
  const form = page.getByRole('form', { name: 'Add host' });
  await expect(form).toBeVisible();
  expect(Math.abs((await title.boundingBox())!.y - titleTop)).toBeLessThan(2);
  expect((await form.boundingBox())!.y).toBeGreaterThan(titleTop);
  await expect(page.getByRole('button', { name: 'Add host', exact: true })).toBeDisabled();
  await page.getByLabel('Name (lower case, digits, dashes)').fill('e2e-linux');
  await page.getByRole('button', { name: 'Add host and make a token' }).click();
  const env = page.getByTestId('enroll-env');
  await expect(env).toContainText('CC_HOST_NAME=e2e-linux');
  const enrollToken = /CC_ENROLL_TOKEN=(\S+)/.exec((await env.textContent()) ?? '')?.[1];
  expect(enrollToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await expect(page.getByTestId('host-status-e2e-linux')).toHaveText('waiting for agent');

  // The agent's side, as plain HTTP without a browser Origin.
  const enroll = (token: string) =>
    page.request.post(`${apiBase}/agent/v1/enroll`, { data: { enrollToken: token, hostname: 'e2e', os: 'linux', agentVersion: '0.1.0' } });
  const first = await enroll(enrollToken!);
  expect(first.status()).toBe(200);
  const hostToken = (await first.json()).token as string;
  expect((await enroll(enrollToken!)).status()).toBe(401);
  const report = () =>
    page.request.post(`${apiBase}/agent/v1/metrics`, {
      headers: { authorization: `Bearer ${hostToken}`, 'x-agent-version': '0.1.0' },
      data: {
        v: 1, ts: Date.now(), actions: 'off',
        host: {
          cpuPct: 12, cpuPerCore: [12], memUsedBytes: 1073741824, memTotalBytes: 4294967296, swapUsedBytes: 0, swapTotalBytes: 0,
          netRxBps: 0, netTxBps: 0, uptimeS: 60, pendingReboot: false, disks: [{ volume: '/', usedBytes: 1, totalBytes: 2 }],
        },
      },
    });
  expect((await report()).status()).toBe(204);

  await page.getByRole('button', { name: 'Done, I have saved it' }).click();
  await expect(page.getByTestId('enroll-token')).toHaveCount(0);
  await page.reload();
  const row = page.getByTestId('host-e2e-linux');
  await expect(page.getByTestId('host-status-e2e-linux')).toHaveText('online', { timeout: 15_000 });
  await expect(row).toContainText('CPU 12%');
  await expect(row).toContainText('actions off');
  await expect(row).not.toContainText(enrollToken!);

  page.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByTestId('host-status-e2e-linux')).toHaveText('revoked');
  expect((await report()).status()).toBe(401);

  await page.goto('/admin/audit');
  await expect(page.locator('body')).toContainText('host_revoked', { timeout: 15_000 });
  await expect(page.locator('body')).toContainText('host_enrolled');
});

test('the host switcher shows the demo Ubuntu host, reported by the real node agent (phase 11 M2)', async () => {
  const page = shared;
  await page.goto('/host');
  const pick = page.getByRole('combobox', { name: 'Host' });
  await expect(pick).toBeVisible({ timeout: 30_000 });
  await pick.selectOption({ label: 'ubuntu-acs' });
  await expect(page).toHaveURL(/\/host\?host=\d+$/);
  await expect(page.getByRole('heading', { name: 'Host · ubuntu-acs', level: 1 })).toBeVisible();
  await expect(page.getByTestId('agent-info')).toContainText('0.3.0', { timeout: 30_000 });
  await expect(page.getByTestId('agent-host-details')).toContainText('Last report');
  await expect(page.getByRole('region', { name: 'Disks' })).toContainText('/');
  await expect(page.getByRole('region', { name: 'Agent' })).toContainText('docker');
  await expect(page.getByTestId('agent-host-stale')).toHaveCount(0);
  // This server's own cards stay on its page.
  await expect(page.getByRole('region', { name: 'Monitor health' })).toHaveCount(0);

  await page.goto('/services');
  await page.getByRole('combobox', { name: 'Host' }).selectOption({ label: 'ubuntu-acs' });
  await expect(page.getByRole('heading', { name: 'Services · ubuntu-acs', level: 1 })).toBeVisible();
  const list = page.getByRole('region', { name: 'Services' });
  await expect(list).toContainText('genieacs-cwmp', { timeout: 30_000 });
  await expect(list).not.toContainText('chatty');
  const cpe = list.getByRole('row').filter({ hasText: 'acs/cpe-sim' });
  await expect(cpe).toContainText('stopped');
  // Started before the agent watched: Docker's "Up N minutes" only, shown as approximate (V28).
  await expect(list.getByRole('row').filter({ hasText: 'acs/genieacs-cwmp' })).toContainText(/~\d+m/);
  await cpe.getByRole('link', { name: 'cpe-sim' }).click();
  await expect(page.getByRole('heading', { name: 'cpe-sim', level: 1 })).toBeVisible();
  await expect(page.locator('body')).toContainText('container acs/cpe-sim');
  // Stopped: nothing to follow, but the log card and the counts are there (M3).
  await expect(page.getByRole('region', { name: 'Logs' })).toBeVisible();
  await expect(page.getByTestId('log-counts')).toContainText('lines received');

  // Back to this server: the address loses ?host and PM2's services return.
  await page.goto('/services?host=2');
  await page.getByRole('combobox', { name: 'Host' }).selectOption({ label: 'windows-vps (this server)' });
  await expect(page).toHaveURL(/\/services$/);
  await expect(page.getByRole('region', { name: 'Services' })).toContainText('chatty');
});

test('container logs from the demo host: live tail, search next to this server’s, and the switch to stop shipping (phase 11 M3)', async () => {
  // Moves between pages by their links: the whole suite runs close to the API's 300 requests a minute.
  const page = shared;
  await page.goto('/services?host=2');
  await page.getByRole('region', { name: 'Services' }).getByRole('link', { name: 'genieacs-cwmp' }).click();
  await expect(page.getByRole('heading', { name: 'genieacs-cwmp', level: 1 })).toBeVisible();
  await expect(page.getByTestId('log-box')).toContainText('genieacs-cwmp handled request', { timeout: 30_000 });
  await expect(page.getByTestId('log-counts')).toContainText(/[1-9][\d,]* lines received/);

  // Searched with this server's services; the line names its host.
  await page.getByRole('link', { name: 'Log search' }).first().click();
  await page.getByLabel('genieacs-cwmp · ubuntu-acs', { exact: true }).check();
  await page.getByLabel('chatty', { exact: true }).check();
  await page.getByTestId('search-query').fill('handled request');
  await page.getByTestId('search-go').click();
  const results = page.getByTestId('search-results');
  await expect(results).toContainText('genieacs-cwmp handled request', { timeout: 20_000 });
  await expect(results).toContainText('genieacs-cwmp · ubuntu-acs');

  // Switched off, the page says so (the agent stops following it); then switched on again.
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'genieacs-cwmp', level: 1 })).toBeVisible();
  await page.getByTestId('log-ship-toggle').click();
  await expect(page.getByTestId('logs-excluded')).toBeVisible();
  await page.getByTestId('log-ship-toggle').click();
  await expect(page.getByTestId('log-box')).toBeVisible();
});
