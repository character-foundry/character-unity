import type { Page } from '@playwright/test';
import { expect, importCard, save, screenshot, test } from './fixtures.js';

// QA inventory: local-only opt-in tools, real Archive/Lance context reads,
// deterministic provider proposals and explicit apply/save; owned ComfyUI
// workflow/image review/staging; wizard editable local prompt set and cancellation.
// Negative cases: no provider, late cancellation, unsafe model fields, invalid
// image bytes. Screenshots cover desktop and mobile post-interaction states.
const model = 'http://127.0.0.1:1234/v1/chat/completions';
async function settings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  return page.getByRole('dialog', { name: 'Settings', exact: true });
}
async function enable(page: Page, name: 'Local tools' | 'Wizard') {
  const dialog = await settings(page);
  await dialog.getByRole('tab', { name: 'Editors', exact: true }).click();
  await dialog.getByRole('tab', { name, exact: true }).click();
  await dialog.getByRole('switch', { name: `Enable ${name === 'Wizard' ? 'wwwyzzerdd' : name}`, exact: true }).check();
  await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
}
async function provider(page: Page) {
  const dialog = await settings(page);
  await dialog.getByRole('tab', { name: 'AI', exact: true }).click();
  await dialog.getByRole('button', { name: '+ Add Provider', exact: true }).click();
  await dialog.getByPlaceholder('My Provider', { exact: true }).fill('Deterministic local QA');
  await dialog.getByRole('combobox').first().selectOption('openai-compatible');
  await dialog.getByPlaceholder('https://api.openai.com', { exact: true }).fill('http://127.0.0.1:1234/v1');
  await dialog.getByPlaceholder('gpt-4, claude-3-opus, etc.', { exact: true }).fill('deterministic-fixture');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
}
const fit = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

