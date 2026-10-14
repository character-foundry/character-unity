import { readFile } from 'node:fs/promises';
import { expect, fixture, freshWorkspace, gif, notes, parse, screenshot, test } from './fixtures.js';
import type { Page } from '@playwright/test';

test.beforeEach(async ({ page }) => { await freshWorkspace(page); });

// QA inventory: favorite→link and unfavorite→retained membership; exact historical
// reads/downloads; ordinary file/content dedupe; untouched edit creates nothing;
// changed first Save promotes to a fork with inherited assets and original lineage.
// Exploratory failures: unavailable source stays visible; failed fork Save keeps
// text and staged files. Desktop/mobile screenshots are reviewed separately.
interface Imported {
  card: { id: string; workspaceId: string };
  revision: { id: string; document: { data: { name: string } }; assets: { path: string; assetId: string }[] };
  reference?: { archiveId: string; cardId: string; versionId: string };
  import: { created: boolean; match: string | null };
}
async function upload(page: Page, bytes: Buffer, filename: string): Promise<Imported> {
  const received = page.waitForResponse((response) => response.url().endsWith('/imports') && response.request().method() === 'POST');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTitle('Import card files').click();
  await (await chooser).setFiles({ name: filename, mimeType: 'application/octet-stream', buffer: bytes });
  const response = await received;
  expect(response.ok(), await response.text()).toBe(true);
  const result = await response.json() as { card: { id: string }; import: Imported['import'] };
  // File imports deliberately return only membership for known Archive bytes;
  // opening is a separate read, not a prerequisite for the deduplication result.
  const workspace = new URL(response.url()).pathname.split('/')[3]!;
  const opened = await page.request.get(`/api/workspaces/${workspace}/cards/${encodeURIComponent(result.card.id)}`);
  expect(opened.ok(), await opened.text()).toBe(true);
  return { ...await opened.json() as Omit<Imported, 'import'>, import: result.import };
}
async function download(page: Page, button: string) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  return readFile((await (await pending).path())!);
}

