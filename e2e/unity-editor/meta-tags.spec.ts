import { freshWorkspace, expect, screenshot, test } from './fixtures.js';
import type { Page } from '@playwright/test';
import type { MetaTagCatalog } from '../../packages/store/src/meta-tags.js';

async function saveCatalog(page: Page) {
  const pending = page.waitForResponse((response) => response.url().endsWith('/meta-tags') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save Meta-tags', exact: true }).click();
  const response = await pending;
  expect(response.ok(), await response.text()).toBe(true);
  await expect(page.getByRole('button', { name: 'Save Meta-tags', exact: true })).toBeDisabled();
  return { catalog: await response.json() as MetaTagCatalog, path: new URL(response.url()).pathname };
}
async function member(page: Page, value: string) {
  const input = page.getByRole('combobox', { name: 'Member tags', exact: true });
  await input.fill(value); await input.press('Enter');
}

test('Meta-tags save explicit groups, correct members and filter Library/Archive without rewriting cards', async ({ page, diagnostics }, info) => {
  await freshWorkspace(page);
  const cardWrites: string[] = [];
  page.on('request', (request) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && /\/(?:asset-revisions|revisions|fork-assets|imports|assets)(?:\?|$)/.test(request.url())) cardWrites.push(request.url());
  });
  await page.getByRole('link', { name: 'Meta-tags', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Meta-tags', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create Meta-tag', exact: true }).click();
  await page.getByLabel('Meta-tag name', { exact: true }).fill('Fantasy Guild');
  await member(page, 'browser-regression-typo');
  const first = await saveCatalog(page), id = first.catalog.groups[0]!.id;
  expect(first.catalog.groups[0]).toMatchObject({ name: 'Fantasy Guild', members: ['browser-regression-typo'] });
  await page.reload();
  await expect(page.getByLabel('Meta-tag name', { exact: true })).toHaveValue('Fantasy Guild');
  await expect(page.getByRole('button', { name: 'Remove browser-regression-typo', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove browser-regression-typo', exact: true }).click();
  await member(page, 'browser-regression');
  const corrected = await saveCatalog(page);
  expect(corrected.catalog.groups[0]).toEqual({ id, name: 'Fantasy Guild', members: ['browser-regression'] });
  await screenshot(page, info, 'native-meta-tag-editor-explicit-save');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, info, 'native-meta-tag-editor-mobile');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.getByRole('link', { name: 'Archive', exact: true }).click();
  await page.getByText('Filters and saved searches', { exact: true }).click();
  await page.getByLabel('Include Meta-tags', { exact: true }).selectOption(id);
  const query = page.waitForResponse((response) => /\/archive\/v2\/cards$/.test(new URL(response.url()).pathname)
    && new URL(response.url()).searchParams.has('tagGroups'));
  await page.getByRole('button', { name: 'Search Archive', exact: true }).click();
  expect((await query).ok()).toBe(true);
  await expect(page).toHaveURL(new RegExp(`metaTags=${id}`));
  const tile = page.locator('article').filter({ has: page.getByRole('button', { name: 'Quick view Archive PNG', exact: true }) });
  await expect(tile).toBeVisible();
  await tile.getByRole('button', { name: '+ Library', exact: true }).click();
  await expect(tile.getByRole('link', { name: 'In library ✓', exact: true })).toBeVisible();
  await screenshot(page, info, 'native-meta-tag-archive-filter');
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await page.getByLabel('Include Meta-tags', { exact: true }).selectOption(id);
  await expect(page.getByRole('button', { name: 'Quick view Archive PNG', exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`metaTags=${id}`));
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, info, 'native-meta-tag-library-filter-mobile');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Remove include meta-tags: Fantasy Guild', exact: true }).click();
  await page.getByLabel('Exclude Meta-tags', { exact: true }).selectOption(id);
  await expect(page.getByText('No cards match these filters', { exact: true })).toBeVisible();

  await page.goto('/meta-tags');
  await expect(page.getByLabel('Meta-tag name', { exact: true })).toHaveValue('Fantasy Guild');
  await page.getByLabel('Meta-tag name', { exact: true }).fill('Renamed Fantasy Guild');
  expect((await saveCatalog(page)).catalog.groups[0]!.id).toBe(id);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete Meta-tag', exact: true }).click();
  expect((await saveCatalog(page)).catalog.groups).toEqual([]);
  diagnostics.expectedStatuses.add(400);
  await page.goto(`/?metaTags=${id}`);
  await expect(page.getByRole('alert').filter({ hasText: /selected meta-tag.*no longer/i })).toBeVisible();
  await expect(page.getByText(`Unavailable Meta-tag: ${id}`, { exact: true })).toBeVisible();
  expect(cardWrites).toEqual([]);
});

test('legacy Meta-tag imports require review and Save; stale writes preserve the draft for explicit reload', async ({ page, diagnostics }, info) => {
  await freshWorkspace(page);
  await page.getByRole('link', { name: 'Meta-tags', exact: true }).click();
  let writes = 0;
  page.on('request', (request) => { if (request.url().endsWith('/meta-tags') && request.method() === 'PUT') writes++; });
  const bytes = Buffer.from(JSON.stringify({ Heroic: ['hero', 'champion'] }));
  async function importLegacy() {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import legacy JSON…', exact: true }).click();
    await (await chooser).setFiles({ name: 'tag-aliases.json', mimeType: 'application/json', buffer: bytes });
  }
  await importLegacy();
  const review = page.getByRole('dialog', { name: 'Review legacy Meta-tag import', exact: true });
  await expect(review).toContainText('reverse/fuzzy alias behavior is not enabled');
  await screenshot(page, info, 'native-meta-tag-import-review');
  await review.getByRole('button', { name: 'Cancel import', exact: true }).click();
  expect(writes).toBe(0);
  await importLegacy();
  await review.getByRole('button', { name: 'Apply import to draft', exact: true }).click();
  await expect(page.getByLabel('Meta-tag name', { exact: true })).toHaveValue('Heroic');
  expect(writes).toBe(0);
  await screenshot(page, info, 'native-meta-tag-reviewed-import-draft');
  const saved = await saveCatalog(page);
  const received = await page.request.put(saved.path, { headers: { origin: 'http://127.0.0.1:19430', 'x-unity-actor': 'local' }, data: {
    expectedVersion: saved.catalog.version, groups: [...saved.catalog.groups, { id: 'concurrent-group', name: 'Concurrent group', members: ['keeper'] }],
  } });
  expect(received.ok(), await received.text()).toBe(true);
  await page.getByLabel('Meta-tag name', { exact: true }).fill('My unsaved Heroic rename');
  diagnostics.expectedStatuses.add(409);
  await page.getByRole('button', { name: 'Save Meta-tags', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Your draft has not been discarded');
  await expect(page.getByLabel('Meta-tag name', { exact: true })).toHaveValue('My unsaved Heroic rename');
  await screenshot(page, info, 'native-meta-tag-stale-save-retains-draft');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reload latest catalog', exact: true }).click();
  await expect(page.getByLabel('Meta-tag name', { exact: true })).toHaveValue('Heroic');
  await expect(page.getByRole('button', { name: 'Concurrent group 1 member', exact: true })).toBeVisible();
  await page.getByLabel('Meta-tag name', { exact: true }).fill('Discard this draft');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Cancel changes', exact: true }).click();
  await expect(page.getByLabel('Meta-tag name', { exact: true })).toHaveValue('Heroic');
  const oversized = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import legacy JSON…', exact: true }).click();
  await (await oversized).setFiles({ name: 'oversized-aliases.json', mimeType: 'application/json', buffer: Buffer.alloc(256 * 1024 + 1, 32) });
  await expect(page.getByRole('alert')).toContainText('256 KiB');
  await expect(page.getByLabel('Meta-tag name', { exact: true })).toHaveValue('Heroic');
});

test('dense Meta-tag members and a valid 128-character tag remain editable within a mobile viewport', async ({ page }, info) => {
  await freshWorkspace(page);
  await page.getByRole('link', { name: 'Meta-tags', exact: true }).click();
  await page.getByRole('button', { name: 'Create Meta-tag', exact: true }).click();
  await page.getByLabel('Meta-tag name', { exact: true }).fill('Fantasy Guild');
  const members = ['elves', 'wizards', 'adventurers', 'enchanted-forest', 'X'.repeat(128)];
  for (const value of members) await member(page, value);
  await page.setViewportSize({ width: 390, height: 844 });
  const editor = page.getByRole('region', { name: 'Selected Meta-tag', exact: true });
  await editor.scrollIntoViewIfNeeded();
  await expect(editor.getByRole('button', { name: `Remove ${members[4]}`, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const longChip = editor.getByRole('button', { name: `Remove ${members[4]}`, exact: true }).locator('..');
  expect(await longChip.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= innerWidth && element.scrollWidth <= element.clientWidth;
  }), 'The complete nonbreaking tag and its Remove control fit without clipping').toBe(true);
  const preview = editor.getByRole('heading', { name: 'Matches any of these exact tags', exact: true }).locator('..').getByText(members[4]!, { exact: true });
  expect(await preview.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= innerWidth && element.scrollWidth <= element.clientWidth;
  }), 'The same full tag also fits the OR-group preview').toBe(true);
  await screenshot(page, info, 'native-meta-tag-five-members-long-tag-mobile');
  await editor.getByRole('button', { name: 'Remove enchanted-forest', exact: true }).click();
  await member(page, 'enchanted-forest-revised');
  const saved = await saveCatalog(page);
  expect(saved.catalog.groups[0]!.members).toEqual(['elves', 'wizards', 'adventurers', members[4], 'enchanted-forest-revised']);
  await page.reload();
  await expect(page.getByLabel('Meta-tag name', { exact: true })).toHaveValue('Fantasy Guild');
  await expect(page.getByRole('button', { name: `Remove ${members[4]}`, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('unsaved Meta-tag drafts survive internal navigation in the same workspace until explicit cancel', async ({ page }, info) => {
  await freshWorkspace(page);
  let writes = 0;
  page.on('request', (request) => { if (request.url().endsWith('/meta-tags') && request.method() === 'PUT') writes++; });
  await page.getByRole('link', { name: 'Meta-tags', exact: true }).click();
  await page.getByRole('button', { name: 'Create Meta-tag', exact: true }).click();
  await page.getByLabel('Meta-tag name', { exact: true }).fill('Travelling Fantasy Guild');
  await member(page, 'elves');
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await page.getByRole('link', { name: 'Meta-tags', exact: true }).click();
  await expect(page.getByLabel('Meta-tag name', { exact: true })).toHaveValue('Travelling Fantasy Guild');
  await expect(page.getByRole('button', { name: 'Remove elves', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Recovered your unsaved Meta-tag draft');
  expect(writes).toBe(0);
  await screenshot(page, info, 'native-meta-tag-navigation-keeps-unsaved-session-draft');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Cancel changes', exact: true }).click();
  await expect(page.getByLabel('Meta-tag name', { exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await page.getByRole('link', { name: 'Meta-tags', exact: true }).click();
  await expect(page.getByText('No Meta-tags yet. Create one or review a legacy JSON import.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Meta-tag name', { exact: true })).toHaveCount(0);
  expect(writes).toBe(0);
});

test('Meta-tag member editing uses the same ASCII-only equivalence as persisted search groups', async ({ page }) => {
  await freshWorkspace(page);
  await page.getByRole('link', { name: 'Meta-tags', exact: true }).click();
  await page.getByRole('button', { name: 'Create Meta-tag', exact: true }).click();
  await page.getByLabel('Meta-tag name', { exact: true }).fill('Unicode members');
  await member(page, 'ÉLF');
  await member(page, 'élf');
  await expect(page.getByRole('button', { name: 'Remove ÉLF', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove élf', exact: true })).toBeVisible();
  expect((await saveCatalog(page)).catalog.groups[0]!.members).toEqual(['ÉLF', 'élf']);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Remove ÉLF', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove élf', exact: true })).toBeVisible();
});

test('pending legacy file reads cannot race Save or replace a newer reviewed import', async ({ page }, info) => {
  await page.addInitScript(() => {
    const original = File.prototype.text;
    const pending = new Map<string, () => void>();
    File.prototype.text = async function () {
      const text = await original.call(this);
      if (!this.name.startsWith('delayed-')) return text;
      return new Promise<string>((resolve) => pending.set(this.name, () => { pending.delete(this.name); resolve(text); }));
    };
    Object.assign(window, { pendingMetaTagFiles: pending, releaseMetaTagFile: (name: string) => pending.get(name)?.() });
  });
  await freshWorkspace(page);
  await page.getByRole('link', { name: 'Meta-tags', exact: true }).click();
  await page.getByRole('button', { name: 'Create Meta-tag', exact: true }).click();
  await page.getByLabel('Meta-tag name', { exact: true }).fill('Existing draft');
  await member(page, 'elves');
  async function choose(name: string, groups: Record<string, string[]>) {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import legacy JSON…', exact: true }).click();
    await (await chooser).setFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(groups)) });
  }
  await choose('delayed-older.json', { Older: ['old-member'] });
  await expect(page.getByRole('status')).toContainText('Reading legacy Meta-tag JSON');
  await expect.poll(() => page.evaluate(() => (window as unknown as { pendingMetaTagFiles: Map<string, unknown> }).pendingMetaTagFiles.has('delayed-older.json'))).toBe(true);
  await expect(page.getByRole('button', { name: 'Save Meta-tags', exact: true })).toBeDisabled();
  await choose('newer.json', { Newer: ['new-member'] });
  const review = page.getByRole('dialog', { name: 'Review legacy Meta-tag import', exact: true });
  await expect(review).toContainText('newer.json');
  await review.getByRole('button', { name: 'Apply import to draft', exact: true }).click();
  let releaseSave!: () => void;
  const held = new Promise<void>((resolve) => { releaseSave = resolve; });
  await page.route('**/meta-tags', async (route) => { if (route.request().method() === 'PUT') await held; await route.continue(); });
  const saving = page.waitForRequest((request) => request.url().endsWith('/meta-tags') && request.method() === 'PUT');
  const saved = page.waitForResponse((response) => response.url().endsWith('/meta-tags') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save Meta-tags', exact: true }).click();
  await saving;
  await page.evaluate(() => (window as unknown as { releaseMetaTagFile(name: string): void }).releaseMetaTagFile('delayed-older.json'));
  await expect.poll(() => page.evaluate(() => (window as unknown as { pendingMetaTagFiles: Map<string, unknown> }).pendingMetaTagFiles.size)).toBe(0);
  await expect(review).toHaveCount(0);
  releaseSave();
  const response = await saved;
  expect(response.ok(), await response.text()).toBe(true);
  expect((await response.json() as MetaTagCatalog).groups.map((group) => group.name)).toEqual(['Existing draft', 'Newer']);
  await expect(page.getByRole('button', { name: 'Save Meta-tags', exact: true })).toBeDisabled();
  await choose('delayed-cancelled.json', { Cancelled: ['cancelled-member'] });
  await expect(page.getByRole('status')).toContainText('Reading legacy Meta-tag JSON');
  await expect.poll(() => page.evaluate(() => (window as unknown as { pendingMetaTagFiles: Map<string, unknown> }).pendingMetaTagFiles.has('delayed-cancelled.json'))).toBe(true);
  await page.getByRole('button', { name: 'Cancel pending import', exact: true }).click();
  await page.evaluate(() => (window as unknown as { releaseMetaTagFile(name: string): void }).releaseMetaTagFile('delayed-cancelled.json'));
  await expect.poll(() => page.evaluate(() => (window as unknown as { pendingMetaTagFiles: Map<string, unknown> }).pendingMetaTagFiles.size)).toBe(0);
  await expect(review).toHaveCount(0);
  await screenshot(page, info, 'native-meta-tag-import-generation-fence');
});
