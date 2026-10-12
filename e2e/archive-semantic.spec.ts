import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

for (const [profile, origin] of [['local', 'http://127.0.0.1:19310'], ['browser', 'http://127.0.0.1:19311'], ['hub', 'http://127.0.0.1:19312']] as const) {
  test(`${profile}: semantic and hybrid Archive search preserves pagination, excerpts and reviewed imports without fallback`, async ({ page }, info) => {
    if (profile === 'hub') await page.setViewportSize({ width: 390, height: 844 });
    const searches: URL[] = [], errors: string[] = [];
    page.on('request', (request) => { if (new URL(request.url()).pathname.endsWith('/search')) searches.push(new URL(request.url())); });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    if (profile === 'hub') {
      const accounts = JSON.parse(await readFile('runtime/e2e-hub-accounts.json', 'utf8'));
      await page.getByLabel('Access key').fill(accounts.Alice.key); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    } else if (profile === 'local') await page.getByRole('button', { name: 'Connect to local library' }).click();
    await page.getByLabel('New workspace', { exact: true }).fill(`Semantic ${profile}`);
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await page.getByRole('button', { name: 'Browse Archive', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Archive import', exact: true });
    await panel.getByLabel('Search mode').selectOption('semantic');
    await panel.getByLabel('Search Archive', { exact: true }).fill('sea voyage');
    await panel.getByLabel('Provider', { exact: true }).fill('synthetic');
    await panel.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(panel.getByText('Semantic results for “sea voyage”: 13 matches · 10 shown.')).toBeVisible();
    await expect(panel.getByRole('checkbox').first()).toHaveAccessibleName('Lexical 13');
    await panel.locator('summary').first().click();
    await expect(panel.getByText('Lexical 13 A silver ocean beside the south gate.', { exact: true })).toBeVisible();
    await panel.getByRole('checkbox', { name: 'Lexical 13', exact: true }).check();
    await panel.getByLabel('Search mode').selectOption('hybrid');
    await panel.getByLabel('Search Archive', { exact: true }).fill('Lexical 01');
    await panel.getByRole('button', { name: 'Load more from Archive' }).click();
    await expect(panel.getByText('Semantic results for “sea voyage”: 13 matches · 13 shown.')).toBeVisible();
    expect(searches.at(-1)!.searchParams.get('mode')).toBe('semantic');
    expect(searches.at(-1)!.searchParams.get('text')).toBe('sea voyage');
    await expect(panel.locator('summary')).toHaveCount(13);
    await panel.getByRole('checkbox', { name: 'Lexical 01', exact: true }).check();
    await panel.getByRole('button', { name: 'Review selection (2)', exact: true }).click();
    await panel.getByRole('button', { name: 'Import selected originals', exact: true }).click();
    await expect(panel.getByText('Imported 2 of 2 selected originals.')).toBeVisible();
    await panel.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(panel.getByText('Hybrid results for “Lexical 01”: 13 matches · 10 shown.')).toBeVisible();
    await expect(panel.getByRole('checkbox').first()).toHaveAccessibleName('Lexical 01');
    await panel.getByLabel('Search mode').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`semantic-${profile}.png`) });
    await panel.getByLabel('Search Archive', { exact: true }).fill('provider failure');
    const count = searches.length;
    await panel.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(panel.getByRole('alert')).toBeVisible(); await expect(panel.getByRole('checkbox')).toHaveCount(0);
    expect(searches).toHaveLength(count + 1);
    await panel.getByLabel('Search Archive', { exact: true }).fill('forest AND NOT ocean');
    await panel.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(panel.getByRole('alert')).toBeVisible(); await expect(panel.getByRole('checkbox')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('semantic capability withdrawal requires an explicit change of mode', async ({ page }) => {
  let enabled = true, searches = 0;
  page.on('request', (request) => { if (new URL(request.url()).pathname.endsWith('/search')) searches++; });
  await page.route('**/api/archive/v1/status', async (route) => {
    const response = await route.fetch(), data = await response.json(); if (!enabled) delete data.semantic;
    await route.fulfill({ response, json: data });
  });
  await page.goto('http://127.0.0.1:19311');
  await page.getByLabel('New workspace', { exact: true }).fill('Semantic capability');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('button', { name: 'Browse Archive', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Archive import', exact: true });
  await panel.getByLabel('Search mode').selectOption('semantic');
  await panel.getByLabel('Search Archive', { exact: true }).fill('ocean');
  enabled = false;
  await panel.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Semantic search is no longer available');
  await expect(panel.getByRole('checkbox')).toHaveCount(0); expect(searches).toBe(0);
  await expect(panel.getByLabel('Search mode')).toHaveValue('lexical');
  await panel.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(panel.getByText('Card text results for “ocean”: 1 match · 1 shown.')).toBeVisible();
});
