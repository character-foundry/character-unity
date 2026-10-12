import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { connect, Index, makeArrowTable } from '@lancedb/lancedb';
import { Bool, Field, Float64, List, Schema, Utf8 } from 'apache-arrow';
import { expect, it } from 'vitest';
import { createArchiveClient } from '@character-unity/archive-client';
import { openCopiedSearch } from './copied-search.js';
import { compileSearchFilter, searchFilterFields } from './search-filter.js';
import { createArchiveIndex } from './read-source.js';
import { createFixtureArchive } from './fixture.js';
import { createArchiveApp } from './app.js';

const schema = new Schema([
  ...['id', 'searchText', 'name', 'source', 'author', 'createdAt', 'platform_summary'].map((name) => new Field(name, new Utf8(), true)),
  new Field('tokenCount', new Float64(), true), new Field('hasLorebook', new Bool(), true),
  new Field('tags', new List(new Field('item', new Utf8(), true)), true),
]);
const fields = searchFilterFields(schema);
async function inventory(directory: string, prefix = ''): Promise<{ path: string; sha256: string }[]> {
  const result: { path: string; sha256: string }[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (entry.isDirectory()) result.push(...await inventory(join(directory, entry.name), `${prefix}${entry.name}/`));
    else result.push({ path: `${prefix}${entry.name}`, sha256: createHash('sha256').update(await readFile(join(directory, entry.name))).digest('hex') });
  }
  return result;
}

