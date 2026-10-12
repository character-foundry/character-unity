import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test.use({ baseURL: 'http://127.0.0.1:19311' });
const original = JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', opaque: { keep: true }, data: {
  name: 'Browser Aster', description: 'An offline astronomer.', extensions: { foreign: { untouched: [1, null] } },
} });
async function setup(page: Page, workspace: string) {
  await page.goto('/');
  await expect(page.getByText('Stored in this browser', { exact: true })).toBeVisible();
  await page.getByLabel('New workspace', { exact: true }).fill(workspace);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByText('Your library is empty.')).toBeVisible();
}
async function importCard(page: Page) {
  await page.getByLabel('Import a card').setInputFiles({ name: 'aster.json', mimeType: 'application/json', buffer: Buffer.from(original) });
  await expect(page.getByRole('region', { name: 'Editor 1', exact: true })).toBeVisible();
}

test('static browser host imports and saves offline, reloads and retains exact originals', async ({ page, context }, info) => {
  const apiRequests: string[] = [], errors: string[] = [];
  page.on('request', (req) => { if (new URL(req.url()).pathname.startsWith('/api')) apiRequests.push(req.url()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await setup(page, 'Browser desk');
  await context.setOffline(true);
  await importCard(page);
  const editor = page.getByRole('region', { name: 'Editor 1', exact: true });
  await editor.getByLabel('Name', { exact: true }).fill('Aster in the browser');
  await editor.getByRole('button', { name: 'Character', exact: true }).click();
  await editor.getByLabel('Description', { exact: true }).fill('Saved while the network was unavailable.');
  await editor.getByRole('button', { name: 'Save revision' }).click();
  await expect(editor.getByRole('status')).toHaveText('Saved');
  await page.screenshot({ path: info.outputPath('browser-editor.png'), fullPage: false });
  await context.setOffline(false);
  await page.reload();
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: 'Browser desk' });
  await page.getByRole('button', { name: 'Open Aster in the browser', exact: true }).click();
  await editor.getByRole('button', { name: 'Character', exact: true }).click();
  await expect(editor.getByLabel('Description', { exact: true })).toHaveValue('Saved while the network was unavailable.');
  const download = page.waitForEvent('download');
  await editor.getByRole('button', { name: 'Download accepted original' }).click();
  expect(await readFile((await (await download).path())!, 'utf8')).toBe(original);
  expect(apiRequests).toEqual([]); expect(errors).toEqual([]);
});

test('separate tabs reject stale saves and separate browser profiles have independent libraries', async ({ page, context, browser }) => {
  await setup(page, 'Shared tabs');
  await importCard(page);
  const secondPage = await context.newPage();
  await secondPage.goto('/');
  await secondPage.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: 'Shared tabs' });
  await secondPage.getByRole('button', { name: 'Open Browser Aster', exact: true }).click();
  const first = page.getByRole('region', { name: 'Editor 1', exact: true });
  const second = secondPage.getByRole('region', { name: 'Editor 1', exact: true });
  await first.getByLabel('Name', { exact: true }).fill('First tab');
  await second.getByLabel('Name', { exact: true }).fill('Second tab');
  await first.getByRole('button', { name: 'Save revision' }).click();
  await expect(first.getByRole('status')).toHaveText('Saved');
  await second.getByRole('button', { name: 'Save revision' }).click();
  await expect(second.getByRole('alert')).toContainText('card has changed');
  await expect(second.getByLabel('Name', { exact: true })).toHaveValue('Second tab');
  await second.getByRole('button', { name: 'Discard changes' }).click();
  await second.getByRole('button', { name: 'Confirm discard' }).click();
  await second.getByRole('button', { name: 'Close editor' }).click();
  await secondPage.getByRole('button', { name: 'Refresh', exact: true }).click();
  await secondPage.getByRole('button', { name: 'Open First tab', exact: true }).click();
  await expect(second.getByLabel('Name', { exact: true })).toHaveValue('First tab');
  const isolated = await browser.newContext();
  try {
    const other = await isolated.newPage(); await other.goto('http://127.0.0.1:19311');
    await expect(other.getByLabel('New workspace', { exact: true })).toBeVisible();
    await expect(other.getByRole('combobox', { name: 'Workspace', exact: true })).toHaveCount(0);
  } finally { await isolated.close(); await secondPage.close(); }
});

test('a failed storage write rolls back the revision and leaves the draft available to retry', async ({ page }) => {
  await page.addInitScript(() => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === 'revisions' && localStorage.getItem('inject-quota-failure')) throw new DOMException('Injected quota failure', 'QuotaExceededError');
      return add.apply(this, args);
    };
  });
  await setup(page, 'Quota recovery'); await importCard(page);
  const editor = page.getByRole('region', { name: 'Editor 1', exact: true });
  await editor.getByLabel('Name', { exact: true }).fill('Recovered after failure');
  await page.evaluate(() => localStorage.setItem('inject-quota-failure', 'yes'));
  await editor.getByRole('button', { name: 'Save revision' }).click();
  await expect(editor.getByRole('alert')).toContainText('Browser storage is full');
  await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Recovered after failure');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Browser Aster', exact: true })).toBeVisible();
  await page.evaluate(() => localStorage.removeItem('inject-quota-failure'));
  await editor.getByRole('button', { name: 'Save revision' }).click();
  await expect(editor.getByRole('status')).toHaveText('Saved');
  await expect(page.getByText('Revision 2', { exact: true })).toBeVisible();
});

