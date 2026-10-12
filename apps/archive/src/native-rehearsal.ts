import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { connect, Index, makeArrowTable } from '@lancedb/lancedb';
import { Bool, Field, FixedSizeList, Float32, Float64, List, Schema, Utf8 } from 'apache-arrow';
import { createArchiveClient } from '@character-unity/archive-client';
import { createArchiveApp } from './app.js';
import { createQueryEmbedder } from './embeddings.js';
import { openCopiedArchive } from './copied.js';
import { searchSourceColumns } from './search-document.js';
import { rehearseSemanticGeneration } from './generation-rehearsal.js';

// An installation/restart probe, not a production indexer or a parity claim.
// seed refuses existing directories; check accepts only this synthetic corpus.
const [operation, directory, ...extra] = process.argv.slice(2);
const generationProbe = operation === 'generate' || operation === 'generation-check';
if (!['seed', 'check', 'generate', 'generation-check'].includes(operation ?? '') || !directory || extra.length !== (generationProbe ? 1 : 0)) {
  throw new Error('Usage: native-rehearsal.js seed NEW_DIRECTORY | check REHEARSAL_DIRECTORY | generate REHEARSAL_DIRECTORY NEW_OUTPUT | generation-check REHEARSAL_DIRECTORY OUTPUT');
}
const root = resolve(directory), copyRoot = join(root, 'copy'), lanceRoot = join(copyRoot, 'search.lance');
const marker = 'unity.archive-native-rehearsal.v1';
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
async function query<T>(name: string, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (cause) { throw new Error(`Native rehearsal failed: ${name}`, { cause }); }
}
const rows = [
  { id: '1', name: 'Aster', source: 'chub', searchText: 'Aster guards the silver forest beside a café.', tags: ['Forest'], hasLorebook: true, tokenCount: 200, vector: [1, 0, 0, 0] },
  { id: '2', name: 'Birch', source: 'ct', searchText: 'Birch sails an ocean under silver stars.', tags: ['Ocean'], hasLorebook: false, tokenCount: 100, vector: [0, 1, 0, 0] },
  { id: '3', name: 'Cinder', source: 'chub', searchText: 'Cinder lives in a silver forest near the castle.', tags: ['Forest', "keeper's"], hasLorebook: true, tokenCount: 300, vector: [0, 0, 1, 0] },
];
const vectorSpace = { model: 'unity-native-synthetic', dimensions: 4, sourceDimensions: 4, queryInstruction: '' };
const schema = new Schema([
  ...['id', 'name', 'source', 'searchText', 'card_id', 'section', 'matchText'].map((name) => new Field(name, new Utf8(), false)),
  new Field('tags', new List(new Field('item', new Utf8(), false)), false),
  new Field('hasLorebook', new Bool(), false), new Field('tokenCount', new Float64(), false),
  new Field('vector', new FixedSizeList(4, new Field('item', new Float32(), false)), false),
]);
const original = (name: string) => Buffer.from(JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name, extensions: { rehearsal: true } } }) + '\n');

/** Include directory entries and file digests, so new sidecars also fail. */
async function inventory(directory: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (!prefix && entry.name === 'rehearsal.json') continue;
    assert.ok(!entry.isSymbolicLink(), 'Synthetic rehearsal must not contain symlinks');
    const relative = `${prefix}${entry.name}`, path = join(directory, entry.name);
    if (entry.isDirectory()) {
      result[`${relative}/`] = 'directory';
      Object.assign(result, await inventory(path, `${relative}/`));
    } else {
      assert.ok(entry.isFile(), 'Synthetic rehearsal contains an unexpected file type');
      result[relative] = digest(await readFile(path));
    }
  }
  return result;
}

