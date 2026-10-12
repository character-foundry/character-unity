import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { connect, Index, makeArrowTable } from '@lancedb/lancedb';
import { Field, Schema, Utf8 } from 'apache-arrow';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { createArchiveClient } from '@character-unity/archive-client';
import { openCopiedArchive } from './copied.js';
import { openCopiedSearch } from './copied-search.js';
import { createCopyFixture } from '../tests/copy-fixture.js';
import { createArchiveApp } from './app.js';
import { createArchiveIndex } from './read-source.js';
import { parseSearchExpression, evaluateSearch } from './search-query.js';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'unity-archive-search-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function inventory(directory: string, prefix = ''): Promise<{ path: string; sha256: string }[]> {
  const files: { path: string; sha256: string }[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...await inventory(join(directory, entry.name), `${path}/`));
    else files.push({ path, sha256: digest(await readFile(join(directory, entry.name))) });
  }
  return files;
}
async function index(rows = [{ id: '1', searchText: 'silver forest cafe north gate' }, { id: '2', searchText: 'silver ocean cafe south gate' }], indexed = true) {
  const connection = await connect(join(root, 'search.lance')); let version: number;
  try {
    const table = await connection.createTable('cards', makeArrowTable(rows, { schema: new Schema(['id', 'searchText'].map((name) => new Field(name, new Utf8(), false))) }));
    try {
      if (indexed) await table.createIndex('searchText', { config: Index.fts({ withPosition: true, lowercase: true, asciiFolding: true }) });
      version = await table.version();
    } finally { table.close(); }
  } finally { connection.close(); }
  return { path: 'search.lance', table: 'cards', version, files: await inventory(join(root, 'search.lance')) };
}
async function fixture() {
  const copy = await createCopyFixture(root), search = await index();
  const manifest = { ...copy, search };
  await writeFile(join(root, 'copy-manifest.json'), JSON.stringify(manifest));
  const source = await openCopiedArchive(root), app = createArchiveApp(source);
  const client = createArchiveClient('http://search.test', { fetch: async (input, init) => app.fetch(new Request(input, init)) });
  return { source, app, client, manifest };
}

it('serves persisted lexical, phrase, Boolean and filtered search through the public read client without changing files', async () => {
  const { client, source, manifest } = await fixture(), before = await inventory(root), status = await client.status();
  expect(status.search).toBe('lance-fts-v1');
  // Expected sets follow the pinned legacy grammar's precedence. The corpus and
  // assertions are hand-authored; results are not regenerated from an oracle.
  for (const [text, ids] of [
    ['forest', ['1']], ['"north gate"', ['1']], ['"gate north"', []],
    ['forest OR ocean', ['1', '2']], ['silver AND NOT ocean', ['1']],
    ['NOT forest', ['2']], ['NOT (forest OR ocean)', []],
    ['forest OR ocean AND missing', ['1']], ['(forest OR ocean) AND missing', []],
    ['silver (forest OR missing)', ['1']], ['NOT NOT forest', ['1']],
  ] as const) expect((await client.search({ text, sort: 'id' })).cards.map((card) => card.id)).toEqual(ids);
  expect((await client.search({ text: 'silver', provider: 'ct', tag: 'Forest' })).cards.map((card) => card.id)).toEqual(['2']);
  expect((await client.search({ text: 'silver', provider: 'missing' })).total).toBe(0);
  const first = await client.search({ text: 'silver', sort: 'title', limit: 1 });
  expect(first).toMatchObject({ total: 2, cards: [{ id: '1' }] }); expect(first.nextCursor).not.toBeNull();
  const next = await client.search({ text: 'silver', sort: 'title', limit: 1, snapshot: first.snapshot, cursor: first.nextCursor! });
  expect(next).toMatchObject({ total: 2, cards: [{ id: '2' }], nextCursor: null });
  expect(first.scores[0]).toBeGreaterThan(0);
  // Make field order disagree with both relevance tie-breaking and ID order.
  // A native top-k before field sorting would incorrectly keep ID 1 here.
  const reordered = createArchiveIndex('sort-fixture', source.list().cards.map((card) => ({ ...card, title: card.id === '1' ? 'Zulu' : 'Alfa' })),
    'copy', () => { throw new Error('This ordering test does not read objects'); }, 'synthetic-sort', await openCopiedSearch(root, manifest.search, ['1', '2']));
  expect((await reordered.search({ text: 'silver', sort: 'title', limit: 1 })).cards.map((card) => card.id)).toEqual(['2']);
  expect((await reordered.search({ text: 'silver', sort: 'id', limit: 1 })).cards.map((card) => card.id)).toEqual(['1']);
  expect((await reordered.search({ text: 'silver', sort: 'relevance', limit: 1 })).cards.map((card) => card.id)).toEqual(['1']);
  const selected = await client.select(first, [first.cards[0]!.id]);
  expect(await client.original(selected, selected.cards[0]!.original)).toEqual(new Uint8Array(await readFile(join(root, 'files/aster.json'))));
  const reopened = await openCopiedArchive(root);
  expect(reopened.status()).toEqual(status);
  expect(await reopened.search({ text: 'silver', sort: 'title', limit: 1 })).toEqual(first);
  expect(await inventory(root)).toEqual(before);
});

