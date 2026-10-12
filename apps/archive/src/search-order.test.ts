import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { connect, Index, makeArrowTable } from '@lancedb/lancedb';
import { Field, Float64, Int64, Schema, Utf8 } from 'apache-arrow';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createArchiveClient } from '@character-unity/archive-client';
import type { IndexSearchSort, SearchRequest } from '@character-unity/archive-client';
import { openCopiedSearch } from './copied-search.js';
import { createArchiveIndex } from './read-source.js';
import { createArchiveApp } from './app.js';
import { createFixtureArchive } from './fixture.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'unity-search-order-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function inventory(directory: string, prefix = ''): Promise<{ path: string; sha256: string }[]> {
  const result: { path: string; sha256: string }[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (entry.isDirectory()) result.push(...await inventory(join(directory, entry.name), `${prefix}${entry.name}/`));
    else result.push({ path: `${prefix}${entry.name}`, sha256: createHash('sha256').update(await readFile(join(directory, entry.name))).digest('hex') });
  }
  return result;
}
async function fixture(rows: { id: string; searchText: string; [key: string]: unknown }[], schema: Schema) {
  const connection = await connect(join(root, 'index')); let version: number;
  try {
    const table = await connection.createTable('cards', makeArrowTable(rows, { schema }));
    try { await table.createIndex('searchText', { config: Index.fts({ withPosition: true }) }); version = await table.version(); }
    finally { table.close(); }
  } finally { connection.close(); }
  const manifest = { path: 'index', table: 'cards', version, files: await inventory(join(root, 'index')) };
  const backend = await openCopiedSearch(root, manifest, rows.map((row) => row.id));
  const metadata = createFixtureArchive('ordering', rows.map((row) => ({ id: row.id, title: `Title ${row.id}`, tags: ['b', 'd', 'f'].includes(row.id) ? ['keep'] : [],
    source: { provider: 'fixture', recordId: row.id, url: null }, assets: [],
    original: { mediaType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(row, (_, value: unknown) => typeof value === 'bigint' ? String(value) : value)) },
  })));
  let page = metadata.list({ limit: 100 }); const cards = [...page.cards];
  while (page.nextCursor) { page = metadata.list({ limit: 100, snapshot: page.snapshot, cursor: page.nextCursor }); cards.push(...page.cards); }
  const source = createArchiveIndex('ordering', cards, 'copy', () => { throw new Error('No object reads'); }, 'ordered-index', backend);
  const app = createArchiveApp(source), client = createArchiveClient('http://order.test', { fetch: async (input, init) => app.fetch(new Request(input, init)) });
  return { backend, source, app, client, manifest };
}
const baseFields = ['id', 'searchText'].map((name) => new Field(name, new Utf8(), false));

