import type { Page } from '@playwright/test';
import { test, expect, save, download, screenshot, type Imported } from './fixtures';

async function importDocument(page: Page, document: Record<string, unknown>) {
  const name = (document.data as { name: string }).name;
  const bytes = Buffer.from(JSON.stringify(document));
  await page.goto('/');
  const pending = page.waitForResponse(response => response.url().endsWith('/imports') && response.request().method() === 'POST');
  const choosing = page.waitForEvent('filechooser');
  await page.getByTitle('Import card files').click();
  await (await choosing).setFiles({ name: 'core-fields.json', mimeType: 'application/json', buffer: bytes });
  const response = await pending;
  expect(response.status(), await response.text()).toBe(201);
  const imported: Imported = await response.json();
  await expect(page.getByRole('status').filter({ hasText: 'Imported 1 card' })).toBeVisible();
  await page.getByRole('button', { name: `Quick view ${name}`, exact: true }).click();
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(name);
  return { imported, bytes, path: `/api/workspaces/${imported.card.workspaceId}/cards/${imported.card.id}` };
}

test('native core fields edit one wrapped document while preserving books, unknown fields and accepted bytes', async ({ page }, info) => {
  const document = { spec: 'chara_card_v3', spec_version: '3.0', futureEnvelope: { keep: [1, null, 'é'] }, data: {
    name: 'Native core Aster', description: 'A patient astronomer.', personality: '', scenario: '', first_mes: 'Good evening.',
    tags: ['quiet'], alternate_greetings: ['Hello'], group_only_greetings: [], source: [],
    character_book: { entries: [{ id: 1, keys: ['stars'], content: 'A distant observatory.', enabled: true, unknown: 'preserve' }] },
    extensions: { vendor: { opaque: [0, false] }, depth_prompt: { prompt: 'Listen carefully.', depth: 4, role: 'assistant', unknown: 'preserve' } },
  } };
  const { bytes, path } = await importDocument(page, document);
  await page.getByLabel('Name', { exact: true }).fill('Native Aster, keeper of stars');
  await page.getByLabel('Nickname', { exact: true }).fill('Star');
  await page.getByRole('button', { name: 'Remove quiet', exact: true }).click();
  await page.getByLabel('Tags', { exact: true }).fill('astronomer');
  await page.getByLabel('Tags', { exact: true }).press('Enter');
  await page.getByLabel('Creator', { exact: true }).fill('A creator');
  await page.getByLabel('Character Version', { exact: true }).fill('2.0');
  await page.getByLabel('Tagline / Short Description', { exact: true }).fill('A voice under the stars');
  await page.getByRole('button', { name: 'Character', exact: true }).click();
  await page.getByLabel('Description', { exact: true }).fill('A careful astronomer, charting an unfamiliar sky.');
  await page.getByLabel('Scenario', { exact: true }).fill('A mountain observatory.');
  await page.getByLabel('Personality', { exact: true }).fill('Thoughtful and curious.');
  await page.getByLabel('Appearance', { exact: true }).fill('A wool coat and silver glasses.');
  await page.getByRole('button', { name: 'Greetings', exact: true }).click();
  await page.getByLabel('First Message', { exact: true }).fill('Come and look through the telescope.');
  page.once('dialog', dialog => dialog.accept());
  await page.getByTitle('Delete greeting', { exact: true }).click();
  await page.getByRole('button', { name: '+ Add Alternate Greeting', exact: true }).click();
  await page.getByLabel('Greeting 1', { exact: true }).fill('The sky is clear tonight.');
  await page.getByRole('button', { name: '+ Add Group Greeting', exact: true }).click();
  await page.getByLabel('Group Greeting 1', { exact: true }).fill('There is room for everyone.');
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  for (const label of ['System Prompt', 'Post History Instructions', 'Example Messages', 'Creator Notes', 'Character Note']) {
    await page.getByLabel(label, { exact: true }).fill(`Edited ${label}`);
  }
  await page.getByLabel('Character Note Depth', { exact: true }).fill('0');
  await expect(page.getByLabel('Character Note Depth', { exact: true })).toHaveValue('0');
  await page.getByRole('button', { name: '+ Add Source URL', exact: true }).click();
  await page.getByLabel('Source URL 1', { exact: true }).fill('https://example.test/aster');
  await page.getByRole('button', { name: '+ Add Language', exact: true }).click();
  await page.getByLabel('Language code (xx)', { exact: true }).fill('en');
  await page.getByLabel('Multilingual Creator Notes (en)', { exact: true }).fill('A translated note.');
  await save(page);
  const accepted = await (await page.request.get(path)).json();
  expect(accepted.revision.document).toMatchObject({ futureEnvelope: document.futureEnvelope, data: {
    name: 'Native Aster, keeper of stars', nickname: 'Star', tags: ['astronomer'], creator: 'A creator', character_version: '2.0',
    description: 'A careful astronomer, charting an unfamiliar sky.', personality: 'Thoughtful and curious.', scenario: 'A mountain observatory.',
    first_mes: 'Come and look through the telescope.', alternate_greetings: ['The sky is clear tonight.'], group_only_greetings: ['There is room for everyone.'],
    system_prompt: 'Edited System Prompt', post_history_instructions: 'Edited Post History Instructions', mes_example: 'Edited Example Messages',
    creator_notes: 'Edited Creator Notes', creator_notes_multilingual: { en: 'A translated note.' }, source: ['https://example.test/aster'],
    character_book: document.data.character_book,
    extensions: { vendor: document.data.extensions.vendor, visual_description: 'A wool coat and silver glasses.', tagline: 'A voice under the stars',
      depth_prompt: { prompt: 'Edited Character Note', depth: 0, role: 'assistant', unknown: 'preserve' } },
  } });
  expect(accepted.revision.document).not.toHaveProperty('description');
  await page.reload();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await expect(page.getByLabel('Character Note Depth', { exact: true })).toHaveValue('0');
  await page.getByLabel('Character Note Depth', { exact: true }).scrollIntoViewIfNeeded();
  await screenshot(page, info, 'native-core-fields-desktop');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  expect(await download(page, 'Download original')).toEqual(bytes);
});