it('binds cursors to snapshot, text, filters and ordering and fails closed for malformed or unbounded input', async () => {
  const { client, app } = await fixture();
  const first = await client.search({ text: 'silver', limit: 1 });
  for (const changed of [{ text: 'forest' }, { provider: 'chub' }, { tag: 'quiet' }, { filter: 'id EXISTS' }, { sort: 'title' as const }]) {
    await expect(client.search({ text: 'silver', snapshot: first.snapshot, cursor: first.nextCursor!, ...changed })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }
  await expect(client.search({ text: 'silver', cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(client.search({ text: 'silver', snapshot: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'SNAPSHOT_CHANGED' });
  for (const text of ['', '"unclosed', 'forest AND', 'OR forest', '()', 'NOT', '""', '"forest"ocean', 'foo"bar', 'NOT '.repeat(40) + 'forest', 'forest OR '.repeat(100) + 'ocean']) {
    await expect(client.search({ text })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }
  for (const query of ['text=a&text=b', 'text=a&filter=unknown%3E0', 'text=a&sort=tokenCount', 'text=a&limit=101']) {
    expect((await app.request(`/api/archive/v1/search?${query}`)).status).toBe(400);
  }
  expect((await app.request('/api/archive/v1/search', { method: 'POST' })).status).toBe(404);
});

it('does not silently fall back when an index is absent, changes on disk or contains IDs outside the copied selection', async () => {
  const copy = await createCopyFixture(root), source = await openCopiedArchive(root);
  expect(source.status().search).toBeUndefined();
  await expect(source.search({ text: 'forest' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  const search = await index(), manifest = { ...copy, search };
  await writeFile(join(root, 'copy-manifest.json'), JSON.stringify(manifest));
  const ready = await openCopiedArchive(root);
  expect(ready.status().snapshot).not.toBe(source.status().snapshot);
  await writeFile(join(root, 'search.lance/unmapped'), 'new file');
  await expect(ready.search({ text: 'silver' })).rejects.toMatchObject({ code: 'SNAPSHOT_CHANGED' });
  await rm(join(root, 'search.lance/unmapped'));
  const file = search.files.find((file) => file.path.endsWith('.lance'))!;
  await writeFile(join(root, 'search.lance', file.path), 'changed bytes');
  await expect(ready.search({ text: 'silver' })).rejects.toMatchObject({ code: 'SNAPSHOT_CHANGED' });
  await expect(openCopiedArchive(root)).rejects.toMatchObject({ code: 'SNAPSHOT_CHANGED' });
});

it('requires an existing FTS index and exactly one indexed row for every selected card', async () => {
  const search = await index([{ id: '1', searchText: 'forest' }, { id: '3', searchText: 'ocean' }]);
  await expect(openCopiedSearch(root, search, ['1', '2'])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(openCopiedSearch(root, { ...search, path: '../elsewhere' }, ['1', '3'])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(openCopiedSearch(root, { ...search, files: [...search.files, search.files[0]] }, ['1', '3'])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await rm(join(root, 'search.lance'), { recursive: true });
  const unindexed = await index(undefined, false);
  const before = await inventory(root);
  await expect(openCopiedSearch(root, unindexed, ['1', '2'])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(await inventory(root)).toEqual(before);
});

it('evaluates NOT over the complete selected universe and never truncates positive term matches to a page', async () => {
  const rows = Array.from({ length: 150 }, (_, index) => ({ id: String(index + 1), searchText: index === 149 ? 'ocean' : 'forest' }));
  const search = await index(rows), source = await openCopiedSearch(root, search, rows.map((row) => row.id));
  expect((await source.search('forest')).size).toBe(149);
  expect([...(await source.search('NOT forest')).keys()]).toEqual(['150']);
  expect((await source.search('forest OR ocean')).size).toBe(150);
  expect((await source.search('forest', 'id EXISTS')).size).toBe(149);
  expect((await source.search('NOT missing', 'id EXISTS')).size).toBe(150);
  expect((await source.search('NOT forest', 'id != 150')).size).toBe(0);
});

it('treats quoted operators as text and caches repeated terms while preserving Boolean scores', async () => {
  const calls: string[] = [];
  const result = await evaluateSearch(parseSearchExpression('forest AND forest OR NOT "AND"'), ['1', '2'], async (term) => {
    calls.push(term); return new Map(term === 'forest' ? [['1', 2]] : [['2', 3]]);
  });
  expect(calls).toEqual(['forest', '"AND"']); expect([...result]).toEqual([['1', 4]]);
  expect(parseSearchExpression('"AND"')).toEqual({ type: 'term', value: '"AND"' });
});

it('rejects malformed search responses in the portable client', async () => {
  const { source } = await fixture(), page = await source.search({ text: 'silver' });
  for (const data of [{ ...page, total: 1 }, { ...page, scores: [] }, { ...page, scores: [-1, 0] }, { ...page, cards: [page.cards[0], page.cards[0]] }, { ...page, total: 10001 }]) {
    const client = createArchiveClient('http://invalid.test', { fetch: async () => Response.json(data) });
    await expect(client.search({ text: 'silver' })).rejects.toMatchObject({ code: 'PROTOCOL' });
  }
});
