import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

for (const profile of ['local', 'browser', 'hub'] as const) {
  test(`${profile}: lorebooks preserve duplicate IDs and opaque data through edit, save, export and reload`, async ({ page }, info) => {
    const origin = `http://127.0.0.1:${profile === 'local' ? 19310 : profile === 'browser' ? 19311 : 19312}`;
    const name = `Lorebook ${profile}`;
    const book = { name: 'Places', description: 'Original lorebook', extensions: { vendor: [1, null] }, futureBook: { keep: true }, entries: [
      { id: 9, name: 'Observatory', content: 'Under the stars.', keys: ['sky, moon', ''], enabled: true, insertion_order: 10, comment: null,
        extensions: { vendor: { preserve: true } } },
      { id: 9, name: 'Forest', content: 'Deep in the woods.', enabled: true, insertion_order: 20, position: 0, opaque: ['keep'] },
      { name: 'Without ID', content: 'An untouched entry.', enabled: false, insertion_order: 30 },
    ] };
    const original = JSON.stringify({ spec: profile === 'local' ? 'chara_card_v2' : 'chara_card_v3', spec_version: profile === 'local' ? '2.0' : '3.0',
      futureEnvelope: ['keep'], data: { name, character_book: book, extensions: { foreign: { keep: true } } } });
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    if (profile === 'hub') await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin);
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
    await page.getByLabel('Import a card').setInputFiles({ name: 'lorebook.json', mimeType: 'application/json', buffer: Buffer.from(original) });
    const imported = await importResponse;
    const originalUrl = imported ? `${imported.url().replace(/\/imports$/, '')}/cards/${(await imported.json()).card.id}/original` : undefined;
    const editor = page.getByRole('region', { name: profile === 'hub' ? 'Character editor' : 'Editor 1', exact: true });
    if (profile === 'local') {
      await page.getByRole('button', { name: `Open ${name}`, exact: true }).click();
      const second = page.getByRole('region', { name: 'Editor 2', exact: true });
      await second.getByRole('button', { name: 'Lorebook', exact: true }).click();
      await second.getByRole('button', { name: '1. Observatory', exact: true }).click();
    }
    await editor.getByRole('button', { name: 'Lorebook', exact: true }).click();
    await expect(editor.getByRole('status')).toHaveText('No changes');
    await editor.getByText('Lorebook settings', { exact: true }).filter({ visible: true }).click();
    await editor.getByLabel('Token budget', { exact: true }).fill('0');
    await editor.getByLabel('Scan depth', { exact: true }).fill('0');
    await editor.getByLabel('Recursive scanning', { exact: true }).selectOption({ label: 'Yes' });
    await editor.getByRole('button', { name: '1. Observatory', exact: true }).click();
    await expect(editor.getByLabel('Primary keys 1', { exact: true })).toHaveValue('sky, moon');
    await editor.getByRole('button', { name: 'Add secondary keys', exact: true }).click();
    await editor.getByLabel('Secondary keys 1', { exact: true }).fill('sun, stars');
    await editor.getByLabel('Entry content', { exact: true }).fill('An edited observatory.');
    await editor.getByLabel('Entry comment', { exact: true }).fill('Explicit comment');
    await editor.getByLabel('Probability (%)', { exact: true }).fill('0');
    await editor.getByLabel('Weight / group weight', { exact: true }).fill('0');
    const priority = editor.getByLabel('Priority', { exact: true });
    await priority.fill('-');
    await expect(priority).toHaveValue('-');
    await priority.pressSequentially('5');
    await expect(priority).toHaveValue('-5');
    await editor.getByLabel('Enabled', { exact: true }).selectOption({ label: 'No' });
    await editor.getByLabel('Find lorebook entries').fill('Forest');
    await expect(editor.getByRole('group', { name: 'Lorebook entries', exact: true }).getByRole('button')).toHaveCount(1);
    await editor.getByRole('button', { name: '2. Forest', exact: true }).click();
    await expect(editor.getByText('Position has a value this form cannot edit.')).toBeVisible();
    await editor.getByLabel('Entry content', { exact: true }).fill('Only the second duplicate ID changes.');
    await editor.getByRole('button', { name: 'Copy entry', exact: true }).click();
    await expect(editor.getByLabel('Entry name', { exact: true })).toHaveValue('Forest (copy)');
    await editor.getByRole('button', { name: 'Move earlier', exact: true }).click();
    await editor.getByRole('button', { name: 'Delete entry', exact: true }).click();
    await editor.getByRole('button', { name: 'Keep entry', exact: true }).click();
    await expect(editor.getByLabel('Entry name', { exact: true })).toHaveValue('Forest (copy)');
    await editor.getByRole('button', { name: 'Delete entry', exact: true }).click();
    await editor.getByRole('button', { name: 'Confirm delete entry', exact: true }).click();
    await editor.getByRole('button', { name: 'Add entry', exact: true }).click();
    await editor.getByLabel('Entry name', { exact: true }).fill('New lore');
    await editor.getByLabel('Entry content', { exact: true }).fill('A new place.');
    await editor.getByRole('button', { name: 'Move earlier', exact: true }).click();
    await expect(editor.getByLabel('Insertion order', { exact: true })).toHaveValue('31');
    if (profile === 'local') {
      const second = page.getByRole('region', { name: 'Editor 2', exact: true });
      await expect(second.getByLabel('Entry content', { exact: true })).toHaveValue('Under the stars.');
      await expect(second.getByRole('status')).toHaveText('No changes');
      await page.route('**/revisions', (route) => route.abort('connectionfailed'));
      await editor.getByRole('button', { name: 'Save revision' }).click();
      await expect(editor.getByRole('alert')).toContainText('Cannot reach the local API');
      await expect(editor.getByLabel('Entry content', { exact: true })).toHaveValue('A new place.');
      await page.unroute('**/revisions');
    }
    await editor.getByRole('button', { name: 'Save revision' }).click();
    await expect(editor.getByRole('status')).toHaveText('Saved');
    await editor.getByRole('button', { name: '3. New lore', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('lorebook.png'), fullPage: false });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await editor.getByLabel('Export format', { exact: true }).selectOption('json');
    const exported = page.waitForEvent('download');
    await editor.getByRole('button', { name: 'Download saved revision' }).click();
    const document = JSON.parse(await readFile((await (await exported).path())!, 'utf8'));
    expect(document.data.character_book).toEqual({ ...book, token_budget: 0, scan_depth: 0, recursive_scanning: true, entries: [
      { ...book.entries[0], content: 'An edited observatory.', comment: 'Explicit comment', secondary_keys: ['sun, stars'], enabled: false, probability: 0, priority: -5,
        extensions: { vendor: { preserve: true }, weight: 0 } },
      { ...book.entries[1], content: 'Only the second duplicate ID changes.' },
      { id: 0, name: 'New lore', keys: [], content: 'A new place.', enabled: true, insertion_order: 31, extensions: {} },
      book.entries[2],
    ] });
    expect(document.futureEnvelope).toEqual(['keep']);
    expect(document.data.extensions.foreign).toEqual({ keep: true });
    expect(document.data.extensions.foundry.lineage.operation).toBe('edit');
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
    await editor.getByRole('button', { name: '1. Observatory Disabled', exact: true }).click();
    await expect(editor.getByLabel('Entry content', { exact: true })).toHaveValue('An edited observatory.');
    await editor.getByRole('button', { name: '2. Forest', exact: true }).click();
    await expect(editor.getByLabel('Entry content', { exact: true })).toHaveValue('Only the second duplicate ID changes.');
    await editor.getByLabel('Entry content', { exact: true }).fill('Discard this lorebook edit.');
    await editor.getByRole('button', { name: 'Discard changes' }).click();
    await editor.getByRole('button', { name: 'Confirm discard', exact: true }).click();
    await expect(editor.getByLabel('Entry content', { exact: true })).toHaveValue('Only the second duplicate ID changes.');
    expect(errors).toEqual([]);
  });
}
