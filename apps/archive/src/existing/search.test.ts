import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, Index, makeArrowTable } from '@lancedb/lancedb';
import { Field, FixedSizeList, Float32, Schema, Utf8 } from 'apache-arrow';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildSearchDocument, searchBooleans, searchDocumentSchema, searchSourceColumns } from '../search-document.js';
import type { QueryEmbedder } from '../embeddings.js';
import { openExistingSearch, readExistingVectorMetadata } from './search.js';
import type { ExistingSearch } from './search.js';

let root: string;
const readers: ExistingSearch[] = [];
const embedder: QueryEmbedder = { space: { model: 'existing-test-model', dimensions: 2, sourceDimensions: 2, queryInstruction: '' }, embed: async () => [1, 0] };
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'unity-existing-search-')); });
afterEach(async () => { for (const reader of readers.splice(0)) reader.close(); await rm(root, { recursive: true, force: true }); });
function source(id: string, name: string, description: string, provider = 'chub') {
  const numbers = new Set(['id', 'favorited', ...searchBooleans]);
  const row: Record<string, unknown> = Object.fromEntries(searchSourceColumns.map((column) => [column, numbers.has(column) ? 0 : null]));
  return { ...row, id, name, description, source: provider, topics: 'demo', createdAt: '2026-10-12T00:00:00.000Z', lastModified: '2026-10-12T00:00:00.000Z' };
}
async function seed(options: { active?: boolean; indexed?: boolean; vector?: boolean; nullableTags?: boolean } = {}) {
  const directory = join(root, 'search.lance'), connection = await connect(directory);
  const name = options.active ? 'cards_build_previous' : 'cards';
  const rows = [source('1', 'Silver Forest', 'silver forest north gate'), source('2', 'Ocean', 'silver ocean south gate'), source('3', 'Silver', 'silver distant forest', 'ct')];
  const documents: Record<string, unknown>[] = rows.map((row, index) => ({ ...buildSearchDocument(row, Date.UTC(2026, 9, 13)), ...(options.nullableTags
    ? { topics: 'not a membership list', tags: index === 0 ? null : index === 1 ? [] : ['demo'] } : {}) }));
  const lexicalSchema = options.nullableTags ? new Schema(searchDocumentSchema.fields.map((field) => field.name === 'topics'
    ? new Field('topics', new Utf8(), false) : field.name === 'tags' ? new Field('tags', field.type, true) : field)) : searchDocumentSchema;
  const table = await connection.createTable(name, makeArrowTable(documents, { schema: lexicalSchema }));
  if (options.indexed !== false) await table.createIndex('searchText', { config: Index.fts({ withPosition: true, lowercase: true, asciiFolding: true }) });
  table.close();
  if (options.vector !== false) {
    const schema = new Schema([new Field('card_id', new Utf8(), false), new Field('section', new Utf8(), false), new Field('matchText', new Utf8(), false),
      ...lexicalSchema.fields, new Field('vector', new FixedSizeList(2, new Field('item', new Float32(), false)), false)]);
    const vectors = await connection.createTable('card_vectors', makeArrowTable(documents.map((document, index) => ({ ...document, card_id: document.id,
      section: 'card', matchText: String(document.description), vector: index === 0 ? [1, 0] : index === 1 ? [0, 1] : [0.8, 0.6] })), { schema }));
    vectors.close();
  }
  connection.close();
  const db = new Database(join(root, 'metadata.sqlite'));
  db.exec('CREATE TABLE card_embedding_meta(cardId TEXT,embedder_name TEXT,model_name TEXT,dims INTEGER,section TEXT,chunk_index INTEGER,text_sha256 TEXT)');
  db.prepare('INSERT INTO card_embedding_meta(cardId,embedder_name,model_name,dims,section,chunk_index) VALUES (?,?,?,?,?,?)').run('1', 'existing-test', embedder.space.model, 2, 'card', 0); db.close();
  if (options.active) await writeFile(join(directory, '.cards.active.json'), JSON.stringify({ tableName: name }));
  return { directory, rows };
}
async function inventory(directory: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), key = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(result, await inventory(path, `${key}/`));
    else result[key] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return result;
}
async function open(directory: string, semantic = false) {
  const reader = await openExistingSearch({ lanceDirectory: directory, ...(semantic ? { embedder, databasePath: join(root, 'metadata.sqlite') } : {}) });
  readers.push(reader); return reader;
}