for (const spec of ['v2', 'v3'] as const) {
  test(`native mobile ${spec} keeps opaque optional fields read-only across core, focused, preview and Save`, async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const document = { spec: spec === 'v2' ? 'chara_card_v2' : 'chara_card_v3', spec_version: spec === 'v2' ? '2.0' : '3.0',
      futureEnvelope: { keep: [0, false] }, data: { name: `Opaque native ${spec}`, description: 'Editable text', creator: null,
        personality: false, scenario: 0, alternate_greetings: { foreign: [false, 0] }, group_only_greetings: ['valid', false],
        source: false, creator_notes_multilingual: { en: 0 },
        extensions: { depth_prompt: 'opaque', voxta: false, tagline: 0, vendor: { keep: [false, 0] } },
      } };
    const { path, bytes } = await importDocument(page, document);
    await expect(page.getByRole('region', { name: 'Creator preserved value', exact: true })).toContainText('Creator has a value this form cannot edit.');
    await expect(page.getByLabel('Creator', { exact: true })).toHaveCount(0);
    await page.getByLabel('Name', { exact: true }).fill(`Edited opaque native ${spec}`);
    await page.getByRole('button', { name: 'Character', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Personality preserved value', exact: true })).toContainText('false');
    await expect(page.getByRole('region', { name: 'Scenario preserved value', exact: true })).toContainText('0');
    await expect(page.getByRole('region', { name: 'Appearance preserved value', exact: true })).toContainText('false');
    await page.getByLabel('Description', { exact: true }).fill('Edited safely');
    await page.getByRole('button', { name: 'Greetings', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Alternate Greetings preserved value', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ Add Alternate Greeting', exact: true })).toHaveCount(0);
    if (spec === 'v2') await expect(page.getByText('Group Only Greetings', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Advanced', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Character Note preserved value', exact: true })).toContainText('"opaque"');
    await expect(page.getByRole('region', { name: 'Character Note Depth preserved value', exact: true })).toContainText('"opaque"');
    await page.getByRole('region', { name: 'Character Note preserved value', exact: true }).scrollIntoViewIfNeeded();
    await screenshot(page, info, `native-opaque-${spec}-advanced-mobile`);
    await page.getByRole('button', { name: 'Focused', exact: true }).click();
    await page.getByRole('button', { name: 'Scenario', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Scenario preserved value', exact: true })).toContainText('0');
    await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Greetings', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Alternate Greetings preserved value', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ Add Alt', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Alternate Greetings preserved value', exact: true })).toContainText('foreign');
    await expect(page.getByRole('region', { name: 'Personality preserved value', exact: true })).toContainText('false');
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await screenshot(page, info, `native-opaque-${spec}-preview-mobile`);
    await save(page);
    const accepted = await (await page.request.get(path)).json();
    expect(accepted.revision.document).toMatchObject({ ...document, data: { ...document.data, name: `Edited opaque native ${spec}`, description: 'Edited safely' } });
    expect(accepted.revision.document).not.toHaveProperty('description');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    expect(await download(page, 'Download original')).toEqual(bytes);
  });
}

