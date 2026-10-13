import { expect, screenshot, test } from './fixtures.js';
import type { Page } from '@playwright/test';

interface SeedPage { cards: Record<string, unknown>[] }

// QA inventory: real ExistingArchive/Lance Boolean, semantic and hybrid queries;
// submitted-only provider work; model/coverage/candidate/excerpt disclosure;
// typed metadata filters; URL/reload/back; capability withdrawal and provider
// failure without a fallback. Controlled pages exercise snapshot/excerpt alignment
// beyond the four-card fixture. Desktop and mobile screenshots are reviewed.
const isList = (url: string) => /\/archive\/v2\/cards$/.test(new URL(url).pathname);
const quickView = (page: Page, name: string) => page.getByRole('button', { name: `Quick view ${name}`, exact: true });
async function search(page: Page, mode: string, query: string) {
  await page.getByLabel('Archive search mode', { exact: true }).selectOption(mode);
  await page.getByLabel('Archive query', { exact: true }).fill(query);
  const submitted = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return isList(response.url()) && url.searchParams.get('mode') === mode && url.searchParams.get('q') === query;
  });
  await page.getByRole('button', { name: 'Search Archive', exact: true }).click();
  await submitted;
}

test('native Boolean, semantic and hybrid search submit explicitly and retain URL history', async ({ page }, info) => {
  const searches: URL[] = [];
  page.on('request', (request) => { if (isList(request.url()) && new URL(request.url()).searchParams.has('q')) searches.push(new URL(request.url())); });
  await page.goto('/archive');
  await expect(quickView(page, 'Archive PNG')).toBeVisible();
  await search(page, 'lexical', '"silver forest" AND NOT ocean');
  await expect(quickView(page, 'Archive JSON')).toHaveCount(1);
  await expect(quickView(page, 'Archive PNG')).toHaveCount(0);
  await expect(page.getByText('1 shown of 1 matches', { exact: false })).toBeVisible();
  await expect(page).toHaveURL(/archiveMode=lexical/);
  const booleanUrl = page.url();

  await page.getByLabel('Archive search mode', { exact: true }).selectOption('semantic');
  await page.getByLabel('Archive query', { exact: true }).fill('ocean keeper');
  await expect(page.getByText('Model: unity-browser-synthetic-v1', { exact: false })).toBeVisible();
  await expect(page.getByText('Vector coverage: not reported', { exact: false })).toBeVisible();
  await expect(page.getByText('may incur provider charges', { exact: false })).toBeVisible();
  const beforeDraftPause = searches.length;
  // Deliberately exceed the former debounce window: drafting must not call search.
  await page.waitForTimeout(400);
  expect(searches).toHaveLength(beforeDraftPause);
  await page.getByRole('button', { name: 'Search Archive', exact: true }).click();
  await expect(quickView(page, 'Archive PNG')).toBeVisible();
  await expect(page.locator('article').first().getByRole('button', { name: 'Quick view Archive PNG', exact: true })).toBeVisible();
  await expect(page.getByText('bounded candidate set, not the full Archive match count', { exact: false })).toBeVisible();
  await page.getByText('Matched description', { exact: true }).first().click();
  await expect(page.getByText('Original description', { exact: true }).first()).toBeVisible();
  expect(searches.at(-1)!.searchParams.get('mode')).toBe('semantic');
  expect(searches.at(-1)!.searchParams.has('sort')).toBe(false);
  const semanticUrl = page.url();
  await screenshot(page, info, 'native-semantic-model-results-and-excerpt');

  await search(page, 'hybrid', 'silver forest');
  await expect(quickView(page, 'Archive JSON').first()).toBeVisible();
  await expect(page.getByText('40% semantic weight', { exact: false })).toBeVisible();
  expect(searches.at(-1)!.searchParams.get('mode')).toBe('hybrid');
  await page.reload();
  await expect(page.getByLabel('Archive search mode', { exact: true })).toHaveValue('hybrid');
  await expect(page.getByLabel('Archive query', { exact: true })).toHaveValue('silver forest');
  await expect(quickView(page, 'Archive JSON').first()).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(semanticUrl);
  await expect(page.getByLabel('Archive search mode', { exact: true })).toHaveValue('semantic');
  await expect(page.locator('article').first().getByRole('button', { name: 'Quick view Archive PNG', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(booleanUrl);
  await expect(page.getByLabel('Archive query', { exact: true })).toHaveValue('"silver forest" AND NOT ocean');
  await expect(quickView(page, 'Archive PNG')).toHaveCount(0);
});

test('filter-only browsing is explicit; invalid filters and embedding failures stay actionable', async ({ page, diagnostics }, info) => {
  await page.goto('/archive');
  await expect(quickView(page, 'Archive PNG')).toBeVisible();
  await page.getByText('Filters and saved searches', { exact: true }).click();
  await page.getByLabel('Archive search mode', { exact: true }).selectOption('browse');
  await page.getByLabel('Archive typed filter', { exact: true }).fill('source = "ct"');
  const filtering = page.waitForResponse((response) => isList(response.url()) && new URL(response.url()).searchParams.get('mode') === 'browse');
  await page.getByRole('button', { name: 'Search Archive', exact: true }).click();
  const filtered = await filtering;
  expect(filtered.ok(), await filtered.text()).toBe(true);
  expect(new URL(filtered.url()).searchParams.get('filter')).toBe('source = "ct"');
  expect(new URL(filtered.url()).searchParams.has('q')).toBe(false);
  await expect(page.locator('article')).toHaveCount(1);
  await expect(page.locator('article').getByText('CT', { exact: true })).toBeVisible();
  await expect(page.getByText('Applied filter:', { exact: false })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, info, 'native-typed-filter-mobile');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.getByLabel('Archive query', { exact: true }).fill('leftover text');
  await page.getByRole('button', { name: 'Search Archive', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Indexed filters only does not search card text. Clear the query');
  await expect(page.locator('article')).toHaveCount(0);
  await page.getByLabel('Archive query', { exact: true }).fill('');
  await page.getByLabel('Archive typed filter', { exact: true }).fill('notAField = 3');
  diagnostics.expectedStatuses.add(400);
  await page.getByRole('button', { name: 'Search Archive', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/field|filter/i);
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await expect(page.locator('article')).toHaveCount(0);

  await page.getByRole('button', { name: 'Clear filters and query', exact: true }).click();
  await expect(quickView(page, 'Archive PNG')).toBeVisible();
  diagnostics.expectedStatuses.add(503);
  await search(page, 'semantic', 'provider failure');
  await expect(page.getByRole('alert')).toContainText(/embedding|provider|unavailable/i);
  await expect(page.locator('article')).toHaveCount(0);
  await screenshot(page, info, 'native-provider-failure-no-lexical-fallback');
  await search(page, 'semantic', 'ocean keeper');
  await expect(quickView(page, 'Archive PNG')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a withdrawn semantic capability invalidates results and never runs a lexical fallback', async ({ page }, info) => {
  let withdrawn = false;
  let textRequests = 0;
  page.on('request', (request) => { if (isList(request.url()) && new URL(request.url()).searchParams.has('q')) textRequests++; });
  await page.route('**/archive/v2/status', async (route) => {
    const response = await route.fetch();
    if (!withdrawn) { await route.fulfill({ response }); return; }
    const status = await response.json();
    status.capabilities.semantic = false;
    delete status.capabilities.embedding;
    await route.fulfill({ response, json: status });
  });
  await page.goto('/archive?search=ocean+keeper&archiveMode=semantic');
  await expect(quickView(page, 'Archive PNG')).toBeVisible();
  const prior = textRequests;
  withdrawn = true;
  await page.getByRole('button', { name: 'Refresh capabilities', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Semantic is unavailable. Choose another mode and search again.');
  await expect(page.getByRole('option', { name: 'Semantic (unavailable)', exact: true })).toHaveAttribute('disabled', '');
  await expect(page.locator('article')).toHaveCount(0);
  expect(textRequests).toBe(prior);
  await screenshot(page, info, 'native-withdrawn-semantic-no-stale-results');
  withdrawn = false;
  await page.getByRole('button', { name: 'Refresh capabilities', exact: true }).click();
  await expect(quickView(page, 'Archive PNG')).toBeVisible();
  await expect(page.getByRole('option', { name: 'Semantic', exact: true })).toBeEnabled();
});

test('explicit result paging carries snapshots and keeps excerpts aligned; stale pages preserve prior results', async ({ page, diagnostics }, info) => {
  const snapshot = 'a'.repeat(64);
  const requests: URL[] = [];
  let failedPage = true;
  let seed: SeedPage | null = null;
  await page.route('**/archive/v2/cards?**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('q') !== 'fixture paging') { await route.continue(); return; }
    requests.push(url);
    const offset = Number(url.searchParams.get('offset'));
    if (offset > 0 && failedPage) {
      await route.fulfill({ status: 409, contentType: 'application/json', json: { error: { code: 'SEARCH_CHANGED', message: 'Archive search snapshot changed. Search again before loading more.' } } });
      return;
    }
    if (!seed) {
      const response = await route.fetch();
      expect(response.ok(), await response.text()).toBe(true);
      seed = await response.json() as SeedPage;
      // Earlier workflows legitimately leave searchable Unity forks in the
      // workspace. This controlled Archive fixture must not inherit their owned
      // routing contract (View instead of Quick view) or real library IDs.
      seed.cards = seed.cards.filter((card) => card.libraryOwned !== true);
      expect(seed.cards.length).toBeGreaterThan(0);
    }
    const end = Math.min(52, offset + Number(url.searchParams.get('limit')));
    const indices = Array.from({ length: end - offset }, (_, index) => offset + index);
    await route.fulfill({ status: 200, contentType: 'application/json', json: {
      cards: indices.map((index) => ({ ...seed!.cards[0]!, id: `paging-${index}`, name: `Search page ${index + 1}`, libraryCardId: null })),
      total: 52, complete: false, snapshot,
      matches: indices.map((index) => ({ section: 'description', text: `Aligned excerpt ${index + 1}`, score: 1 / (index + 1) })),
      scores: indices.map((index) => 1 / (index + 1)),
    } });
  });
  diagnostics.expectedStatuses.add(409);
  await page.goto('/archive?search=fixture+paging&archiveMode=semantic');
  await expect(page.locator('article')).toHaveCount(48);
  await expect(page.getByRole('button', { name: 'Load more (48 of 52 candidates)', exact: true })).toBeVisible();
  expect(requests[0]!.searchParams.has('snapshot')).toBe(false);
  await page.getByRole('button', { name: 'Load more (48 of 52 candidates)', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Archive search snapshot changed');
  await expect(page.locator('article')).toHaveCount(48);
  expect(requests.at(-1)!.searchParams.get('snapshot')).toBe(snapshot);
  expect(requests.at(-1)!.searchParams.get('offset')).toBe('48');
  failedPage = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Load more (48 of 52 candidates)', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Load more (48 of 52 candidates)', exact: true }).click();
  await expect(page.locator('article')).toHaveCount(52);
  await expect(page.getByRole('button', { name: /^Load more/ })).toHaveCount(0);
  const last = page.locator('article').filter({ has: quickView(page, 'Search page 52') }).locator('..');
  await last.getByText('Matched description', { exact: true }).click();
  await expect(last.getByText('Aligned excerpt 52', { exact: true })).toBeVisible();
  await screenshot(page, info, 'native-paged-excerpt-alignment');
});

test('a page containing only stale owned hits advances its consumed cursor and exposes explicit paging', async ({ page }, info) => {
  const snapshot = 'b'.repeat(64);
  const requests: URL[] = [];
  let seed: SeedPage | null = null;
  await page.route('**/archive/v2/cards?**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('q') !== 'stale owner paging') { await route.continue(); return; }
    requests.push(url);
    if (!seed) {
      const response = await route.fetch();
      expect(response.ok(), await response.text()).toBe(true);
      seed = await response.json() as SeedPage;
      seed.cards = seed.cards.filter((card) => card.libraryOwned !== true);
      expect(seed.cards.length).toBeGreaterThan(0);
    }
    const offset = Number(url.searchParams.get('offset'));
    expect([0, 48]).toContain(offset);
    await route.fulfill({ status: 200, contentType: 'application/json', json: offset === 0 ? {
      cards: [], total: 49, nextOffset: 48, staleLibraryHits: 48, complete: false, snapshot, matches: [], scores: [],
    } : {
      cards: [seed.cards[0]], total: 49, nextOffset: 49, staleLibraryHits: 0, complete: true, snapshot,
      matches: [{ section: 'description', text: 'Visible excerpt after 48 stale saved-card results', score: 0.9 }], scores: [0.9],
    } });
  });
  await page.goto('/archive?search=stale+owner+paging&archiveMode=semantic');
  await expect(page.getByRole('button', { name: 'Load more (0 of 49 candidates)', exact: true })).toBeVisible();
  await expect(page.getByText('48 stale saved-card results were hidden while indexing catches up.', { exact: false })).toBeVisible();
  await expect(page.getByText('No Archive cards match these filters', { exact: true })).toHaveCount(0);
  await expect(page.locator('article')).toHaveCount(0);
  expect(requests.map((request) => request.searchParams.get('offset'))).toEqual(['0']);
  await page.getByRole('button', { name: 'Load more (0 of 49 candidates)', exact: true }).click();
  await expect(page.locator('article')).toHaveCount(1);
  await expect(page.locator('article').getByRole('button', { name: /^Quick view Archive / })).toBeVisible();
  await page.getByText('Matched description', { exact: true }).click();
  await expect(page.getByText('Visible excerpt after 48 stale saved-card results', { exact: true })).toBeVisible();
  await expect(page.getByText('48 stale saved-card results were hidden while indexing catches up.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Load more/ })).toHaveCount(0);
  expect(requests.map((request) => request.searchParams.get('offset'))).toEqual(['0', '48']);
  expect(requests[1]!.searchParams.get('snapshot')).toBe(snapshot);
  await screenshot(page, info, 'native-stale-owned-page-cursor-and-excerpt');
});
