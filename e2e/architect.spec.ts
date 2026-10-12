import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const original = JSON.stringify({
  spec: 'chara_card_v3', spec_version: '3.0', futureEnvelope: { keep: [1, null, 'é'] },
  data: { name: 'Aster', description: 'A patient astronomer.', personality: '', scenario: '', first_mes: 'Good evening.',
    tags: ['quiet'], alternate_greetings: ['Hello'], group_only_greetings: [], source: [],
    character_book: { entries: [{ id: 1, keys: ['stars'], content: 'A distant observatory.', enabled: true, unknown: 'preserve' }] },
    extensions: { vendor: { opaque: true }, depth_prompt: { prompt: 'Listen carefully.', depth: 4, unknown: 'preserve' } },
  },
});
async function setup(page: Page, workspace: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Connect to local library' }).click();
  await page.getByLabel('New workspace', { exact: true }).fill(workspace);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByText('Your library is empty.')).toBeVisible();
}
async function importCard(page: Page, buffer = original) {
  await page.getByLabel('Import a card').setInputFiles({ name: 'étoile.json', mimeType: 'application/json', buffer: Buffer.from(buffer) });
  await expect(page.getByRole('region', { name: 'Editor 1', exact: true })).toBeVisible();
}

test('two isolated editors, all core fields, conflict recovery, exact originals and reload', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setup(page, 'Browser editing');
  await importCard(page);
  const first = page.getByRole('region', { name: 'Editor 1', exact: true });
  await page.getByRole('button', { name: 'Open Aster', exact: true }).click();
  const second = page.getByRole('region', { name: 'Editor 2', exact: true });
  await expect(second.getByLabel('Name', { exact: true })).toHaveValue('Aster');
  await first.getByLabel('Name', { exact: true }).fill('Aster, keeper of stars');
  await first.getByLabel('Nickname', { exact: true }).fill('Star');
  await first.getByRole('button', { name: 'Remove Tag 1' }).click();
  await first.getByRole('button', { name: 'Add Tag', exact: true }).click();
  await first.getByLabel('Tag 1', { exact: true }).fill('astronomer');
  await first.getByLabel('Creator', { exact: true }).fill('A creator');
  await first.getByLabel('Character Version', { exact: true }).fill('2.0');
  await first.getByLabel('Tagline / Short Description', { exact: true }).fill('A voice under the stars');
  await expect(second.getByLabel('Name', { exact: true })).toHaveValue('Aster');
  await page.getByRole('heading', { name: 'Room for a new story.' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('two-editors.png'), fullPage: false });
  await first.getByRole('button', { name: 'Character', exact: true }).click();
  await first.getByLabel('Description', { exact: true }).fill('A careful astronomer, charting an unfamiliar sky.');
  await first.getByLabel('Scenario', { exact: true }).fill('A mountain observatory.');
  await first.getByLabel('Personality', { exact: true }).fill('Thoughtful and curious.');
  await first.getByLabel('Appearance', { exact: true }).fill('A wool coat and silver glasses.');
  await first.getByRole('button', { name: 'Greetings', exact: true }).click();
  await first.getByLabel('First Message', { exact: true }).fill('Come and look through the telescope.');
  await first.getByRole('button', { name: 'Remove Greeting 1', exact: true }).click();
  await first.getByRole('button', { name: '+ Add Alternate Greeting', exact: true }).click();
  await first.getByLabel('Greeting 1', { exact: true }).fill('The sky is clear tonight.');
  await first.getByRole('button', { name: '+ Add Group Greeting', exact: true }).click();
  await first.getByLabel('Group Greeting 1', { exact: true }).fill('There is room for everyone.');
  await first.getByRole('button', { name: 'Advanced', exact: true }).click();
  for (const field of ['System Prompt', 'Post History Instructions', 'Example Messages', 'Creator Notes', 'Character Note']) {
    await first.getByLabel(field, { exact: true }).fill(`Edited ${field}`);
  }
  await first.getByLabel('Character Note Depth', { exact: true }).fill('6');
  await first.getByRole('button', { name: '+ Add Source URL', exact: true }).click();
  await first.getByLabel('Source URL 1', { exact: true }).fill('https://example.test/aster');
  await first.getByLabel('Language code', { exact: true }).fill('en');
  await first.getByRole('button', { name: 'Add Language', exact: true }).click();
  await first.getByLabel('Notes (en)', { exact: true }).fill('A translated note.');
  const saveResponse = page.waitForResponse((response) => response.url().endsWith('/revisions') && response.request().method() === 'POST');
  await first.getByRole('button', { name: 'Save revision' }).click();
  const saved = await (await saveResponse).json();
  await expect(first.getByRole('status')).toHaveText('Saved');
  expect(saved.document).toMatchObject({ futureEnvelope: { keep: [1, null, 'é'] }, data: {
    name: 'Aster, keeper of stars', tags: ['astronomer'], alternate_greetings: ['The sky is clear tonight.'],
    group_only_greetings: ['There is room for everyone.'], creator_notes_multilingual: { en: 'A translated note.' },
    character_book: JSON.parse(original).data.character_book,
    extensions: { vendor: { opaque: true }, depth_prompt: { prompt: 'Edited Character Note', depth: 6, unknown: 'preserve' },
      foundry: { lineage: { operation: 'edit', author: 'urn:unity:user:local' } } },
  } });
  await second.getByLabel('Name', { exact: true }).fill('A conflicting name');
  await second.getByRole('button', { name: 'Save revision' }).click();
  await expect(second.getByRole('alert')).toContainText('card has changed');
  await expect(second.getByLabel('Name', { exact: true })).toHaveValue('A conflicting name');
  await second.getByRole('button', { name: 'Discard changes' }).click();
  await second.getByRole('button', { name: 'Keep editing' }).click();
  await expect(second.getByLabel('Name', { exact: true })).toHaveValue('A conflicting name');
  await second.getByRole('button', { name: 'Discard changes' }).click();
  await second.getByRole('button', { name: 'Confirm discard' }).click();
  await second.getByRole('button', { name: 'Close editor' }).click();
  const downloadPromise = page.waitForEvent('download');
  await first.getByRole('button', { name: 'Download accepted original' }).click();
  const downloadPath = await (await downloadPromise).path();
  expect(downloadPath).not.toBeNull();
  expect(await readFile(downloadPath!, 'utf8')).toBe(original);
  await page.reload();
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: 'Browser editing' });
  await page.getByRole('button', { name: 'Open Aster, keeper of stars', exact: true }).click();
  await expect(first.getByLabel('Name', { exact: true })).toHaveValue('Aster, keeper of stars');
  await first.getByRole('button', { name: 'Character', exact: true }).click();
  await expect(first.getByLabel('Description', { exact: true })).toHaveValue('A careful astronomer, charting an unfamiliar sky.');
  await first.getByRole('button', { name: 'Close editor' }).click();
  await expect(page.getByRole('heading', { name: 'A character begins with a voice.' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('malformed imports, interrupted saves and discard-on-close preserve usable state', async ({ page, context }, info) => {
  await setup(page, 'Failure recovery');
  await page.getByLabel('Import a card').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Editor 1', exact: true })).toHaveCount(0);
  await importCard(page);
  const editor = page.getByRole('region', { name: 'Editor 1', exact: true });
  await editor.getByLabel('Name', { exact: true }).fill('Still here');
  await page.route('**/revisions', (route) => route.abort('connectionfailed'));
  await editor.getByRole('button', { name: 'Save revision' }).click();
  await expect(editor.getByRole('alert')).toContainText('Cannot reach the local API');
  await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Still here');
  await page.screenshot({ path: info.outputPath('failed-save.png'), fullPage: false });
  await page.unroute('**/revisions');
  await context.clearCookies();
  await editor.getByRole('button', { name: 'Save revision' }).click();
  await expect(editor.getByRole('alert')).toContainText('Connect to this workspace first');
  await page.getByRole('button', { name: 'Reconnect session', exact: true }).click();
  await expect(page.getByText('Local session reconnected. Your open drafts are unchanged.')).toBeVisible();
  await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Still here');
  await editor.getByRole('button', { name: 'Save revision' }).click();
  await expect(editor.getByRole('status')).toHaveText('Saved');
  await editor.getByLabel('Name', { exact: true }).fill('Unsaved');
  await editor.getByRole('button', { name: 'Close editor' }).click();
  await editor.getByRole('button', { name: 'Keep editing' }).click();
  await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Unsaved');
  await editor.getByRole('button', { name: 'Close editor' }).click();
  await editor.getByRole('button', { name: 'Discard and close' }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Open Still here', exact: true }).click();
  await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Still here');
});

test('mobile CCv2 form preserves incompatible fields and fits the viewport', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Connect to local library' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('mobile-welcome.png'), fullPage: false });
  await setup(page, 'Mobile CCv2');
  await importCard(page, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Aster', creator: null, extensions: { depth_prompt: 'opaque' } } }));
  const editor = page.getByRole('region', { name: 'Editor 1', exact: true });
  await expect(editor.getByText('Creator has a value this form cannot edit.')).toBeVisible();
  await editor.getByLabel('Name', { exact: true }).fill('Aster mobile');
  await editor.getByRole('button', { name: 'Greetings', exact: true }).click();
  await expect(editor.getByRole('group', { name: 'Group Only Greetings' })).toHaveCount(0);
  await editor.getByRole('button', { name: 'Advanced', exact: true }).click();
  await expect(editor.getByText('Character Note has a value this form cannot edit.')).toBeVisible();
  await editor.getByRole('button', { name: 'Basic Info', exact: true }).click();
  await editor.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('mobile-editor.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const responsePromise = page.waitForResponse((response) => response.url().endsWith('/revisions'));
  await editor.getByRole('button', { name: 'Save revision' }).click();
  const revision = await (await responsePromise).json();
  expect(revision.document.data).toMatchObject({ creator: null, extensions: { depth_prompt: 'opaque' } });
});
