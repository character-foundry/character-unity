import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function seedOrphans(page: Page, missing = false) {
  return page.evaluate(async (missingObject) => {
    const bytes = new TextEncoder().encode('Explicitly reviewed orphan bytes');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('');
    return new Promise<{ oldId: string; legacyId: string; byteLength: number }>((resolve, reject) => {
      const opening = indexedDB.open('character-unity:architect');
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result, tx = db.transaction(['workspaces', 'assets', 'blobs', 'meta'], 'readwrite');
        const query = tx.objectStore('workspaces').getAll();
        const oldId = missingObject ? 'missing-ready-fixture' : 'old-orphan-fixture', legacyId = 'legacy-orphan-fixture';
        query.onsuccess = () => {
          const workspace = query.result.find((row: { ownerId: string }) => row.ownerId === 'browser');
          for (const id of missingObject ? [oldId] : [oldId, legacyId]) {
            const key = `assets/${id}`;
            tx.objectStore('assets').add({ id, workspaceId: workspace.id, hash, byteLength: bytes.byteLength, mediaType: 'text/plain', storageKey: key, state: 'ready' });
            if (!missingObject) tx.objectStore('blobs').add({ key, hash, byteLength: bytes.byteLength, bytes: new Blob([bytes]) });
            if (id === oldId) tx.objectStore('meta').add({ key: `maintenance:age:${id}`, createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString() });
          }
        };
        tx.oncomplete = () => { db.close(); resolve({ oldId, legacyId, byteLength: bytes.byteLength }); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }, missing);
}
async function state(page: Page) {
  return page.evaluate(() => new Promise<{ cards: number; revisions: number; sources: number; keys: string[] }>((resolve, reject) => {
    const opening = indexedDB.open('character-unity:architect');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result, tx = db.transaction(['cards', 'revisions', 'sources', 'blobs'], 'readonly');
      const cards = tx.objectStore('cards').count(), revisions = tx.objectStore('revisions').count(), sources = tx.objectStore('sources').count(), keys = tx.objectStore('blobs').getAllKeys();
      tx.oncomplete = () => { db.close(); resolve({ cards: cards.result, revisions: revisions.result, sources: sources.result, keys: keys.result as string[] }); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }));
}

test('browser cleanup is explicit, preserves live originals and metadata, and requires a conservative legacy age clock', async ({ page }, info) => {
  const api: string[] = [], errors: string[] = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/')) api.push(request.url()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const choosing = page.waitForEvent('filechooser'); await page.getByTitle('Import card files').click();
  const original = JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Keep my browser original', description: 'Never cleanup a live source.' } });
  await (await choosing).setFiles({ name: 'kept.json', mimeType: 'application/json', buffer: Buffer.from(original) });
  await expect(page.getByRole('status')).toContainText('Imported 1 card');
  const fixture = await seedOrphans(page), initial = await state(page);
  await page.goto('/settings#browser-storage');
  const panel = page.locator('[data-browser-storage-settings]');
  await expect(panel.getByRole('button', { name: 'Preview browser cleanup', exact: true })).toBeVisible();
  await expect(panel.getByText('eligible objects', { exact: false })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Preview browser cleanup', exact: true }).click();
  await expect(panel.getByText('1 eligible objects', { exact: false })).toBeVisible();
  await expect(panel.getByText('1 legacy orphan objects', { exact: false })).toBeVisible();
  expect((await state(page)).keys).toEqual(initial.keys);
  await panel.getByRole('button', { name: 'Select reviewed page', exact: true }).click();
  await expect(panel.getByRole('checkbox')).toBeChecked();
  await panel.getByRole('button', { name: 'Deselect all', exact: true }).click();
  await expect(panel.getByRole('checkbox')).not.toBeChecked();
  await panel.getByRole('checkbox').check();
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('browser-cleanup-desktop-preview.png') });
  await panel.getByRole('button', { name: 'Review selected objects (1)', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm browser object cleanup', exact: true });
  await expect(dialog.getByText('deleted bytes cannot be recovered', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0); expect((await state(page)).keys).toEqual(initial.keys);
  await panel.getByRole('button', { name: 'Review selected objects (1)', exact: true }).click();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 375, height: 812 });
  await panel.getByRole('button', { name: 'Review selected objects (1)', exact: true }).click();
  await page.screenshot({ path: info.outputPath('browser-cleanup-mobile-confirmation.png') });
  const bounds = await dialog.boundingBox(); expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
  await dialog.getByRole('button', { name: 'Remove selected objects', exact: true }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'Removed 1 objects' })).toContainText(`(${fixture.byteLength} B)`);
  await expect(panel.getByText('No eligible local objects.', { exact: false })).toBeVisible();
  const after = await state(page);
  expect(after).toMatchObject({ cards: initial.cards, revisions: initial.revisions, sources: initial.sources });
  expect(after.keys).toEqual(initial.keys.filter((key) => key !== `assets/${fixture.oldId}`));
  await panel.getByRole('status').filter({ hasText: 'Removed 1 objects' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('browser-cleanup-mobile-removed.png') });
  await panel.getByRole('button', { name: 'Start 24-hour clock', exact: true }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'Recorded 1 orphan objects.' })).toContainText('Earliest cleanup:');
  await expect(panel.getByRole('button', { name: 'Start 24-hour clock', exact: true })).toHaveCount(0);
  expect((await state(page)).keys).toContain(`assets/${fixture.legacyId}`);
  await page.screenshot({ path: info.outputPath('browser-cleanup-mobile-complete.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto('/'); await page.getByRole('button', { name: 'Quick view Keep my browser original', exact: true }).click();
  await page.getByRole('link', { name: 'View Full Profile', exact: true }).click();
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download original', exact: true }).click();
  expect((await readFile((await (await downloading).path())!)).toString()).toBe(original);
  await seedOrphans(page, true); await page.goto('/settings#browser-storage');
  await panel.getByRole('button', { name: 'Preview browser cleanup', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('A ready browser object is missing');
  await panel.getByRole('alert').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('browser-cleanup-mobile-integrity-error.png') });
  expect(api).toEqual([]); expect(errors).toEqual([]);
});
