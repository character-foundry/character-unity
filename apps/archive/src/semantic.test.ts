import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { connect, Index, makeArrowTable } from '@lancedb/lancedb';
import { Field, FixedSizeList, Float32, Schema, Utf8 } from 'apache-arrow';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createArchiveClient } from '@character-unity/archive-client';
import { openCopiedSearch } from './copied-search.js';
import { createArchiveIndex } from './read-source.js';
import { createArchiveApp } from './app.js';
import { createFixtureArchive } from './fixture.js';
import { hybridRank } from './semantic-search.js';
import { createQueryEmbedder } from './embeddings.js';
const space = { model: 'synthetic-v1', dimensions: 3, sourceDimensions: 3, queryInstruction: 'Find a character' };
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'unity-semantic-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function files(directory: string, prefix = ''): Promise<{ path: string; sha256: string }[]> {
  const result: { path: string; sha256: string }[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (entry.isDirectory()) result.push(...await files(join(directory, entry.name), `${prefix}${entry.name}/`));
    else result.push({ path: `${prefix}${entry.name}`, sha256: createHash('sha256').update(await readFile(join(directory, entry.name))).digest('hex') });
  } return result;
}
async function fixture(options: { rows?: { id: string; card_id: string; section: string; matchText: string; vector: number[] }[]; provider?: boolean } = {}) {
  const connection = await connect(join(root, 'index')); let lexicalVersion: number, vectorVersion: number;
  const cards = [{ id: 'a', name: 'Forest Knight', source: 'ct', searchText: 'forest silver knight' },
    { id: 'b', name: 'Ocean Pilot', source: 'ct', searchText: 'ocean silver pilot' },
    { id: 'c', name: 'Silver', source: 'other', searchText: 'silver archivist' },
    { id: 'd', name: 'Missing Vector', source: 'ct', searchText: 'silver missing vector' }];
  const vectors = options.rows ?? [
    { id: 'a-card', card_id: 'a', section: 'card', matchText: 'Forest knight', vector: [0, 1, 0] },
    { id: 'a-lore', card_id: 'a', section: 'lorebook', matchText: 'The silver gate\nopens in the forest.', vector: [1, 0, 0] },
    { id: 'b-card', card_id: 'b', section: 'card', matchText: 'Ocean pilot', vector: [0.8, 0.6, 0] },
    { id: 'c-card', card_id: 'c', section: 'card', matchText: 'Archivist', vector: [-1, 0, 0] },
  ];
  try {
    const table = await connection.createTable('cards', makeArrowTable(cards, { schema: new Schema(['id', 'name', 'source', 'searchText'].map((name) => new Field(name, new Utf8(), false))) }));
    try { await table.createIndex('searchText', { config: Index.fts({ withPosition: true }) }); lexicalVersion = await table.version(); } finally { table.close(); }
    const vector = await connection.createTable('vectors', makeArrowTable(vectors, { schema: new Schema([
      ...['id', 'card_id', 'section', 'matchText'].map((name) => new Field(name, new Utf8(), false)),
      new Field('vector', new FixedSizeList(3, new Field('item', new Float32(), false)), false),
    ]) }));
    try { vectorVersion = await vector.version(); } finally { vector.close(); }
  } finally { connection.close(); }
  const manifest = { path: 'index', table: 'cards', version: lexicalVersion, files: await files(join(root, 'index')),
    vector: { table: 'vectors', version: vectorVersion, space } };
  let vector = [1, 0, 0]; const requests: string[] = [];
  function embedder() { return createQueryEmbedder({ provider: 'openai', baseUrl: 'https://synthetic.invalid/v1', space }, '', async (_, init) => {
    requests.push(JSON.parse(String(init?.body)).input[0]); return Response.json({ model: space.model, data: [{ index: 0, embedding: vector }] });
  }); }
  const metadata = createFixtureArchive('semantic', cards.map((card) => ({ id: card.id, title: card.name, tags: [], source: { provider: card.source, recordId: card.id, url: null }, assets: [],
    original: { mediaType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(card)) },
  }))).list().cards;
  async function reopen() {
    const backend = await openCopiedSearch(root, manifest, cards.map((card) => card.id), options.provider === false ? undefined : embedder());
    const source = createArchiveIndex('semantic', metadata, 'copy', () => { throw new Error('No byte reads'); }, 'synthetic-semantic', backend);
    const app = createArchiveApp(source), client = createArchiveClient('http://semantic.test', { fetch: async (input, init) => app.fetch(new Request(input, init)) });
    return { source, client, app };
  }
  return { ...await reopen(), manifest, reopen, requests, changeVector: (next: number[]) => { vector = next; } };
}

