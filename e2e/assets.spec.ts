import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Revision } from '../packages/store/src/types.js';

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
for (const profile of ['local', 'browser', 'hub'] as const) {
  test(`${profile}: asset drafts save exact bytes, recover failures and export/reimport without changing originals`, async ({ page, context }, info) => {
    const origin = `http://127.0.0.1:${profile === 'local' ? 19310 : profile === 'browser' ? 19311 : 19312}`;
    const name = `Assets ${profile}`, v3 = profile !== 'local';
    const original = JSON.stringify({ spec: v3 ? 'chara_card_v3' : 'chara_card_v2', spec_version: v3 ? '3.0' : '2.0',
      envelope: { keep: [null, 1] }, data: { name, description: 'Original', extensions: { vendor: { preserve: true } } } });
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin); let key = '';
    if (profile === 'local') await page.getByRole('button', { name: 'Connect to local library' }).click();
    if (profile === 'hub') {
      key = JSON.parse(await readFile('runtime/e2e-hub-accounts.json', 'utf8')).Alice.key;
      await page.getByLabel('Access key').fill(key); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible(); await page.setViewportSize({ width: 390, height: 844 });
    }
    await page.getByLabel('New workspace', { exact: true }).fill(name); await page.getByRole('button', { name: 'Create workspace' }).click();
    const importedResponse = profile !== 'browser' ? page.waitForResponse((response) => response.url().endsWith('/imports')) : undefined;
    await page.getByLabel('Import a card').setInputFiles({ name: 'assets.json', mimeType: 'application/json', buffer: Buffer.from(original) });
    const imported = await importedResponse, initial = imported ? await imported.json() : null;
    const cardUrl = imported ? `${imported.url().replace(/\/imports$/, '')}/cards/${initial.card.id}` : '';
    const editor = page.getByRole('region', { name: profile === 'hub' ? 'Character editor' : 'Editor 1', exact: true });
    if (profile === 'local') {
      await page.getByRole('button', { name: `Open ${name}`, exact: true }).click();
      await page.route('**/assets?*', (route) => route.abort('connectionfailed'));
    }
    await editor.getByRole('button', { name: 'Assets', exact: true }).click();
    if (profile === 'local') {
      await expect(editor.getByRole('alert')).toContainText('Cannot reach the local API'); await page.unroute('**/assets?*');
      await editor.getByRole('button', { name: 'Retry asset list' }).click();
    }
    await expect(editor.getByLabel('Choose portrait')).toBeEnabled(); await expect(editor.getByRole('status')).toHaveText('No changes');
    await editor.getByLabel('Choose portrait').setInputFiles({ name: 'portrait.png', mimeType: 'image/png', buffer: image });
    await expect(editor.getByRole('status')).toHaveText('Unsaved changes');
    await expect(editor.getByAltText('Draft portrait')).toBeVisible();
    if (v3) {
      for (const [filename, bytes] of [['first.txt', 'first exact attachment'], ['second.txt', 'second exact attachment']]) {
        await editor.getByLabel('Add attachment').setInputFiles({ name: filename!, mimeType: 'text/plain', buffer: Buffer.from(bytes!) });
      }
      await editor.getByRole('button', { name: 'Move attachment 3 up', exact: true }).click();
      await editor.getByLabel('Asset name', { exact: true }).nth(1).fill('Renamed second');
      const download = page.waitForEvent('download'); await editor.getByRole('button', { name: 'Download attachment 2', exact: true }).click();
      expect(await readFile((await (await download).path())!, 'utf8')).toBe('second exact attachment');
    }
    await editor.getByRole('button', { name: 'Character', exact: true }).click(); await editor.getByLabel('Description', { exact: true }).fill('Prompt and assets together');
    await editor.getByRole('button', { name: 'Assets', exact: true }).click();
    await expect(editor.getByLabel('Choose portrait')).toBeEnabled();
    if (profile === 'local') {
      await expect(page.getByRole('region', { name: 'Editor 2', exact: true }).getByRole('status')).toHaveText('No changes');
      await page.route('**/asset-revisions', (route) => route.abort('connectionfailed'));
      await editor.getByRole('button', { name: 'Save revision' }).click(); await expect(editor.getByRole('alert')).toContainText('Cannot reach the local API');
      await page.unroute('**/asset-revisions');
    }
    if (profile === 'hub') {
      await context.clearCookies(); await editor.getByRole('button', { name: 'Save revision' }).click();
      await expect(page.getByRole('heading', { name: 'Reconnect as Alice' })).toBeVisible();
      await page.getByLabel('Access key').fill(key); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(editor.getByRole('status')).toHaveText('Unsaved changes');
    }
    await editor.getByRole('button', { name: 'Save revision' }).click(); await expect(editor.getByRole('status')).toHaveText('Saved');
    await expect(editor.getByLabel('Choose portrait')).toBeEnabled();
    const portrait = page.waitForEvent('download'); await editor.getByRole('button', { name: 'Download portrait' }).click();
    expect(await readFile((await (await portrait).path())!)).toEqual(image);
    await expect.poll(() => editor.getByAltText('Draft portrait').evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(1);
    await editor.getByLabel('Choose portrait').scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('assets.png'), fullPage: false });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    let saved: Revision | undefined;
    if (cardUrl) {
      saved = (await (await page.request.get(cardUrl)).json()).revision;
      expect(saved!.sequence).toBe(2); expect(saved!.document).toMatchObject({ envelope: { keep: [null, 1] }, data: { description: 'Prompt and assets together', extensions: { vendor: { preserve: true } } } });
      const old = await page.request.get(`${cardUrl}/assets?revisionId=${initial.revision.id}`); expect((await old.json()).assets).toEqual([]);
      expect(await (await page.request.get(`${cardUrl}/original`)).text()).toBe(original);
    } else {
      const download = page.waitForEvent('download'); await editor.getByRole('button', { name: 'Download accepted original' }).click();
      expect(await readFile((await (await download).path())!, 'utf8')).toBe(original);
    }
    if (profile === 'local') {
      const second = page.getByRole('region', { name: 'Editor 2', exact: true }); await second.getByRole('button', { name: 'Assets', exact: true }).click();
      await expect(second.getByLabel('Choose portrait')).toBeEnabled(); await second.getByLabel('Choose portrait').setInputFiles({ name: 'stale.png', mimeType: 'image/png', buffer: image });
      await second.getByRole('button', { name: 'Save revision' }).click(); await expect(second.getByRole('alert')).toContainText('card has changed');
      await second.getByRole('button', { name: 'Discard changes' }).click(); await second.getByRole('button', { name: 'Confirm discard', exact: true }).click();
      await second.getByRole('button', { name: 'Close editor' }).click();
    }
    if (profile === 'local') {
      let release!: () => void, entered!: () => void, finished!: () => void;
      let intercepted = false;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const ended = new Promise<void>((resolve) => { finished = resolve; });
      const url = '**/asset?*path=portrait';
      await page.route(url, async (route) => {
        intercepted = true; entered();
        try { const response = await route.fetch(); await held; await route.fulfill({ response }); }
        catch { /* Replacing the draft portrait cancels this owned read. */ }
        finally { finished(); }
      });
      const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
      try {
        await editor.getByRole('button', { name: 'Basic Info', exact: true }).click();
        await editor.getByRole('button', { name: 'Assets', exact: true }).click(); await started;
        await editor.getByLabel('Choose portrait').setInputFiles({ name: 'pending.gif', mimeType: 'image/gif', buffer: gif });
        await expect.poll(() => editor.getByAltText('Draft portrait').evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(1);
      } finally { release(); if (intercepted) await ended; await page.unroute(url); }
      const pending = page.waitForEvent('download'); await editor.getByRole('button', { name: 'Download portrait' }).click();
      expect(await readFile((await (await pending).path())!)).toEqual(gif);
      // A removal confirmation cannot act on a different draft after discard.
      await editor.getByRole('button', { name: 'Remove portrait', exact: true }).click();
      await editor.getByRole('button', { name: 'Discard changes' }).click(); await editor.getByRole('button', { name: 'Confirm discard', exact: true }).click();
      await expect(editor.getByRole('button', { name: 'Confirm removal' })).toHaveCount(0);
    }
    if (profile === 'browser') {
      await page.reload(); await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: name });
      await page.getByRole('button', { name: `Open ${name}`, exact: true }).click();
      await editor.getByRole('button', { name: 'Assets', exact: true }).click();
      await expect(editor.getByLabel('Choose portrait')).toBeEnabled();
      await expect(editor.getByLabel('Asset name', { exact: true }).nth(1)).toHaveValue('Renamed second');
    }
    await editor.getByRole('button', { name: 'Remove portrait', exact: true }).click(); await editor.getByRole('button', { name: 'Confirm removal' }).click();
    await expect(editor.getByText('No portrait in this draft.', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Discard changes' }).click(); await editor.getByRole('button', { name: 'Confirm discard', exact: true }).click();
    await expect(editor.getByAltText('Draft portrait')).toBeVisible();
    await editor.getByLabel('Export format', { exact: true }).selectOption(v3 ? 'charx' : 'sillytavern-png');
    const exported = page.waitForEvent('download'); await editor.getByRole('button', { name: 'Download saved revision' }).click();
    const exportedDownload = await exported; expect(exportedDownload.suggestedFilename()).toBe(`character.${v3 ? 'charx' : 'png'}`);
    const exportedPath = (await exportedDownload.path())!;
    if (profile !== 'hub') await editor.getByRole('button', { name: 'Close editor' }).click();
    const reimportResponse = profile !== 'browser' ? page.waitForResponse((response) => response.url().endsWith('/imports')) : undefined;
    await page.getByLabel('Import a card').setInputFiles({ name: `roundtrip.${v3 ? 'charx' : 'png'}`, mimeType: 'application/octet-stream', buffer: await readFile(exportedPath) });
    const response = await reimportResponse;
    if (response) { const value = await response.json(); expect(value.revision.identity).toEqual(saved!.identity); }
    await editor.getByRole('button', { name: 'Assets', exact: true }).click(); await expect(editor.getByLabel('Choose portrait')).toBeEnabled();
    if (v3) {
      await expect(editor.getByLabel('Asset name', { exact: true }).nth(1)).toHaveValue('Renamed second');
      const download = page.waitForEvent('download'); await editor.getByRole('button', { name: 'Download attachment 2', exact: true }).click();
      expect(await readFile((await (await download).path())!, 'utf8')).toBe('second exact attachment');
      await editor.getByLabel('Replace attachment 2', { exact: true }).setInputFiles({ name: 'replacement.txt', mimeType: 'text/plain', buffer: Buffer.from('replacement bytes') });
      await editor.getByRole('button', { name: 'Save revision' }).click(); await expect(editor.getByRole('status')).toHaveText('Saved');
      await expect(editor.getByLabel('Choose portrait')).toBeEnabled();
      const replaced = page.waitForEvent('download'); await editor.getByRole('button', { name: 'Download attachment 2', exact: true }).click();
      expect(await readFile((await (await replaced).path())!, 'utf8')).toBe('replacement bytes');
    }
    await editor.getByRole('button', { name: 'Remove portrait', exact: true }).click(); await editor.getByRole('button', { name: 'Confirm removal' }).click();
    if (v3) for (let index = 0; index < 2; index++) {
      await editor.getByRole('button', { name: 'Remove attachment 1', exact: true }).click(); await editor.getByRole('button', { name: 'Confirm removal' }).click();
    }
    await editor.getByRole('button', { name: 'Save revision' }).click(); await expect(editor.getByRole('status')).toHaveText('Saved');
    await editor.getByLabel('Export format', { exact: true }).selectOption('json');
    const empty = page.waitForEvent('download'); await editor.getByRole('button', { name: 'Download saved revision' }).click();
    const document = JSON.parse(await readFile((await (await empty).path())!, 'utf8'));
    expect(document.data.assets ?? []).toEqual([]); expect(document.envelope).toEqual({ keep: [null, 1] });
    expect(document.data.extensions.foundry.lineage.operation).toBe('edit'); expect(errors).toEqual([]);
  });
}