test('Archive favorite creates a pinned library link; unfavoriting and removing it leave the original untouched', async ({ page }, info) => {
  await page.goto('/archive');
  const tile = page.locator('article').filter({ has: page.getByRole('button', { name: 'Quick view Archive PNG', exact: true }) });
  const favorite = page.waitForResponse((response) => response.url().includes('/archive/v2/cards/1002/favorite') && response.request().method() === 'PUT');
  await tile.getByTitle('Favorite and add a library link', { exact: true }).click();
  const added = await (await favorite).json() as { cardId: string };
  await expect(tile.getByRole('link', { name: 'In library ✓', exact: true })).toBeVisible();
  await expect(tile.locator('img')).toHaveCount(1);
  await expect.poll(() => page.locator('article img').evaluateAll((images) => images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)), 'Archive portraits are image bytes, not card ZIP containers').toBe(true);
  await screenshot(page, info, 'archive-favorite-pinned-link');
  await tile.getByRole('link', { name: 'In library ✓', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Archive PNG', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText('ARCHIVE LINK', { exact: true })).toBeVisible();
  await expect(page.getByTitle('Remove from favorites', { exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await download(page, 'Download original')).toEqual(await fixture('Archive PNG', 'png'));
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByText('Archive original — changes stay local until you save a fork', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/card/${added.cardId}$`));
  await page.goto('/archive');
  await tile.getByTitle('Remove favorite; keep the library link', { exact: true }).click();
  await expect(tile.getByTitle('Favorite and add a library link', { exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(tile.getByRole('link', { name: 'In library ✓', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, info, 'archive-unfavorite-keeps-link-mobile');
  await tile.getByRole('link', { name: 'In library ✓', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Remove from library', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/archive');
  await expect(tile.getByRole('button', { name: '+ Library', exact: true })).toBeVisible();
  await expect(tile.getByRole('button', { name: 'Quick view Archive PNG', exact: true })).toBeVisible();
});

test('ordinary imports find exact historical Archive bytes and content; changed Save creates a tracked fork', async ({ page }, info) => {
  await page.goto('/');
  const bytes = await fixture('Archive JSON', 'json');
  const imported = await upload(page, bytes, 'historical-original.json');
  expect(imported.reference).toMatchObject({ cardId: '1001' });
  await expect(page.getByRole('status').filter({ hasText: 'Already have 1' })).toBeVisible();
  await page.getByRole('link', { name: 'Open existing: historical-original.json', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Archive JSON', exact: true, level: 1 })).toBeVisible();
  expect(await download(page, 'Download original')).toEqual(bytes);
  await page.getByRole('button', { name: 'Character Card', exact: true }).click();
  await page.getByRole('button', { name: /^Description\b/ }).click();
  await expect(page.locator('[data-card-section="character"] pre').filter({ hasText: 'Original description' }).first()).toBeVisible();
  const duplicate = await upload(page, bytes, 'same-original-again.json');
  expect(duplicate.card.id).toBe(imported.card.id);
  expect(duplicate.import.created).toBe(false);
  const sameContent = await upload(page, Buffer.from(JSON.stringify(JSON.parse(bytes.toString()), null, 2)), 'same-content-different-bytes.json');
  expect(sameContent.card.id).toBe(imported.card.id);
  expect(sameContent.import.created).toBe(false);
  expect(sameContent.import.match).toBe('content');
  await screenshot(page, info, 'native-import-already-have-historical-reference');
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Archive JSON');
  await page.getByLabel('Name', { exact: true }).fill('My Archive JSON fork');
  await expect(page.getByText('Unsaved changes — Save creates your fork', { exact: true })).toBeVisible();
  const saved = page.waitForResponse((response) => response.url().endsWith(`/${imported.card.id}/fork-assets`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const fork = await (await saved).json() as { cardId: string };
  expect(fork.cardId).not.toBe(imported.card.id);
  await expect(page).toHaveURL(new RegExp(`/card/${fork.cardId}/edit$`));
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  const base = `/api/workspaces/${imported.card.workspaceId}/cards`;
  const original = await (await page.request.get(`${base}/${imported.card.id}`)).json() as Imported;
  expect(original.reference).toEqual(imported.reference);
  expect(original.revision.id).toBe(imported.revision.id);
  const family = await (await page.request.get(`${base}/${fork.cardId}/family`)).json();
  expect(family.parent.id).toBe(imported.card.id);
  expect(family.parent.reference).toEqual(imported.reference);
  await screenshot(page, info, 'first-archive-edit-promoted-to-owned-fork');
});

test('a held Archive search result previews and adds its historical version, never a newer replacement', async ({ page, diagnostics }, info) => {
  const listing = page.waitForResponse((response) => /\/archive\/v2\/cards$/.test(new URL(response.url()).pathname));
  await page.goto('/archive');
  const base = new URL((await listing).url()).pathname;
  const latestResponse = await page.request.get(`${base}/1001`);
  expect(latestResponse.ok(), await latestResponse.text()).toBe(true);
  const latest = await latestResponse.json() as { versionId: string; versionList: { id: string; sequence: number }[] };
  const version = latest.versionList.find((candidate) => candidate.sequence === 1)!.id;
  expect(version).not.toBe(latest.versionId);
  const pinnedResponse = await page.request.get(`${base}/1001?${new URLSearchParams({ version })}`);
  expect(pinnedResponse.ok(), await pinnedResponse.text()).toBe(true);
  const pinned = await pinnedResponse.json() as { versionId: string };
  expect(pinned.versionId).toBe(version);
  // Hold a real older query page while the source is already at version three.
  // No Archive originals are rewritten or test-only production routes introduced.
  await page.route('**/archive/v2/cards?*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    cards: [{ ...pinned, libraryCardId: null, libraryFavorite: false }], total: 1, complete: true,
    nextOffset: 1, staleLibraryHits: 0, snapshot: 'a'.repeat(64),
  }) }));
  const requestedVersions: (string | null)[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === `${base}/1001`) requestedVersions.push(url.searchParams.get('version'));
  });
  await page.reload();
  await page.getByRole('button', { name: 'Quick view Archive JSON', exact: true }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByText('Original description', { exact: true })).toBeVisible();
  await expect(modal.getByText('silver forest', { exact: false })).toHaveCount(0);
  expect(requestedVersions).toEqual([version]);
  await screenshot(page, info, 'archive-quick-view-pinned-historical-version');
  const adding = page.waitForResponse((response) => response.url().endsWith('/archive/v2/cards/1001/import') && response.request().method() === 'POST');
  await modal.getByRole('button', { name: '+ Library', exact: true }).click();
  const addedResponse = await adding;
  expect(addedResponse.request().postDataJSON()).toEqual({ versionId: version });
  expect(addedResponse.ok(), await addedResponse.text()).toBe(true);
  const added = await addedResponse.json() as { cardId: string };
  await modal.getByRole('link', { name: 'In library ✓', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/card/${added.cardId}$`));
  const workspace = base.split('/')[3]!;
  const opened = await page.request.get(`/api/workspaces/${workspace}/cards/${added.cardId}`);
  expect(await opened.json()).toMatchObject({ reference: { cardId: '1001', versionId: version }, revision: { document: { data: { description: 'Original description' } } } });

  diagnostics.expectedStatuses.add(404);
  await page.route('**/archive/v2/cards/1001?version=*', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({
    error: { code: 'NOT_FOUND', message: 'This exact archived version is unavailable' },
  }) }));
  await page.goto('/archive');
  await page.getByRole('button', { name: 'Quick view Archive JSON', exact: true }).click();
  await expect(modal.getByRole('alert')).toHaveText('This exact archived version is unavailable');
  await expect(modal.getByText('Original description', { exact: true })).toHaveCount(0);
  await expect(modal.getByText('silver forest', { exact: false })).toHaveCount(0);
  expect(requestedVersions.every((requested) => requested === version)).toBe(true);
  await screenshot(page, info, 'archive-unavailable-pinned-version-no-latest-fallback');
});