test('local tools retrieve real Archive context and review AI writing/names without saving until asked', async ({ page }, info) => {
  const imported = await importCard(page, 'Native local tools', 'json'); await enable(page, 'Local tools');
  await page.getByRole('button', { name: 'Local tools', exact: true }).click();
  await page.getByRole('button', { name: 'Propose optimized text', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Configure a browser AI provider');
  await provider(page);
  const requests: Record<string, unknown>[] = [];
  await page.route(model, async (route) => {
    const input = route.request().postDataJSON() as { messages: { content: string }[] }; requests.push(input);
    const names = input.messages[0]!.content.includes('character names');
    await route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      json: { choices: [{ message: { content: names ? '["Cedar", "Birch"]' : 'Reviewed native prose with the original facts.' } }] } });
  });
  await page.getByLabel('Context query', { exact: true }).fill('silver forest');
  await page.getByRole('button', { name: 'Retrieve context', exact: true }).click();
  const context = page.getByRole('article').filter({ hasText: 'historical version three' }).getByRole('checkbox');
  await expect(context).toBeVisible(); await context.check();
  await page.getByLabel('Generation guidance', { exact: true }).fill('Make the prose concise.');
  await page.getByRole('button', { name: 'Propose optimized text', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Review generated text', exact: true })).toContainText('Reviewed native prose');
  expect(JSON.stringify(requests[0])).toContain('silver forest');
  expect((await (await page.request.get(imported.path)).json()).revision.document.data.description).toBe('Original description');
  await fit(page); await screenshot(page, info, 'native-local-tools-desktop-reviewed-rag-writing');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { name: 'Local tools', exact: true }).scrollIntoViewIfNeeded(); await fit(page);
  await screenshot(page, info, 'native-local-tools-mobile-context');
  await page.getByRole('region', { name: 'Review generated text', exact: true }).scrollIntoViewIfNeeded();
  await screenshot(page, info, 'native-local-tools-mobile-reviewed-writing');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Apply reviewed text', exact: true }).click();
  await page.getByRole('button', { name: 'Generate names', exact: true }).click();
  await page.getByRole('button', { name: 'Use name Cedar', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Cedar');
  await page.getByRole('button', { name: 'Character', exact: true }).click();
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Reviewed native prose with the original facts.');
  expect((await (await page.request.get(imported.path)).json()).revision.document.data.name).toBe('Native local tools');
  await save(page);
});

test('ComfyUI uses an explicit owned workflow and verifies/reviews exact PNG bytes before staging and Save', async ({ page }, info) => {
  const imported = await importCard(page, 'Native ComfyUI portrait', 'json'); await enable(page, 'Local tools');
  await page.getByRole('button', { name: 'Local tools', exact: true }).click();
  // A browser-encoded raster, not the old permissive-parser PNG fixture. This
  // stages only external fixture bytes; all signoff actions use visible controls.
  const png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 160;
    const context = canvas.getContext('2d')!, gradient = context.createLinearGradient(0, 0, 128, 160);
    gradient.addColorStop(0, '#9333ea'); gradient.addColorStop(1, '#2563eb'); context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 160); return canvas.toDataURL('image/png').split(',')[1]!;
  }), 'base64');
  const calls: string[] = [];
  let invalid = true;
  await page.route('http://127.0.0.1:8188/**', async (route) => {
    const request = route.request(), url = new URL(request.url()); calls.push(url.pathname);
    expect(request.headers()['x-unity-actor']).toBeUndefined(); expect(request.headers().cookie).toBeUndefined();
    const headers = { 'access-control-allow-origin': '*' };
    if (url.pathname === '/prompt') {
      expect(request.postDataJSON().prompt).toEqual({ '1': { class_type: 'SaveImage', inputs: {} } });
      await route.fulfill({ contentType: 'application/json', headers, json: { prompt_id: 'qa-owned-job' } });
    } else if (url.pathname.startsWith('/history/')) {
      expect(url.pathname).toBe('/history/qa-owned-job');
      await route.fulfill({ contentType: 'application/json', headers, json: { 'qa-owned-job': { status: { completed: true },
        outputs: { '1': { images: [{ filename: 'portrait.png', subfolder: '', type: 'output' }] } } } } });
    } else {
      expect(url.pathname).toBe('/view'); expect(url.searchParams.get('filename')).toBe('portrait.png');
      await route.fulfill({ contentType: 'text/html', headers, body: invalid ? '<svg>not a raster</svg>' : png });
    }
  });
  expect(calls).toEqual([]);
  await page.getByLabel('ComfyUI API workflow file', { exact: true }).setInputFiles({ name: 'workflow.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ '1': { class_type: 'SaveImage', inputs: {} } })) });
  await page.getByRole('button', { name: 'Run reviewed workflow', exact: true }).click();
  const review = page.getByRole('button', { name: 'Review generated image 1: portrait.png', exact: true }); await expect(review).toBeVisible();
  expect(calls).toEqual(['/prompt', '/history/qa-owned-job']);
  await review.click(); await expect(page.getByRole('alert')).toContainText('not a PNG or JPEG');
  await expect(page.getByRole('button', { name: 'Stage reviewed portrait', exact: true })).toHaveCount(0);
  invalid = false; await review.click();
  await expect(page.getByAltText('Generated portrait proposal', { exact: true })).toHaveJSProperty('naturalWidth', 128);
  await page.getByRole('region', { name: 'Review generated portrait', exact: true }).scrollIntoViewIfNeeded();
  await screenshot(page, info, 'native-local-tools-comfy-reviewed-image');
  await page.getByRole('button', { name: 'Stage reviewed portrait', exact: true }).click();
  expect((await (await page.request.get(imported.path)).json()).revision.assets).toEqual([]);
  await save(page);
  const opened = await (await page.request.get(imported.path)).json();
  expect(await (await page.request.get(`${imported.path}/asset?revisionId=${opened.revision.id}&path=portrait`)).body()).toEqual(png);
  expect(await (await page.request.get(`${imported.path}/original`)).body()).toEqual(imported.bytes);
  expect(calls.some((path) => /interrupt|queue/.test(path))).toBe(false);
});

test('native wizard uses an editable local prompt set, reviews fields and cancels late provider results', async ({ page }, info) => {
  const imported = await importCard(page, 'Native wizard QA', 'json'); await provider(page); await enable(page, 'Wizard');
  const dialog = await settings(page); await dialog.getByRole('tab', { name: 'Editors', exact: true }).click();
  await dialog.getByRole('tab', { name: 'Wizard', exact: true }).click();
  await dialog.getByRole('button', { name: '+ New Prompt Set', exact: true }).click();
  await dialog.getByPlaceholder('e.g., Creative Wizard', { exact: true }).fill('Deterministic native prompt');
  await dialog.getByPlaceholder('System prompt for character creation assistance...', { exact: true }).fill('NATIVE_QA_CHARACTER_PROMPT');
  await dialog.getByPlaceholder('System prompt for lore/worldbuilding assistance...', { exact: true }).fill('NATIVE_QA_LORE_PROMPT');
  await dialog.getByPlaceholder('How wwwyzzerdd should speak and behave...', { exact: true }).fill('A concise fixture assistant.');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.getByRole('combobox').selectOption({ label: 'Deterministic native prompt' });
  await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.getByRole('button', { name: 'wwwyzzerdd', exact: true }).click();
  let held = false, release!: () => void, entered!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  await page.route(model, async (route) => {
    expect(route.request().postDataJSON().messages[0].content).toContain('NATIVE_QA_CHARACTER_PROMPT');
    if (held) { entered(); await pending; }
    await route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      json: { choices: [{ message: { content: held ? '{"name":"Late canceled name"}' : '```json\n{"name":"Reviewed wizard name","description":"Reviewed wizard description"}\n```' } }] } }).catch(() => undefined);
  });
  const input = page.getByPlaceholder('Describe your character or ask for suggestions...', { exact: true });
  await input.fill('Generate a character'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply to Card', exact: true })).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Native wizard QA');
  await screenshot(page, info, 'native-wizard-desktop-reviewed-fields');
  await page.getByRole('button', { name: 'Apply to Card', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Reviewed wizard name');
  expect((await (await page.request.get(imported.path)).json()).revision.document.data.name).toBe('Native wizard QA');
  await page.getByRole('button', { name: 'Clear Chat', exact: true }).click();
  held = true; await input.fill('This request will be canceled'); await page.getByRole('button', { name: 'Send', exact: true }).click(); await started;
  await page.getByRole('button', { name: 'Stop', exact: true }).click(); release();
  await expect(page.getByText('[Request stopped by user]', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply to Card', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Reviewed wizard name');
  await page.setViewportSize({ width: 390, height: 844 }); await fit(page);
  const send = await page.getByRole('button', { name: 'Send', exact: true }).boundingBox();
  expect(send!.x + send!.width).toBeLessThanOrEqual(390);
  await screenshot(page, info, 'native-wizard-mobile-layout');
  await page.getByText('[Request stopped by user]', { exact: true }).scrollIntoViewIfNeeded();
  await screenshot(page, info, 'native-wizard-mobile-cancelled-request');
});
