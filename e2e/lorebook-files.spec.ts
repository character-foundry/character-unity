import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

for (const profile of ['local', 'browser', 'hub'] as const) {
  test(`${profile}: reviewed lorebook import, draft download, save and reopen preserve native data`, async ({ page }, info) => {
    const name = `Lorebook files ${profile}`;
    const existing = { name: 'Existing book', entries: [{ keys: ['old'], content: 'Old content', name: 'Old entry' }] };
    const next = { name: 'Imported places', scan_depth: 0, token_budget: 500, recursive_scanning: false,
      extensions: { vendor: [1, null] }, futureBook: { keep: true }, entries: [
        { id: 8, name: 'Observatory', keys: ['sky, moon', ''], content: 'Under the stars.', position: 'after_char', extensions: { vendor: { preserve: true } } },
        { id: 8, name: 'Forest', keys: ['trees'], content: 'Deep woods.', insertion_order: -3, enabled: false, probability: 0 },
        { name: 'Without ID', keys: [], content: 'Untouched', opaque: ['keep'] },
      ] };
    const original = JSON.stringify({ spec: profile === 'local' ? 'chara_card_v2' : 'chara_card_v3', spec_version: profile === 'local' ? '2.0' : '3.0',
      opaqueEnvelope: ['keep'], data: { name, character_book: existing, extensions: { foreign: { keep: true } } } });
    const errors: string[] = []; page.on('pageerror', (failure) => errors.push(failure.message));
    if (profile === 'hub') await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${profile === 'local' ? 19310 : profile === 'browser' ? 19311 : 19312}`);
    if (profile === 'local') await page.getByRole('button', { name: 'Connect to local library' }).click();
    if (profile === 'hub') {
      const accounts = JSON.parse(await readFile('runtime/e2e-hub-accounts.json', 'utf8'));
      await page.getByLabel('Access key').fill(accounts.Alice.key);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    }
    await page.getByLabel('New workspace', { exact: true }).fill(name);
    await page.getByRole('button', { name: 'Create workspace' }).click();
    const importResponse = profile === 'hub' ? page.waitForResponse((response) => response.url().endsWith('/imports') && response.request().method() === 'POST') : undefined;
    await page.getByLabel('Import a card').setInputFiles({ name: 'card.json', mimeType: 'application/json', buffer: Buffer.from(original) });
    const imported = await importResponse;
    const originalUrl = imported ? `${imported.url().replace(/\/imports$/, '')}/cards/${(await imported.json()).card.id}/original` : undefined;
    const editor = page.getByRole('region', { name: profile === 'hub' ? 'Character editor' : 'Editor 1', exact: true });
    if (profile === 'local') {
      await page.getByRole('button', { name: `Open ${name}`, exact: true }).click();
      const second = page.getByRole('region', { name: 'Editor 2', exact: true });
      await second.getByRole('button', { name: 'Lorebook', exact: true }).click();
      await second.getByRole('button', { name: '1. Old entry', exact: true }).click();
    }
    await editor.getByRole('button', { name: 'Character', exact: true }).click();
    await editor.getByLabel('Description', { exact: true }).fill('Keep this unsaved description.');
    await editor.getByRole('button', { name: 'Lorebook', exact: true }).click();
    const chooser = editor.getByLabel('Import lorebook JSON', { exact: true });
    const file = { name: 'places.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(next)) };
    await chooser.setInputFiles({ name: 'world-info.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ entries: { '1': { uid: 1, key: ['sky'], content: 'World info' } } })) });
    await expect(editor.getByRole('alert')).toContainText('Import supports native character-book JSON');
    await chooser.setInputFiles(file);
    const review = editor.getByRole('region', { name: 'Lorebook import review' });
    await expect(review).toContainText('Imported places · 3 entries');
    await expect(review).toContainText('replaces the entire lorebook');
    await expect(editor.getByRole('button', { name: '1. Old entry', exact: true })).toBeVisible();
    await review.getByRole('button', { name: 'Cancel lorebook import' }).click();
    await expect(review).toHaveCount(0);
    await chooser.setInputFiles(file);
    await editor.getByRole('button', { name: '1. Old entry', exact: true }).click();
    await editor.getByLabel('Entry content', { exact: true }).fill('An intervening edit.');
    await expect(review.getByRole('button', { name: 'Replace draft lorebook' })).toBeDisabled();
    await expect(review).toContainText('The draft changed');
    if (profile === 'local') {
      await page.evaluate(() => {
        const read = File.prototype.arrayBuffer;
        File.prototype.arrayBuffer = async function () {
          if (this.name === 'delayed.json') await new Promise<void>((resolve) => {
            Object.assign(window, { finishLorebookRead: resolve });
          });
          return read.call(this);
        };
      });
      await chooser.setInputFiles({ ...file, name: 'delayed.json' });
      await expect(editor.getByText('Reading lorebook…', { exact: true })).toBeVisible();
      await editor.getByLabel('Entry content', { exact: true }).fill('Keep this edit during the file read.');
      await page.evaluate(() => (window as unknown as { finishLorebookRead(): void }).finishLorebookRead());
      await expect(editor.getByRole('alert')).toContainText('The draft changed');
      await expect(review).toHaveCount(0);
      await expect(editor.getByLabel('Entry content', { exact: true })).toHaveValue('Keep this edit during the file read.');
      // An abandoned read must not show a review in a newly mounted lorebook tab.
      await chooser.setInputFiles({ ...file, name: 'delayed.json' });
      await expect(editor.getByText('Reading lorebook…', { exact: true })).toBeVisible();
      await editor.getByRole('button', { name: 'Character', exact: true }).click();
      await page.evaluate(() => (window as unknown as { finishLorebookRead(): void }).finishLorebookRead());
      await editor.getByRole('button', { name: 'Lorebook', exact: true }).click();
      await expect(review).toHaveCount(0);
    }
    await chooser.setInputFiles(file);
    await review.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('lorebook-import-review.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await review.getByRole('button', { name: 'Replace draft lorebook' }).click();
    await expect(editor.getByRole('button', { name: '1. Old entry', exact: true })).toHaveCount(0);
    await editor.getByRole('button', { name: '1. Observatory', exact: true }).click();
    await expect(editor.getByLabel('Entry content', { exact: true })).toHaveValue('Under the stars.');
    await expect(editor.getByRole('status')).toHaveText('Unsaved changes');
    const download = page.waitForEvent('download');
    await editor.getByRole('button', { name: 'Download draft lorebook JSON', exact: true }).click();
    expect(JSON.parse(await readFile((await (await download).path())!, 'utf8'))).toEqual(next);
    await editor.getByRole('button', { name: 'Character', exact: true }).click();
    await expect(editor.getByLabel('Description', { exact: true })).toHaveValue('Keep this unsaved description.');
    await editor.getByRole('button', { name: 'Lorebook', exact: true }).click();
    if (profile === 'local') {
      const second = page.getByRole('region', { name: 'Editor 2', exact: true });
      await expect(second.getByLabel('Entry content', { exact: true })).toHaveValue('Old content');
      await page.route('**/revisions', (route) => route.abort('connectionfailed'));
      await editor.getByRole('button', { name: 'Save revision' }).click();
      await expect(editor.getByRole('alert')).toContainText('Cannot reach the local API');
      await expect(editor.getByRole('button', { name: '1. Observatory', exact: true })).toBeVisible();
      await page.unroute('**/revisions');
    }
    await editor.getByRole('button', { name: 'Save revision' }).click();
    await expect(editor.getByRole('status')).toHaveText('Saved');
    await editor.getByLabel('Export format', { exact: true }).selectOption('json');
    const exported = page.waitForEvent('download');
    await editor.getByRole('button', { name: 'Download saved revision' }).click();
    const document = JSON.parse(await readFile((await (await exported).path())!, 'utf8'));
    expect(document.data.character_book).toEqual(next);
    expect(document.data.description).toBe('Keep this unsaved description.');
    expect(document.opaqueEnvelope).toEqual(['keep']);
    expect(document.data.extensions.foreign).toEqual({ keep: true });
    if (originalUrl) {
      const accepted = await page.request.get(originalUrl);
      expect(accepted.status()).toBe(200); expect(await accepted.text()).toBe(original);
    } else {
      const accepted = page.waitForEvent('download');
      await editor.getByRole('button', { name: 'Download accepted original' }).click();
      expect(await readFile((await (await accepted).path())!, 'utf8')).toBe(original);
    }
    await page.reload();
    await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: name });
    await page.getByRole('button', { name: `${profile === 'hub' ? 'Edit' : 'Open'} ${name}`, exact: true }).click();
    await editor.getByRole('button', { name: 'Lorebook', exact: true }).click();
    await chooser.setInputFiles({ name: 'empty.json', mimeType: 'application/json', buffer: Buffer.from('{"entries":[],"future":null}') });
    await review.getByRole('button', { name: 'Replace draft lorebook' }).click();
    await expect(editor.getByText('Add an entry to begin.', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await editor.getByRole('button', { name: 'Confirm discard', exact: true }).click();
    await editor.getByRole('button', { name: '1. Observatory', exact: true }).click();
    await expect(editor.getByLabel('Entry content', { exact: true })).toHaveValue('Under the stars.');
    expect(errors).toEqual([]);
  });
}