it('reopens the existing active lexical table and reads phrases/Boolean/filter results without writing files', async () => {
  const { directory } = await seed({ active: true }), before = await inventory(directory), reader = await open(directory);
  expect(reader.tableName).toBe('cards_build_previous');
  for (const [text, ids] of [['ocean', ['2']], ['"north gate"', ['1']], ['forest AND NOT ocean', ['1', '3']], ['NOT forest', ['2']], ['forest OR ocean', ['1', '2', '3']]] as const) {
    const result = await reader.search(text);
    expect([...result.ids].sort()).toEqual([...ids].sort()); expect(result.complete).toBe(true);
  }
  expect((await reader.search('silver', { filter: 'source = ct' })).ids).toEqual(['3']);
  expect((await reader.search('silver', { filter: 'topics = demo' })).ids).toHaveLength(3);
  expect((await reader.search('silver', { excludedIds: ['1', '3'] })).ids).toEqual(['2']);
  expect((await reader.search('NOT ocean', { excludedIds: ['1'] })).ids).toEqual(['3']);
  reader.close();
  const reopened = await open(directory);
  expect((await reopened.search('ocean')).ids).toEqual(['2']);
  expect(await inventory(directory)).toEqual(before);
});

it('reuses old vector rows for semantic/hybrid queries and marks top-k coverage explicitly', async () => {
  const { directory } = await seed(), before = await inventory(directory), reader = await open(directory, true);
  const result = await reader.search('silver', { mode: 'semantic', maxCandidates: 2 });
  expect(result.ids).toEqual(['1', '3']); expect(result.complete).toBe(false);
  expect(result.matches.get('1')).toEqual({ section: 'card', text: 'silver forest north gate', score: 1 });
  const hybrid = await reader.search('silver', { mode: 'hybrid', maxCandidates: 3 });
  // The old ranking puts an exact literal title ahead of a more similar description.
  expect(hybrid.ids[0]).toBe('3'); expect(hybrid.complete).toBe(false);
  expect((await reader.search('silver', { mode: 'semantic', filter: 'source = ct' })).ids).toEqual(['3']);
  expect((await reader.search('silver forest', { mode: 'semantic', eligibleIds: ['2'], maxCandidates: 1 })).ids).toEqual(['2']);
  expect((await reader.search('silver forest', { mode: 'semantic', excludedIds: ['1', '3'], maxCandidates: 1 })).ids).toEqual(['2']);
  expect((await reader.search('silver', { mode: 'hybrid', excludedIds: ['3'] })).ids).not.toContain('3');
  expect((await reader.search('forest and ocean', { mode: 'semantic' })).complete).toBe(false);
  expect((await reader.search('forest OR ocean', { mode: 'hybrid' })).complete).toBe(false);
  expect((await reader.search('"forest" and not ocean', { mode: 'semantic' })).complete).toBe(false);
  expect((await reader.search('silver', { mode: 'hybrid', eligibleIds: [] })).ids).toEqual([]);
  expect(await inventory(directory)).toEqual(before);
});

it('retains legacy Unicode list-filter folding across browse, lexical and vector searches', async () => {
  const { directory } = await seed(), reader = await open(directory, true);
  const rows = [
    { ...source('1', 'Silver Forest', 'silver forest north gate'), topics: 'ÉLF' },
    { ...source('2', 'Ocean', 'silver ocean south gate'), topics: 'élf' },
    { ...source('3', 'Silver', 'silver distant forest', 'ct'), topics: 'other' },
  ];
  await reader.upsertDocuments(rows);
  await reader.upsertVectorDocuments(rows.map((document) => ({ document, vector: [1, 0] })));
  const before = await inventory(directory);
  for (const mode of ['browse', 'lexical', 'semantic', 'hybrid'] as const) {
    for (const [filter, expected] of [
      ['topics = ÉLF', ['1', '2']], ['topics IN [ÉLF, missing]', ['1', '2']],
      ['tags = ÉLF', ['1', '2']], ['topics != ÉLF', ['3']], ['topics NOT IN [ÉLF, missing]', ['3']],
    ] as const) {
      const result = mode === 'browse' ? await reader.browse({ filter }) : await reader.search('silver', { mode, filter });
      expect([...result.ids].sort(), `${mode}: ${filter}`).toEqual(expected);
    }
  }
  expect(await inventory(directory)).toEqual(before);
});

