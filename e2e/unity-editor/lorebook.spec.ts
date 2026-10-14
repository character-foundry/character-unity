import { readFile } from 'node:fs/promises';
import { document as cardDocument, expect, importCard, save, screenshot, test } from './fixtures.js';

test('native lorebook editing preserves duplicate IDs, opaque numeric shapes and reviewed file replacements', async ({ page }, info) => {
  const name = 'Native lorebook parity';
  const book = { name: 'Existing book', scan_depth: 0, token_budget: 0, opaqueBook: [1, null], entries: [
    { id: 8, name: 'First', keys: ['sky, moon', ''], content: 'First content', insertion_order: -3, position: 7, extensions: { vendor: { keep: true } } },
    { id: 8, name: 'Second', keys: ['woods'], content: 'Second content', insertion_order: 0, enabled: false, probability: 0 },
    { name: 'Missing ID', keys: [], content: 'Third content', opaque: ['keep'] },
  ] };
  const original = Buffer.from(JSON.stringify({ ...cardDocument(name), data: { ...cardDocument(name).data, character_book: book } }));
  await page.goto('/');
  const received = page.waitForResponse((response) => response.url().endsWith('/imports') && response.request().method() === 'POST');
  const choosing = page.waitForEvent('filechooser'); await page.getByTitle('Import card files').click();
  await (await choosing).setFiles({ name: 'lorebook.json', mimeType: 'application/json', buffer: original });
  const response = await received, imported = await response.json();
  const path = response.url().replace(/\/imports$/, `/cards/${imported.card.id}`);
  await page.getByRole('button', { name: `Quick view ${name}`, exact: true }).click();
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Lorebook', exact: true }).click();
  await page.getByRole('button', { name: '2. Second Disabled', exact: true }).click();
  await expect(page.getByLabel('Probability (%)', { exact: true })).toHaveValue('0');
  await page.getByLabel('Entry content', { exact: true }).fill('Only second changes');
  await page.getByRole('button', { name: '1. First', exact: true }).click();
  await expect(page.getByLabel('Entry content', { exact: true })).toHaveValue('First content');
  await expect(page.getByText('Position has a value this form cannot edit. It will be preserved when saving.')).toBeVisible();
  await page.getByRole('button', { name: 'Copy entry', exact: true }).click();
  await expect(page.getByLabel('Entry name', { exact: true })).toHaveValue('First (copy)');
  await page.getByRole('button', { name: 'Move earlier', exact: true }).click();
  await page.getByRole('button', { name: 'Delete entry', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm delete entry', exact: true }).click();
  await save(page);
  const saved = await (await page.request.get(path)).json();
  expect(saved.revision.document.data.character_book).toEqual({ ...book, entries: [book.entries[0], { ...book.entries[1], content: 'Only second changes' }, book.entries[2]] });

  const next = { name: 'Imported places', scan_depth: 0, token_budget: 500, extensions: { vendor: [1, null] }, entries: [
    { id: 2, name: 'Observatory', keys: ['sky, moon'], content: 'Under the stars.', opaque: { retain: true } },
    { id: 2, name: 'Forest', keys: [], content: 'Woods', enabled: false, probability: 0 },
  ] };
  const file = { name: 'places.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(next)) };
  await page.getByLabel('Import lorebook JSON', { exact: true }).setInputFiles(file);
  const review = page.getByRole('region', { name: 'Lorebook import review', exact: true });
  await expect(review).toContainText('Imported places · 2 entries');
  await page.getByRole('button', { name: '1. First', exact: true }).click();
  await page.getByLabel('Entry content', { exact: true }).fill('Intervening draft edit');
  await expect(review.getByRole('button', { name: 'Replace draft lorebook', exact: true })).toBeDisabled();
  await expect(review).toContainText('The draft changed');
  await page.getByLabel('Import lorebook JSON', { exact: true }).setInputFiles(file);
  await review.scrollIntoViewIfNeeded();
  await screenshot(page, info, 'native-lorebook-import-review');
  await review.getByRole('button', { name: 'Replace draft lorebook', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download draft lorebook JSON', exact: true }).click();
  expect(JSON.parse(await readFile((await (await downloading).path())!, 'utf8'))).toEqual(next);
  await save(page);
  expect((await (await page.request.get(path)).json()).revision.document.data.character_book).toEqual(next);
  expect(await (await page.request.get(`${path}/original`)).body()).toEqual(original);
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, info, 'native-lorebook-mobile-initial');
  await page.getByRole('button', { name: '1. Observatory', exact: true }).click();
  await expect(page.getByLabel('Entry content', { exact: true })).toHaveValue('Under the stars.');
  await page.getByLabel('Entry content', { exact: true }).scrollIntoViewIfNeeded();
  await screenshot(page, info, 'native-lorebook-mobile-fields');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('library lorebook sources are searchable and paginated beyond the first hundred without saving on review', async ({ page }, info) => {
  const imported = await importCard(page, 'Paginated lorebook destination', 'json');
  const sources = Array.from({ length: 110 }, (_, index) => ({ id: `source-${index}`, name: `Source ${String(index + 1).padStart(3, '0')}` }));
  const requested: { limit: number; offset: number; query: string }[] = [];
  await page.route('**/card-summaries?*', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const limit = Number(params.get('limit')), offset = Number(params.get('offset')), query = params.get('q') ?? '';
    requested.push({ limit, offset, query });
    expect(params.get('has')).toBe('lorebook'); expect(params.get('sort')).toBe('name');
    const filtered = sources.filter((source) => source.name.includes(query));
    await route.fulfill({ json: { total: filtered.length, cards: filtered.slice(offset, offset + limit).map((source) => ({
      ...source, headRevisionId: `${source.id}-head`, spec: 'v3', tags: [], creator: '', favorite: false,
      createdAt: imported.card.createdAt, updatedAt: imported.revision.createdAt, hasPortrait: false,
    })) } });
  });
  const sourceBook = { name: 'Last paginated source', entries: [{ keys: ['distant'], content: 'Beyond the first hundred.', opaque: [0, false] }] };
  await page.route('**/cards/source-109', (route) => route.fulfill({ json: {
    card: { id: 'source-109', createdAt: imported.card.createdAt }, revision: { id: 'source-109-head', sequence: 7,
      document: { ...cardDocument('Source 110'), data: { ...cardDocument('Source 110').data, character_book: sourceBook } },
      assets: [], createdAt: imported.revision.createdAt },
  } }));
  await page.getByRole('button', { name: 'Lorebook', exact: true }).click();
  await page.getByRole('button', { name: 'Import from another card', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Import lorebook from another card', exact: true });
  await expect(dialog.getByRole('button', { name: 'Source 001', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Previous sources', exact: true })).toBeDisabled();
  await expect(dialog.getByText('Page 1 of 3', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Next sources', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Source 051', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Next sources', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Source 110', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Next sources', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Previous sources', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Source 051', exact: true })).toBeVisible();
  await dialog.getByLabel('Search source cards', { exact: true }).fill('Source 110');
  await dialog.getByRole('button', { name: 'Search sources', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Source 110', exact: true })).toBeVisible();
  await expect(dialog.getByText('Page 1 of 1', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Source 110', exact: true }).click();
  await expect(dialog.getByRole('region', { name: 'Library lorebook import review', exact: true })).toContainText('Last paginated source · 1 entry');
  await dialog.getByRole('button', { name: 'Cancel library import', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect((await (await page.request.get(imported.path)).json()).revision.id).toBe(imported.revision.id);

  await page.getByRole('button', { name: 'Import from another card', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Import lorebook from another card', exact: true });
  await dialog.getByLabel('Search source cards', { exact: true }).fill('Source 110');
  await dialog.getByRole('button', { name: 'Search sources', exact: true }).click();
  await dialog.getByRole('button', { name: 'Source 110', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, info, 'native-lorebook-paginated-source-review-mobile');
  await dialog.getByRole('button', { name: 'Replace draft lorebook', exact: true }).click();
  await save(page);
  expect((await (await page.request.get(imported.path)).json()).revision.document.data.character_book).toEqual(sourceBook);
  expect(await (await page.request.get(`${imported.path}/original`)).body()).toEqual(imported.bytes);
  expect(requested).toEqual(expect.arrayContaining([{ limit: 50, offset: 0, query: '' }, { limit: 50, offset: 50, query: '' },
    { limit: 50, offset: 100, query: '' }, { limit: 50, offset: 0, query: 'Source 110' }]));
  expect(requested.every((request) => request.limit <= 50)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