it('preserves all legacy field orders for text, Boolean and filter-only results, with deterministic ties, nulls and page cursors', async () => {
  const columns = {
    tokenCount: [20, 10, 20, 300, 5, null], starCount: [1, 7, 2, null, 7, 0], n_favorites: [9, 3, 1, 8, null, 4],
    nMessages: [4, null, 10, 3, 2, 8], nChats: [11, 7, null, 9, 4, 3], scoreComposite: [1.5, 1.1, 2.9, 2.9, null, -3],
    scoreVelocity: [0.5, 0.1, null, -1, 2, 3], engagementScore: [10, 8, 6, 4, 2, 0], engagementVelocity: [1, 2, 3, 4, 5, 6],
  };
  const modified = ['2026-01-01', '2025-02-01', '2027-01-01', null, '2026-01-01', '2026-03-01'];
  const created = ['2025-01-01', '2026-01-01', null, '2027-01-01', '2024-01-01', '2028-01-01'];
  const rows = [...'abcdef'].map((id, index) => ({ id, searchText: 'signal '.repeat(6 - index), lastModified: modified[index], createdAt: created[index],
    ...Object.fromEntries(Object.entries(columns).map(([name, values]) => [name, values[index]])),
  }));
  const schema = new Schema([...baseFields, ...['lastModified', 'createdAt'].map((name) => new Field(name, new Utf8(), true)),
    ...Object.keys(columns).map((name) => new Field(name, new Float64(), true))]);
  const { client, source, backend, manifest } = await fixture(rows, schema), before = await inventory(root);
  const expected: [IndexSearchSort, string][] = [
    ['new', 'cfeabd'], ['old', 'baefcd'], ['create_new', 'fdbaec'], ['create_old', 'eabdfc'],
    ['tokens_desc', 'dcabef'], ['tokens_asc', 'ebacdf'], ['most_stars_desc', 'ebcafd'], ['most_stars_asc', 'facbed'],
    ['most_favs_desc', 'adfbce'], ['most_favs_asc', 'cbfdae'], ['most_msgs_desc', 'cfadeb'], ['most_msgs_asc', 'edafcb'],
    ['most_chats_desc', 'adbefc'], ['most_chats_asc', 'febdac'], ['overall_rating_desc', 'dcabfe'], ['overall_rating_asc', 'fbacde'],
    ['trending_desc', 'feabdc'], ['trending_asc', 'dbaefc'], ['engagement_desc', 'abcdef'], ['engagement_asc', 'fedcba'],
    ['fresh_engagement_desc', 'fedcba'], ['fresh_engagement_asc', 'abcdef'],
  ];
  expect((await client.status()).sorts).toEqual(expected.map(([sort]) => sort));
  expect((await client.status()).browse).toBe('lance-filter-v1');
  for (const [sort, ids] of expected) for (const query of [{ text: 'signal' }, { text: 'signal AND NOT absent' }, { text: '', mode: 'browse' as const }]) {
    let page = await client.search({ ...query, sort, limit: 2 }); const found = page.cards.map((card) => card.id);
    expect(page.total).toBe(6);
    if (query.mode === 'browse') expect(page.scores).toEqual([0, 0]);
    while (page.nextCursor) { page = await client.search({ ...query, sort, limit: 2, snapshot: page.snapshot, cursor: page.nextCursor }); found.push(...page.cards.map((card) => card.id)); }
    expect(found.join(''), `${query.text || 'browse'} / ${sort}`).toBe(ids);
  }
  const first = await client.search({ text: '', mode: 'browse', sort: 'tokens_desc', limit: 2 });
  for (const changed of [{ sort: 'tokens_asc' }, { text: 'signal', mode: 'text' }, { filter: 'tokenCount EXISTS' }, { tag: 'keep' }]) {
    await expect(client.search({ text: '', mode: 'browse', sort: 'tokens_desc', snapshot: first.snapshot, cursor: first.nextCursor!, ...changed } as SearchRequest)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }
  expect((await client.search({ text: '', mode: 'browse', sort: 'tokens_desc', tag: 'keep' })).cards.map((card) => card.id)).toEqual(['d', 'b', 'f']);
  expect((await client.search({ text: 'NOT absent', sort: 'tokens_asc', filter: 'tokenCount 10 TO 20' })).cards.map((card) => card.id)).toEqual(['b', 'a', 'c']);
  const reopened = await openCopiedSearch(root, manifest, rows.map((row) => row.id));
  expect([...await reopened.search('', '', 'tokens_desc', 'browse')]).toEqual([...await backend.search('', '', 'tokens_desc', 'browse')]);
  const metadata = source.list().cards;
  const unsupported = createArchiveIndex('old', metadata, 'copy', () => { throw new Error('unused'); }, '', { search: async () => new Map() });
  await expect(unsupported.search({ text: '', mode: 'browse' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(unsupported.search({ text: 'signal', sort: 'tokens_desc' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(await inventory(root)).toEqual(before);
});

it('orders and browses the full copied set beyond a response page, including a highest-valued row outside a native top-k window', async () => {
  const rows = Array.from({ length: 150 }, (_, index) => ({ id: String(index).padStart(3, '0'), searchText: index === 149 ? 'signal extra' : 'signal', tokenCount: index }));
  const { client } = await fixture(rows, new Schema([...baseFields, new Field('tokenCount', new Float64(), false)]));
  for (const query of [{ text: 'signal' }, { text: 'signal OR absent' }, { text: '', mode: 'browse' as const }]) {
    const page = await client.search({ ...query, sort: 'tokens_desc', limit: 1 });
    expect(page.total).toBe(150); expect(page.cards.map((card) => card.id)).toEqual(['149']);
    const next = await client.search({ ...query, sort: 'tokens_desc', limit: 100, snapshot: page.snapshot, cursor: page.nextCursor! });
    expect(next.cards[0]!.id).toBe('148'); expect(next.cards.at(-1)!.id).toBe('049');
    expect((await client.search({ ...query, sort: 'tokens_desc', limit: 100, snapshot: page.snapshot, cursor: next.nextCursor! })).cards.at(-1)!.id).toBe('000');
  }
});

it('advertises only orders backed by correctly typed fields and rejects unsupported modes and sorts', async () => {
  const { client, app } = await fixture([{ id: 'a', searchText: 'signal', tokenCount: '100', createdAt: 1 }],
    new Schema([...baseFields, new Field('tokenCount', new Utf8(), false), new Field('createdAt', new Float64(), false)]));
  expect((await client.status()).sorts).toEqual([]);
  for (const query of ['text=signal&sort=tokens_desc', 'text=signal&sort=create_new', 'text=signal&sort=constructor', 'mode=browse&sort=relevance', 'mode=browse&text=signal', 'mode=sql', 'mode=browse&mode=text']) {
    expect((await app.request(`/api/archive/v1/search?${query}`)).status, query).toBe(400);
  }
  expect((await client.search({ mode: 'browse', text: '' })).cards.map((card) => card.id)).toEqual(['a']);
  const status = await client.status();
  for (const extra of [{ browse: 'unknown' }, { sorts: ['unknown'] }, { sorts: ['new', 'new'] }, { search: undefined }]) {
    const bad = createArchiveClient('http://bad.test', { fetch: async () => Response.json({ ...status, ...extra }) });
    await expect(bad.status()).rejects.toMatchObject({ code: 'PROTOCOL' });
  }
});

it('sorts 64-bit integers beyond JavaScript number precision without collapsing adjacent values', async () => {
  const rows = [
    { id: 'a', searchText: 'signal', tokenCount: 9007199254740993n },
    { id: 'b', searchText: 'signal', tokenCount: 9007199254740992n },
    { id: 'c', searchText: 'signal', tokenCount: 9007199254740994n },
  ];
  const { client } = await fixture(rows, new Schema([...baseFields, new Field('tokenCount', new Int64(), false)]));
  expect((await client.status()).sorts).toEqual(['tokens_desc', 'tokens_asc']);
  for (const query of [{ text: 'signal' }, { text: '', mode: 'browse' as const }]) {
    expect((await client.search({ ...query, sort: 'tokens_desc' })).cards.map((card) => card.id)).toEqual(['c', 'a', 'b']);
    expect((await client.search({ ...query, sort: 'tokens_asc' })).cards.map((card) => card.id)).toEqual(['b', 'a', 'c']);
  }
});