it('reads exact cosine matches, deduplicates chunks before paging, preserves filters and verifies cursor stability after restart', async () => {
  const { client, manifest, reopen, changeVector, requests } = await fixture(), before = await files(root);
  expect((await client.status()).semantic).toEqual({ version: 'lance-cosine-v1', model: 'synthetic-v1', dimensions: 3, indexedCards: 3, indexedRows: 4 });
  const first = await client.search({ mode: 'semantic', text: 'silver', limit: 1 });
  expect(first).toMatchObject({ total: 3, cards: [{ id: 'a' }], scores: [1], matches: [{ section: 'lorebook', text: 'The silver gate\nopens in the forest.', score: 1 }] });
  const nextRequest = { mode: 'semantic' as const, text: 'silver', snapshot: first.snapshot, cursor: first.nextCursor!, limit: 2 };
  const next = await client.search(nextRequest); expect(next.cards.map((card) => card.id)).toEqual(['b', 'c']); expect(next.nextCursor).toBeNull();
  expect(next.scores[0]).toBeCloseTo(1 / 1.2, 5); expect(next.scores[1]).toBeCloseTo(1 / 3, 5);
  expect(requests).toEqual(['Instruct: Find a character\nQuery:silver']);
  expect((await (await reopen()).client.search(nextRequest)).cards.map((card) => card.id)).toEqual(['b', 'c']);
  expect((await client.search({ mode: 'semantic', text: 'silver', filter: 'source = ct', provider: 'other' })).total).toBe(0);
  expect((await client.search({ mode: 'semantic', text: 'silver', filter: 'id != a', provider: 'ct' })).cards.map((card) => card.id)).toEqual(['b']);
  expect((await client.search({ mode: 'hybrid', text: 'silver', semanticRatio: 0 })).cards.map((card) => card.id)).toContain('d');
  const hybrid = await client.search({ mode: 'hybrid', text: 'silver' });
  expect(hybrid.cards[0]!.id).toBe('c'); // Literal title outranks the nearest semantic-only title.
  expect(hybrid.total).toBe(4); expect(hybrid.matches![hybrid.cards.findIndex((card) => card.id === 'd')]).toBeNull();
  for (const text of ['forest AND NOT ocean', '"silver"']) await expect(client.search({ mode: 'hybrid', text })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(client.search({ ...nextRequest, mode: 'hybrid' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const ranked = await client.search({ mode: 'hybrid', text: 'silver', limit: 1, semanticRatio: 0.2 });
  await expect(client.search({ mode: 'hybrid', text: 'silver', snapshot: ranked.snapshot, cursor: ranked.nextCursor!, semanticRatio: 0.8 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  changeVector([0, 1, 0]);
  await expect((await reopen()).client.search(nextRequest)).rejects.toMatchObject({ code: 'SNAPSHOT_CHANGED' });
  expect(await files(root)).toEqual(before);
  await expect(openCopiedSearch(root, { ...manifest, vector: { ...manifest.vector, space: { ...space, dimensions: 2 } } }, ['a', 'b', 'c', 'd'])).rejects.toThrow(/schema/);
});

it('keeps semantic capability off without a provider and rejects model mismatch and invalid vector rows at startup', async () => {
  const { client, manifest } = await fixture({ provider: false });
  expect((await client.status()).semantic).toBeUndefined();
  await expect(client.search({ mode: 'semantic', text: 'silver' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  const wrong = createQueryEmbedder({ provider: 'ollama', baseUrl: 'http://127.0.0.1:1', space: { ...space, model: 'other' } });
  await expect(openCopiedSearch(root, manifest, ['a', 'b', 'c', 'd'], wrong)).rejects.toThrow(/space/);
  await expect(openCopiedSearch(root, manifest, ['a', 'b', 'c'])).rejects.toThrow(/selection/);
});

it('rejects zero vectors and vector rows outside the copied selection', async () => {
  await expect(fixture({ rows: [{ id: 'bad', card_id: 'z', section: 'card', matchText: '', vector: [0, 0, 0] }] })).rejects.toThrow(/selected/);
  await rm(join(root, 'index'), { recursive: true });
  await expect(fixture({ rows: [{ id: 'bad', card_id: 'a', section: 'card', matchText: '', vector: [0, 0, 0] }] })).rejects.toThrow(/nonzero/);
});

it('fuses independent ranking lists with legacy weights, stable vector-first ties and literal title priority', () => {
  const vector = new Map([['semantic-only', 1], ['shared', 0.8], ['title', 0.6]]), lexical = new Map([['keyword-only', 3], ['shared', 2], ['title', 1]]);
  expect([...hybridRank(vector, lexical, 1, 60, new Map(), 'query').keys()]).toEqual([...vector.keys()]);
  expect([...hybridRank(vector, lexical, 0, 60, new Map(), 'query').keys()]).toEqual([...lexical.keys()]);
  const result = hybridRank(vector, lexical, 0.5, 60, new Map(), 'query');
  expect([...result.keys()]).toEqual(['shared', 'title', 'semantic-only', 'keyword-only']);
  expect(result.get('shared')).toBeCloseTo(1 / 62, 12);
  expect([...hybridRank(vector, lexical, 0.5, 60, new Map([['title', 'The Heroes Party']]), 'heroes party').keys()][0]).toBe('title');
});

it('collects every vector row before deduplication instead of losing cards behind a chunk top-k window', async () => {
  const rows = Array.from({ length: 150 }, (_, i) => ({ id: `a-${i}`, card_id: 'a', section: 'lorebook', matchText: 'Repeated nearest chunk', vector: [1, 0, 0] }));
  rows.push({ id: 'b-1', card_id: 'b', section: 'card', matchText: 'Second card', vector: [0.8, 0.6, 0] });
  rows.push({ id: 'c-1', card_id: 'c', section: 'card', matchText: 'Third card', vector: [0, 1, 0] });
  const { client } = await fixture({ rows });
  const first = await client.search({ mode: 'semantic', text: 'query', limit: 1 });
  expect(first.total).toBe(3); expect(first.cards[0]!.id).toBe('a');
  const rest = await client.search({ mode: 'semantic', text: 'query', limit: 2, snapshot: first.snapshot, cursor: first.nextCursor! });
  expect(rest.cards.map((card) => card.id)).toEqual(['b', 'c']);
});

it('rejects malformed semantic matches and capabilities in the portable client', async () => {
  const { source } = await fixture(), page = await source.search({ mode: 'semantic', text: 'silver' });
  for (const matches of [undefined, [], [{ section: 'card', text: 'x', score: 2 }], [null, null]]) {
    const client = createArchiveClient('http://bad.test', { fetch: async () => Response.json({ ...page, matches }) });
    await expect(client.search({ mode: 'semantic', text: 'silver' })).rejects.toMatchObject({ code: 'PROTOCOL' });
  }
  for (const semantic of [{ ...source.status().semantic, dimensions: 0 }, { ...source.status().semantic, indexedCards: 5 }, { ...source.status().semantic, version: 'unknown' }]) {
    const client = createArchiveClient('http://bad.test', { fetch: async () => Response.json({ ...source.status(), semantic }) });
    await expect(client.status()).rejects.toMatchObject({ code: 'PROTOCOL' });
  }
});
