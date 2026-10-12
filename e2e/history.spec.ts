import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Revision } from '../packages/store/src/types.js';

for (const profile of ['local', 'browser', 'hub'] as const) {
  test(`${profile}: inspect saved history without replacing drafts, with safe save and conflict recovery`, async ({ page, context }, info) => {
    const origin = `http://127.0.0.1:${profile === 'local' ? 19310 : profile === 'browser' ? 19311 : 19312}`;
    const name = `History ${profile}`;
    const original = JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', futureEnvelope: [null, 7],
      data: { name, description: 'Original description', extensions: { foreign: { preserve: true } } } });
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    let key = '';
    if (profile === 'local') await page.getByRole('button', { name: 'Connect to local library' }).click();
    if (profile === 'hub') {
      key = JSON.parse(await readFile('runtime/e2e-hub-accounts.json', 'utf8')).Alice.key;
      await page.getByLabel('Access key').fill(key); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await page.getByLabel('New workspace', { exact: true }).fill(name);
    await page.getByRole('button', { name: 'Create workspace' }).click();
    const importedResponse = profile !== 'browser' ? page.waitForResponse((response) => response.url().endsWith('/imports')) : undefined;
    await page.getByLabel('Import a card').setInputFiles({ name: 'history.json', mimeType: 'application/json', buffer: Buffer.from(original) });
    const imported = await importedResponse;
    const importedValue = imported ? await imported.json() : null;
    const cardUrl = imported ? `${imported.url().replace(/\/imports$/, '')}/cards/${importedValue.card.id}` : '';
    const editor = page.getByRole('region', { name: profile === 'hub' ? 'Character editor' : 'Editor 1', exact: true });
    await editor.getByRole('button', { name: 'Character', exact: true }).click();
    await editor.getByLabel('Description', { exact: true }).fill('Second saved description');
    await editor.getByRole('button', { name: 'Save revision' }).click(); await expect(editor.getByRole('status')).toHaveText('Saved');
    await editor.getByLabel('Description', { exact: true }).fill('Keep my unsaved draft');
    await editor.getByRole('button', { name: 'History', exact: true }).click();
    const history = editor.getByRole('region', { name: 'History fields', exact: true });
    const change = history.getByRole('region', { name: 'Character / description', exact: true });
    await expect(change).toContainText('Second saved description'); await expect(change).toContainText('Keep my unsaved draft');
    await history.getByRole('button', { name: /^Revision 1 / }).click();
    await expect(change).toContainText('Original description');
    await expect(editor.getByRole('status')).toHaveText('Unsaved changes');
    await change.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('history-comparison.png'), fullPage: false });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (profile === 'local') {
      let release!: () => void, intercepted!: () => void, finished!: () => void;
      let hasEntered = false;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { intercepted = resolve; });
      const ended = new Promise<void>((resolve) => { finished = resolve; });
      const oldRevision = `**/revisions/${importedValue.revision.id}`;
      await page.route(oldRevision, async (route) => {
        hasEntered = true; intercepted();
        try { const response = await route.fetch(); await held; await route.fulfill({ response }); }
        catch { /* Refresh aborts this owned request. */ }
        finally { finished(); }
      });
      try {
        await history.getByRole('button', { name: /^Revision 1 / }).click(); await entered;
        await history.getByRole('button', { name: 'Refresh history' }).click();
        await expect(change).toContainText('Second saved description');
      } finally { release(); if (hasEntered) await ended; await page.unroute(oldRevision); }
      await expect(change).toContainText('Second saved description');
      await expect(history.getByRole('alert')).toHaveCount(0);
      let latest: Revision = (await (await page.request.get(cardUrl)).json()).revision;
      expect(latest.sequence).toBe(2);
      // An independent writer advances the head while this draft/history stays open.
      for (let index = 0; index < 20; index++) {
        const document = structuredClone(latest.document);
        (document.data as Record<string, unknown>).description = `Concurrent save ${index + 1}`;
        const response = await page.request.post(`${cardUrl}/revisions`, { headers: { origin }, data: { expectedHead: latest.id, document } });
        expect(response.status()).toBe(200); latest = await response.json();
      }
      await expect(history.getByText('History includes revisions through 2.')).toBeVisible();
      await history.getByRole('button', { name: 'Refresh history' }).click();
      await expect(history.getByText('A newer revision is saved.', { exact: false })).toBeVisible();
      await expect(change).toContainText('Concurrent save 20'); await expect(change).toContainText('Keep my unsaved draft');
      await history.getByRole('button', { name: 'Load more revisions' }).click();
      await expect(history.getByRole('button', { name: /^Revision 22 / })).toBeVisible();
      await expect(history.getByRole('button', { name: 'Load more revisions' })).toHaveCount(0);
      await editor.getByRole('button', { name: 'Save revision' }).click();
      await expect(editor.getByRole('alert')).toContainText('card has changed');
      expect((await (await page.request.get(cardUrl)).json()).revision.id).toBe(latest.id);
      await page.route('**/revisions?*', (route) => route.abort('connectionfailed'));
      await history.getByRole('button', { name: 'Refresh history' }).click();
      await expect(history.getByRole('alert')).toContainText('Cannot reach the local API');
      await page.unroute('**/revisions?*');
      await history.getByRole('button', { name: 'Refresh history' }).click();
      await expect(change).toContainText('Keep my unsaved draft');
      await editor.getByRole('button', { name: 'Discard changes' }).click();
      await editor.getByRole('button', { name: 'Confirm discard', exact: true }).click();
      await expect(change).toContainText('Second saved description');
      await editor.getByRole('button', { name: 'Close editor' }).click();
      await page.getByRole('button', { name: `Open ${name}`, exact: true }).click();
      await editor.getByRole('button', { name: 'History', exact: true }).click();
      await expect(history.getByText('No document changes.', { exact: true })).toBeVisible();
    } else {
      if (profile === 'hub') {
        await context.clearCookies();
        await history.getByRole('button', { name: 'Refresh history' }).click();
        await expect(page.getByRole('heading', { name: 'Reconnect as Alice' })).toBeVisible();
        await page.getByLabel('Access key').fill(key); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await expect(editor.getByRole('status')).toHaveText('Unsaved changes');
      }
      await editor.getByRole('button', { name: 'Save revision' }).click(); await expect(editor.getByRole('status')).toHaveText('Saved');
      await expect(history.getByRole('button', { name: /^Revision 3 / })).toBeVisible();
      await expect(history.getByText('No document changes.', { exact: true })).toBeVisible();
      await history.getByRole('button', { name: /^Revision 1 / }).click();
      await expect(change).toContainText('Original description'); await expect(change).toContainText('Keep my unsaved draft');
    }
    if (profile === 'hub') {
      const accepted = await page.request.get(`${cardUrl}/original`); expect(accepted.status()).toBe(200); expect(await accepted.text()).toBe(original);
    } else {
      const download = page.waitForEvent('download'); await editor.getByRole('button', { name: 'Download accepted original' }).click();
      expect(await readFile((await (await download).path())!, 'utf8')).toBe(original);
    }
    expect(errors).toEqual([]);
  });
}
