import { readFile } from 'node:fs/promises';
import { expect, moduleRisum, notes, opaque, parse, png, screenshot, test } from './fixtures.js';
import { creator, descriptionEnd, greetingEnd, importViewerCard, remoteAsset, tag } from './viewer-fixtures.js';

// Native viewer QA inventory: file picker → tile → quick view → routed reader;
// every read tab; URL/query/back navigation; favorite/follow cycles; exact original,
// portrait, attachment and CharX downloads; unavailable/external assets; desktop/mobile;
// missing card, failed read/export and cancellation during route changes.
async function quickView(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('button', { name: `Quick view ${name}`, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close quick view', exact: true })).toBeVisible();
}

async function profile(page: import('@playwright/test').Page, name: string) {
  await quickView(page, name);
  await page.getByRole('link', { name: 'View Full Profile', exact: true }).click();
  await expect(page).toHaveURL(/\/card\/[^/]+$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeVisible();
}

async function exported(page: import('@playwright/test').Page, name: string) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  return readFile((await (await pending).path())!);
}

/** Read the final text bounds, then reach them with real wheel input; no DOM/state manipulation. */
async function revealLongTail(page: import('@playwright/test').Page, content: import('@playwright/test').Locator, marker: string) {
  const bounds = () => content.evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const index = node.textContent?.indexOf(text) ?? -1;
      if (index < 0) continue;
      const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + text.length);
      const rectangle = range.getBoundingClientRect();
      return { top: rectangle.top, bottom: rectangle.bottom, height: element.getBoundingClientRect().height };
    }
    throw new Error('Long-content end marker is missing');
  }, marker);
  const initial = await bounds();
  expect(initial.height, 'Expanded long text is not capped at the old 5000px limit').toBeGreaterThan(5000);
  await page.mouse.wheel(0, initial.top - 350);
  await expect.poll(async () => { const visible = await bounds(); return visible.top >= 0 && visible.bottom <= (page.viewportSize()!.height); }).toBe(true);
}