test('browser PNG and CharX parsing retains verified assets and exact accepted containers', async ({ page }) => {
  await setup(page, 'Container fixtures');
  for (const format of ['png', 'charx']) {
    const filename = resolve(`e2e/fixtures/aster.${format}`);
    await page.getByLabel('Import a card').setInputFiles(filename);
    const editor = page.getByRole('region', { name: 'Editor 1', exact: true });
    await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Container Aster');
    await editor.getByRole('button', { name: 'Character', exact: true }).click();
    await editor.getByLabel('Description', { exact: true }).fill(`Edited ${format} in the browser.`);
    await editor.getByRole('button', { name: 'Save revision' }).click();
    await expect(editor.getByRole('status')).toHaveText('Saved');
    await editor.getByLabel('Export format', { exact: true }).selectOption(format);
    const output = page.waitForEvent('download');
    await editor.getByRole('button', { name: 'Download saved revision' }).click();
    expect((await readFile((await (await output).path())!)).byteLength).toBeGreaterThan(0);
    const download = page.waitForEvent('download');
    await editor.getByRole('button', { name: 'Download accepted original' }).click();
    expect(await readFile((await (await download).path())!)).toEqual(await readFile(filename));
    await editor.getByRole('button', { name: 'Close editor' }).click();
  }
  // Read-only inspection complements the visible workflow: the browser persisted
  // both source containers, both revision asset bindings and preserved SDK lineage.
  const revisions = await page.evaluate(async () => {
    return new Promise<{ sequence: number; assets: { assetId: string; path: string }[]; document: Record<string, unknown>; identity: { hash: string } }[]>((resolve, reject) => {
      const opening = indexedDB.open('character-unity:architect');
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result;
        const tx = db.transaction('revisions', 'readonly');
        const read = tx.objectStore('revisions').getAll();
        tx.oncomplete = () => { db.close(); resolve(read.result); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  });
  expect(revisions).toHaveLength(4);
  const imports = revisions.filter((value) => value.sequence === 1);
  expect(imports[0]!.identity).toEqual(imports[1]!.identity);
  for (const value of revisions) {
    expect(value.assets.map((item) => item.path)).toEqual(['declared/0', 'portrait']);
    expect(value.document).toMatchObject({ opaque: { keep: true }, data: { extensions: { foreign: { keep: [1, null] } } } });
    if (value.sequence === 2) expect(value.document).toMatchObject({ data: { extensions: { foundry: { lineage: { author: 'urn:unity:user:browser', operation: 'edit' } } } } });
  }
});

test('browser CharX export and reimport retains opaque descriptors and colliding asset names', async ({ page }) => {
  await setup(page, 'Opaque asset transport');
  const source = resolve('e2e/fixtures/opaque-assets.png');
  await page.getByLabel('Import a card').setInputFiles(source);
  const editor = page.getByRole('region', { name: 'Editor 1', exact: true });
  await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Opaque Aster');
  await editor.getByRole('button', { name: 'Character', exact: true }).click();
  await editor.getByLabel('Description', { exact: true }).fill('Opaque containers survive.');
  await editor.getByRole('button', { name: 'Save revision' }).click();
  await expect(editor.getByRole('status')).toHaveText('Saved');
  const original = page.waitForEvent('download');
  await editor.getByRole('button', { name: 'Download accepted original' }).click();
  expect(await readFile((await (await original).path())!)).toEqual(await readFile(source));
  await editor.getByLabel('Export format', { exact: true }).selectOption('charx');
  const output = page.waitForEvent('download');
  await editor.getByRole('button', { name: 'Download saved revision' }).click();
  const bytes = await readFile((await (await output).path())!);
  await editor.getByRole('button', { name: 'Close editor' }).click();
  await page.getByLabel('Import a card').setInputFiles({ name: 'preserved.charx', mimeType: 'application/zip', buffer: bytes });
  await editor.getByRole('button', { name: 'Character', exact: true }).click();
  await expect(editor.getByLabel('Description', { exact: true })).toHaveValue('Opaque containers survive.');
  const returnedOriginal = page.waitForEvent('download');
  await editor.getByRole('button', { name: 'Download accepted original' }).click();
  expect(await readFile((await (await returnedOriginal).path())!)).toEqual(bytes);
  const revisions = await page.evaluate(async () => {
    return new Promise<{ sequence: number; identity: unknown; document: { data: { assets: { name: string; uri: string; license?: unknown; vendor?: unknown }[]; extensions: { foundry?: { lineage?: unknown } } } } }[]>((resolve, reject) => {
      const opening = indexedDB.open('character-unity:architect');
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result; const tx = db.transaction('revisions', 'readonly');
        const rows = tx.objectStore('revisions').getAll();
        tx.oncomplete = () => { db.close(); resolve(rows.result); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  });
  expect(revisions).toHaveLength(3);
  const saved = revisions.find((revision) => revision.sequence === 2)!;
  const imported = revisions.find((revision) => revision.sequence === 1 && revision.document.data.extensions.foundry?.lineage)!;
  expect(imported.identity).toEqual(saved.identity);
  expect(imported.document.data.extensions.foundry?.lineage).toEqual(saved.document.data.extensions.foundry?.lineage);
  expect(imported.document.data.assets).toMatchObject([{ name: 'Main.Art', license: { preserve: true } }, { name: 'data.file', vendor: [1, null] }, { name: 'data_file', vendor: [2, false] }]);
  expect(new Set(imported.document.data.assets.map((asset) => asset.uri)).size).toBe(3);
});