test('native wizard and writing tools visibly preserve unsupported fields at generation and Apply', async ({ page }, info) => {
  const document = { spec: 'chara_card_v3', spec_version: '3.0', data: {
    name: 'Opaque wizard tools', description: 'Editable description', scenario: false, personality: 0,
    extensions: { voxta: { appearance: 0, vendor: false }, vendor: [false, 0] },
  } };
  const { path } = await importDocument(page, document);
  for (const name of ['Local tools', 'Wizard'] as const) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await dialog.getByRole('tab', { name: 'Editors', exact: true }).click();
    await dialog.getByRole('tab', { name, exact: true }).click();
    await dialog.getByRole('switch', { name: `Enable ${name === 'Wizard' ? 'wwwyzzerdd' : name}`, exact: true }).check();
    await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('tab', { name: 'AI', exact: true }).click();
  await dialog.getByRole('button', { name: '+ Add Provider', exact: true }).click();
  await dialog.getByPlaceholder('My Provider', { exact: true }).fill('Opaque fields QA');
  await dialog.getByRole('combobox').first().selectOption('openai-compatible');
  await dialog.getByPlaceholder('https://api.openai.com', { exact: true }).fill('http://127.0.0.1:1234/v1');
  await dialog.getByPlaceholder('gpt-4, claude-3-opus, etc.', { exact: true }).fill('fixture');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
  let requests = 0;
  await page.route('http://127.0.0.1:1234/v1/chat/completions', async route => {
    requests++;
    expect(route.request().postDataJSON().messages[0].content).toContain('unsupported value preserved; do not propose changes');
    await route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      json: { choices: [{ message: { content: '{"name":"Wizard preserved proof","scenario":"Unsafe replacement","personality":"Unsafe replacement","appearance":"Unsafe replacement"}' } }] } });
  });
  await page.getByRole('button', { name: 'wwwyzzerdd', exact: true }).click();
  for (const label of ['Scenario', 'Personality', 'Appearance']) {
    await expect(page.getByRole('region', { name: `${label} preserved value`, exact: true })).toBeVisible();
    await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  }
  await page.getByPlaceholder('Describe your character or ask for suggestions...', { exact: true }).fill('Suggest updates without replacing unsupported values');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'were excluded from the proposal' })).toBeVisible();
  await page.getByRole('button', { name: 'Apply to Card', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Wizard preserved proof');
  await page.getByRole('region', { name: 'Scenario preserved value', exact: true }).scrollIntoViewIfNeeded();
  await screenshot(page, info, 'native-wizard-preserved-values-desktop');
  await page.getByRole('button', { name: 'Local tools', exact: true }).click();
  await page.getByLabel('Field to optimize', { exact: true }).selectOption('scenario');
  await expect(page.getByRole('region', { name: 'Scenario preserved value', exact: true })).toContainText('false');
  await page.getByRole('button', { name: 'Propose optimized text', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Scenario has a value this form cannot edit.');
  expect(requests).toBe(1);
  await screenshot(page, info, 'native-tools-preserved-value-desktop');
  await save(page);
  const accepted = await (await page.request.get(path)).json();
  expect(accepted.revision.document).toMatchObject({ ...document, data: { ...document.data, name: 'Wizard preserved proof' } });
});