it('combines literal tags and selected OR groups before browse, lexical and vector candidate limits without rewriting the index', async () => {
  const { directory } = await seed(), reader = await open(directory, true);
  const rows = [
    { ...source('1', 'Silver Forest', 'silver forest north gate'), topics: 'unrelated' },
    { ...source('2', 'Ocean', 'silver ocean south gate'), topics: "fantasy, mermaid, creator's pick" },
    { ...source('3', 'Silver', 'silver distant forest', 'ct'), topics: "fantasy, elf, literal') OR true --" },
  ];
  await reader.upsertDocuments(rows);
  await reader.upsertVectorDocuments(rows.map((document, index) => ({ document, vector: index === 0 ? [1, 0] : index === 1 ? [0, 1] : [0.8, 0.6] })));
  const before = await inventory(directory);
  const all = { tags: [' FANTASY '], tagGroups: [[' MERMAID ', 'dragon'], ["creator's pick", 'absent']] };
  expect((await reader.browse(all)).ids).toEqual(['2']);
  expect((await reader.search('silver', { ...all, maxCandidates: 1 })).ids).toEqual(['2']);
  expect((await reader.search('silver', { ...all, mode: 'semantic', maxCandidates: 1 })).ids).toEqual(['2']);
  expect((await reader.search('silver', { ...all, mode: 'hybrid', maxCandidates: 1 })).ids).toEqual(['2']);
  const any = { tags: ['unrelated'], tagGroups: [['mermaid', 'dragon']], tagMode: 'any' as const };
  expect((await reader.browse(any)).ids).toEqual(['2', '1']);
  expect((await reader.search('silver', { ...any, excludeTagGroups: [[' MERMAID ', 'absent']] })).ids).toEqual(['1']);
  expect((await reader.browse({ ...any, exclude: ['unrelated'] })).ids).toEqual(['2']);
  expect((await reader.search('silver', { ...all, filter: 'source = ct' })).ids).toEqual([]);
  expect((await reader.search('silver', { tagGroups: [["literal') OR true --"]] })).ids).toEqual(['3']);
  expect(await inventory(directory)).toEqual(before);
});

