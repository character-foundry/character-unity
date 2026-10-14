import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { connect, Index, makeArrowTable } from '@lancedb/lancedb';
import { Schema } from 'apache-arrow';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openLibraryIndex } from './library-index.js';
import type { LibraryIndex, LibraryIndexEvent, LibraryProjection } from './library-index.js';
import type { DocumentEmbedder, QueryEmbedder } from './embeddings.js';

const space = { model: 'shared-existing-model', dimensions: 2, sourceDimensions: 2, queryInstruction: '' };
const queryEmbedder: QueryEmbedder = { space, embed: async () => [1, 0] };
let root: string, documents: string[], fail: boolean;
const readers: LibraryIndex[] = [];
const documentEmbedder: DocumentEmbedder = { space, async embed(texts) {
  documents.push(...texts);
  if (fail) throw new Error('Configured provider is offline');
  return texts.map((text) => text.includes('ocean') ? [0, 1] : [1, 0]);
} };
function projection(name = 'My changed fork', description = 'A woodland glass oracle.'): LibraryProjection {
  return { name, creator: 'owner', tags: ['Fantasy'], spec: 'v3', tokens: 50,
    description, personality: '', scenario: '', first_mes: 'Hello.', mes_example: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [],
    createdAt: '2026-10-13T01:00:00.000Z', updatedAt: '2026-10-13T02:00:00.000Z' };
}
function event(sequence = 1, overrides: Partial<LibraryIndexEvent> = {}): LibraryIndexEvent {
  return { workspaceId: 'owner-a', cardId: 'fork-card', revisionId: `revision-${sequence}`, eventSequence: sequence, operation: 'upsert', projection: projection(), ...overrides };
}
async function open(semantic = true) {
  const index = await openLibraryIndex({ lanceDirectory: root, space, ...(semantic ? { queryEmbedder, documentEmbedder } : {}) });
  readers.push(index); return index;
}
async function inventory(directory = root, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), key = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(result, await inventory(path, `${key}/`));
    else result[key] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return result;
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'unity-library-index-')); documents = []; fail = false; });
afterEach(async () => { for (const reader of readers.splice(0)) await reader.close(); await rm(root, { recursive: true, force: true }); });

it('opens and idles without creating a table, embedding or scanning any Archive corpus', async () => {
  const index = await open(), before = await inventory();
  expect((await index.search('owner-a', { q: 'woodland', mode: 'semantic' })).cards).toEqual([]);
  expect(await index.snapshot()).toBe('absent');
  expect(await inventory()).toEqual(before);
  expect(documents).toEqual([]);
});

