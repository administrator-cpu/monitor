import { expect, test, type Page } from '@playwright/test';

const PASSWORD = process.env.E2E_PASSWORD ?? 'e2e test passphrase 1';
const MAIL = `http://127.0.0.1:${process.env.E2E_MAIL_PORT ?? 4101}/__sent`;

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Username').fill('owner');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}

const sentMail = async (page: Page): Promise<{ to: string[]; subject: string; auth: string }[]> =>
  (await page.request.get(MAIL)).json();

test.describe.configure({ mode: 'serial' });

test('PM2 services are discovered and shown on the overview', async ({ page }) => {
  await signIn(page);
  const grid = page.getByTestId('service-grid');
  await expect(grid.getByTestId('svc-chatty')).toBeVisible({ timeout: 30_000 });
  await expect(grid.getByTestId('svc-crasher')).toBeVisible();
  await expect(grid.getByTestId('svc-chatty')).toContainText('online');
});

test('the log tail streams, pauses, filters and splits stderr', async ({ page }) => {
  await signIn(page);
  await page.getByTestId('svc-chatty').click({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'chatty' })).toBeVisible();
  const box = page.getByTestId('log-box');
  await expect(box).toContainText('chatty line', { timeout: 15_000 });
  await expect(page.getByTestId('log-state')).toHaveText('Live');

  // Pause: the view stops moving while lines keep arriving behind it.
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByTestId('log-state')).toContainText('Paused');
  const frozen = await box.locator('.log-line').count();
  await page.waitForTimeout(1500);
  expect(await box.locator('.log-line').count()).toBe(frozen);
  await expect(page.getByTestId('log-state')).toContainText('new');
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect.poll(async () => box.locator('.log-line').count()).toBeGreaterThan(frozen);

  // Filter inside the view.
  await page.getByLabel('Filter lines').fill('chatty error');
  await expect(box.locator('.log-line').first()).toContainText('chatty error');
  expect(await box.locator('.log-line:not(:has-text("chatty error"))').count()).toBe(0);
  await page.getByLabel('Filter lines').fill('');

  // Server-side stream filter.
  await page.getByLabel('Stream', { exact: true }).selectOption('err');
  await expect(box).toContainText('chatty error', { timeout: 10_000 });
  await expect(box).not.toContainText('chatty line');
});

test('a crash loop opens an alert, shows a badge and sends one email', async ({ page }) => {
  await signIn(page);
  await expect(page.getByTestId('alerts-badge')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('incident-banner')).toBeVisible();

  await page.getByRole('link', { name: /^Alerts/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Alerts' })).toBeVisible();
  const row = page.getByRole('row', { name: /Crash loop/ });
  await expect(row.first()).toBeVisible({ timeout: 15_000 });
  await expect(row.first()).toContainText('crasher');

  await expect
    .poll(async () => (await sentMail(page)).filter((m) => m.subject === '[CRITICAL] Crash loop (crasher)').length, { timeout: 20_000 })
    .toBe(1);
  const mails = await sentMail(page);
  const m = mails.find((x) => x.subject.includes('Crash loop'))!;
  expect(m.to).toEqual(['owner@example.com']);
  expect(m.auth).toBe('Bearer re_e2e_not_a_real_key');

  // The delivery log is visible to admins.
  await row.first().locator('summary').click();
  await expect(row.first()).toContainText('sent');
});

test('the test-email button reaches only the signed-in admin', async ({ page }) => {
  await signIn(page);
  await page.goto('/alerts');
  const before = (await sentMail(page)).length;
  await page.getByRole('button', { name: 'Send me a test email' }).click();
  await expect(page.getByText('Test email sent to your own address.')).toBeVisible();
  const after = await sentMail(page);
  expect(after.length).toBe(before + 1);
  expect(after[after.length - 1]!.to).toEqual(['owner@example.com']);
  expect(after[after.length - 1]!.subject).toContain('TEST');
});

test('rules can be edited, and a mute can be created and removed', async ({ page }) => {
  await signIn(page);
  await page.goto('/alerts');
  await page.getByRole('tab', { name: 'Rules' }).click();
  const rule = page.getByTestId('rule-host.disk_high');
  await rule.locator('summary').click();
  const threshold = rule.getByLabel(/^Threshold/);
  await threshold.fill('80');
  await rule.getByRole('button', { name: 'Save' }).click();
  await expect(rule.getByText('Saved.')).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: 'Rules' }).click();
  await expect(page.getByTestId('rule-host.disk_high')).toContainText('80');

  await page.getByRole('tab', { name: 'Mutes' }).click();
  await page.getByLabel('Category').selectOption('nginx');
  await page.getByLabel('Reason').fill('e2e window');
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  const mute = page.getByRole('row', { name: /e2e window/ });
  await expect(mute).toContainText('active');
  await mute.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('row', { name: /e2e window/ })).toHaveCount(0);
});

test('settings are editable, validated and resettable', async ({ page }) => {
  await signIn(page);
  await page.goto('/admin/settings');
  const row = page.getByTestId('setting-alert.reminder_minutes');
  await row.getByLabel('alert.reminder_minutes').fill('0');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByRole('alert')).toBeVisible(); // below the allowed range
  await row.getByLabel('alert.reminder_minutes').fill('30');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('setting-alert.reminder_minutes').getByRole('button', { name: 'Reset' })).toBeVisible();
  await page.getByTestId('setting-alert.reminder_minutes').getByRole('button', { name: 'Reset' }).click();
  await expect(page.getByTestId('setting-alert.reminder_minutes').getByLabel('alert.reminder_minutes')).toHaveValue('60');
});

test('settings page shows the GitHub and dashboard action settings, not unused ones', async ({ page }) => {
  await signIn(page);
  await page.goto('/admin/settings');
  await expect(page.getByRole('region', { name: 'GitHub' }).getByTestId('setting-github.poll_minutes')).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Dashboard actions' }).getByTestId('setting-actions.stop_mute_minutes'),
  ).toBeVisible();
  await expect(page.getByTestId('setting-mongo.slow_ms')).toHaveCount(0);
  await expect(page.getByTestId('setting-agent.max_tenants_per_report')).toHaveCount(0);
});

test('a running service cannot be archived', async ({ page }) => {
  await signIn(page);
  await page.getByTestId('svc-chatty').click({ timeout: 30_000 });
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'PM2 still lists this process' })).toBeVisible();
});
