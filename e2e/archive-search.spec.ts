import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const archiveOrigin = 'http://127.0.0.1:19313/api/archive/v1';
for (const [profile, origin] of [['local', 'http://127.0.0.1:19310'], ['browser', 'http://127.0.0.1:19311'], ['hub', 'http://127.0.0.1:19312']] as const) {
  test(`${profile}: lexical Archive paging, reviewed import and recovery preserve selection, drafts and accepted bytes`, async ({ page }, info) => {
    test.setTimeout(45000);
    if (profile === 'hub') await page.setViewportSize({ width: 390, height: 844 });
    const errors: string[] = [], searches: URL[] = [], writes: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith('/search')) searches.push(new URL(request.url()));
      if (request.url().startsWith('http://127.0.0.1:19313') && request.method() !== 'GET') writes.push(request.method());
    });
    const snapshot = await (await page.request.get(`${archiveOrigin}/status`)).json();
    expect(snapshot.search).toBe('lance-fts-v1');
    const source = await (await page.request.get(`${archiveOrigin}/cards/zlex-01?snapshot=${snapshot.snapshot}`)).json();
    const original = await (await page.request.get(`${archiveOrigin}/originals/${source.card.original.hash}?snapshot=${snapshot.snapshot}`)).body();
    await page.goto(origin);
    const accounts = profile === 'hub' ? JSON.parse(await readFile('runtime/e2e-hub-accounts.json', 'utf8')) : null;
    async function login() {
      await page.getByLabel('Access key').fill(accounts.Alice.key); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    }
    if (profile === 'hub') await login();
    else if (profile === 'local') await page.getByRole('button', { name: 'Connect to local library' }).click();
    await page.getByLabel('New workspace', { exact: true }).fill(`Lexical search ${profile}`);
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await page.getByRole('button', { name: 'Browse Archive', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Archive import', exact: true });
    await panel.getByLabel('Search mode').selectOption('lexical');
    await expect(panel.getByRole('button', { name: 'Search', exact: true })).toBeDisabled();
    await panel.getByLabel('Search Archive', { exact: true }).fill('forest AND NOT ocean');
    await panel.getByLabel('Provider', { exact: true }).fill('synthetic');
    await panel.getByLabel('Tag', { exact: true }).fill('lexical');
    await panel.getByLabel('Result order').selectOption('title');
    await panel.getByLabel('Advanced filter', { exact: true }).fill('tokenCount >= 100');
    await panel.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(panel.getByText('Card text results for “forest AND NOT ocean”: 12 matches · 10 shown.')).toBeVisible();
    await expect(panel.getByRole('checkbox')).toHaveCount(10);
    await panel.getByLabel('Search mode').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`lexical-${profile}-controls.png`) });
    await panel.getByRole('checkbox', { name: 'Lexical 01', exact: true }).check();
    // Unsubmitted form changes cannot change a cursor's search or ordering.
    await panel.getByLabel('Search Archive', { exact: true }).fill('ocean');
    await panel.getByLabel('Result order').selectOption('relevance');
    await panel.getByLabel('Advanced filter', { exact: true }).fill('tokenCount >= 1300');
    if (profile === 'hub') {
      await page.request.delete(`${origin}/api/session`, { headers: { origin } });
      await panel.getByRole('button', { name: 'Load more from Archive' }).click();
      await expect(page.getByLabel('Access key')).toBeVisible(); await login();
      await expect(panel.getByRole('checkbox', { name: 'Lexical 01', exact: true })).toBeChecked();
      await expect(panel.getByLabel('Search Archive', { exact: true })).toHaveValue('ocean');
    }
    await panel.getByRole('button', { name: 'Load more from Archive' }).click();
    await expect(panel.getByText('Card text results for “forest AND NOT ocean”: 12 matches · 12 shown.')).toBeVisible();
    expect(searches.at(-1)!.searchParams.get('text')).toBe('forest AND NOT ocean');
    expect(searches.at(-1)!.searchParams.get('sort')).toBe('title');
    expect(searches.at(-1)!.searchParams.get('filter')).toBe('tokenCount >= 100');
    await expect(panel.getByText('Applied filter: tokenCount >= 100', { exact: true })).toBeVisible();
    expect(searches.at(-1)!.searchParams.get('snapshot')).toBe(snapshot.snapshot);
    await expect(panel.getByRole('checkbox')).toHaveCount(12);
    await panel.getByRole('checkbox', { name: 'Lexical 12', exact: true }).check();
    await panel.getByRole('button', { name: 'Review selection (2)', exact: true }).click();
    const review = panel.getByRole('region', { name: 'Selected originals', exact: true });
    await expect(review).toContainText('Lexical 01'); await expect(review).toContainText('Lexical 12'); await expect(review).not.toContainText('Lexical 02');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await review.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`lexical-${profile}.png`) });
    const importedResponse = profile === 'hub' ? page.waitForResponse((response) => response.url().endsWith('/archive/imports')) : undefined;
    await panel.getByRole('button', { name: 'Import selected originals', exact: true }).click();
    await expect(panel.getByText('Imported 2 of 2 selected originals.')).toBeVisible();
    const editor = page.getByRole('region', { name: profile === 'hub' ? 'Character editor' : 'Editor 1', exact: true });
    await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Lexical 01');
    if (profile === 'hub') {
      const response = await importedResponse!, imported = await response.json();
      const accepted = await page.request.get(response.url().replace(/\/archive\/imports$/, `/cards/${imported.imported[0].card.id}/original`));
      expect(accepted.status()).toBe(200); expect(await accepted.body()).toEqual(original);
    } else {
      const download = page.waitForEvent('download');
      await editor.getByRole('button', { name: 'Download accepted original', exact: true }).click();
      expect(await readFile((await (await download).path())!)).toEqual(original);
    }
    await editor.getByLabel('Name', { exact: true }).fill('Keep this draft');
    await panel.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(panel.getByText('Card text results for “ocean”: 1 match · 1 shown.')).toBeVisible();
    await panel.getByRole('checkbox', { name: 'Lexical 13', exact: true }).check();
    await panel.getByRole('button', { name: 'Review selection (1)', exact: true }).click();
    await panel.getByRole('button', { name: 'Import selected originals', exact: true }).click();
    await expect(panel.getByText('Imported 1 of 1 selected originals.')).toBeVisible();
    await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Keep this draft');
    await expect(editor.getByRole('status')).toHaveText('Unsaved changes');
    // Malformed syntax reports failure and never falls back to metadata matches.
    await panel.getByLabel('Search Archive', { exact: true }).fill('forest AND');
    await panel.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(panel.getByRole('alert')).toBeVisible(); await expect(panel.getByRole('checkbox')).toHaveCount(0);
    await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Keep this draft');
    await panel.getByLabel('Search Archive', { exact: true }).fill('forest');
    await panel.getByLabel('Advanced filter', { exact: true }).fill('tokenCount <= 200');
    await panel.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(panel.getByText('Card text results for “forest”: 2 matches · 2 shown.')).toBeVisible();
    await panel.getByLabel('Advanced filter', { exact: true }).fill('unknown = 1');
    await panel.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(panel.getByRole('alert')).toBeVisible(); await expect(panel.getByRole('checkbox')).toHaveCount(0);
    expect(await (await page.request.get(`${archiveOrigin}/status`)).json()).toEqual(snapshot);
    expect(await (await page.request.get(`${archiveOrigin}/originals/${source.card.original.hash}?snapshot=${snapshot.snapshot}`)).body()).toEqual(original);
    expect(errors).toEqual([]); expect(writes).toEqual([]);
  });
}

