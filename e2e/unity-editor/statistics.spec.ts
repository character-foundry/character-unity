import { randomUUID } from 'node:crypto';
import { expect, screenshot, test } from './fixtures.js';
import { importViewerCard } from './viewer-fixtures.js';

test('native statistics show real workspace counts, refresh, and mobile layout without scheduling work', async ({ page }, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Account and workspace', exact: true }).click();
  await page.getByRole('button', { name: 'New workspace', exact: true }).click();
  await page.getByLabel('Workspace name', { exact: true }).fill(`Stats ${randomUUID()}`);
  const created = page.waitForResponse((response) => response.url().endsWith('/api/workspaces') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  expect((await created).status()).toBe(201);
  await page.getByRole('link', { name: 'Stats', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Collection stats', exact: true })).toBeVisible();
  await expect(page.getByText('Your library is empty.', { exact: false })).toBeVisible();
  await importViewerCard(page, `Stats card ${randomUUID()}`, 'json');
  const writes: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    // Reload must reconnect the explicit local session; it still performs no
    // domain/index/scrape/model mutations while reading collection summaries.
    if (path.startsWith('/api/') && path !== '/api/local-session' && !['GET', 'HEAD'].includes(request.method())) writes.push(request.url());
  });
  await page.getByRole('link', { name: 'Stats', exact: true }).click();
  // dt/dd are native semantic content, not test-only hooks.
  const metrics = page.locator('dl[aria-label="Library membership"]');
  await expect(metrics.locator('dt').filter({ hasText: /^Owned cards$/ }).locator('..').locator('dd').first()).toHaveText('1');
  await expect(metrics.locator('dt').filter({ hasText: /^Archive references$/ }).locator('..').locator('dd').first()).toHaveText('0');
  await page.reload();
  await expect(metrics.locator('dt').filter({ hasText: /^Owned cards$/ }).locator('..').locator('dd').first()).toHaveText('1');
  await expect(page.getByRole('heading', { name: 'Common tags', exact: true })).toBeVisible();
  await expect(page.getByText('native-viewer', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh statistics', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh statistics', exact: true })).toBeEnabled();
  await screenshot(page, info, 'native-stats-desktop');
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole('heading', { name: 'Collection stats', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await screenshot(page, info, 'native-stats-mobile');
  expect(writes).toEqual([]);
});

test('statistics failure is visibly unavailable, never presented as an empty library, and retry recovers', async ({ page, diagnostics }, info) => {
  await importViewerCard(page, `Stats retry ${randomUUID()}`, 'json');
  diagnostics.expectedStatuses.add(503);
  let fail = true;
  await page.route('**/statistics', (route) => fail
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Statistics temporarily unavailable' } }) })
    : route.continue());
  await page.getByRole('link', { name: 'Stats', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Statistics temporarily unavailable');
  await expect(page.getByRole('alert')).toContainText('not an empty-library result');
  await expect(page.locator('dl[aria-label="Library membership"]')).toHaveCount(0);
  await screenshot(page, info, 'native-stats-actionable-error');
  fail = false;
  await page.getByRole('button', { name: 'Retry statistics', exact: true }).click();
  await expect(page.locator('dl[aria-label="Library membership"]')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
