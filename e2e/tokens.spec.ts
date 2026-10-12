import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

for (const profile of ['local', 'browser', 'hub'] as const) {
  test(`${profile}: count draft text locally with separate greetings, failure recovery and unchanged originals`, async ({ page }, info) => {
    const name = `Tokens ${profile}`, origin = `http://127.0.0.1:${profile === 'local' ? 19310 : profile === 'browser' ? 19311 : 19312}`;
    const original = JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name, description: 'Hello world!',
      alternate_greetings: ['😀 café', 'お誕生日おめでとう'], character_book: { entries: [
        { id: 1, content: 'Hello world!', keys: ['one'], enabled: true },
        { id: 2, content: '😀 café', keys: ['two'] }, { id: 3, content: 'Never include this entry', enabled: false },
      ] }, extensions: { unknown: { retained: true } } } });
    const errors: string[] = [], workerRequests: string[] = [], tokenizeRequests: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (request.url().includes('/assets/tokenizer.worker-')) workerRequests.push(request.url());
      if (/\/api\/.*token/.test(request.url())) tokenizeRequests.push(request.url());
    });
    await page.goto(origin);
    if (profile === 'local') await page.getByRole('button', { name: 'Connect to local library' }).click();
    if (profile === 'hub') {
      const key = JSON.parse(await readFile('runtime/e2e-hub-accounts.json', 'utf8')).Alice.key;
      await page.getByLabel('Access key').fill(key); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await page.getByLabel('New workspace', { exact: true }).fill(name); await page.getByRole('button', { name: 'Create workspace' }).click();
    const imported = profile === 'hub' ? page.waitForResponse((response) => response.url().endsWith('/imports')) : undefined;
    await page.getByLabel('Import a card').setInputFiles({ name: 'tokens.json', mimeType: 'application/json', buffer: Buffer.from(original) });
    const response = await imported, result = response ? await response.json() : undefined;
    const editor = page.getByRole('region', { name: profile === 'hub' ? 'Character editor' : 'Editor 1', exact: true });
    await expect(editor.getByRole('button', { name: 'Tokens', exact: true })).toBeVisible();
    expect(workerRequests).toEqual([]); // The 2 MB vocabulary is not part of initial page loading.
    if (profile === 'browser') await page.route('**/assets/tokenizer.worker-*.js', (route) => route.abort());
    await editor.getByRole('button', { name: 'Tokens', exact: true }).click();
    const panel = editor.getByRole('region', { name: 'Tokens fields', exact: true });
    if (profile === 'browser') {
      await expect(panel.getByRole('alert')).toContainText('could not load');
      await page.unroute('**/assets/tokenizer.worker-*.js');
      await panel.getByRole('button', { name: 'Retry token count' }).click();
    }
    const row = (label: string) => panel.getByRole('row').filter({ has: page.getByRole('rowheader', { name: label, exact: true }) }).getByRole('cell');
    await expect(row('Description')).toHaveText('3');
    await expect(row('Alternate Greetings')).toHaveText('10');
    await expect(row('Enabled lorebook entries')).toHaveText('5');
    await expect(panel).toContainText('1 disabled lorebook entry excluded');
    await expect(editor.getByRole('status')).toHaveText('No changes');
    expect(workerRequests.length).toBeGreaterThan(0); expect(tokenizeRequests).toEqual([]);
    await editor.getByRole('button', { name: 'Character', exact: true }).click();
    await editor.getByLabel('Description', { exact: true }).fill('<|endoftext|>');
    await editor.getByRole('button', { name: 'Tokens', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('Reserved token markers');
    await expect(panel.getByRole('table')).toHaveCount(0);
    await expect(editor.getByRole('status')).toHaveText('Unsaved changes');
    await editor.getByRole('button', { name: 'Character', exact: true }).click();
    await expect(editor.getByLabel('Description', { exact: true })).toHaveValue('<|endoftext|>');
    await editor.getByLabel('Description', { exact: true }).fill('😀 café');
    await editor.getByRole('button', { name: 'Tokens', exact: true }).click();
    await expect(row('Description')).toHaveText('2');
    await editor.getByRole('button', { name: 'Save revision' }).click();
    await expect(editor.getByRole('status')).toHaveText('Saved'); await expect(row('Description')).toHaveText('2');
    if (profile === 'local') {
      const other = JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Second tokenizer', description: 'お誕生日おめでとう' } });
      await page.getByLabel('Import a card').setInputFiles({ name: 'second.json', mimeType: 'application/json', buffer: Buffer.from(other) });
      const second = page.getByRole('region', { name: 'Editor 2', exact: true });
      await second.getByRole('button', { name: 'Tokens', exact: true }).click();
      await expect(second.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Description', exact: true }) }).getByRole('cell')).toHaveText('8');
      await expect(row('Description')).toHaveText('2');
    }
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('text-token-counts.png'), fullPage: false });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (profile !== 'hub') {
      const download = page.waitForEvent('download'); await editor.getByRole('button', { name: 'Download accepted original' }).click();
      expect(await readFile((await (await download).path())!, 'utf8')).toBe(original);
    } else {
      const accepted = await page.request.get(`${response!.url().replace(/\/imports$/, '')}/cards/${result.card.id}/original`);
      expect(accepted.status()).toBe(200); expect(await accepted.text()).toBe(original);
    }
    await page.reload();
    await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: name });
    await page.getByRole('button', { name: `${profile === 'hub' ? 'Edit' : 'Open'} ${name}`, exact: true }).click();
    await editor.getByRole('button', { name: 'Tokens', exact: true }).click();
    await expect(row('Description')).toHaveText('2');
    await expect(row('Alternate Greetings')).toHaveText('10');
    expect(errors).toEqual([]); expect(tokenizeRequests).toEqual([]);
  });
}