test('saving an unchanged Archive fork or reverted edit keeps the same reference', async ({ page }, info) => {
  await page.goto('/archive');
  const tile = page.locator('article').filter({ has: page.getByRole('button', { name: 'Quick view Archive PNG', exact: true }) });
  await tile.getByRole('button', { name: '+ Library', exact: true }).click();
  await tile.getByRole('link', { name: 'In library ✓', exact: true }).click();
  const referenceId = page.url().split('/').at(-1)!;
  await page.getByRole('link', { name: 'Fork', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Archive PNG');
  const saved = page.waitForResponse((response) => response.url().endsWith(`/${referenceId}/fork-assets`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect(await (await saved).json()).toMatchObject({ cardId: referenceId, reference: { cardId: '1002' } });
  await expect(page).toHaveURL(new RegExp(`/card/${referenceId}/edit$`));
  await expect(page.getByText('Archive original — changes stay local until you save a fork', { exact: true })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Temporary edit');
  await page.getByLabel('Name', { exact: true }).fill('Archive PNG');
  const reverted = page.waitForResponse((response) => response.url().endsWith(`/${referenceId}/fork-assets`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect(await (await reverted).json()).toMatchObject({ cardId: referenceId, reference: { cardId: '1002' } });
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await screenshot(page, info, 'unchanged-archive-save-keeps-reference');
});

test('Archive CharX assets stay referenced through a failed first fork Save and successful retry', async ({ page, diagnostics }, info) => {
  await page.goto('/archive');
  const tile = page.locator('article').filter({ has: page.getByRole('button', { name: 'Quick view Archive CHARX', exact: true }) });
  const added = page.waitForResponse((response) => response.url().endsWith('/archive/v2/cards/1003/import') && response.request().method() === 'POST');
  await tile.getByRole('button', { name: '+ Library', exact: true }).click();
  const reference = await (await added).json() as { cardId: string };
  await tile.getByRole('link', { name: 'In library ✓', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Archive CHARX', exact: true, level: 1 })).toBeVisible();
  const acceptedOriginal = await download(page, 'Download original');
  const original = await download(page, 'Export CharX');
  expect(Buffer.from((await parse(original)).assets.find((asset) => asset.name === 'notes')!.data)).toEqual(notes);
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Archive CHARX');
  await page.getByLabel('Name', { exact: true }).fill('My Archive attachment fork');
  await page.getByLabel('Choose portrait', { exact: true }).setInputFiles({ name: 'my-portrait.gif', mimeType: 'image/gif', buffer: gif });
  const pattern = `**/cards/${reference.cardId}/fork-assets`;
  diagnostics.expectedStatuses.add(503);
  await page.route(pattern, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Archive fork test storage unavailable' } }) }));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Archive fork test storage unavailable');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('My Archive attachment fork');
  await expect(page.getByAltText('Character Avatar', { exact: true })).toHaveAttribute('src', /^blob:/);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await screenshot(page, info, 'archive-failed-fork-keeps-text-and-portrait');
  await page.unroute(pattern);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).not.toHaveURL(new RegExp(`/card/${reference.cardId}/edit$`));
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByText('FORK', { exact: true })).toBeVisible();
  expect(await download(page, 'Download original')).toEqual(acceptedOriginal);
  const exported = await parse(await download(page, 'Export CharX'));
  expect(Buffer.from(exported.assets.find((asset) => asset.name === 'notes')!.data)).toEqual(notes);
  expect(Buffer.from(exported.assets.find((asset) => asset.isMain)!.data)).toEqual(gif);
  await screenshot(page, info, 'archive-fork-keeps-inherited-assets');
});

test('an unavailable Archive source remains visible as a library link and never becomes an empty editable card', async ({ page, diagnostics }, info) => {
  await page.goto('/');
  const source = await upload(page, await fixture('Archive JSON', 'json'), 'unavailable-source.json');
  diagnostics.expectedStatuses.add(503);
  const path = `**/api/workspaces/${source.card.workspaceId}/cards/${source.card.id}`;
  await page.route(path, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ASSET_UNAVAILABLE', message: 'This exact Archive source version is unavailable' } }) }));
  await page.getByRole('link', { name: 'Open existing: unavailable-source.json', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('This exact Archive source version is unavailable');
  await expect(page.getByRole('link', { name: 'Edit', exact: true })).toHaveCount(0);
  await screenshot(page, info, 'archive-source-unavailable-explicit');
  await page.getByRole('link', { name: 'Back to library', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Quick view Archive JSON', exact: true }).first()).toBeVisible();
  await expect(page.getByText('ARCHIVE', { exact: true }).first()).toBeVisible();
});

test('ordinary import reports the filename and incomplete identity index reason without claiming success', async ({ page, diagnostics }, info) => {
  await page.goto('/');
  diagnostics.expectedStatuses.add(409);
  await page.route('**/imports', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
    error: { code: 'ARCHIVE_IDENTITY_INCOMPLETE', message: 'Archive identity indexing is incomplete. No duplicate was stored; run the bounded index command and retry.' },
  }) }));
  const chooser = page.waitForEvent('filechooser');
  await page.getByTitle('Import card files').click();
  await (await chooser).setFiles({ name: '日本語 100%.json', mimeType: 'application/json', buffer: await fixture('Unindexed import', 'json') });
  await expect(page.getByRole('alert')).toContainText('日本語 100%.json: Archive identity indexing is incomplete. No duplicate was stored');
  await expect(page.getByRole('alert')).toContainText('Imported 0 cards');
  await screenshot(page, info, 'import-incomplete-index-actionable-error');
});

test('a saved Archive fork joins the same semantic search and opens as an owned card, then deletion removes only its projection', async ({ page }, info) => {
  await page.goto('/archive');
  const tile = page.locator('article').filter({ has: page.getByRole('button', { name: 'Quick view Archive PNG', exact: true }) });
  // Membership is asynchronous: an immediate count on an unrendered tile can
  // skip Add and then wait forever for a link that was never created.
  await expect(tile.getByRole('button', { name: '+ Library', exact: true })
    .or(tile.getByRole('link', { name: 'In library ✓', exact: true }))).toBeVisible();
  if (await tile.getByRole('button', { name: '+ Library', exact: true }).count()) await tile.getByRole('button', { name: '+ Library', exact: true }).click();
  await tile.getByRole('link', { name: 'In library ✓', exact: true }).click();
  const sourceId = page.url().split('/').at(-1)!;
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Archive PNG');
  await page.getByLabel('Name', { exact: true }).fill('Searchable Unity ocean keeper');
  await page.getByRole('button', { name: 'Character', exact: true }).click();
  await page.getByLabel('Description', { exact: true }).fill('An ocean map keeper whose saved fork is searchable alongside archived originals.');
  const saving = page.waitForResponse((response) => response.url().endsWith(`/${sourceId}/fork-assets`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await (await saving).json() as { cardId: string; revision: { workspaceId: string } };
  await expect(page).toHaveURL(new RegExp(`/card/${saved.cardId}/edit$`));
  const statusPath = `/api/workspaces/${saved.revision.workspaceId}/search-index`;
  async function settled() {
    await expect.poll(async () => {
      const response = await page.request.get(statusPath);
      expect(response.ok(), await response.text()).toBe(true);
      const status = await response.json() as { enabled: boolean; pending: number; failed: number; running: boolean };
      return { enabled: status.enabled, pending: status.pending, failed: status.failed, running: status.running };
    }).toEqual({ enabled: true, pending: 0, failed: 0, running: false });
  }
  await settled();
  await page.goto('/archive');
  await expect(page.getByRole('region', { name: 'Saved-card search indexing', exact: true })).toContainText('0 queued changes; 0 failed');
  await expect(page.getByRole('option', { name: 'Semantic', exact: true })).toBeEnabled();
  await page.getByLabel('Archive search mode', { exact: true }).selectOption('semantic');
  await page.getByLabel('Archive query', { exact: true }).fill('ocean map keeper');
  await page.getByRole('button', { name: 'Search Archive', exact: true }).click();
  const owned = page.locator('article').filter({ has: page.getByRole('button', { name: 'View Searchable Unity ocean keeper', exact: true }) });
  await expect(owned).toBeVisible();
  await expect(owned.getByText('UNITY', { exact: true })).toBeVisible();
  await expect(owned.locator('img')).toHaveCount(1);
  await expect.poll(() => owned.locator('img').evaluate((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0), 'Owned search portrait resolves the inherited Archive asset through its exact library revision').toBe(true);
  await owned.getByTitle('Add to favorites', { exact: true }).click();
  await expect(owned.getByTitle('Remove from favorites', { exact: true })).toHaveAttribute('aria-pressed', 'true');
  await owned.getByTitle('Remove from favorites', { exact: true }).click();
  await expect(owned.getByTitle('Add to favorites', { exact: true })).toHaveAttribute('aria-pressed', 'false');
  await screenshot(page, info, 'shared-lance-semantic-archive-and-owned-fork');
  await owned.getByRole('button', { name: 'View Searchable Unity ocean keeper', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/card/${saved.cardId}$`));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Searchable Unity ocean keeper', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText('FORK', { exact: true })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await settled();
  await page.goto('/archive?archiveMode=semantic&search=ocean+map+keeper');
  await expect(page.getByText('bounded candidate set, not the full Archive match count', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View Searchable Unity ocean keeper', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Quick view Archive PNG', exact: true })).toBeVisible();
});

test('saved-card indexing failures, explicit retry and a disabled host remain visible without polling', async ({ page }, info) => {
  let reads = 0, failing = true;
  await page.route('**/search-index', async (route) => {
    reads++;
    if (failing) await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      enabled: true, running: false, pending: 100, failed: 2, bounded: true, reason: null, lastError: 'Document embedding provider is unavailable; queued changes are retained', semantic: null,
    }) });
    else await route.continue();
  });
  let retries = 0;
  await page.route('**/search-index/retry', async (route) => { retries++; failing = false; await route.continue(); });
  await page.goto('/archive');
  const status = page.getByRole('region', { name: 'Saved-card search indexing', exact: true });
  await expect(status).toContainText('At least 100 queued changes; at least 2 failed');
  await expect(status.getByRole('alert')).toContainText('queued changes are retained');
  const before = reads;
  await page.getByRole('button', { name: 'Refresh saved-card indexing', exact: true }).click();
  await expect.poll(() => reads).toBeGreaterThan(before);
  await screenshot(page, info, 'saved-card-index-failure-explicit-retry');
  await page.getByRole('button', { name: 'Retry saved-card indexing', exact: true }).click();
  await expect.poll(() => retries).toBe(1);
  await expect(status).toContainText('0 queued changes; 0 failed');
  await expect(status.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry saved-card indexing', exact: true })).toHaveCount(0);
  await page.unroute('**/search-index');
  await page.route('**/search-index', (route) => {
    reads++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      enabled: false, running: false, pending: 3, failed: 0, bounded: false, reason: 'Library indexing is not enabled on this host', lastError: null, semantic: null,
    }) });
  });
  await page.getByRole('button', { name: 'Refresh saved-card indexing', exact: true }).click();
  await expect(status).toContainText('Saved-card search indexing disabled: Library indexing is not enabled on this host');
  await expect(status).toContainText('Existing library coverage is not counted');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, info, 'saved-card-index-disabled-reason-mobile');
  await page.clock.install();
  const settledReads = reads;
  await page.clock.fastForward(60_000);
  expect(reads, 'An idle Archive page does not poll saved-card indexing').toBe(settledReads);
});