if (operation === 'seed') {
  await mkdir(root); // Never overwrite an operator's data or a previous rehearsal.
  await mkdir(copyRoot);
  const database = new Database(join(copyRoot, 'archive.sqlite'));
  try {
    database.exec(`CREATE TABLE cards (id INTEGER PRIMARY KEY, name TEXT, source TEXT, sourceId TEXT, sourcePath TEXT, fullPath TEXT, sourceUrl TEXT);
      CREATE TABLE card_tags (cardId INTEGER, tag TEXT, normalizedTag TEXT);
      CREATE TABLE cached_assets (id INTEGER PRIMARY KEY, cardId INTEGER, originalUrl TEXT, localPath TEXT);
      CREATE TABLE optimizer_queue (cardId INTEGER);
      CREATE TABLE search_index_queue (cardId INTEGER);
      CREATE TRIGGER no_read_side_effects AFTER UPDATE ON cards BEGIN
        INSERT INTO optimizer_queue VALUES (new.id); INSERT INTO search_index_queue VALUES (new.id);
      END;`);
    const present = new Set(['id', 'name', 'source', 'sourceId', 'sourcePath', 'fullPath']);
    for (const column of searchSourceColumns) if (!present.has(column)) database.exec(`ALTER TABLE cards ADD COLUMN "${column}"`);
    for (const row of rows) {
      database.prepare('INSERT INTO cards (id, name, source, sourceId, description, topics, hasLorebook, tokenCount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(Number(row.id), row.name, row.source, `remote-${row.name}`, row.searchText, row.tags.join(','), Number(row.hasLorebook), row.tokenCount);
      for (const tag of row.tags) database.prepare('INSERT INTO card_tags VALUES (?, ?, ?)').run(Number(row.id), tag, tag.toLowerCase());
      await writeFile(join(copyRoot, `${row.id}.json`), original(row.name));
    }
  } finally { database.close(); }
  await writeFile(join(copyRoot, 'copy-manifest.json'), JSON.stringify({
    version: 'unity.archive-copy.v1', archiveId: 'native-rehearsal',
    database: { path: 'archive.sqlite', sha256: digest(await readFile(join(copyRoot, 'archive.sqlite'))) },
    cards: rows.map((row) => ({ id: row.id, original: { path: `${row.id}.json`, mediaType: 'application/json' }, assets: [] })),
  }));
  const connection = await connect(lanceRoot); let searchVersion: number;
  try {
    const table = await connection.createTable('cards', makeArrowTable(rows.map((row) => ({ ...row, card_id: row.id, section: 'description', matchText: row.searchText })), { schema }));
    try {
      await table.createIndex('searchText', { config: Index.fts({ withPosition: true, lowercase: true, asciiFolding: true }) });
      searchVersion = await table.version();
    } finally { table.close(); }
  } finally { connection.close(); }
  const manifest = JSON.parse(await readFile(join(copyRoot, 'copy-manifest.json'), 'utf8'));
  manifest.search = { path: 'search.lance', table: 'cards', version: searchVersion, vector: { table: 'cards', version: searchVersion, space: vectorSpace },
    files: Object.entries(await inventory(lanceRoot)).filter(([, sha256]) => sha256 !== 'directory').map(([path, sha256]) => ({ path, sha256 })) };
  await writeFile(join(copyRoot, 'copy-manifest.json'), JSON.stringify(manifest));
  const source = await openCopiedArchive(copyRoot);
  await writeFile(join(root, 'rehearsal.json'), JSON.stringify({ version: marker, snapshot: source.status().snapshot, files: await inventory(root) }));
}

const expected = JSON.parse(await readFile(join(root, 'rehearsal.json'), 'utf8')) as { version: string; snapshot: string; files: Record<string, string> };
assert.equal(expected.version, marker, 'Only an explicitly seeded synthetic rehearsal is accepted');
assert.deepEqual(await inventory(root), expected.files, 'Fixture bytes changed before reopening');
const embedder = createQueryEmbedder({ provider: 'ollama', baseUrl: 'http://127.0.0.1:1', space: vectorSpace }, '', async () => Response.json({ embeddings: [[1, 0, 0, 0]] }));
const source = await openCopiedArchive(copyRoot, embedder);
assert.equal(source.status().snapshot, expected.snapshot, 'Copied snapshot survives a new process');
const app = createArchiveApp(source);
const client = createArchiveClient('http://rehearsal.invalid', { fetch: async (input, init) => app.request(String(input), init) });
const status = await client.status();
assert.equal(status.mode, 'copy'); assert.equal(status.cardCount, 3);
assert.equal(status.search, 'lance-fts-v1');
assert.equal(status.semantic?.indexedCards, 3);
const semantic = await client.search({ mode: 'semantic', text: 'forest', limit: 1 });
assert.equal(semantic.total, 3); assert.equal(semantic.cards[0]?.id, '1'); assert.equal(semantic.matches?.[0]?.section, 'description');
assert.ok(semantic.nextCursor);
assert.deepEqual((await client.search({ mode: 'semantic', text: 'forest', snapshot: semantic.snapshot, cursor: semantic.nextCursor, limit: 2 })).cards.map((card) => card.id), ['2', '3']);
assert.equal((await client.search({ mode: 'hybrid', text: 'Cinder' })).cards[0]?.id, '3');
const lexical = await client.search({ text: 'silver AND NOT ocean', limit: 1, sort: 'id' });
assert.equal(lexical.total, 2); assert.deepEqual(lexical.cards.map((card) => card.id), ['1']); assert.ok(lexical.nextCursor);
const lexicalNext = await client.search({ text: 'silver AND NOT ocean', limit: 1, sort: 'id', snapshot: lexical.snapshot, cursor: lexical.nextCursor });
assert.deepEqual(lexicalNext.cards.map((card) => card.id), ['3']); assert.equal(lexicalNext.nextCursor, null);
assert.deepEqual((await client.search({ text: 'NOT forest' })).cards.map((card) => card.id), ['2']);
assert.equal(status.browse, 'lance-filter-v1');
assert.ok(status.sorts?.includes('tokens_desc'));
const browsed = await client.search({ text: '', mode: 'browse', sort: 'tokens_desc', limit: 1 });
assert.equal(browsed.total, 3); assert.deepEqual(browsed.cards.map((card) => card.id), ['3']); assert.deepEqual(browsed.scores, [0]);
assert.ok(browsed.nextCursor);
assert.deepEqual((await client.search({ text: '', mode: 'browse', sort: 'tokens_desc', limit: 1, snapshot: browsed.snapshot, cursor: browsed.nextCursor })).cards.map((card) => card.id), ['1']);
assert.deepEqual((await client.search({ text: 'silver OR absent', sort: 'tokens_asc' })).cards.map((card) => card.id), ['2', '1', '3']);
assert.ok(status.filterFields?.some((field) => field.name === 'tokenCount' && field.type === 'number'));
assert.deepEqual((await client.search({ text: 'silver', filter: 'hasLorebook = true AND token_count >= 250' })).cards.map((card) => card.id), ['3']);
assert.deepEqual((await client.search({ text: 'NOT forest', filter: 'source = chub' })).cards.map((card) => card.id), []);
assert.deepEqual((await client.search({ text: '"silver forest"', tag: "keeper's" })).cards.map((card) => card.id), ['3']);
const first = await client.list({ limit: 1, q: 'forest', provider: 'chub' });
assert.deepEqual(first.cards.map((card) => card.id), ['1']); assert.ok(first.nextCursor);
const next = await client.list({ limit: 1, q: 'forest', provider: 'chub', snapshot: first.snapshot, cursor: first.nextCursor });
assert.deepEqual(next.cards.map((card) => card.id), ['3']); assert.equal(next.nextCursor, null);
const selection = await client.select(status, ['3', '1']);
assert.deepEqual(selection.cards.map((card) => card.id), ['1', '3']);
for (const card of selection.cards) assert.deepEqual(Buffer.from(await client.original(status, card.original)), original(card.title));
const database = new Database(join(copyRoot, 'archive.sqlite'), { readonly: true, fileMustExist: true });
let sqliteVersion: unknown;
try {
  sqliteVersion = database.prepare('SELECT sqlite_version()').pluck().get();
  assert.equal(database.prepare('SELECT COUNT(*) FROM optimizer_queue').pluck().get(), 0);
  assert.equal(database.prepare('SELECT COUNT(*) FROM search_index_queue').pluck().get(), 0);
} finally { database.close(); }

const connection = await connect(lanceRoot);
try {
  assert.deepEqual(await connection.tableNames(), ['cards']);
  const table = await connection.openTable('cards');
  try {
    assert.equal(await table.countRows(), 3);
    assert.equal((await table.listIndices()).length, 1);
    const ids = (hits: { id: string }[]) => hits.map((hit) => hit.id);
    assert.deepEqual(ids(await query('FTS accent folding', () => table.search('cafe', 'fts', 'searchText').select(['id', '_score']).limit(10).toArray())), ['1']);
    assert.deepEqual(ids(await query('FTS phrase', () => table.search('"silver forest"', 'fts', 'searchText').select(['id', '_score'])
      .orderBy([{ columnName: 'id', ascending: true }]).limit(10).toArray())), ['1', '3']);
    // FTS selects its top-k candidate set before field sorting. As in the legacy
    // backend, retrieve the bounded candidate set before applying page slicing.
    assert.deepEqual(ids(await query('FTS filtered field sort', () => table.search('silver', 'fts', 'searchText').where("source = 'chub' AND hasLorebook = true")
      .orderBy([{ columnName: 'tokenCount', ascending: false }]).select(['id', '_score']).limit(10).toArray())), ['3', '1']);
    assert.deepEqual(ids(await query('tag filter', () => table.query().where("array_has(tags, 'keeper''s')").select(['id']).limit(10).toArray())), ['3']);
    // 0.37.1 requires the sort field in this scalar query's projection. Omitting
    // it fails native planning (TakeExec row-address column), not Node loading.
    assert.deepEqual(ids(await query('field sort pagination', () => table.query().orderBy([{ columnName: 'tokenCount', ascending: false }])
      .offset(1).limit(1).select(['id', 'tokenCount']).toArray())), ['1']);
    // Exact supplied-vector search proves the native query path, not ANN training
    // or an embedding provider. No models, credentials or network are required.
    const hits = await query('exact vector', () => table.vectorSearch([0, 1, 0, 0]).distanceType('cosine').select(['id', '_distance']).limit(1).toArray());
    assert.deepEqual(ids(hits), ['2']); assert.equal(hits[0]?._distance, 0);
  } finally { table.close(); }
} finally { connection.close(); }
let generated;
if (generationProbe) {
  const output = resolve(extra[0]!);
  const before = operation === 'generation-check' ? await inventory(output) : undefined;
  generated = await rehearseSemanticGeneration(copyRoot, output, operation === 'generate');
  if (before) assert.deepEqual(await inventory(output), before, 'Generated vector files remain unchanged after reopening');
}
assert.deepEqual(await inventory(root), expected.files, 'Reads must not modify SQLite, original bytes or the persisted Lance index');
console.log(JSON.stringify({ version: marker, operation, node: process.version, platform: process.platform, arch: process.arch,
  sqliteVersion, snapshot: status.snapshot, cards: status.cardCount, ...(generated ? { generated } : {}),
  checks: ['copied-read-contract', 'copied-lexical-api', 'copied-semantic-api', 'hybrid-title-ranking', 'boolean-search-pagination', 'exact-originals', 'queue-sentinels', 'lance-fts', 'lance-phrase', 'lance-filters', 'lance-sort-page', 'lance-exact-vector', 'unchanged-files'] }));