it('executes typed legacy filters, aliases and filtered NOT against a pinned native index through HTTP, with stable paging and unchanged bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unity-filter-'));
  try {
    const rows = [
      { id: '1', searchText: 'silver forest', name: 'Star: Pilot', source: 'CT', author: "O'Brien", createdAt: '2026-01-01', platform_summary: 'Bright', tokenCount: 1200, hasLorebook: true, tags: ['fantasy', "keeper's"] },
      { id: '2', searchText: 'silver ocean', name: 'Ocean', source: 'chub', author: 'Anonymous', createdAt: '2026-05-01', platform_summary: 'Deep', tokenCount: 2000, hasLorebook: false, tags: ['sci-fi'] },
      { id: '3', searchText: 'silver forest', name: 'Forest', source: 'ct', author: "x' OR true --", createdAt: '2025-01-01', platform_summary: null, tokenCount: 2500, hasLorebook: null, tags: ['gore'] },
      { id: '4', searchText: 'silver ocean', name: 'Other', source: 'risuai', author: "x\\' OR true --", createdAt: null, platform_summary: null, tokenCount: null, hasLorebook: true, tags: [] },
    ];
    const connection = await connect(join(root, 'index')); let version: number;
    try {
      const table = await connection.createTable('cards', makeArrowTable(rows, { schema }));
      try { await table.createIndex('searchText', { config: Index.fts({ withPosition: true }) }); version = await table.version(); }
      finally { table.close(); }
    } finally { connection.close(); }
    const before = await inventory(root);
    const manifest = { path: 'index', table: 'cards', version, files: await inventory(join(root, 'index')) };
    const backend = await openCopiedSearch(root, manifest, rows.map((row) => row.id));
    const cards = createFixtureArchive('filter', rows.map((row) => ({ id: row.id, title: row.name, tags: row.tags,
      source: { provider: row.source.toLowerCase(), recordId: row.id, url: null }, assets: [],
      original: { mediaType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(row)) },
    }))).list().cards;
    const source = createArchiveIndex('filter', cards, 'copy', () => { throw new Error('No object reads'); }, 'filter-copy', backend);
    const app = createArchiveApp(source), client = createArchiveClient('http://filter.test', { fetch: async (input, init) => app.fetch(new Request(input, init)) });
    expect((await client.status()).filterFields).toEqual(fields);
    for (const [filter, ids] of [
      ['hasLorebook = true AND tokenCount >= 1200 AND source = "ct"', ['1']],
      ['(tags = "fantasy" OR tags = "sci-fi") AND NOT tags = "gore"', ['1', '2']],
      ['NOT (hasLorebook = true OR source = risuai)', ['2']],
      ['source IN ["ct", "chub"]', ['1', '2', '3']],
      ['tags IN ["fantasy", "sci-fi"]', ['1', '2']],
      ['tokenCount 1000 TO 2000', ['1', '2']],
      ['source NOT IN ["risuai", "chub"]', ['1', '3']],
      ['hasLorebook EXISTS', ['1', '2', '4']], ['hasLorebook NOT EXISTS', ['3']],
      ['name = "Star: Pilot"', ['1']], ['createdAt:2026-01-01', ['1']],
      ['createdAt 2026-01-01 TO 2026-12-31', ['1', '2']],
      ['author = "Anonymous"', ['2']], ['token_count:2500', ['3']], ['id:1', ['1']],
      ['platformSummary = bright', ['1']], ['author = "O\'Brien"', ['1']],
      ['author = "x\' OR true --"', ['3']], ['tags = "keeper\'s"', ['1']],
      ['name > forest AND name < star', ['2', '4']],
      ['source = ct OR source = chub AND tokenCount > 1500', ['1', '2', '3']],
      ['(source = ct OR source = chub) AND tokenCount > 1500', ['2', '3']],
    ] as const) expect((await client.search({ text: 'silver', filter, sort: 'id' })).cards.map((card) => card.id), filter).toEqual(ids);
    expect((await client.search({ text: 'silver', filter: `author = ${JSON.stringify(rows[3]!.author)}` })).cards.map((card) => card.id)).toEqual(['4']);
    expect((await client.search({ text: 'NOT forest', filter: 'tokenCount >= 1200' })).cards.map((card) => card.id)).toEqual(['2']);
    expect((await client.search({ text: 'forest OR NOT forest', filter: 'source = ct', provider: 'ct', tag: 'fantasy' })).cards.map((card) => card.id)).toEqual(['1']);
    const first = await client.search({ text: 'NOT missing', filter: 'tokenCount EXISTS', sort: 'id', limit: 2 });
    expect(first.cards.map((card) => card.id)).toEqual(['1', '2']); expect(first.total).toBe(3);
    const next = { text: 'NOT missing', filter: 'tokenCount EXISTS', sort: 'id' as const, snapshot: first.snapshot, cursor: first.nextCursor!, limit: 2 };
    expect((await client.search(next)).cards.map((card) => card.id)).toEqual(['3']);
    await expect(client.search({ ...next, filter: 'hasLorebook EXISTS' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    for (const filter of ['missing = 1', 'searchText = silver', 'tokenCount = nope', 'hasLorebook > true', 'tags 1 TO 2', 'id = 1 OR true', 'id = 1; DROP TABLE cards', 'name = "open', 'name IN []']) {
      await expect(client.search({ text: 'silver', filter })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect((await app.request('/api/archive/v1/search?text=silver&filter=id:1&filter=id:2')).status).toBe(400);
    expect((await openCopiedSearch(root, manifest, rows.map((row) => row.id))).filterFields).toEqual(fields);
    expect(await inventory(root)).toEqual(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('bounds filter parsing and SQL generation and rejects malformed typed values', () => {
  for (const raw of ['x'.repeat(4097), 'NOT '.repeat(33) + 'id:1', '('.repeat(33) + 'id:1' + ')'.repeat(33),
    'id:1 OR '.repeat(100) + 'id:2', `id IN [${Array(65).fill('1').join(',')}]`, 'id:1\n',
    'tokenCount = 99999999999999999999999999', 'tokenCount = NaN', 'tokenCount = 1e3', 'hasLorebook = "true"',
    'tokenCount = "2"', 'tags > x', 'id IN [1,]', 'id:1 AND', 'id NOT = 1', 'id:1 )', 'name = "a\\', 'id = \\']) {
    expect(() => compileSearchFilter(raw, fields), raw).toThrow();
  }
  expect(() => compileSearchFilter('constructor = 1', fields)).toThrow(/Unsupported/);
  expect(compileSearchFilter('', fields)).toBe('');
  const wrongSchema = new Schema([new Field('tags', new List(new Field('item', new Float64())), false), new Field('secret', new Utf8(), false)]);
  expect(searchFilterFields(wrongSchema)).toEqual([]);
});

it('rejects malformed or contradictory filter capabilities from a remote source', async () => {
  const envelope = { version: 'unity.archive-read.v1', archiveId: 'test', snapshot: 'a'.repeat(64), mode: 'copy', cardCount: 0 };
  for (const extra of [{ filterFields: [{ name: 'id', type: 'string' }] }, { search: 'lance-fts-v1', filterFields: [{ name: 'id', type: 'sql' }] },
    { search: 'lance-fts-v1', filterFields: [{ name: 'id', type: 'string' }, { name: 'id', type: 'string' }] }]) {
    const client = createArchiveClient('http://invalid.test', { fetch: async () => Response.json({ ...envelope, ...extra }) });
    await expect(client.status()).rejects.toMatchObject({ code: 'PROTOCOL' });
  }
});

it('omits an unused filter parameter for pre-filter read services', async () => {
  let requested: URL | undefined;
  const client = createArchiveClient('http://older.test', { fetch: async (url) => {
    requested = new URL(String(url));
    return Response.json({ version: 'unity.archive-read.v1', archiveId: 'older', snapshot: 'a'.repeat(64), cards: [], total: 0, scores: [], nextCursor: null });
  } });
  await client.search({ text: 'forest', filter: '   ' });
  expect(requested!.searchParams.has('filter')).toBe(false);
  expect(requested!.searchParams.has('mode')).toBe(false);
});
