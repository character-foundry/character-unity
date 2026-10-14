import { readFile } from 'node:fs/promises';
import { expect, parse, screenshot, test } from './fixtures.js';
import { importViewerCard, tag } from './viewer-fixtures.js';

// Native design QA: actual file picker/cards, density controls, every compact filter,
// persistent actions, unclipped keyboard menus and loss/error reporting, narrow viewport.
// Auth/publication/remote flows have a separate real-backend acceptance suite.
test('native tile densities keep real actions and keyboard export menus reachable', async ({ page }, info) => {
  const imported = await importViewerCard(page, 'Tile density QA', 'png');
  const tile = page.locator('article').filter({ has: page.getByRole('button', { name: `Quick view ${imported.name}`, exact: true }) });
  const widths: number[] = [];
  for (const density of ['Large', 'Medium', 'Small']) {
    await page.getByRole('button', { name: 'Display settings', exact: true }).click();
    await page.getByRole('radiogroup', { name: 'Card size', exact: true }).getByRole('radio', { name: density, exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(tile.getByRole('list', { name: 'Tags', exact: true })).toHaveCount(density === 'Small' ? 0 : 1);
    await expect(tile.getByTitle('Add to favorites', { exact: true })).toBeVisible();
    await expect(tile.getByRole('button', { name: /(?:Send to|Connect a chat app)/ })).toBeVisible();
    const exportButton = tile.getByRole('button', { name: `Export ${imported.name}`, exact: true });
    await expect(exportButton).toBeVisible();
    widths.push((await tile.boundingBox())!.width);
    await exportButton.focus();
    await page.keyboard.press('ArrowDown');
    const menu = tile.getByRole('menu', { name: 'Export as', exact: true });
    await expect(menu.getByRole('menuitem', { name: 'PNG card', exact: false })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'CharX archive', exact: false })).toBeFocused();
    await page.keyboard.press('End');
    await expect(menu.getByRole('menuitem', { name: 'SillyTavern JSON', exact: false })).toBeFocused();
    const bounds = (await menu.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(48);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await screenshot(page, info, `native-tile-${density.toLowerCase()}-export-menu`);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(exportButton).toBeFocused();
  }
  expect(widths[0]).toBeGreaterThan(widths[1]!);
  expect(widths[1]).toBeGreaterThan(widths[2]!);
  await tile.getByTitle('Add to favorites', { exact: true }).click();
  await expect(tile.getByTitle('Remove from favorites', { exact: true })).toHaveAttribute('aria-pressed', 'true');
  await tile.getByTitle('Remove from favorites', { exact: true }).click();
  await expect(tile.getByTitle('Add to favorites', { exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('native tile export downloads actual card bytes and reports failures without fake success', async ({ page, diagnostics }, info) => {
  const imported = await importViewerCard(page, 'Tile file QA', 'png');
  const tile = page.locator('article').filter({ has: page.getByRole('button', { name: `Quick view ${imported.name}`, exact: true }) });
  await tile.getByRole('button', { name: `Export ${imported.name}`, exact: true }).click();
  const downloading = page.waitForEvent('download');
  await tile.getByRole('menuitem', { name: 'PNG card', exact: false }).click();
  const downloaded = await downloading;
  expect(downloaded.suggestedFilename()).toMatch(/\.png$/);
  const parsed = await parse(await readFile((await downloaded.path())!));
  expect(parsed.originalShape.data.name).toBe(imported.name);

  diagnostics.expectedStatuses.add(503);
  await page.route(`**/cards/${imported.card.id}/export?**`, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Tile export temporarily unavailable' } }) }));
  await tile.getByRole('button', { name: `Export ${imported.name}`, exact: true }).click();
  await tile.getByRole('menuitem', { name: 'JSON card', exact: false }).click();
  await expect(tile.getByRole('alert')).toContainText('Tile export temporarily unavailable');
  const errorBounds = (await tile.getByRole('alert').boundingBox())!;
  expect(errorBounds.x).toBeGreaterThanOrEqual(0);
  expect(errorBounds.x + errorBounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await expect(tile.getByRole('button', { name: `Export ${imported.name}`, exact: true })).toBeEnabled();
  await screenshot(page, info, 'native-tile-export-actionable-error');
  await tile.getByRole('button', { name: 'Dismiss export error', exact: true }).click();
  await expect(tile.getByRole('alert')).toHaveCount(0);
});

test('compact native filters preserve URL state and remain usable on a narrow viewport', async ({ page }, info) => {
  const imported = await importViewerCard(page, 'Tile filter QA', 'json');
  await page.getByRole('combobox', { name: 'Include tags', exact: true }).fill(tag);
  await page.getByRole('combobox', { name: 'Include tags', exact: true }).press('Enter');
  await page.getByLabel('Sort', { exact: true }).selectOption('name');
  await page.getByLabel('Originals or forks', { exact: true }).selectOption('none');
  await page.getByRole('button', { name: /^Filters(?:\s|$)/ }).click();
  await page.getByRole('combobox', { name: 'Exclude tags', exact: true }).fill('not-in-this-card');
  await page.getByRole('combobox', { name: 'Exclude tags', exact: true }).press('Enter');
  await page.getByRole('radiogroup', { name: 'Tag match mode', exact: true }).getByRole('radio', { name: 'Match any', exact: true }).click();
  await page.getByLabel('Source', { exact: true }).selectOption('file');
  await page.getByLabel('Min tokens', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Lorebook', exact: true }).click();
  await expect(page).toHaveURL(/minTokens=1/);
  const params = new URL(page.url()).searchParams;
  expect(Object.fromEntries(params)).toMatchObject({ tags: tag, sort: 'name', fork: 'none', exclude: 'not-in-this-card', match: 'any', source: 'file', minTokens: '1', has: 'lorebook' });
  await expect(page.getByRole('button', { name: `Quick view ${imported.name}`, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Originals or forks', { exact: true })).toHaveValue('none');
  await expect(page.getByLabel('Sort', { exact: true })).toHaveValue('name');
  await page.getByRole('button', { name: /^Filters(?:\s|$)/ }).click();
  await page.getByRole('radiogroup', { name: 'Tag match mode', exact: true }).getByRole('radio', { name: 'Match any', exact: true }).click();
  await expect(page.getByLabel('Source', { exact: true })).toHaveValue('file');
  await expect(page.getByLabel('Min tokens', { exact: true })).toHaveValue('1');
  await screenshot(page, info, 'native-library-compact-filters-desktop');
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole('button', { name: 'Display settings', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await screenshot(page, info, 'native-library-compact-filters-mobile');
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page).toHaveURL(/\?sort=name$/);
  await expect(page.getByRole('button', { name: `Quick view ${imported.name}`, exact: true })).toBeVisible();
});

test('native tile Send menu retains real target errors and keyboard dismissal', async ({ page, diagnostics }, info) => {
  const imported = await importViewerCard(page, 'Tile send QA', 'json');
  const workspace = imported.path.split('/')[3]!;
  const headers = { origin: new URL(page.url()).origin, 'x-unity-actor': imported.revision.authorId };
  const ids: string[] = [];
  try {
    for (const [index, suffix] of ['One', 'Two'].entries()) {
      const response = await page.request.post(`/api/workspaces/${workspace}/chat/targets`, { headers, data: { kind: 'sillytavern', name: `Tile Chat ${suffix}`, baseUrl: `http://127.0.0.1:${index + 1}`, credentials: {} } });
      expect(response.ok(), await response.text()).toBe(true);
      ids.push((await response.json() as { id: string }).id);
    }
    await page.reload();
    const tile = page.locator('article').filter({ has: page.getByRole('button', { name: `Quick view ${imported.name}`, exact: true }) });
    const send = tile.getByRole('button', { name: 'Send to…', exact: true });
    await send.focus();
    await page.keyboard.press('ArrowDown');
    await expect(tile.getByRole('menuitem', { name: 'Send to Tile Chat One', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(send).toBeFocused();
    diagnostics.expectedStatuses.add(503);
    await page.route(`**/chat/targets/${ids[0]}/sends`, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Tile chat temporarily unavailable' } }) }));
    await send.click();
    await tile.getByRole('menuitem', { name: 'Send to Tile Chat One', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Tile chat temporarily unavailable');
    await expect(send).toBeEnabled();
    await expect(page.getByRole('status').filter({ hasText: 'Sent to Tile Chat One' })).toHaveCount(0);
    await screenshot(page, info, 'native-tile-send-error-no-fake-success');
  } finally {
    for (const id of ids) {
      const removed = await page.request.delete(`/api/workspaces/${workspace}/chat/targets/${id}`, { headers });
      expect(removed.ok(), await removed.text()).toBe(true);
    }
  }
});