test('Archive capability changes keep metadata browsing explicit and never silently fall back from lexical search', async ({ page }) => {
  let lexicalRequests = 0, listRequests = 0, advertise = false;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/search')) lexicalRequests++;
    if (path === '/api/archive/v1/cards') listRequests++;
  });
  await page.route('**/api/archive/v1/status', async (route) => {
    const response = await route.fetch(), data = await response.json(); if (!advertise) { delete data.search; delete data.filterFields; delete data.browse; delete data.sorts; delete data.semantic; }
    await route.fulfill({ response, json: data });
  });
  await page.goto('http://127.0.0.1:19311');
  await page.getByLabel('New workspace', { exact: true }).fill('Metadata-only source');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('button', { name: 'Browse Archive', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Archive import', exact: true });
  await expect(panel.getByRole('checkbox', { name: 'Aster', exact: true })).toBeVisible();
  await expect(panel.getByLabel('Search mode')).toHaveCount(0);
  await panel.getByLabel('Search Archive', { exact: true }).fill('forest');
  await panel.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(panel.getByText('No Archive cards match these filters.')).toBeVisible();
  expect(lexicalRequests).toBe(0);
  advertise = true;
  await panel.getByLabel('Search Archive', { exact: true }).fill('Lexical');
  await panel.getByRole('button', { name: 'Search', exact: true }).click();
  await panel.getByLabel('Search mode').selectOption('lexical');
  await panel.getByLabel('Search Archive', { exact: true }).fill('forest');
  advertise = false; const count = listRequests;
  await panel.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Card text search is no longer available');
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  expect(listRequests).toBe(count); expect(lexicalRequests).toBe(0);
  await panel.getByLabel('Search Archive', { exact: true }).fill('aster');
  await panel.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(panel.getByRole('checkbox', { name: 'Aster', exact: true })).toBeVisible();
});

test('Archive filter capability withdrawal preserves the expression and requires an explicit retry', async ({ page }) => {
  let advertise = true, searches = 0;
  page.on('request', (request) => { if (new URL(request.url()).pathname.endsWith('/search')) searches++; });
  await page.route('**/api/archive/v1/status', async (route) => {
    const response = await route.fetch(), data = await response.json();
    if (!advertise) delete data.filterFields;
    await route.fulfill({ response, json: data });
  });
  await page.goto('http://127.0.0.1:19311');
  await page.getByLabel('New workspace', { exact: true }).fill('Filter capability');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('button', { name: 'Browse Archive', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Archive import', exact: true });
  await panel.getByLabel('Search mode').selectOption('lexical');
  await panel.getByLabel('Search Archive', { exact: true }).fill('forest');
  await panel.getByLabel('Advanced filter', { exact: true }).fill('hasLorebook = true');
  advertise = false;
  await panel.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Advanced filters are no longer available');
  await expect(panel.getByLabel('Advanced filter', { exact: true })).toHaveValue('hasLorebook = true');
  await expect(panel.getByRole('checkbox')).toHaveCount(0); expect(searches).toBe(0);
  await panel.getByLabel('Advanced filter', { exact: true }).fill('');
  await panel.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(panel.getByText('Card text results for “forest”: 12 matches · 10 shown.')).toBeVisible();
  expect(searches).toBe(1);
});