it('executes the bounded thousand-member generated filter independently of the smaller user-filter grammar', async () => {
  const { directory } = await seed(), reader = await open(directory, true);
  const document = { ...source('2', 'Ocean', 'silver ocean south gate'), topics: 'selected-999' };
  await reader.upsertDocuments([document]);
  await reader.upsertVectorDocuments([{ document, vector: [0, 1] }]);
  const before = await inventory(directory);
  const tagGroups = Array.from({ length: 10 }, (_, group) => Array.from({ length: 100 }, (_, index) => `selected-${group * 100 + index}`));
  expect((await reader.browse({ tagGroups, tagMode: 'any' })).ids).toEqual(['2']);
  expect((await reader.search('silver', { tagGroups, tagMode: 'any', maxCandidates: 1 })).ids).toEqual(['2']);
  expect((await reader.search('silver', { tagGroups, tagMode: 'any', mode: 'semantic', maxCandidates: 1 })).ids).toEqual(['2']);
  await expect(reader.browse({ tagGroups: [...tagGroups, ['too-many']] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(reader.search('silver', { tagGroups: [Array.from({ length: 102 }, (_, index) => `tag-${index}`)] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(await inventory(directory)).toEqual(before);
});

it('uses the actual fallback tag list and retains missing tags when excluding a group', async () => {
  const { directory } = await seed({ nullableTags: true });
  const reader = await open(directory, true), before = await inventory(directory);
  expect((await reader.browse({ tagGroups: [['demo']] })).ids).toEqual(['3']);
  expect((await reader.search('silver', { tagGroups: [['demo']], mode: 'semantic', maxCandidates: 1 })).ids).toEqual(['3']);
  expect((await reader.browse({ excludeTagGroups: [['demo']] })).ids).toEqual(['2', '1']);
  expect((await reader.search('silver', { excludeTagGroups: [['demo']], mode: 'semantic' })).ids).toEqual(['1', '2']);
  expect(await inventory(directory)).toEqual(before);
});

it('refuses grouped membership on scalar-only legacy tag metadata instead of silently using string equality', async () => {
  const { directory } = await seed(), connection = await connect(directory);
  for (const name of ['cards', 'card_vectors']) {
    const table = await connection.openTable(name);
    try {
      await table.dropColumns(['topics', 'tags']);
      await table.addColumns([{ name: 'topics', valueSql: "'demo'" }]);
    } finally { table.close(); }
  }
  connection.close();
  const reader = await open(directory, true), before = await inventory(directory);
  expect((await reader.browse()).ids).toEqual(['3', '2', '1']);
  expect((await reader.search('silver', { filter: 'topics = demo' })).ids).toHaveLength(3);
  await expect(reader.browse({ tagGroups: [['demo']] })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  await expect(reader.search('silver', { tagGroups: [['demo']] })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  await expect(reader.search('silver', { tagGroups: [['demo']], mode: 'semantic' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(await inventory(directory)).toEqual(before);
});

it('checks tag-list support only in the search legs that actually run', async () => {
  const { directory } = await seed(), connection = await connect(directory), table = await connection.openTable('cards');
  try {
    await table.dropColumns(['topics', 'tags']);
    await table.addColumns([{ name: 'topics', valueSql: "'demo'" }]);
  } finally { table.close(); connection.close(); }
  const reader = await open(directory, true), before = await inventory(directory);
  expect((await reader.search('silver', { tagGroups: [['demo']], mode: 'semantic', maxCandidates: 1 })).ids).toEqual(['1']);
  expect((await reader.search('silver', { tagGroups: [['demo']], mode: 'hybrid', semanticRatio: 1, maxCandidates: 1 })).ids).toEqual(['1']);
  await expect(reader.search('silver', { tagGroups: [['demo']] })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  await expect(reader.search('silver', { tagGroups: [['demo']], mode: 'hybrid' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(await inventory(directory)).toEqual(before);
});

it('reports actual typed fields and unknown vector coverage without a census, and browses filtered pages without embedding', async () => {
  const { directory } = await seed(), before = await inventory(directory), reader = await open(directory, true);
  expect(reader.filterFields).toContainEqual({ name: 'tokenCount', type: 'number' });
  expect(reader.filterFields).toContainEqual({ name: 'topics', type: 'strings' });
  expect(reader.filterFields.some((field) => field.name === 'searchText' || field.name === 'vector')).toBe(false);
  expect(reader.embedding).toEqual({ model: embedder.space.model, dimensions: 2, indexedCards: null, indexedRows: null });
  const first = await reader.browse({ filter: 'topics = demo', sort: 'name', limit: 1 });
  const second = await reader.browse({ filter: 'topics = demo', sort: 'name', limit: 1, offset: 1 });
  expect(first).toEqual({ ids: ['2'], total: 3 });
  expect(second).toEqual({ ids: ['3'], total: 3 });
  expect(await reader.browse({ filter: 'source = ct', excludedIds: ['3'], sort: 'name' })).toEqual({ ids: [], total: 0 });
  expect(await reader.browse({ eligibleIds: [], sort: 'name' })).toEqual({ ids: [], total: 0 });
  await expect(reader.browse({ filter: 'untrustedSql = 1', sort: 'name' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(await inventory(directory)).toEqual(before);
});

it('fences existing table writes and generation switches in search snapshots', async () => {
  const { directory, rows } = await seed(), reader = await open(directory, true);
  const snapshot = await reader.snapshot();
  expect(await reader.snapshot()).toBe(snapshot);
  await reader.upsertDocuments([{ ...rows[0]!, name: 'Changed' }]);
  expect(await reader.snapshot()).not.toBe(snapshot);
  await writeFile(join(directory, '.cards.active.json'), JSON.stringify({ tableName: 'cards_build_new' }));
  await expect(reader.snapshot()).rejects.toMatchObject({ code: 'SNAPSHOT_CHANGED' });
});

it('does not truncate complete lexical/NOT results or fall back from unsupported semantic queries', async () => {
  const { directory } = await seed({ vector: false }), reader = await open(directory);
  await expect(reader.search('silver', { maxCandidates: 2 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
  await expect(reader.search('NOT ocean', { maxCandidates: 2 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
  await expect(reader.search('silver', { mode: 'semantic' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  await expect(reader.search('forest OR ocean', { mode: 'hybrid' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  await expect(reader.search('silver', { filter: 'unknown = 1' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(reader.search('silver', { excludedIds: ['1', '1'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const signal = AbortSignal.abort();
  await expect(reader.search('silver', { signal })).rejects.toThrow();
});

it('requires preexisting compatible indexes, active pointers and embedding dimensions', async () => {
  await expect(openExistingSearch({ lanceDirectory: join(root, 'absent') })).rejects.toMatchObject({ code: 'ENOENT' });
  const { directory } = await seed({ indexed: false });
  await expect(open(directory)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  await writeFile(join(directory, '.cards.active.json'), JSON.stringify({ tableName: 'unrelated' }));
  await expect(open(directory)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await rm(join(directory, '.cards.active.json'));
  const connection = await connect(directory), table = await connection.openTable('cards');
  await table.createIndex('searchText', { config: Index.fts({ withPosition: true }) }); table.close(); connection.close();
  await expect(openExistingSearch({ lanceDirectory: directory, embedder: { ...embedder, space: { ...embedder.space, dimensions: 3 } } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(openExistingSearch({ lanceDirectory: directory, databasePath: join(root, 'metadata.sqlite'), embedder: { ...embedder, space: { ...embedder.space, model: 'wrong-model' } } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(openExistingSearch({ lanceDirectory: directory, embedder })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

it('uses authoritative active generation metadata and rejects ambiguous or absent model identity', async () => {
  const { directory } = await seed(), databasePath = join(root, 'metadata.sqlite'), db = new Database(databasePath);
  db.prepare('INSERT INTO card_embedding_meta(model_name,dims) VALUES (?, ?)').run('other-model', 2);
  expect(() => readExistingVectorMetadata(databasePath)).toThrow(/ambiguous/);
  db.exec('CREATE TABLE vector_generations(model_name TEXT, dimensions INTEGER, cards_index TEXT, chunks_index TEXT, status TEXT, active INTEGER)');
  db.prepare('INSERT INTO vector_generations VALUES (?, ?, ?, ?, ?, ?)').run(embedder.space.model, 2, 'card_vectors', null, 'active', 1);
  expect(readExistingVectorMetadata(databasePath)).toEqual({ model: embedder.space.model, dimensions: 2, cardsIndex: 'card_vectors' });
  const before = await readFile(databasePath);
  const reader = await open(directory, true); expect(reader.semantic).toBe(true);
  expect(await readFile(databasePath)).toEqual(before);
  await expect(openExistingSearch({ lanceDirectory: directory, databasePath, embedder, vectorTableName: 'wrong_vectors' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  db.exec('DELETE FROM vector_generations; DELETE FROM card_embedding_meta');
  expect(() => readExistingVectorMetadata(databasePath)).toThrow(/missing/);
  db.close();
});

it('opens a corpus beyond the copied adapter limit without scanning or limiting the Archive itself', async () => {
  const directory = join(root, 'large.lance'), connection = await connect(directory);
  const schema = new Schema(['id', 'name', 'searchText'].map((name) => new Field(name, new Utf8(), false)));
  const rows = Array.from({ length: 10_001 }, (_, index) => ({ id: String(index + 1), name: 'Card',
    searchText: index === 10_000 ? 'unique-signal' : index === 0 ? 'common forest spaceship' : index === 1 ? 'common forest grove' : 'common' }));
  const table = await connection.createTable('cards', makeArrowTable(rows, { schema }));
  await table.createIndex('searchText', { config: Index.fts({ withPosition: true }) }); table.close(); connection.close();
  const reader = await open(directory);
  expect(await reader.browse({ sort: 'name', offset: 10_000, limit: 1 })).toEqual({ ids: ['1'], total: 10_001 });
  expect((await reader.search('unique-signal')).ids).toEqual(['10001']);
  for (const [text, ids] of [
    ['forest AND NOT spaceship', ['2']], ['"forest" AND NOT spaceship', ['2']],
    ['common AND forest AND NOT spaceship', ['2']], ['NOT (NOT forest OR spaceship)', ['2']],
    ['NOT (NOT forest AND NOT unique-signal)', ['1', '2', '10001']],
    ['(forest AND NOT spaceship) OR unique-signal', ['2', '10001']],
    ['forest AND NOT common', []], ['forest AND NOT (NOT grove AND NOT unique-signal)', ['2']],
  ] as const) {
    const result = await reader.search(text, { maxCandidates: 100 });
    expect(result.ids.sort()).toEqual([...ids].sort()); expect(result.complete).toBe(true);
  }
  await expect(reader.search('common', { maxCandidates: 100 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
  await expect(reader.search('NOT forest', { maxCandidates: 100 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
  await expect(reader.search('forest OR NOT spaceship', { maxCandidates: 100 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
});

it('updates existing lexical/vector tables only through explicit bounded batches in the old numeric ID space', async () => {
  const { directory, rows } = await seed(), reader = await open(directory, true);
  const fourth = source('4', 'Birch', 'birch woodland');
  await reader.upsertDocuments([fourth]);
  expect((await reader.search('birch')).ids).toEqual(['4']);
  await reader.upsertVectorDocuments([{ document: fourth, vector: [1, 0], text: 'birch woodland' }]);
  expect((await reader.search('birch', { mode: 'semantic', filter: 'id = 4' })).ids).toEqual(['4']);
  await reader.upsertDocuments([{ ...rows[0]!, description: 'changed violet' }]);
  expect((await reader.search('violet')).ids).toEqual(['1']);
  await reader.deleteDocuments(['4']); await reader.deleteVectorDocuments(['4']);
  expect((await reader.search('birch')).ids).toEqual([]);
  expect((await reader.search('birch', { mode: 'semantic', filter: 'id = 4' })).ids).toEqual([]);
  reader.close(); const reopened = await open(directory, true);
  expect((await reopened.search('violet')).ids).toEqual(['1']);
});

it('embeds only explicitly queued new/changed rows in bounded batches with the existing model', async () => {
  const { directory } = await seed(), reader = await open(directory, true), received: string[][] = [];
  const documents = Array.from({ length: 3 }, (_, index) => source(String(index + 4), `New ${index}`, 'woodland '.repeat(5000)));
  const provider = { space: { ...embedder.space }, async embed(texts: readonly string[]) { received.push([...texts]); return texts.map(() => [1, 0]); } };
  const metadata = await reader.indexVectorDocuments(documents, provider);
  expect(metadata.map((item) => item.cardId)).toEqual(['4', '5', '6']);
  expect(metadata.every((item) => item.model === embedder.space.model && item.dimensions === 2 && /^[a-f0-9]{64}$/.test(item.textHash))).toBe(true);
  expect(received.flat()).toHaveLength(3);
  expect(received.every((texts) => texts.length <= 128 && texts.reduce((sum, value) => sum + value.length, 0) <= 96_000)).toBe(true);
  expect(received.flat().every((text) => !text.startsWith('Instruct:'))).toBe(true);
  const found = await reader.search('new', { mode: 'semantic', filter: 'id IN [4, 5, 6]' });
  expect(found.ids.sort()).toEqual(['4', '5', '6']);
  expect([...found.matches.values()].every((match) => match.text.length === 8192)).toBe(true);
  await expect(reader.indexVectorDocuments(documents, { ...provider, space: { ...provider.space, model: 'wrong-model' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

it('leaves vector files untouched when explicit indexing is cancelled or its provider fails', async () => {
  const { directory } = await seed(), reader = await open(directory, true), before = await inventory(directory), row = source('4', 'Birch', 'woodland');
  await expect(reader.indexVectorDocuments([row], { space: embedder.space, embed: async () => { throw new Error('provider failed'); } })).rejects.toThrow('provider failed');
  expect(await inventory(directory)).toEqual(before);
  const controller = new AbortController();
  await expect(reader.indexVectorDocuments([row], { space: embedder.space, embed: async () => { controller.abort(); return [[1, 0]]; } }, controller.signal)).rejects.toThrow();
  expect(await inventory(directory)).toEqual(before);
  expect((await reader.search('birch', { mode: 'semantic', filter: 'id = 4' })).ids).toEqual([]);
});

it('reuses unchanged embeddings for stats-only updates while refreshing vector filter metadata', async () => {
  const { directory, rows } = await seed(), reader = await open(directory, true), document = rows[0]!;
  const provider = { space: embedder.space, embed: async (texts: readonly string[]) => texts.map(() => [0.8, 0.6]) };
  const [metadata] = await reader.indexVectorDocuments([document], provider);
  const db = new Database(join(root, 'metadata.sqlite'));
  db.prepare('UPDATE card_embedding_meta SET text_sha256 = ? WHERE cardId = ?').run(metadata!.textHash, '1');
  const connection = await connect(directory), table = await connection.openTable('card_vectors');
  const before = (await table.query().where("id = '1'").select(['vector']).toArray())[0]!.vector;
  const unexpected = { space: embedder.space, embed: async () => { throw new Error('unchanged text must not call provider'); } };
  await reader.indexVectorDocuments([{ ...document, starCount: 999, hasGallery: true }], unexpected);
  expect((await reader.search('silver', { mode: 'semantic', filter: 'starCount = 999 AND hasGallery = true' })).ids).toEqual(['1']);
  const after = (await table.query().where("id = '1'").select(['vector']).toArray())[0]!.vector;
  expect(Array.from(after)).toEqual(Array.from(before));
  // A matching metadata row cannot stand in for missing vector bytes.
  await reader.deleteVectorDocuments(['1']);
  await expect(reader.indexVectorDocuments([document], unexpected)).rejects.toThrow('unchanged text must not call provider');
  await reader.indexVectorDocuments([document], provider);
  await expect(reader.indexVectorDocuments([{ ...document, description: 'changed text' }], unexpected)).rejects.toThrow('unchanged text must not call provider');
  table.close(); connection.close(); db.close();
});

it('reuses exact legacy ETL text under the active model even before whole-card metadata exists', async () => {
  const { directory, rows } = await seed(), databasePath = join(root, 'metadata.sqlite'), document = rows[0]!;
  const oldText = String(buildSearchDocument(document, Date.UTC(2026, 9, 13)).searchText);
  const writer = await open(directory, true);
  await writer.upsertVectorDocuments([{ document, vector: [0.8, 0.6], text: oldText }]); writer.close();
  const db = new Database(databasePath);
  db.exec('CREATE TABLE vector_generations(model_name TEXT,dimensions INTEGER,cards_index TEXT,chunks_index TEXT,status TEXT,active INTEGER,embedder_name TEXT)');
  db.prepare('INSERT INTO vector_generations VALUES (?,?,?,?,?,?,?)').run(embedder.space.model, 2, 'card_vectors', null, 'active', 1, 'existing-test');
  db.exec('DELETE FROM card_embedding_meta');
  const reader = await open(directory, true);
  const unexpected = { space: embedder.space, embed: async () => { throw new Error('legacy baseline must not be reembedded'); } };
  const result = await reader.indexVectorDocuments([{ ...document, starCount: 123 }], unexpected);
  expect(result).toEqual([{ cardId: '1', model: embedder.space.model, dimensions: 2, textHash: createHash('sha256').update(oldText).digest('hex') }]);
  expect((await reader.search('silver', { mode: 'semantic', filter: 'starCount = 123' })).ids).toEqual(['1']);
  await expect(reader.indexVectorDocuments([{ ...document, description: 'new text' }], unexpected)).rejects.toThrow('legacy baseline must not be reembedded');
  db.close();
});