it('rejects every retry against a different model with the same dimensions without caching the incompatible table', async () => {
  const original = await open(); await original.apply(event());
  const before = await inventory(), snapshot = await original.snapshot();
  const wrongSpace = { ...space, model: 'different-model-same-dimensions' };
  const incompatible = await openLibraryIndex({ lanceDirectory: root, space: wrongSpace,
    queryEmbedder: { space: wrongSpace, async embed() { return [0, 1]; } },
    documentEmbedder: { space: wrongSpace, async embed() { return [[0, 1]]; } } });
  readers.push(incompatible);
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(incompatible.apply(event(2))).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(incompatible.search('owner-a', { q: 'woodland', mode: 'semantic' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  }
  expect(await original.snapshot()).toBe(snapshot);
  expect(await inventory()).toEqual(before);
  expect((await original.search('owner-a', { q: 'woodland' })).cards).toMatchObject([{ versionId: 'revision-1' }]);
});

it('adds only changed owned projections to the existing Lance directory and searches them lexically/semantically by authenticated scope', async () => {
  const index = await open();
  expect(await index.apply(event())).toMatchObject({ applied: true, eventSequence: 1, semantic: true });
  await index.apply(event(1, { workspaceId: 'owner-b', cardId: 'foreign-card', projection: projection('Private foreign card') }));
  expect(documents).toHaveLength(2);
  const before = await inventory();
  const lexical = await index.search('owner-a', { q: 'woodland', mode: 'lexical' });
  expect(lexical.cards).toMatchObject([{ libraryOwned: true, libraryCardId: 'fork-card', id: 'unity:fork-card', versionId: 'revision-1' }]);
  const semantic = await index.search('owner-a', { q: 'A glass companion', mode: 'semantic' });
  expect(semantic.cards.map((card) => card.id)).toEqual(['unity:fork-card']);
  expect(semantic.matches.get('unity:fork-card')).toMatchObject({ section: 'card', score: 1 });
  expect(semantic.complete).toBe(false);
  expect((await index.search('owner-a', { mode: 'hybrid', q: 'woodland' })).cards).toHaveLength(1);
  expect((await index.search('owner-a', { mode: 'browse', filter: 'topics = fantasy AND tokenCount >= 20' })).cards).toHaveLength(1);
  expect((await index.search('owner-a', { mode: 'browse', provider: 'chub' })).cards).toEqual([]);
  expect((await index.search('nobody', { q: 'woodland', mode: 'semantic' })).cards).toEqual([]);
  expect(await inventory()).toEqual(before);
  expect(documents).toHaveLength(2);
  const connection = await connect(root);
  expect(await connection.tableNames()).toEqual(['unity_library_search_v1']); connection.close();
});

it('uses the same selected OR groups and exclusions across owned browse, lexical and semantic results without further indexing', async () => {
  const index = await open();
  await index.apply(event(1, { cardId: 'unrelated', projection: { ...projection(), tags: ['unrelated'] } }));
  await index.apply(event(1, { cardId: 'mermaid', projection: { ...projection('Ocean', 'A woodland ocean guide'), tags: ['Fantasy', 'Mermaid', "creator's pick", 'selected-999'] } }));
  await index.apply(event(1, { cardId: 'elf', projection: { ...projection('Elf'), tags: ['Fantasy', 'Elf', "literal') OR true --"] } }));
  const before = await inventory(), indexed = [...documents];
  const all = { tags: [' FANTASY '], tagGroups: [[' MERMAID ', 'dragon'], ["creator's pick", 'absent']] };
  for (const mode of ['browse', 'lexical', 'semantic', 'hybrid'] as const) {
    const result = await index.search('owner-a', { ...all, mode, ...(mode === 'browse' ? {} : { q: 'woodland' }) });
    expect(result.cards.map((card) => card.libraryCardId)).toEqual(['mermaid']);
  }
  const any = { tags: ['unrelated'], tagGroups: [['mermaid', 'dragon']], tagMode: 'any' as const };
  expect((await index.search('owner-a', any)).cards.map((card) => card.libraryCardId).sort()).toEqual(['mermaid', 'unrelated']);
  expect((await index.search('owner-a', { ...any, excludeTagGroups: [[' MERMAID ', 'absent']] })).cards.map((card) => card.libraryCardId)).toEqual(['unrelated']);
  expect((await index.search('owner-a', { ...any, exclude: ['unrelated'] })).cards.map((card) => card.libraryCardId)).toEqual(['mermaid']);
  expect((await index.search('owner-a', { ...all, filter: 'source = ct' })).cards).toEqual([]);
  expect((await index.search('owner-a', { tagGroups: [["literal') OR true --"]] })).cards.map((card) => card.libraryCardId)).toEqual(['elf']);
  const tagGroups = Array.from({ length: 10 }, (_, group) => Array.from({ length: 100 }, (_, member) => `selected-${group * 100 + member}`));
  expect((await index.search('owner-a', { tagGroups, tagMode: 'any', mode: 'semantic', q: 'woodland' })).cards.map((card) => card.libraryCardId)).toEqual(['mermaid']);
  expect(await inventory()).toEqual(before);
  expect(documents).toEqual(indexed);
});

it('indexes new owned tag arrays exactly without splitting commas or folding non-ASCII letters', async () => {
  const index = await open();
  await index.apply(event(1, { cardId: 'exact', projection: { ...projection(), tags: ['sea, sky', 'ÉLF'] } }));
  await index.apply(event(1, { cardId: 'different', projection: { ...projection(), tags: ['sea', 'sky', 'élf'] } }));
  await index.apply(event(1, { cardId: 'padded', projection: { ...projection(), tags: [' padded '] } }));
  const before = await inventory(), indexed = [...documents];
  expect((await index.search('owner-a', { tagGroups: [['sea, sky']] })).cards.map((card) => card.libraryCardId)).toEqual(['exact']);
  expect((await index.search('owner-a', { tagGroups: [['ÉLF']], mode: 'semantic', q: 'woodland' })).cards.map((card) => card.libraryCardId)).toEqual(['exact']);
  expect((await index.search('owner-a', { tagGroups: [['élf']] })).cards.map((card) => card.libraryCardId)).toEqual(['different']);
  expect((await index.search('owner-a', { tags: ['SEA, SKY'], tagGroups: [['Élf']] })).cards).toMatchObject([{ libraryCardId: 'exact', tags: ['sea, sky', 'ÉLF'] }]);
  expect((await index.search('owner-a', { tagGroups: [['padded']] })).cards).toEqual([]);
  expect(await inventory()).toEqual(before);
  expect(documents).toEqual(indexed);
});

it('keeps owned typed tag equality, lists and exclusions on the exact ASCII-folded membership policy in every search mode', async () => {
  const index = await open();
  await index.apply(event(1, { cardId: 'exact', projection: { ...projection(), tags: ['ÉLF', 'sea, sky', ' padded '] } }));
  await index.apply(event(1, { cardId: 'different', projection: { ...projection(), tags: ['élf', 'sea', 'sky', 'padded'] } }));
  const before = await inventory(), indexed = [...documents];
  for (const mode of ['browse', 'lexical', 'semantic', 'hybrid'] as const) {
    for (const [filter, ids] of [
      ['topics = ÉLF', ['exact']], ['topics IN [ÉLF, "sea, sky"]', ['exact']],
      ['topics != ÉLF', ['different']], ['topics NOT IN [ÉLF]', ['different']],
      ['tags = ÉLF', ['exact']], ['topics = élf', ['different']],
      ['topics = "sea, sky"', ['exact']], ['topics = " padded "', ['exact']], ['topics = padded', ['different']],
    ] as const) {
      const result = await index.search('owner-a', { mode, filter, ...(mode === 'browse' ? {} : { q: 'woodland' }) });
      expect(result.cards.map((card) => card.libraryCardId).sort(), `${mode}: ${filter}`).toEqual(ids);
    }
  }
  expect(documents).toEqual(indexed);
  expect(await inventory()).toEqual(before);
});

it('refuses tag-filtered reads of persisted legacy owned projections without silently missing exact tags or rewriting the index', async () => {
  const index = await open();
  const exact = { ...projection(), tags: ['sea, sky', 'ÉLF'] };
  await index.apply(event(1, { projection: exact }));
  await index.apply(event(1, { cardId: 'second-legacy', projection: exact }));
  await index.apply(event(1, { workspaceId: 'owner-b', cardId: 'healthy', projection: projection() }));
  await index.close(); readers.splice(readers.indexOf(index), 1);
  // Fixture for a table created by the prior writer: raw summary tags remain
  // intact, but the membership columns split commas and Unicode-lowercase.
  const connection = await connect(root), table = await connection.openTable('unity_library_search_v1');
  const actual = await table.schema(), rows = await table.query().toArray();
  const legacySchema = new Schema(actual.fields, new Map([...actual.metadata].filter(([key]) => key !== 'unity.library.tag-policy')));
  const legacyRows = rows.map((row) => ({ ...row, vector: Array.from(row.vector),
    tags: row.workspaceId === 'owner-a' ? ['sea', 'sky', 'élf'] : Array.from(row.tags),
    topics: row.workspaceId === 'owner-a' ? ['sea', 'sky', 'élf'] : Array.from(row.topics) }));
  table.close();
  const legacy = await connection.createTable('unity_library_search_v1', makeArrowTable(legacyRows, { schema: legacySchema }), { mode: 'overwrite' });
  await legacy.createIndex('searchText', { config: Index.fts({ withPosition: true }) });
  legacy.close(); connection.close();
  let queryEmbeddings = 0;
  const reopened = await openLibraryIndex({ lanceDirectory: root, space, documentEmbedder, queryEmbedder: { space, async embed() { queryEmbeddings++; return [1, 0]; } } });
  readers.push(reopened);
  const before = await inventory(), indexed = [...documents];
  for (const mode of ['browse', 'lexical', 'semantic', 'hybrid'] as const) {
    for (const filter of [{ tagGroups: [['sea, sky']] }, { tagGroups: [['ÉLF']] }, { excludeTagGroups: [['sea']] }, { tags: ['sea'] },
      { filter: 'topics = ÉLF' }, { filter: 'topics IN [ÉLF]' }, { filter: 'topics != ÉLF' }, { filter: 'tags = "sea, sky"' }]) {
      await expect(reopened.search('owner-a', { mode, ...(mode === 'browse' ? {} : { q: 'woodland' }), ...filter }))
        .rejects.toMatchObject({ code: 'UNAVAILABLE' });
    }
  }
  expect((await reopened.search('owner-a', {})).cards).toHaveLength(2);
  expect((await reopened.search('owner-a', { filter: 'source = unity' })).cards).toHaveLength(2);
  expect((await reopened.search('owner-a', { filter: 'topics EXISTS' })).cards).toHaveLength(2);
  expect((await reopened.search('owner-a', { filter: 'name = "topics = ÉLF"' })).cards).toEqual([]);
  expect((await reopened.search('owner-b', { tagGroups: [['fantasy']] })).cards).toMatchObject([{ libraryCardId: 'healthy' }]);
  expect(queryEmbeddings).toBe(0);
  expect(documents).toEqual(indexed);
  expect(await inventory()).toEqual(before);
  // A deliberate delivery may fix one row; it must not bless all old rows or
  // reuse the successful validation of another workspace at the new version.
  await reopened.apply(event(2, { projection: exact }));
  const partial = await inventory(), afterDelivery = [...documents];
  await expect(reopened.search('owner-a', { tagGroups: [['sea, sky']], mode: 'semantic', q: 'woodland' }))
    .rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(queryEmbeddings).toBe(0);
  expect(documents).toEqual(afterDelivery);
  expect(await inventory()).toEqual(partial);
  expect((await reopened.search('owner-b', { tagGroups: [['fantasy']] })).cards).toHaveLength(1);
  const writer = await connect(root), changed = await writer.openTable('unity_library_search_v1');
  await changed.update({ where: "workspaceId = 'owner-b'", valuesSql: { tags: "['wrong']", topics: "['wrong']" } });
  changed.close(); writer.close();
  const changedFiles = await inventory();
  await expect(reopened.search('owner-b', { tagGroups: [['fantasy']], mode: 'semantic', q: 'woodland' }))
    .rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(queryEmbeddings).toBe(0);
  expect(documents).toEqual(afterDelivery);
  expect(await inventory()).toEqual(changedFiles);
});

it('keeps portrait presence as metadata for native thumbnails and filtering without copying image bytes', async () => {
  const index = await open();
  await index.apply(event(1, { projection: { ...projection(), hasPortrait: true } }));
  await index.apply(event(1, { cardId: 'without-portrait', projection: projection() }));
  const result = await index.search('owner-a', { q: 'woodland', mode: 'semantic', has: ['portrait'] });
  expect(result.cards).toMatchObject([{ libraryCardId: 'fork-card', hasPortrait: true, portrait: null }]);
  expect(result.cards).toHaveLength(1);
  await expect(index.apply(event(2, { projection: { ...projection(), hasPortrait: 'invalid' as unknown as boolean } }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

it('updates lexical text and semantic vectors atomically, and keeps durable tombstones against old or duplicate deliveries after reopening', async () => {
  const index = await open(); await index.apply(event());
  await index.apply(event(2, { projection: projection('My ocean fork', 'An ocean guide.') }));
  expect((await index.search('owner-a', { q: 'woodland' })).cards).toEqual([]);
  expect((await index.search('owner-a', { q: 'ocean' })).cards).toHaveLength(1);
  expect(await index.apply(event(1))).toMatchObject({ applied: false });
  const deleted = event(3, { operation: 'delete' }); delete deleted.projection;
  expect(await index.apply(deleted)).toMatchObject({ applied: true });
  await index.close(); readers.splice(readers.indexOf(index), 1);
  const reopened = await open();
  expect(await reopened.apply(event(2))).toMatchObject({ applied: false });
  expect(await reopened.apply(deleted)).toMatchObject({ applied: false });
  expect((await reopened.search('owner-a', { q: 'ocean', mode: 'semantic' })).cards).toEqual([]);
  await expect(reopened.apply(event(3))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

it('does not publish a failed or cancelled embedding and leaves the previous projection/revision searchable for retry', async () => {
  const index = await open(); await index.apply(event());
  const before = await index.snapshot(); fail = true;
  await expect(index.apply(event(2, { projection: projection('Unpublished ocean', 'ocean') }))).rejects.toThrow(/offline/);
  expect(await index.snapshot()).toBe(before);
  expect((await index.search('owner-a', { q: 'woodland' })).cards[0]!.versionId).toBe('revision-1');
  await expect(index.apply(event(2), AbortSignal.abort())).rejects.toThrow();
  expect(await index.snapshot()).toBe(before);
  fail = false;
  expect(await index.apply(event(2))).toMatchObject({ applied: true });
});

it('cannot resurrect a newer tombstone when another host deletes while an old embedding is still in flight', async () => {
  const index = await open(); await index.apply(event());
  let release: (() => void) | undefined, started: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const begun = new Promise<void>((resolve) => { started = resolve; });
  const late = await openLibraryIndex({ lanceDirectory: root, space, queryEmbedder, documentEmbedder: {
    space, async embed() { started!(); await pending; return [[1, 0]]; },
  } }); readers.push(late);
  const delivery = late.apply(event(2)); await begun;
  const deleted = event(3, { operation: 'delete' }); delete deleted.projection;
  await index.apply(deleted); release!();
  expect(await delivery).toMatchObject({ applied: false, eventSequence: 2 });
  expect((await late.search('owner-a', { q: 'woodland', mode: 'semantic' })).cards).toEqual([]);
  expect((await index.search('owner-a', { q: 'woodland' })).cards).toEqual([]);
});

it('retains missing-provider upserts for caller retry, allows offline deletes and rejects an incompatible embedding model', async () => {
  const index = await open(false);
  await expect(index.apply(event())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(await index.snapshot()).toBe('absent');
  const deleted = event(2, { operation: 'delete' }); delete deleted.projection;
  expect(await index.apply(deleted)).toMatchObject({ applied: true, semantic: false });
  expect((await index.search('owner-a', { q: 'woodland' })).cards).toEqual([]);
  await expect(index.search('owner-a', { q: 'woodland', mode: 'semantic' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  await expect(openLibraryIndex({ lanceDirectory: root, space: { ...space, model: 'different-model' }, queryEmbedder })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(documents).toEqual([]);
});
