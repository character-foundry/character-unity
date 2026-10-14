import { expect, importCard, save, screenshot, test } from './fixtures.js';

test('native history refresh cancels stale comparisons, pages all revisions and never retargets a dirty Save', async ({ page, diagnostics }, info) => {
  const imported = await importCard(page, 'Native history parity', 'json');
  await page.getByRole('button', { name: 'Character', exact: true }).click();
  await page.getByLabel('Description', { exact: true }).fill('Second saved description');
  await save(page);
  await page.getByLabel('Description', { exact: true }).fill('Keep this unsaved draft');
  await page.getByRole('button', { name: 'Diff', exact: true }).click();
  await expect(page.getByText('Version 2', { exact: true })).toBeVisible();
  const original = page.locator('.card').filter({ has: page.getByText('Version 1', { exact: true }) });
  let entered!: () => void, release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { entered = resolve; });
  const pattern = `**/revisions/${imported.revision.id}`;
  await page.route(pattern, async (route) => {
    entered();
    try { const response = await route.fetch(); await held; await route.fulfill({ response }); }
    catch { /* Refresh cancels this superseded comparison. */ }
  });
  await original.getByRole('button', { name: 'Compare', exact: true }).click(); await ready;
  await page.getByRole('button', { name: 'Refresh history', exact: true }).click(); release();
  await page.unroute(pattern);
  await expect(page.getByRole('heading', { name: 'Version History', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Comparing Version 1 with Current', exact: true })).toHaveCount(0);

  let revision = (await (await page.request.get(imported.path)).json()).revision;
  for (let index = 0; index < 20; index++) {
    const document = structuredClone(revision.document); document.data.description = `Concurrent save ${index + 1}`;
    const response = await page.request.post(`${imported.path}/revisions`, { headers: { origin: new URL(page.url()).origin }, data: { expectedHead: revision.id, document } });
    expect(response.ok(), await response.text()).toBe(true); revision = await response.json();
  }
  await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
  await expect(page.getByText('Version 22', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Compare', exact: true })).toHaveCount(22);
  diagnostics.expectedStatuses.add(409);
  diagnostics.expectedConsole.push('[saveCard] FAILED to save card: Error: The card has changed; reload before saving');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/changed|conflict/i);
  expect((await (await page.request.get(imported.path)).json()).revision.id).toBe(revision.id);
  diagnostics.expectedConsole.push('Failed to load resource');
  await page.route('**/revisions?*', (route) => route.abort('connectionfailed'));
  await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry history', exact: true })).toBeVisible();
  await page.unroute('**/revisions?*');
  await page.getByRole('button', { name: 'Retry history', exact: true }).click();
  await expect(page.getByText('Version 22', { exact: true })).toBeVisible();
  await page.locator('.architect-root .editor-tabs').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Character', exact: true }).click();
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Keep this unsaved draft');
  expect(await (await page.request.get(`${imported.path}/original`)).body()).toEqual(imported.bytes);
  await page.getByRole('button', { name: 'Diff', exact: true }).click();
  await page.locator('.card').filter({ has: page.getByText('Version 1', { exact: true }) }).getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Comparing Version 1 with Current', exact: true })).toBeVisible();
  await expect(page.locator('.cm-editor').first()).toBeVisible();
  await expect(page.locator('.cm-merge-b .cm-content')).toContainText('Keep this unsaved draft');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Unified', exact: true }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(1);
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await expect(page.locator('.cm-content')).toContainText('Keep this unsaved draft');
  await screenshot(page, info, 'native-history-mobile-unified');
  await page.getByRole('button', { name: 'Side-by-Side', exact: true }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(2);
  const statistics = page.getByRole('group', { name: 'Comparison statistics', exact: true });
  expect(await statistics.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await screenshot(page, info, 'native-history-mobile-comparison');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
