import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { notes, parse } from '../unity-editor/fixtures.js';

async function download(page: Page, name: string) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  return readFile((await (await pending).path())!);
}
async function storageCounts(page: Page) {
  return page.evaluate(() => new Promise<Record<string, number>>((resolve, reject) => {
    const opening = indexedDB.open('character-unity:architect');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result, names = ['cards', 'revisions', 'archiveReferences', 'archiveAssets', 'blobs'];
      const tx = db.transaction(names, 'readonly'), counts = names.map((name) => [name, tx.objectStore(name).count()] as const);
      tx.oncomplete = () => { db.close(); resolve(Object.fromEntries(counts.map(([name, request]) => [name, request.result]))); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }));
}

test('opt-in browser Archive favorites remain pinned references and changed forks inherit files after reload without copied blobs', async ({ page }, info) => {
  const errors: string[] = [], localApi: string[] = [], archive: { method: string; headers: Record<string, string> }[] = [];
  const completed: { origin: string | undefined; allowed: string | undefined }[] = [];
  const metadata: Promise<void>[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.port === '19435' && url.pathname.startsWith('/api/')) localApi.push(request.url());
    if (url.port === '19436') metadata.push(request.allHeaders().then((headers) => { archive.push({ method: request.method(), headers }); }));
  });
  page.on('response', (response) => {
    if (new URL(response.url()).port === '19436') metadata.push(response.request().allHeaders().then((headers) => {
      completed.push({ origin: headers.origin, allowed: response.headers()['access-control-allow-origin'] });
    }));
  });
  await page.goto('/archive');
  const tile = page.locator('article').filter({ has: page.getByRole('button', { name: 'Quick view Archive CHARX', exact: true }) });
  await tile.getByTitle('Favorite and add a library link', { exact: true }).click();
  await expect(tile.getByRole('link', { name: 'In library ✓', exact: true })).toBeVisible();
  expect(await storageCounts(page)).toMatchObject({ cards: 0, revisions: 0, archiveReferences: 1, archiveAssets: 0, blobs: 0 });
  await tile.getByRole('link', { name: 'In library ✓', exact: true }).click();
  const referenceUrl = page.url();
  await expect(page.getByText('ARCHIVE LINK', { exact: true })).toBeVisible();
  const detail = await (await page.request.get('http://127.0.0.1:19436/api/archive/v2/cards/1003')).json();
  const source = detail.versionList.find((version: { id: string }) => version.id === detail.versionId).objects.find((object: { role: string }) => object.role === 'card');
  const accepted = await (await page.request.get(`http://127.0.0.1:19436/api/archive/v2/objects/${source.sha256}`)).body();
  expect(await download(page, 'Download original')).toEqual(accepted);
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByText('Archive original — changes stay local until you save a fork', { exact: true })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('My browser Archive fork');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/^Saved \d/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(page.url()).not.toBe(`${referenceUrl}/edit`);
  await page.reload();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('My browser Archive fork');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My browser Archive fork', exact: true, level: 1 })).toBeVisible();
  await expect.poll(() => page.locator('main img').evaluateAll((images) => images.some((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  expect(await download(page, 'Download original')).toEqual(accepted);
  const exported = await parse(await download(page, 'Export CharX'));
  expect(Buffer.from(exported.assets.find((asset) => asset.name === 'notes')!.data)).toEqual(notes);
  expect(exported.assets.find((asset) => asset.isMain)?.data.byteLength).toBeGreaterThan(0);
  const counts = await storageCounts(page);
  expect(counts).toMatchObject({ cards: 1, revisions: 1, archiveReferences: 1, blobs: 0 });
  expect(counts.archiveAssets).toBeGreaterThan(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('native-browser-archive-fork-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto(referenceUrl);
  await expect(page.getByRole('heading', { name: 'Archive CHARX', exact: true, level: 1 })).toBeVisible();
  expect(await download(page, 'Download original')).toEqual(accepted);
  expect((await storageCounts(page)).blobs).toBe(0);
  await Promise.all(metadata);
  expect(archive.length).toBeGreaterThan(0);
  // Cancelled/cached reads may omit Chromium's network-extra Origin metadata.
  // All attempted reads stay public GETs and every response grants this origin.
  expect(archive.every((request) => request.method === 'GET'
    && !request.headers.authorization && !request.headers.cookie && !request.headers['x-unity-actor'])).toBe(true);
  expect(completed.length).toBeGreaterThan(0);
  expect(completed.some((response) => response.origin === 'http://127.0.0.1:19435')).toBe(true);
  expect(completed.every((response) => response.allowed === 'http://127.0.0.1:19435'
    && (response.origin === undefined || response.origin === response.allowed)), JSON.stringify(completed)).toBe(true);
  expect(localApi).toEqual([]); expect(errors).toEqual([]);
});