test('native JSON, PNG and CharX readers expose their content without fetching remote illustrations', async ({ page }, info) => {
  const externalRequests: string[] = [];
  page.on('request', (request) => { if (request.url().startsWith('https://viewer-qa.invalid/')) externalRequests.push(request.url()); });
  await page.route('https://viewer-qa.invalid/**', (route) => route.abort());
  for (const format of ['json', 'png', 'charx'] as const) {
    const name = `Native reader ${format}`;
    const imported = await importViewerCard(page, name, format, { long: format === 'json' });
    await profile(page, name);
    await expect(page).toHaveURL(new RegExp(`/card/${imported.card.id}$`));
    await page.getByRole('button', { name: "Creator's Notes", exact: true }).click();
    await expect(page.getByText('A native reader preserves', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Character Card', exact: true }).click();
    await page.getByRole('button', { name: /^Description\b/ }).click();
    const description = page.locator('[data-card-section="character"] pre').filter({ hasText: 'A keeper of the quiet forest.' }).first();
    await expect(description).toBeVisible();
    if (format === 'json') { await revealLongTail(page, description, descriptionEnd); await screenshot(page, info, 'native-long-description-end-visible'); }
    await page.getByRole('button', { name: /^Personality\b/ }).click();
    await expect(page.getByText('Patient, curious, and meticulous.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Greetings', exact: true }).click();
    await expect(page.getByText('Welcome to the quiet forest.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^Greeting 2\b/ }).click();
    const greeting = page.locator('[data-section="greetings"]').getByText('The lantern is still burning.', { exact: false });
    await expect(greeting).toBeVisible();
    if (format === 'json') { await revealLongTail(page, greeting, greetingEnd); await screenshot(page, info, 'native-long-greeting-end-visible'); }
    await page.getByRole('button', { name: /^Greeting 3\b/ }).click();
    await expect(page.getByText('You found the hidden path.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^Group Greeting 1\b/ }).click();
    await expect(page.getByText('There is room for every traveler.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Lorebook', exact: true }).click();
    await expect(page.getByText('The lantern remembers the road.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /The clearing/ }).click();
    await expect(page.getByText('The clearing is quiet after rain.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Assets', exact: true }).click();
    if (format === 'charx') {
      await expect(page.getByText('notes', { exact: true })).toBeVisible();
    }
    await page.getByRole('button', { name: /^Forks\b/ }).click();
    await expect(page.getByText(/no forks/i)).toBeVisible();
    await page.getByRole('button', { name: 'Character Card', exact: true }).click();
    await screenshot(page, info, `native-${format}-reader-desktop`);
    if (format === 'json') {
      const exportedJson = JSON.parse((await exported(page, 'Export JSON')).toString()) as { data: { name: string }; vendor_envelope: unknown };
      expect(exportedJson.data.name).toBe(name);
      expect(exportedJson.vendor_envelope).toEqual(opaque);
    }
    expect(await page.evaluate(() => Object.hasOwn(window, '__viewerUnsafe')), 'Untrusted card markup never executes').toBe(false);
  }
  expect(externalRequests, 'Card content and unavailable descriptors never auto-load remote assets').toEqual([]);
  expect(await page.locator(`img[src="${remoteAsset}"]`).count()).toBe(0);
});

test('quick view and native links preserve library search, filters and browser history', async ({ page }, info) => {
  const imported = await importViewerCard(page, 'Native navigation');
  const params = new URLSearchParams({ search: 'name:"Native navigation"', tags: tag, sort: 'name' });
  const filtered = `/?${params}`;
  await page.goto(filtered);
  await quickView(page, imported.name);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Close quick view', exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(new URL(filtered, 'http://127.0.0.1:19430').href);
  await profile(page, imported.name);
  await page.goBack();
  await expect(page).toHaveURL(new URL(filtered, 'http://127.0.0.1:19430').href);
  await expect(page.getByRole('button', { name: `Quick view ${imported.name}`, exact: true })).toBeVisible();
  await quickView(page, imported.name);
  await page.getByRole('link', { name: new RegExp(`by ${creator}`) }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('search')).toBe(`creator:"${creator}"`);
  await expect(page.getByRole('button', { name: `Quick view ${imported.name}`, exact: true })).toBeVisible();
  await quickView(page, imported.name);
  await page.getByRole('dialog').getByRole('link', { name: tag, exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('tags')).toBe(tag);
  await expect(page.getByRole('button', { name: `Quick view ${imported.name}`, exact: true })).toBeVisible();
  await screenshot(page, info, 'native-tag-navigation');
});

test('favorites and followed creators use native library state and complete both toggle directions', async ({ page, diagnostics }, info) => {
  const imported = await importViewerCard(page, 'Native local actions');
  await profile(page, imported.name);
  await page.getByTitle('Add to favorites', { exact: true }).click();
  await expect(page.getByTitle('Remove from favorites', { exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '+ Follow', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Following', exact: true })).toBeVisible();
  await page.goto(`/?search=${encodeURIComponent('name:"Native local actions"')}`);
  await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect(page.getByRole('button', { name: `Quick view ${imported.name}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await page.getByRole('button', { name: 'Followed creators only', exact: true }).click();
  await expect(page.getByRole('button', { name: `Quick view ${imported.name}`, exact: true })).toBeVisible();
  await screenshot(page, info, 'native-favorite-and-followed-filters');
  await profile(page, imported.name);
  await page.getByTitle('Remove from favorites', { exact: true }).click();
  await expect(page.getByTitle('Add to favorites', { exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Following', exact: true }).click();
  await expect(page.getByRole('button', { name: '+ Follow', exact: true })).toBeVisible();
  await page.goto(`/?search=${encodeURIComponent('name:"Native local actions"')}&favorite=fav`);
  await expect(page.getByText('No cards match these filters', { exact: true })).toBeVisible();
  await page.goto(`/card/${imported.card.id}`);
  diagnostics.expectedStatuses.add(503);
  const pattern = `**/cards/${imported.card.id}/favorite`;
  await page.route(pattern, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Test favorite store unavailable' } }) }));
  await page.getByTitle('Add to favorites', { exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Test favorite store unavailable');
  await expect(page.getByTitle('Add to favorites', { exact: true })).toHaveAttribute('aria-pressed', 'false');
  await screenshot(page, info, 'native-favorite-failure-rollback');
  await page.unroute(pattern);
  await page.getByTitle('Add to favorites', { exact: true }).click();
  await expect(page.getByTitle('Remove from favorites', { exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByTitle('Remove from favorites', { exact: true }).click();
  await expect(page.getByTitle('Add to favorites', { exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('native downloads preserve original and stored attachment bytes and display export failures in place', async ({ page, diagnostics }, info) => {
  const imported = await importViewerCard(page, 'Native exact downloads');
  await profile(page, imported.name);
  expect(await exported(page, 'Download original')).toEqual(imported.bytes);
  const charx = await parse(await exported(page, 'Export CharX'));
  expect(charx.originalShape.vendor_envelope).toEqual(opaque);
  expect(Buffer.from(charx.assets.find((asset) => asset.name === 'notes')!.data)).toEqual(notes);
  expect(Buffer.from(charx.metadata!.moduleRisum!)).toEqual(moduleRisum);
  diagnostics.expectedStatuses.add(400);
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/JSON cannot carry.*asset bytes/i);
  await page.getByRole('button', { name: 'SillyTavern PNG', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/Separate attachments are not preserved/i);
  const pngExport = await parse(await exported(page, 'Download PNG'));
  expect(pngExport.originalShape.data.name).toBe(imported.name);
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  const row = page.locator('li, article').filter({ has: page.getByText('notes', { exact: true }) }).last();
  const pending = page.waitForEvent('download');
  await row.getByRole('link', { name: 'Download asset', exact: true }).click();
  expect(await readFile((await (await pending).path())!)).toEqual(notes);
  diagnostics.expectedStatuses.add(503);
  const pattern = `**/cards/${imported.card.id}/export?*`;
  await page.route(pattern, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Test export storage unavailable' } }) }));
  await page.getByRole('button', { name: 'Export CharX', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Test export storage unavailable');
  await expect(page.getByRole('heading', { name: imported.name, exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export CharX', exact: true })).toBeEnabled();
  await screenshot(page, info, 'native-export-error');
  await page.unroute(pattern);
  expect((await parse(await exported(page, 'Export CharX'))).originalShape.data.name).toBe(imported.name);
});

test('missing and unavailable native profiles remain navigable and recover after retry', async ({ page, diagnostics }, info) => {
  diagnostics.expectedStatuses.add(404);
  await page.goto('/card/00000000-0000-4000-8000-000000000997');
  await expect(page.getByRole('alert')).toContainText(/not found|could not be opened/i);
  await expect(page.getByTitle('Import card files')).toBeVisible();
  await screenshot(page, info, 'native-missing-profile');
  const imported = await importViewerCard(page, 'Native profile recovery', 'png');
  const pattern = `**/api/workspaces/*/cards/${imported.card.id}`;
  diagnostics.expectedStatuses.add(503);
  await page.route(pattern, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Test viewer temporarily unavailable' } }) }));
  await page.goto(`/card/${imported.card.id}`);
  await expect(page.getByRole('alert')).toContainText('Test viewer temporarily unavailable');
  await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0);
  await screenshot(page, info, 'native-unavailable-profile');
  await page.unroute(pattern);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('heading', { name: imported.name, exact: true }).first()).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('native Archive read routes render fixture-only data and keep filtering inside the application', async ({ page }, info) => {
  const record = { id: 'qa:read-only-card', provider: 'ct', recordId: 'read-only-card', url: 'https://viewer-qa.invalid/source',
    name: 'Native Archive reader', creator, tagline: 'Read contract fixture only', tags: [tag], spec: 'v3', tokens: 321,
    altGreetings: 2, lorebookEntries: 2, flags: { gallery: false, expressions: false, embeddedImages: false, systemPrompt: true, exampleDialogues: true },
    stats: { favorites: 12 }, portrait: null, remoteCreatedAt: null, remoteUpdatedAt: null,
    firstSeenAt: '2026-10-13T12:00:00Z', changedAt: '2026-10-13T12:00:00Z', versionId: 'qa-version-2', versions: 2, libraryCardId: null };
  const writes: string[] = [];
  await page.route('**/archive/v2/**', (route) => {
    const request = route.request();
    if (request.method() !== 'GET') writes.push(request.method());
    const url = new URL(request.url());
    const result = url.pathname.endsWith('/tags') ? { tags: [{ tag, count: 1 }] }
      : url.pathname.endsWith('/cards') ? { cards: [record], total: 1 }
        : { ...record, document: { data: { description: 'Read-only Archive description', first_mes: 'The original greeting', creator_notes: 'Archive-native notes' } },
          versionList: [1, 2].map((sequence) => ({ id: `qa-version-${sequence}`, sequence, fetchedAt: record.firstSeenAt, remoteUpdatedAt: null,
            objects: [{ role: 'card', name: `original-${sequence}.json`, sha256: 'a'.repeat(64), mediaType: 'application/json', byteLength: 123 }] })) };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto('/');
  await page.getByRole('link', { name: 'Archive', exact: true }).click();
  await expect(page).toHaveURL(/\/archive$/);
  await page.getByRole('button', { name: `Quick view ${record.name}`, exact: true }).click();
  await expect(page.getByText('Read-only Archive description', { exact: true })).toBeVisible();
  await expect(page.getByText('original-1.json', { exact: false })).toBeVisible();
  await expect(page.getByText('original-2.json', { exact: false })).toBeVisible();
  await screenshot(page, info, 'native-archive-read-contract-fixture');
  await page.getByRole('link', { name: tag, exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('tags')).toBe(tag);
  await expect(page).toHaveURL(/\/archive\?tags=/);
  expect(writes, 'The reader never mutates Archive fixtures or connects to live Archive storage').toEqual([]);
});

test('a delayed profile cannot replace the card reached after navigating away', async ({ page }, info) => {
  const first = await importViewerCard(page, 'Delayed native profile', 'png');
  const second = await importViewerCard(page, 'Current native profile', 'png');
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pattern = `**/api/workspaces/*/cards/${first.card.id}`;
  await page.route(pattern, async (route) => { entered(); await held; await route.continue().catch(() => undefined); });
  try {
    await quickView(page, first.name);
    await page.getByRole('link', { name: 'View Full Profile', exact: true }).click();
    await started;
    await page.getByRole('link', { name: 'Library', exact: true }).click();
    await profile(page, second.name);
    release();
    await expect(page).toHaveURL(new RegExp(`/card/${second.card.id}$`));
    await expect(page.getByRole('heading', { name: second.name, exact: true }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: first.name, exact: true })).toHaveCount(0);
    await screenshot(page, info, 'native-route-cancellation');
  } finally { release(); await page.unroute(pattern); }
});

test('native quick view and reader fit mobile while keeping tab navigation and downloads usable', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const imported = await importViewerCard(page, 'Mobile native reader');
  await screenshot(page, info, 'native-mobile-library');
  await quickView(page, imported.name);
  await expect(page.getByRole('button', { name: 'Close quick view', exact: true })).toBeInViewport();
  await screenshot(page, info, 'native-mobile-quickview');
  await page.getByRole('link', { name: 'View Full Profile', exact: true }).click();
  await expect(page.getByRole('heading', { name: imported.name, exact: true }).first()).toBeVisible();
  await screenshot(page, info, 'native-mobile-profile');
  await page.getByRole('button', { name: 'Greetings', exact: true }).click();
  await page.getByRole('button', { name: /^Greeting 2\b/ }).click();
  await expect(page.getByText('The lantern is still burning.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  const row = page.locator('li, article').filter({ has: page.getByText('notes', { exact: true }) }).last();
  const pending = page.waitForEvent('download');
  await row.getByRole('link', { name: 'Download asset', exact: true }).click();
  expect(await readFile((await (await pending).path())!)).toEqual(notes);
  await screenshot(page, info, 'native-mobile-assets');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No page-level horizontal overflow').toBe(true);
  const portrait = page.getByRole('img', { name: imported.name, exact: true }).first();
  if (await portrait.count()) {
    const source = (await portrait.getAttribute('src'))!;
    expect(await (await page.request.get(source)).body()).toEqual(png);
  }
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Archive', exact: true })).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: 'Archive', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await expect(page).toHaveURL('http://127.0.0.1:19430/');
  await expect(page.getByRole('button', { name: `Quick view ${imported.name}`, exact: true })).toBeVisible();
});
