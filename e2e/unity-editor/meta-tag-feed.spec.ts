import { document, expect, freshWorkspace, test } from './fixtures.js';
import type { MetaTagCatalog } from '../../packages/store/src/meta-tags.js';

test('a superseded rule read cannot repin refreshed Library pages; a failed head retries from zero', async ({ page, diagnostics }) => {
  const workspace = await freshWorkspace(page);
  const base = `/api/workspaces/${workspace.id}`;
  const headers = { origin: 'http://127.0.0.1:19430', 'x-unity-actor': 'local' };
  // Real disposable-store imports make both rule snapshots exceed one page.
  for (const kind of ['Alpha', 'Beta']) for (let start = 0; start < 52; start += 8) {
    await Promise.all(Array.from({ length: Math.min(8, 52 - start) }, async (_, offset) => {
      const name = `${kind} ${String(start + offset).padStart(3, '0')}`, card = document(name);
      card.data.tags = [kind.toLowerCase()];
      const response = await page.request.post(`${base}/imports`, {
        headers: { ...headers, 'content-type': 'application/octet-stream', 'x-file-name': `${name}.json` },
        data: Buffer.from(JSON.stringify(card)),
      });
      expect(response.status(), await response.text()).toBe(201);
    }));
  }
  const metaPath = `${base}/meta-tags`;
  const first = await page.request.put(metaPath, { headers, data: { expectedVersion: 0,
    groups: [{ id: 'race-group', name: 'Fantasy Guild', members: ['alpha'] }] } });
  expect(first.ok()).toBe(true);
  const oldCatalog = await first.json() as MetaTagCatalog;
  // Keep the infinite-scroll sentinel below its 800px prefetch margin until
  // this test explicitly scrolls. A wide/tall viewport can prefetch all 52.
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto('/?metaTags=race-group&sort=name');
  await expect(page.getByRole('button', { name: 'Quick view Alpha 000', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more (48 of 52)', exact: true })).toBeAttached();

  let release!: () => void, started!: () => void, finished!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const held = new Promise<void>((resolve) => { started = resolve; });
  const fulfilled = new Promise<void>((resolve) => { finished = resolve; });
  let reads = 0;
  await page.route(`**${metaPath}`, async (route) => {
    if (route.request().method() !== 'GET' || ++reads !== 1) return route.continue();
    started(); await hold;
    try { await route.fulfill({ json: oldCatalog }); }
    finally { finished(); }
  });
  const tile = (name: string) => page.locator('article').filter({ has: page.getByRole('button', { name: `Quick view ${name}`, exact: true }) });
  try {
    await tile('Alpha 000').getByTitle('Add to favorites', { exact: true }).click();
    await held;
    const updated = await page.request.put(metaPath, { headers, data: { expectedVersion: oldCatalog.version,
      groups: [{ id: 'race-group', name: 'Fantasy Guild', members: ['beta'] }] } });
    expect(updated.ok()).toBe(true);
    await tile('Alpha 001').getByTitle('Add to favorites', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Quick view Beta 000', exact: true })).toBeVisible();
    release(); await fulfilled;
    const pagedRules: unknown[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === `${base}/card-summaries` && Number(url.searchParams.get('offset')) > 0) {
        pagedRules.push(JSON.parse(url.searchParams.get('tagGroups')!));
      }
    });
    await page.mouse.wheel(0, 30_000);
    await expect(page.getByRole('button', { name: 'Quick view Beta 051', exact: true })).toBeVisible();
    expect(pagedRules.length).toBeGreaterThan(0);
    for (const groups of pagedRules) expect(groups).toEqual([['Fantasy Guild', 'beta']]);
    await expect(page.getByRole('button', { name: /^Quick view Alpha / })).toHaveCount(0);

    // The entire remembered result is now loaded. A failed refreshed head must
    // clear it: Retry cannot append a new rule snapshot or dead-end at hasMore=false.
    diagnostics.expectedStatuses.add(503);
    let failHead = true;
    const offsets: number[] = [];
    await page.route(`**${base}/card-summaries?**`, async (route) => {
      const params = new URL(route.request().url()).searchParams;
      // The independent all-library count also reads limit=1 on mutations.
      // Inject failure only into the grouped result feed, not that count.
      if (!params.has('tagGroups')) return route.continue();
      const offset = Number(params.get('offset') ?? 0); offsets.push(offset);
      if (failHead && offset === 0) {
        failHead = false;
        return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Injected first-range failure' } } });
      }
      return route.continue();
    });
    await page.mouse.wheel(0, -30_000);
    await tile('Beta 000').getByTitle('Add to favorites', { exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Injected first-range failure' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Quick view Beta / })).toHaveCount(0);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Quick view Beta 000', exact: true })).toBeVisible();
    expect(offsets.slice(0, 2)).toEqual([0, 0]);
  } finally { release(); }
});
