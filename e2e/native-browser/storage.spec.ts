import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const original = JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', opaque: { keep: true }, data: {
  name: 'Browser Aster', description: 'An offline astronomer.', extensions: { foreign: { untouched: [1, null] } },
} });
async function workspace(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Account and workspace', exact: true }).click();
  await expect(page.getByText('Stored in this browser', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New workspace', exact: true }).click();
  await page.getByLabel('Workspace name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Account and workspace', exact: true })).toHaveAttribute('title', `Browser owner · ${name}`);
  await expect(page.getByText('No cards yet', { exact: true })).toBeVisible();
}
async function importFile(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }, name: string) {
  const choosing = page.waitForEvent('filechooser');
  await page.getByTitle('Import card files').click();
  await (await choosing).setFiles(file);
  await expect(page.getByRole('status')).toContainText('Imported 1 card');
  await page.getByRole('button', { name: `Quick view ${name}`, exact: true }).click();
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(name);
}
async function save(page: Page) {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/^Saved \d/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
}
async function download(page: Page, button: string) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  return readFile((await (await pending).path())!);
}
async function rows(page: Page) {
  return page.evaluate(() => new Promise<{ version: number; revisions: { sequence: number; document: Record<string, unknown>; assets: { path: string; assetId: string }[]; identity: unknown }[] }>((resolve, reject) => {
    const opening = indexedDB.open('character-unity:architect');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result, transaction = db.transaction('revisions', 'readonly');
      const reading = transaction.objectStore('revisions').getAll();
      transaction.oncomplete = () => { db.close(); resolve({ version: db.version, revisions: reading.result }); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }));
}

test('native browser host opens the existing schema in place, saves offline and keeps exact originals', async ({ page, context }, info) => {
  const api: string[] = [], errors: string[] = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/')) api.push(request.url()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/assets/browser-seed/seed.html');
  await page.getByRole('button', { name: 'Prepare existing browser library' }).click();
  await expect(page.getByRole('status')).toHaveText('Existing browser library ready');
  await page.goto('/');
  await page.getByRole('button', { name: 'Quick view Browser Aster', exact: true }).click();
  await expect(page.getByRole('dialog').getByTitle('Remove from favorites', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Browser Aster');
  await context.setOffline(true);
  await page.getByLabel('Name', { exact: true }).fill('Aster in the browser');
  await save(page);
  await page.screenshot({ path: info.outputPath('native-browser-offline-editor.png') });
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Aster in the browser');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  expect((await download(page, 'Download original')).toString()).toBe(original);
  expect((await rows(page)).version).toBe(4);
  expect((await rows(page)).revisions).toHaveLength(2);
  await page.getByRole('link', { name: 'Stats', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Collection stats', exact: true })).toBeVisible();
  const metrics = page.locator('dl[aria-label="Library membership"]');
  await expect(metrics.locator('dt').filter({ hasText: /^Owned cards$/ }).locator('..').locator('dd').first()).toHaveText('1');
  await expect(page.getByText('Owned revision history', { exact: true }).locator('..').locator('dd')).toHaveText('2');
  await page.getByRole('button', { name: 'Refresh statistics', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh statistics', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('native-browser-real-statistics.png') });
  expect(api).toEqual([]); expect(errors).toEqual([]);
});

test('native browser tabs reject stale saves and separate browser contexts remain isolated', async ({ page, context, browser }) => {
  await workspace(page, 'Shared tabs');
  await importFile(page, { name: 'aster.json', mimeType: 'application/json', buffer: Buffer.from(original) }, 'Browser Aster');
  const other = await context.newPage(); await other.goto('/');
  await other.getByRole('button', { name: 'Account and workspace', exact: true }).click();
  await other.getByLabel('Workspace', { exact: true }).selectOption({ label: 'Shared tabs' });
  await other.getByRole('button', { name: 'Quick view Browser Aster', exact: true }).click();
  await other.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(other.getByLabel('Name', { exact: true })).toHaveValue('Browser Aster');
  await page.getByLabel('Name', { exact: true }).fill('First tab');
  await other.getByLabel('Name', { exact: true }).fill('Second tab');
  await save(page);
  await other.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(other.getByRole('alert')).toContainText(/changed|conflict/i);
  await expect(other.getByLabel('Name', { exact: true })).toHaveValue('Second tab');
  other.once('dialog', (dialog) => dialog.accept());
  await other.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(other.getByLabel('Name', { exact: true })).toHaveValue('First tab');
  const isolated = await browser.newContext();
  try {
    const fresh = await isolated.newPage(); await fresh.goto('http://127.0.0.1:19434');
    await expect(fresh.getByText('No cards yet', { exact: true })).toBeVisible();
    await fresh.getByRole('button', { name: 'Account and workspace', exact: true }).click();
    await expect(fresh.getByLabel('Workspace', { exact: true }).locator('option')).toHaveText(['Library']);
  } finally { await isolated.close(); await other.close(); }
});

test('failed native browser storage commits roll back and retain the draft for a successful retry', async ({ page }) => {
  await page.addInitScript(() => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === 'revisions' && localStorage.getItem('inject-quota-failure')) throw new DOMException('Injected quota failure', 'QuotaExceededError');
      return add.apply(this, args);
    };
  });
  await workspace(page, 'Quota retry');
  await importFile(page, { name: 'aster.json', mimeType: 'application/json', buffer: Buffer.from(original) }, 'Browser Aster');
  await page.getByLabel('Name', { exact: true }).fill('Recovered after failure');
  await page.evaluate(() => localStorage.setItem('inject-quota-failure', 'yes'));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Browser storage is full');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Recovered after failure');
  expect((await rows(page)).revisions).toHaveLength(1);
  await page.evaluate(() => localStorage.removeItem('inject-quota-failure'));
  await save(page);
  expect((await rows(page)).revisions).toHaveLength(2);
});

test('native browser PNG and CharX editing retains assets, opaque fields and accepted container bytes', async ({ page }) => {
  for (const format of ['png', 'charx']) {
    await workspace(page, `Container ${format}`);
    const filename = resolve(`e2e/fixtures/aster.${format}`);
    await importFile(page, filename, 'Container Aster');
    await page.getByLabel('Name', { exact: true }).fill(`Edited ${format}`);
    await save(page);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    expect(await download(page, 'Download original')).toEqual(await readFile(filename));
    expect((await download(page, format === 'png' ? 'Download PNG' : 'Export CharX')).byteLength).toBeGreaterThan(0);
  }
  const stored = (await rows(page)).revisions;
  expect(stored).toHaveLength(4);
  for (const revision of stored) {
    expect(revision.assets.map((asset) => asset.path)).toEqual(['declared/0', 'portrait']);
    expect(revision.document).toMatchObject({ opaque: { keep: true }, data: { extensions: { foreign: { keep: [1, null] } } } });
  }
});

test('native browser CharX export and fresh-workspace import preserve opaque and colliding descriptors', async ({ page }, info) => {
  await workspace(page, 'Opaque transport');
  const filename = resolve('e2e/fixtures/opaque-assets.png');
  await importFile(page, filename, 'Opaque Aster');
  await page.getByLabel('Name', { exact: true }).fill('Opaque browser saved');
  await save(page);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  expect(await download(page, 'Download original')).toEqual(await readFile(filename));
  const exported = await download(page, 'Export CharX');
  await workspace(page, 'Opaque destination');
  await importFile(page, { name: 'preserved.charx', mimeType: 'application/zip', buffer: exported }, 'Opaque browser saved');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  expect(await download(page, 'Download original')).toEqual(exported);
  const stored = (await rows(page)).revisions;
  expect(stored).toHaveLength(3);
  const saved = stored.find((revision) => revision.sequence === 2)!;
  const reimported = stored.find((revision) => revision.sequence === 1 && (revision.document.data as { name: string }).name === 'Opaque browser saved')!;
  expect(reimported.identity).toEqual(saved.identity);
  expect(reimported.document).toMatchObject({ data: { assets: [{ name: 'Main.Art', license: { preserve: true } }, { name: 'data.file', vendor: [1, null] }, { name: 'data_file', vendor: [2, false] }] } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('native-browser-mobile-viewer.png') });
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('native browser mobile CCv2 preserves opaque optional fields through core, focused, preview and saved reload', async ({ page }, info) => {
  const api: string[] = [], errors: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) api.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  const document = { spec: 'chara_card_v2', spec_version: '2.0', opaque: { keep: [false, 0] }, data: {
    name: 'Browser opaque CCv2', description: 'Editable description', creator: null, personality: false, scenario: 0,
    alternate_greetings: { foreign: [0, false] }, group_only_greetings: ['text', false],
    extensions: { depth_prompt: 'opaque', voxta: { appearance: 0, vendor: false }, vendor: [null, false, 0] },
  } };
  const bytes = Buffer.from(JSON.stringify(document));
  await workspace(page, 'Opaque core fields');
  await importFile(page, { name: 'opaque-v2.json', mimeType: 'application/json', buffer: bytes }, document.data.name);
  await expect(page.getByRole('region', { name: 'Creator preserved value', exact: true })).toContainText('null');
  await page.getByLabel('Name', { exact: true }).fill('Browser opaque CCv2 edited');
  await page.getByRole('button', { name: 'Character', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Appearance preserved value', exact: true })).toContainText('0');
  await page.getByLabel('Description', { exact: true }).fill('Edited offline safely');
  await page.getByRole('button', { name: 'Greetings', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Alternate Greetings preserved value', exact: true })).toContainText('foreign');
  await expect(page.getByText('Group Only Greetings', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Character Note preserved value', exact: true })).toContainText('opaque');
  await page.getByRole('button', { name: 'Focused', exact: true }).click();
  await page.getByRole('button', { name: 'Scenario', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Scenario preserved value', exact: true })).toContainText('0');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Alternate Greetings preserved value', exact: true })).toBeVisible();
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('native-browser-opaque-core-mobile.png') });
  await save(page);
  const stored = (await rows(page)).revisions.find(revision => revision.sequence === 2)!;
  expect(stored.document).toMatchObject({ ...document, data: { ...document.data, name: 'Browser opaque CCv2 edited', description: 'Edited offline safely' } });
  expect(stored.document).not.toHaveProperty('description');
  await page.reload();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Creator preserved value', exact: true })).toContainText('null');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  expect(await download(page, 'Download original')).toEqual(bytes);
  expect(api).toEqual([]); expect(errors).toEqual([]);
});

test('browser settings distinguish unavailable operator services from failed connections', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByText('Archive sources and credentials are managed by the installation operator.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run now', exact: true })).toHaveCount(0);
  await expect(page.getByText('The Archive is not available:', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Sharing', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Remotes', exact: true })).toHaveCount(0);
});
