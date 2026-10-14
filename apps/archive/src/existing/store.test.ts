import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { injectTextChunk } from '@character-foundry/character-foundry/png';
import type { ScrapedCard } from '@character-unity/scraper-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openExistingArchive } from './store.js';
import type { ExistingSearch } from './search.js';
import { openExistingSearch } from './search.js';
import { connect, Index, makeArrowTable } from '@lancedb/lancedb';
import { Field, FixedSizeList, Float32, Schema, Utf8 } from 'apache-arrow';
import { buildSearchDocument, searchDocumentSchema } from '../search-document.js';
import { createNativeArchiveApp, nativeReadPrefix } from '../native/app.js';
import { createScheduler } from '../native/scheduler.js';
import { openLibraryIndex } from '../library-index.js';
import type { LibraryIndex } from '../library-index.js';
import { serializeNativeArchiveQuery } from '@character-unity/archive-client/native';
import type { NativeArchiveQuery } from '@character-unity/archive-client/native';

const encoder = new TextEncoder();
const image = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
function document(name = 'Aster', description = 'The original map keeper.') {
  return { spec: 'chara_card_v2', spec_version: '2.0', opaque: { keep: [null, true] }, data: {
    name, description, personality: '', scenario: '', first_mes: 'Hello.', mes_example: '', creator_notes: '',
    system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: ['Fantasy'], creator: 'ash',
    character_version: '1', extensions: { vendor: { keep: true } },
  } };
}
const json = (name = 'Aster', description?: string) => encoder.encode(JSON.stringify(document(name, description)));
function scraped(recordId: string, description = 'The updated map keeper.', extra: Partial<ScrapedCard> = {}): ScrapedCard {
  return { provider: 'chub', recordId, url: `https://chub.ai/characters/ash/${recordId}`, creator: 'ash', tags: ['Fantasy'],
    updatedAt: '2026-10-13T12:00:00Z', stats: { stars: 9 },
    objects: [{ role: 'card', bytes: json('Aster', description), mediaType: 'application/json' }], ...extra };
}
function fakeSearch(overrides: Partial<ExistingSearch>): ExistingSearch {
  const unused = () => { throw new Error('Unexpected search operation in store fixture'); };
  return { tableName: 'cards', vectorTableName: null, semantic: false, search: unused, browse: unused,
    snapshot: async () => 'fixture-generation', filterFields: [], sorts: [], embedding: undefined,
    upsertDocuments: unused, deleteDocuments: unused, upsertVectorDocuments: unused, indexVectorDocuments: unused,
    deleteVectorDocuments: unused, close() {}, ...overrides };
}

// A synthetic projection of the established Archive layout. Never invoke legacy initialization:
// its migrations, optimizer triggers and workers must not run against an attached Archive.
const legacySchema = `
  CREATE TABLE cards (
    id INTEGER PRIMARY KEY, author TEXT, name TEXT, tagline TEXT, description TEXT, topics TEXT,
    tokenCount INTEGER, tokenDescriptionCount INTEGER, tokenPersonalityCount INTEGER, tokenScenarioCount INTEGER,
    tokenMesExampleCount INTEGER, tokenFirstMessageCount INTEGER, tokenSystemPromptCount INTEGER, tokenPostHistoryCount INTEGER,
    lastModified TEXT, createdAt TEXT, firstDownloadedAt TEXT, nChats INTEGER, nMessages INTEGER, n_favorites INTEGER,
    starCount INTEGER, ratingsEnabled INTEGER, rating REAL, ratingCount INTEGER, ratings TEXT, fullPath TEXT,
    favorited INTEGER DEFAULT 0, language TEXT DEFAULT 'unknown', visibility TEXT DEFAULT 'unknown',
    hasAlternateGreetings INTEGER DEFAULT 0, hasLorebook INTEGER DEFAULT 0, hasEmbeddedLorebook INTEGER DEFAULT 0,
    hasLinkedLorebook INTEGER DEFAULT 0, hasExampleDialogues INTEGER DEFAULT 0, hasSystemPrompt INTEGER DEFAULT 0,
    hasGallery INTEGER DEFAULT 0, hasEmbeddedImages INTEGER DEFAULT 0, hasExpressions INTEGER DEFAULT 0,
    isFuzzed INTEGER DEFAULT 0, source TEXT DEFAULT 'chub', sourceId TEXT, sourcePath TEXT, sourceUrl TEXT
  );
  CREATE TABLE card_tags (
    cardId INTEGER NOT NULL, tag TEXT NOT NULL, normalizedTag TEXT NOT NULL,
    PRIMARY KEY(cardId, normalizedTag), FOREIGN KEY(cardId) REFERENCES cards(id) ON DELETE CASCADE
  );
  CREATE TABLE cached_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, cardId INTEGER NOT NULL, originalUrl TEXT NOT NULL, localPath TEXT NOT NULL,
    assetType TEXT NOT NULL, fileSize INTEGER, cachedAt TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(cardId, originalUrl), FOREIGN KEY(cardId) REFERENCES cards(id) ON DELETE CASCADE
  );
  CREATE TABLE card_source_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, source_id TEXT, source_path TEXT,
    canonical_card_id INTEGER NOT NULL, retired_card_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source, source_path, retired_card_id), FOREIGN KEY(canonical_card_id) REFERENCES cards(id) ON DELETE CASCADE
  );
  CREATE TABLE search_index_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, cardId TEXT NOT NULL, action TEXT NOT NULL);
  INSERT INTO search_index_queue(cardId, action) VALUES ('already-queued', 'upsert');
`;

describe('Archive using the existing database and files', () => {
  let directory: string;
  let databasePath: string;
  let filesDirectory: string;
  let objectsDirectory: string;
  let archive: Awaited<ReturnType<typeof openExistingArchive>> | undefined;
  let clock: number;

  function sql<T>(operation: (db: Database.Database) => T): T {
    const db = new Database(databasePath);
    try { return operation(db); } finally { db.close(); }
  }
  function tableInventory() {
    return sql((db) => {
      const names = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as { name: string }[];
      return Object.fromEntries(names.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]));
    });
  }
  async function fileInventory(root: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) Object.assign(files, await fileInventory(path));
      else files[path] = (await readFile(path)).toString('hex');
    }
    return files;
  }
  function seed(id: number, overrides: Record<string, string | number | null> = {}) {
    const row = { id, author: 'ash', name: 'Aster', description: 'Legacy searchable description', topics: 'Fantasy',
      tokenCount: 17, firstDownloadedAt: '2024-01-02T03:04:05Z', createdAt: '2023-01-01T00:00:00Z',
      lastModified: '2026-10-01T00:00:00Z', favorited: 1, starCount: 3,
      source: 'chub', sourceId: String(id), sourcePath: `ash/${id}`, fullPath: `ash/${id}`,
      sourceUrl: `https://chub.ai/characters/ash/${id}`, ...overrides };
    sql((db) => {
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO cards (${keys.join(',')}) VALUES (${keys.map((key) => `@${key}`).join(',')})`).run(row);
      db.prepare('INSERT INTO card_tags(cardId, tag, normalizedTag) VALUES (?, ?, ?)').run(id, 'Fantasy', 'fantasy');
    });
  }
  async function original(id: number, extension = 'json', bytes = json()) {
    const folder = join(filesDirectory, String(id).slice(0, 2));
    await mkdir(folder, { recursive: true });
    const path = join(folder, `${id}.${extension}`);
    await writeFile(path, bytes);
    return path;
  }
  async function open(readOnly = false, search?: ExistingSearch, libraryIndex?: LibraryIndex) {
    archive = await openExistingArchive({ databasePath, filesDirectory, objectsDirectory, readOnly,
      ...(search ? { search } : {}),
      ...(libraryIndex ? { libraryIndex } : {}),
      now: () => new Date(Date.UTC(2026, 9, 13, 12, 0, clock++)).toISOString() });
    return archive;
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'unity-existing-archive-'));
    databasePath = join(directory, 'cards.db');
    filesDirectory = join(directory, 'static');
    objectsDirectory = join(directory, 'versions');
    await mkdir(filesDirectory); await mkdir(objectsDirectory);
    clock = 0;
    sql((db) => { db.pragma('journal_mode = WAL'); db.exec(legacySchema); });
  });
  afterEach(async () => {
    archive?.close(); archive = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  it('browses existing metadata and reads wrapped JSON and full PNG only when requested', async () => {
    seed(1234);
    seed(5678, { name: 'PNG Aster', source: 'risuai', sourceId: 'risu-aster' });
    const wrapped = encoder.encode(JSON.stringify({ name: 'Listing metadata', description: 'A truncated listing summary.', source: { untouched: true }, definition: document('Sidecar Aster') }));
    const png = new Uint8Array(injectTextChunk(image, 'chara', Buffer.from(json('PNG Aster')).toString('base64')));
    const jsonPath = await original(1234, 'json', wrapped);
    const pngPath = await original(5678, 'card.png', png);
    const store = await open();
    const tablesBefore = tableInventory();
    const filesBefore = await fileInventory(filesDirectory);
    const objectsBefore = await fileInventory(objectsDirectory);
    expect((await store.list()).cards.map((card) => card.id).sort()).toEqual(['1234', '5678']);
    expect(store.status()).toMatchObject({ cards: 2, providers: { chub: 1, risuai: 1 } });
    expect(await readdir(objectsDirectory)).toEqual([]);
    expect(await store.tags()).toEqual([{ tag: 'Fantasy', count: 2 }]);
    expect((await store.card('1234')).document).toEqual(document('Sidecar Aster'));
    expect((await store.card('5678')).document).toEqual(document('PNG Aster'));
    const jsonRef = (await store.files('1234')).find((ref) => ref.role === 'card')!;
    expect((await store.object(jsonRef.sha256)).bytes).toEqual(json('Sidecar Aster'));
    const cardRef = (await store.files('5678')).find((ref) => ref.role === 'card')!;
    expect((await store.object(cardRef.sha256)).bytes).toEqual(png);
    expect(new Uint8Array(await readFile(jsonPath))).toEqual(wrapped);
    expect(new Uint8Array(await readFile(pngPath))).toEqual(png);
    expect(sql((db) => db.prepare('SELECT * FROM search_index_queue').all()))
      .toEqual([{ id: 1, cardId: 'already-queued', action: 'upsert' }]);
    expect(tableInventory()).toEqual(tablesBefore);
    expect(await fileInventory(filesDirectory)).toEqual(filesBefore);
    expect(await fileInventory(objectsDirectory)).toEqual(objectsBefore);
  });

  it('keeps the read-only instance identity when the first writer creates bookkeeping', async () => {
    seed(1234); await original(1234);
    const reader = await open(true), archiveId = reader.archiveId;
    const pinned = await reader.card('1234');
    reader.close(); archive = undefined;
    const writer = await open();
    expect(writer.archiveId).toBe(archiveId);
    expect((await writer.card('1234', pinned.versionId)).archiveId).toBe(archiveId);
    writer.close(); archive = undefined;
    expect((await open(true)).archiveId).toBe(archiveId);
  });

  it('updates one numeric identity and keeps its original bytes, versions, favorite and first download date', async () => {
    seed(1234);
    const bytes = json();
    const path = await original(1234, 'json', bytes);
    const store = await open();
    expect(await store.sink.known('chub', '1234')).toMatchObject({ updatedAt: expect.any(String) });
    expect(await store.put(scraped('1234'))).toBe('updated');
    expect(await store.put(scraped('1234'))).toBe('unchanged');
    const detail = await store.card('1234');
    expect(detail).toMatchObject({ id: '1234', recordId: '1234', versions: 2 });
    expect(detail.versionList.map((version) => version.sequence)).toEqual([2, 1]);
    expect(detail.document).toEqual(document('Aster', 'The updated map keeper.'));
    const first = detail.versionList[1]!.objects.find((ref) => ref.role === 'card')!;
    expect((await store.object(first.sha256)).bytes).toEqual(bytes);
    expect(new Uint8Array(await readFile(path))).toEqual(bytes);
    expect(sql((db) => db.prepare('SELECT id, sourceId, favorited, firstDownloadedAt FROM cards').all()))
      .toEqual([{ id: 1234, sourceId: '1234', favorited: 1, firstDownloadedAt: '2024-01-02T03:04:05Z' }]);
    store.close(); archive = undefined;
    const reopened = await open();
    expect((await reopened.card('1234')).versionList).toHaveLength(2);
    // All bookkeeping shares cards.db; there is no rebuilt metadata database alongside it.
    expect((await readdir(directory)).filter((name) => /\.(?:db|sqlite)$/.test(name))).toEqual(['cards.db']);
  });

  it('lazily checks bounded legacy candidates, indexes explicitly without copying files, and pins source versions', async () => {
    seed(1234); seed(5678, { source: 'ct', sourceId: 'same-content' });
    await original(1234); await original(5678);
    const store = await open();
    const first = await store.card('1234');
    const file = first.versionList[0]!.objects.find((ref) => ref.role === 'card')!;
    const lazy = await store.identity({ fileHash: file.sha256, name: 'Aster' });
    expect(lazy).toMatchObject({ complete: false });
    expect(lazy.matches.map((match) => match.cardId)).toEqual(['1234', '5678']);
    const batch = await store.indexIdentities({ limit: 1 });
    expect(batch).toMatchObject({ processed: 1, nextAfter: expect.any(String), complete: false });
    expect(await store.indexIdentities({ limit: 1, after: batch.nextAfter! })).toMatchObject({ processed: 1, nextAfter: null, complete: true });
    expect(await fileInventory(objectsDirectory)).toEqual({});
    const indexed = await store.identity({ fileHash: file.sha256, contentHash: lazy.matches[0]!.contentHash! });
    expect(indexed.complete).toBe(true);
    await store.put(scraped('1234', undefined, { objects: [{ role: 'card', bytes: json('Latest title', 'Changed text'), mediaType: 'application/json' }] }));
    const pinned = await store.card('1234', first.versionId);
    expect(pinned.document).toEqual(document());
    expect(pinned).toMatchObject({ name: 'Aster', tags: ['Fantasy'], changedAt: first.versionList[0]!.fetchedAt, remoteUpdatedAt: first.versionList[0]!.remoteUpdatedAt });
    await expect(store.card('5678', first.versionId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    store.close(); archive = undefined;
    const reopened = await open(true);
    expect((await reopened.identity({ fileHash: file.sha256 })).matches.map((match) => match.cardId)).toEqual(['1234', '5678']);
    expect((await reopened.card('1234', first.versionId)).document).toEqual(document());
  });

  it('indexes actual document names, reports unresolved matching content, and never substitutes a changed legacy file', async () => {
    seed(1234, { name: 'Stale listing name' });
    const card = { ...document('Actual document name'), data: { ...document('Actual document name').data,
      assets: [{ type: 'icon', name: 'missing', ext: 'png', uri: 'https://images.test/missing.png' }] } };
    await original(1234, 'json', encoder.encode(JSON.stringify(card)));
    const store = await open();
    const before = await store.card('1234');
    expect(await store.identity({ contentHash: 'b'.repeat(64), name: 'Unrelated card' })).toMatchObject({ complete: false, unresolved: 1 });
    expect(await store.indexIdentities({ limit: 1 })).toMatchObject({ processed: 1, unavailable: 1, complete: true });
    expect(await store.identity({ contentHash: 'b'.repeat(64), name: 'Unrelated card' })).toMatchObject({ complete: true, unresolved: 0 });
    expect(await store.identity({ contentHash: 'b'.repeat(64), name: 'Actual document name' })).toMatchObject({ complete: false, unresolved: 1 });
    await original(1234, 'json', json('Changed document'));
    await expect(store.card('1234', before.versionId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.files('1234', before.versionId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.indexIdentities({ limit: 101 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.indexIdentities({ after: 'not-a-cursor' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('keeps an identical baseline as one version across repeated scrapes with different container filenames', async () => {
    seed(1234);
    await original(1234);
    const store = await open();
    const update = scraped('1234', 'The original map keeper.');
    expect(await store.put(update)).toBe('unchanged');
    expect(await store.put(update)).toBe('unchanged');
    const detail = await store.card('1234');
    expect(detail.versions).toBe(1);
    expect(detail.versionList).toHaveLength(1);
    expect(detail.document).toEqual(document());
    expect(await fileInventory(objectsDirectory)).toEqual({});
  });

  it('uses upstream Chub numeric IDs and normalized CT paths without duplicating an existing card', async () => {
    seed(11, { source: 'ct', sourceId: 'old-record', sourcePath: ' Alice//Test/ ', fullPath: null,
      sourceUrl: 'https://character-tavern.com/character/alice/test' });
    await original(11);
    const store = await open();
    expect(await store.put(scraped('829'))).toBe('added');
    expect(await store.put(scraped('new-record', 'The tavern changed.', { provider: 'ct',
      url: 'https://character-tavern.com/character/ALICE/test/' }))).toBe('updated');
    expect(await store.put(scraped('new-record', 'The tavern changed.', { provider: 'ct',
      url: 'https://character-tavern.com/character/ALICE/test/' }))).toBe('unchanged');
    expect(sql((db) => db.prepare('SELECT id, source, sourceId FROM cards ORDER BY id').all()))
      .toEqual([{ id: 11, source: 'ct', sourceId: 'new-record' }, { id: 829, source: 'chub', sourceId: '829' }]);
    expect((await store.card('11')).document).toEqual(document('Aster', 'The tavern changed.'));
    expect((await store.list()).total).toBe(2);
  });

  it('matches a CT historical path alias to the same numeric card after the upstream ID changes again', async () => {
    seed(11, { source: 'ct', sourceId: 'current-id', sourcePath: 'alice/current', fullPath: null,
      sourceUrl: 'https://character-tavern.com/character/alice/current' });
    await original(11);
    sql((db) => db.prepare('INSERT INTO card_source_aliases(source,source_id,source_path,canonical_card_id,retired_card_id) VALUES (?,?,?,?,?)')
      .run('ct', 'retired-id', ' Alice//Previous/ ', 11, 12));
    const store = await open();
    expect(await store.put(scraped('new-id', 'Found through the old path.', { provider: 'ct',
      url: 'https://character-tavern.com/character/ALICE/previous/' }))).toBe('updated');
    expect(sql((db) => db.prepare('SELECT id, source, sourceId FROM cards').all()))
      .toEqual([{ id: 11, source: 'ct', sourceId: 'new-id' }]);
    expect((await store.card('11')).document).toEqual(document('Aster', 'Found through the old path.'));
  });

  it('blocks a canonical CT card through a retired identity and restores it when unblocked', async () => {
    seed(11, { source: 'ct', sourceId: 'current-id', sourcePath: 'alice/current' });
    await original(11);
    sql((db) => db.prepare('INSERT INTO card_source_aliases(source,source_id,source_path,canonical_card_id,retired_card_id) VALUES (?,?,?,?,?)')
      .run('ct', 'retired-id', 'alice/previous', 11, 12));
    const store = await open();
    store.block('ct', 'retired-id');
    expect((await store.list()).total).toBe(0);
    expect(store.status().cards).toBe(0);
    expect(await store.tags()).toEqual([]);
    await expect(store.card('11')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await store.sink.blocked('ct', 'current-id')).toBe(true);
    await expect(store.put(scraped('current-id', 'Blocked update.', { provider: 'ct',
      url: 'https://character-tavern.com/character/alice/current' }))).rejects.toThrow(/blocked/i);
    store.unblock('ct', 'retired-id');
    expect((await store.list()).total).toBe(1);
    expect(await store.sink.blocked('ct', 'current-id')).toBe(false);
    expect((await store.card('11')).document).toEqual(document());
  });

  it('imports root and data blacklists into the same database and blocks canonical CT aliases and unseen paths', async () => {
    seed(1234); seed(5678);
    seed(11, { source: 'ct', sourceId: 'current-id', sourcePath: 'alice/current' });
    sql((db) => db.prepare('INSERT INTO card_source_aliases(source,source_id,source_path,canonical_card_id,retired_card_id) VALUES (?,?,?,?,?)')
      .run('ct', 'retired-id', 'alice/previous', 11, 12));
    await mkdir(join(directory, 'data'));
    await writeFile(join(directory, 'blacklist.txt'), '1234\n');
    await writeFile(join(directory, 'data', 'chub-blacklist.txt'), '5678 # removed upstream\n');
    await writeFile(join(directory, 'ct-blacklist.txt'), ' ALICE//Previous/ \nnew/hidden\n');
    archive = await openExistingArchive({ databasePath, filesDirectory, objectsDirectory, legacyRoot: directory });
    expect(archive.status()).toMatchObject({ cards: 0, blocked: 4 });
    expect((await archive.list()).total).toBe(0);
    expect(await archive.sink.blocked('chub', '1234')).toBe(true);
    expect(await archive.sink.blocked('chub', '5678')).toBe(true);
    expect(await archive.sink.blocked('ct', 'current-id')).toBe(true);
    await expect(archive.put(scraped('unseen-id', 'Blacklisted path.', { provider: 'ct',
      url: 'https://character-tavern.com/character/new/hidden' }))).rejects.toThrow(/blocked/i);
    expect(sql((db) => db.prepare('SELECT id FROM cards ORDER BY id').all()))
      .toEqual([{ id: 11 }, { id: 1234 }, { id: 5678 }]);
    archive.close(); archive = undefined;
    const reopened = await open();
    expect(reopened.status()).toMatchObject({ cards: 0, blocked: 4 });
    expect(await readFile(join(directory, 'blacklist.txt'), 'utf8')).toBe('1234\n');
    expect(await readFile(join(directory, 'data', 'chub-blacklist.txt'), 'utf8')).toBe('5678 # removed upstream\n');
    expect(await fileInventory(objectsDirectory)).toEqual({});
  });

  it('does not import or persist legacy blacklists during read-only attachment', async () => {
    seed(1234); await original(1234);
    await writeFile(join(directory, 'blacklist.txt'), '1234\n');
    const before = tableInventory();
    archive = await openExistingArchive({ databasePath, filesDirectory, readOnly: true, legacyRoot: directory });
    expect((await archive.list()).total).toBe(1);
    expect(archive.status()).toMatchObject({ cards: 1, blocked: 0 });
    expect(await archive.sink.blocked('chub', '1234')).toBe(false);
    expect((await archive.card('1234')).document).toEqual(document());
    expect(tableInventory()).toEqual(before);
    expect(await fileInventory(objectsDirectory)).toEqual({});
  });

  it('retains a new version when only a cached asset changes', async () => {
    seed(1234); await original(1234);
    const folder = join(filesDirectory, 'cached-assets', '1234');
    const previous = encoder.encode('Original attachment');
    const changed = encoder.encode('Changed attachment');
    await mkdir(folder, { recursive: true });
    const path = join(folder, 'note.txt');
    await writeFile(path, previous);
    sql((db) => db.prepare('INSERT INTO cached_assets(cardId, originalUrl, localPath, assetType) VALUES (?, ?, ?, ?)')
      .run(1234, 'embedded://note.txt', 'cached-assets/1234/note.txt', 'custom'));
    const store = await open();
    const update = scraped('1234', 'The original map keeper.', { objects: [
      { role: 'card', bytes: json(), mediaType: 'application/json' },
      { role: 'asset', name: 'embedded://note.txt', bytes: changed, mediaType: 'text/plain' },
    ] });
    expect(await store.put(update)).toBe('updated');
    expect(await store.put(update)).toBe('unchanged');
    const detail = await store.card('1234');
    expect(detail.document).toEqual(document());
    expect(detail.versionList).toHaveLength(2);
    const latest = detail.versionList[0]!.objects.find((ref) => ref.role === 'asset')!;
    const earlier = detail.versionList[1]!.objects.find((ref) => ref.role === 'asset')!;
    expect((await store.object(latest.sha256)).bytes).toEqual(changed);
    expect((await store.object(earlier.sha256)).bytes).toEqual(previous);
    expect(new Uint8Array(await readFile(path))).toEqual(previous);
  });

  it('stores only changed bytes when a scrape reuses the existing portrait and cached asset', async () => {
    seed(1234); await original(1234); await original(1234, 'png', image);
    const folder = join(filesDirectory, 'cached-assets', '1234');
    const attachment = encoder.encode('Retained attachment');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'note.txt'), attachment);
    sql((db) => db.prepare('INSERT INTO cached_assets(cardId, originalUrl, localPath, assetType) VALUES (?, ?, ?, ?)')
      .run(1234, 'embedded://note.txt', 'cached-assets/1234/note.txt', 'custom'));
    const staticBefore = await fileInventory(filesDirectory);
    const changedCard = json('Aster', 'Changed card, same portrait and attachment.');
    const update = scraped('1234', 'Changed card, same portrait and attachment.', { objects: [
      { role: 'card', bytes: changedCard, mediaType: 'application/json' },
      { role: 'portrait', bytes: image, mediaType: 'image/png' },
      { role: 'asset', name: 'embedded://note.txt', bytes: attachment, mediaType: 'text/plain' },
    ] });
    const store = await open();
    expect(await store.put(update)).toBe('updated');
    expect(await store.put(update)).toBe('unchanged');
    expect(Object.values(await fileInventory(objectsDirectory))).toEqual([Buffer.from(changedCard).toString('hex')]);
    expect(await fileInventory(filesDirectory)).toEqual(staticBefore);
    const detail = await store.card('1234');
    expect(detail.versionList).toHaveLength(2);
    const refs = await store.files('1234');
    const portrait = refs.find((ref) => ref.role === 'portrait')!;
    const asset = refs.find((ref) => ref.role === 'asset')!;
    expect((await store.object(portrait.sha256)).bytes).toEqual(image);
    expect((await store.object(asset.sha256)).bytes).toEqual(attachment);
  });

  it('serializes concurrent lexical drains so a slow old write cannot replace newer indexed content', async () => {
    seed(1234);
    sql((db) => { db.exec('DELETE FROM search_index_queue'); db.prepare('INSERT INTO search_index_queue(cardId,action) VALUES (?,?)').run('1234', 'upsert'); });
    let release: () => void = () => undefined, started: () => void = () => undefined;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    const began = new Promise<void>((resolve) => { started = resolve; });
    let calls = 0, indexedDescription: unknown;
    archive = await openExistingArchive({ databasePath, filesDirectory, objectsDirectory, search: fakeSearch({
      async upsertDocuments(rows) {
        calls++;
        if (calls === 1) { started(); await delayed; }
        indexedDescription = rows[0]!.description;
      },
    }) });
    const first = archive.flushSearchQueue();
    await began;
    sql((db) => {
      db.prepare('UPDATE cards SET description = ? WHERE id = ?').run('Newest source content', 1234);
      db.prepare('INSERT INTO search_index_queue(cardId,action) VALUES (?,?)').run('1234', 'upsert');
    });
    const second = archive.flushSearchQueue();
    release();
    await Promise.all([first, second]);
    expect(indexedDescription).toBe('Newest source content');
    expect(sql((db) => db.prepare('SELECT * FROM search_index_queue').all())).toEqual([]);
  });

  it('keeps changing upstream counters from accumulating unreferenced raw snapshots', async () => {
    const store = await open();
    const scrape = (stars: number) => scraped('1234', 'Stable card content', { stats: { stars }, objects: [
      { role: 'card', bytes: json('Aster', 'Stable card content'), mediaType: 'application/json' },
      { role: 'raw', name: 'source.json', bytes: encoder.encode(JSON.stringify({ stars })), mediaType: 'application/json' },
    ] });
    expect(await store.put(scrape(1))).toBe('added');
    const files = await fileInventory(objectsDirectory);
    const recorded = sql((db) => db.prepare('SELECT * FROM unity_archive_objects ORDER BY sha256').all());
    expect(await store.put(scrape(2))).toBe('unchanged');
    expect(await store.put(scrape(3))).toBe('unchanged');
    expect(await fileInventory(objectsDirectory)).toEqual(files);
    expect(sql((db) => db.prepare('SELECT * FROM unity_archive_objects ORDER BY sha256').all())).toEqual(recorded);
    const detail = await store.card('1234');
    expect(detail).toMatchObject({ versions: 1, stats: { stars: 3 } });
    const raw = detail.versionList[0]!.objects.find((ref) => ref.role === 'raw')!;
    expect(new TextDecoder().decode((await store.object(raw.sha256)).bytes)).toBe(JSON.stringify({ stars: 1 }));
  });

  it('does not scan originals at startup and reports missing or malformed files on demand', async () => {
    seed(1234); seed(5678, { name: 'Missing' });
    await original(1234, 'json', encoder.encode('{broken'));
    const store = await open();
    expect((await store.list()).total).toBe(2);
    await expect(store.card('1234')).rejects.toBeInstanceOf(Error);
    await expect(store.card('5678')).rejects.toBeInstanceOf(Error);
    expect(await readdir(objectsDirectory)).toEqual([]);
    expect((await store.list()).total).toBe(2);
  });

  it('rejects symlinked originals and cached paths escaping the configured file root', async () => {
    seed(1234);
    const outside = join(directory, 'outside.json');
    await writeFile(outside, json());
    await mkdir(join(filesDirectory, '12'));
    await symlink(outside, join(filesDirectory, '12', '1234.json'));
    let store = await open();
    await expect(store.card('1234')).rejects.toBeInstanceOf(Error);
    store.close(); archive = undefined;
    await rm(join(filesDirectory, '12', '1234.json'));
    await original(1234);
    sql((db) => db.prepare('INSERT INTO cached_assets(cardId, originalUrl, localPath, assetType) VALUES (?, ?, ?, ?)')
      .run(1234, 'https://example.invalid/asset.json', '../outside.json', 'custom'));
    store = await open();
    await expect(store.files('1234')).rejects.toBeInstanceOf(Error);
    expect(new Uint8Array(await readFile(outside))).toEqual(json());
  });

  it('refuses known legacy optimizer triggers before writer takeover and permits read-only browsing', async () => {
    seed(1234); await original(1234);
    sql((db) => db.exec(`CREATE TABLE png_optimization_queue(cardId INTEGER UNIQUE);
      CREATE TRIGGER trg_cards_after_update_png_opt_queue AFTER UPDATE ON cards
      BEGIN INSERT OR IGNORE INTO png_optimization_queue(cardId) VALUES (NEW.id); END;`));
    await expect(open()).rejects.toThrow(/optimi[sz]/i);
    const before = await readFile(databasePath);
    const store = await open(true);
    expect((await store.card('1234')).document).toEqual(document());
    store.close(); archive = undefined;
    expect(await readFile(databasePath)).toEqual(before);
    expect(sql((db) => db.prepare('SELECT * FROM png_optimization_queue').all())).toEqual([]);
  });

  it('rejects object roots containing the existing files and rejects symlinked roots', async () => {
    for (const unsafeObjects of [filesDirectory, directory]) {
      await expect(openExistingArchive({ databasePath, filesDirectory, objectsDirectory: unsafeObjects }))
        .rejects.toThrow(/object directory.*existing files/i);
    }
    const alias = join(directory, 'static-alias');
    await symlink(filesDirectory, alias);
    await expect(openExistingArchive({ databasePath, filesDirectory: alias, objectsDirectory }))
      .rejects.toThrow(/symlink/i);
  });

  it('reads wrapped originals without requiring or creating an object directory in read-only mode', async () => {
    seed(1234);
    const bytes = encoder.encode(JSON.stringify({ definition: document() }));
    const path = await original(1234, 'json', bytes);
    await rm(objectsDirectory, { recursive: true });
    const before = await readFile(databasePath);
    archive = await openExistingArchive({ databasePath, filesDirectory, readOnly: true });
    expect((await archive.card('1234')).document).toEqual(document());
    const ref = (await archive.files('1234')).find((file) => file.role === 'card')!;
    expect((await archive.object(ref.sha256)).bytes).toEqual(json());
    archive.close(); archive = undefined;
    expect(await readFile(databasePath)).toEqual(before);
    expect(new Uint8Array(await readFile(path))).toEqual(bytes);
    expect(await readdir(directory)).not.toContain('versions');
    expect(await readdir(directory)).not.toContain('unity-objects');
  });

  it('reads committed WAL metadata changes rather than a startup copy', async () => {
    seed(1234); await original(1234);
    const store = await open(true);
    const writer = new Database(databasePath);
    try {
      writer.pragma('journal_mode = WAL');
      writer.prepare('UPDATE cards SET name = ? WHERE id = ?').run('Changed by the owner', 1234);
      expect((await store.list()).cards[0]!.name).toBe('Changed by the owner');
    } finally { writer.close(); }
  });

  it('paginates beyond ten thousand existing rows without requiring their originals', async () => {
    sql((db) => {
      const insert = db.prepare('INSERT INTO cards(id, name, source, sourceId) VALUES (?, ?, ?, ?)');
      db.transaction(() => {
        for (let id = 1; id <= 10_001; id++) insert.run(id, `Card ${id}`, 'chub', String(id));
      })();
    });
    const store = await open(true);
    const page = await store.list({ limit: 1, offset: 10_000, sort: 'updated' });
    expect(page).toMatchObject({ total: 10_001, cards: [{ id: '1' }] });
    expect(store.status()).toMatchObject({ cards: 10_001 });
    expect(await readdir(objectsDirectory)).toEqual([]);
  });

  it('reports portrait filtering as unsupported before a search operation', async () => {
    seed(1234);
    const store = await open(false, fakeSearch({}));
    expect(store.status().capabilities.has).not.toContain('portrait');
    expect(store.status().capabilities.sorts).not.toContain('downloads');
    await expect(store.list({ sort: 'downloads' })).rejects.toThrow(/no download-count metric/i);
    await expect(store.list({ has: ['portrait'] })).rejects.toThrow(/cannot filter portrait presence/i);
    await expect(store.list({ q: 'Aster', has: ['portrait'] })).rejects.toThrow(/cannot filter portrait presence/i);
  });

  it('preserves semantic ranking and pagination unless an explicit sort is requested', async () => {
    seed(1234, { name: 'Alpha', lastModified: '2026-10-13T00:00:00Z' });
    seed(5678, { name: 'Zeta', lastModified: '2025-01-01T00:00:00Z' });
    const modes: (string | undefined)[] = [];
    const store = await open(false, fakeSearch({ semantic: true, async search(_text, query) {
      modes.push(query?.mode);
      return { ids: ['5678', '1234'], scores: new Map([['5678', 0.9], ['1234', 0.5]]),
        matches: new Map([['5678', { section: 'description', text: 'A semantic map keeper match', score: 0.9 }]]), complete: false };
    } }));
    const ranked = await store.list({ q: 'map keeper', mode: 'semantic' });
    expect(ranked.cards.map((card) => card.id)).toEqual(['5678', '1234']);
    expect(ranked).toMatchObject({ total: 2, complete: false, scores: [0.9, 0.5],
      matches: [{ section: 'description', text: 'A semantic map keeper match', score: 0.9 }, null] });
    expect((await store.list({ q: 'map keeper', mode: 'semantic', limit: 1, offset: 1, snapshot: ranked.snapshot })).cards[0]!.id).toBe('1234');
    const sorted = await store.list({ q: 'map keeper', mode: 'semantic', sort: 'name' });
    expect(sorted.cards.map((card) => card.id)).toEqual(['1234', '5678']);
    expect(sorted.scores).toEqual([0.5, 0.9]);
    expect(sorted.matches).toEqual([null, { section: 'description', text: 'A semantic map keeper match', score: 0.9 }]);
    expect(modes).toEqual(['semantic', 'semantic', 'semantic']);
    expect(store.status().capabilities.semantic).toBe(true);
  });

  it('binds offset paging to the query, current SQLite data, Lance generation and full ranking', async () => {
    seed(1234); seed(5678);
    let generation = 'one', order = ['1234', '5678'];
    const store = await open(false, fakeSearch({ snapshot: async () => generation, async search() {
      return { ids: order, scores: new Map(order.map((id, index) => [id, 1 / (index + 1)])), matches: new Map(), complete: false };
    } }));
    const first = await store.list({ q: 'map keeper', mode: 'semantic', limit: 1 });
    const next = { q: 'map keeper', mode: 'semantic' as const, limit: 1, offset: 1, snapshot: first.snapshot };
    expect((await store.list(next)).cards[0]!.id).toBe('5678');
    await expect(store.list({ ...next, q: 'different' })).rejects.toMatchObject({ code: 'SNAPSHOT_CHANGED' });
    generation = 'two';
    await expect(store.list(next)).rejects.toMatchObject({ code: 'SNAPSHOT_CHANGED' });
    generation = 'one'; order = ['5678', '1234'];
    await expect(store.list(next)).rejects.toMatchObject({ code: 'SNAPSHOT_CHANGED' });
    order = ['1234', '5678'];
    sql((db) => db.prepare('UPDATE cards SET name = ? WHERE id = ?').run('Changed by the Archive owner', 1234));
    await expect(store.list(next)).rejects.toMatchObject({ code: 'SNAPSHOT_CHANGED' });
  });

  it('rejects a search whose source or Lance generation changes during the request', async () => {
    seed(1234);
    let generation = 'before';
    const store = await open(false, fakeSearch({ snapshot: async () => generation, async search() {
      generation = 'after';
      return { ids: ['1234'], scores: new Map([['1234', 1]]), matches: new Map(), complete: true };
    } }));
    await expect(store.list({ q: 'map keeper' })).rejects.toMatchObject({ code: 'SNAPSHOT_CHANGED' });
  });

  it('passes typed browse filters to Lance and reads only the returned ordered page', async () => {
    seed(1234, { name: 'Alpha' }); seed(5678, { name: 'Zeta' });
    const calls: unknown[] = [];
    const store = await open(false, fakeSearch({ filterFields: [{ name: 'tokenCount', type: 'number' }], async browse(query) {
      calls.push(query);
      return { ids: ['5678'], total: 30_000 };
    } }));
    const page = await store.list({ mode: 'browse', filter: 'tokenCount >= 100 OR tokenCount = 0', sort: 'name_desc', offset: 20_000, limit: 1 });
    expect(page).toMatchObject({ cards: [{ id: '5678' }], total: 30_000, complete: true });
    expect(calls).toEqual([{ filter: '(tokenCount >= 100 OR tokenCount = 0)', sort: 'name_desc', offset: 20_000, limit: 1 }]);
    expect(store.status().capabilities).toMatchObject({ browse: true, filterFields: [{ name: 'tokenCount', type: 'number' }] });
  });

  it('serves existing Lance lexical, semantic, hybrid and typed browse through the native v2 HTTP contract', async () => {
    seed(1234, { name: 'Silver forest', description: 'A woodland map keeper.' });
    seed(5678, { name: 'Ocean', description: 'A blue ocean diver.', source: 'ct' });
    const rows = sql((db) => db.prepare('SELECT * FROM cards ORDER BY id').all()) as Record<string, unknown>[];
    const documents = rows.map((row) => buildSearchDocument(row, Date.UTC(2026, 9, 13)));
    const lanceDirectory = join(directory, 'search.lance'), connection = await connect(lanceDirectory);
    const lexical = await connection.createTable('cards', makeArrowTable(documents, { schema: searchDocumentSchema }));
    await lexical.createIndex('searchText', { config: Index.fts({ withPosition: true }) }); lexical.close();
    const schema = new Schema([new Field('card_id', new Utf8(), false), new Field('section', new Utf8(), false), new Field('matchText', new Utf8(), false),
      ...searchDocumentSchema.fields, new Field('vector', new FixedSizeList(2, new Field('item', new Float32(), false)), false)]);
    const vectors = await connection.createTable('card_vectors', makeArrowTable(documents.map((doc, index) => ({ ...doc,
      card_id: doc.id, section: 'description', matchText: doc.description, vector: index ? [0, 1] : [1, 0] })), { schema }));
    vectors.close(); connection.close();
    sql((db) => {
      db.exec('CREATE TABLE card_embedding_meta(model_name TEXT,dims INTEGER)');
      db.prepare('INSERT INTO card_embedding_meta VALUES (?,?)').run('http-fixture', 2);
    });
    let embeddings = 0;
    const search = await openExistingSearch({ lanceDirectory, databasePath, embedder: {
      space: { model: 'http-fixture', dimensions: 2, sourceDimensions: 2, queryInstruction: '' },
      async embed() { embeddings++; return [1, 0]; },
    } });
    const libraryIndex = await openLibraryIndex({ lanceDirectory, space: { model: 'http-fixture', dimensions: 2 },
      queryEmbedder: { space: { model: 'http-fixture', dimensions: 2, sourceDimensions: 2, queryInstruction: '' }, embed: async () => [1, 0] },
      documentEmbedder: { space: { model: 'http-fixture', dimensions: 2, sourceDimensions: 2, queryInstruction: '' }, embed: async () => [[1, 0]] },
    });
    const store = await open(true, search, libraryIndex), app = createNativeArchiveApp(store, createScheduler(store, []), [], { adminToken: 'integration-admin', libraryIndex });
    const status = await (await app.request(`${nativeReadPrefix}/status`)).json();
    expect(status).toMatchObject({ capabilities: { lexical: true, semantic: true, browse: true,
      embedding: { model: 'http-fixture', dimensions: 2, indexedCards: null, indexedRows: null } } });
    expect(await (await app.request(`${nativeReadPrefix}/cards?mode=lexical&q=forest`)).json()).toMatchObject({ total: 1, cards: [{ id: '1234' }] });
    const browse = await (await app.request(`${nativeReadPrefix}/cards?mode=browse&filter=source%20%3D%20ct&sort=name`)).json();
    expect(browse).toMatchObject({ total: 1, cards: [{ id: '5678' }], complete: true });
    expect(embeddings).toBe(0);
    const first = await (await app.request(`${nativeReadPrefix}/cards?mode=semantic&q=woodland&limit=1`)).json() as { snapshot: string };
    expect(first).toMatchObject({ complete: false, cards: [{ id: '1234' }], scores: [1], matches: [{ section: 'description', text: 'A woodland map keeper.' }] });
    const next = await app.request(`${nativeReadPrefix}/cards?mode=semantic&q=woodland&limit=1&offset=1&snapshot=${first.snapshot}`);
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({ cards: [{ id: '5678' }], matches: [{ section: 'description', text: 'A blue ocean diver.' }] });
    expect((await app.request(`${nativeReadPrefix}/cards?mode=hybrid&q=forest`)).status).toBe(200);
    expect((await app.request(`${nativeReadPrefix}/cards?mode=browse&filter=unknown%20%3D%20ct`)).status).toBe(400);
    expect((await app.request(`${nativeReadPrefix}/cards?mode=semantic&q=different&offset=1&snapshot=${first.snapshot}`)).status).toBe(409);
    const mutation = { workspaceId: 'owner-a', cardId: 'owned-fork', revisionId: 'own-revision', eventSequence: 1, operation: 'upsert', projection: {
      name: 'My changed woodland', creator: 'owner', tags: ['Fantasy'], description: 'A newly changed woodland glass oracle.', personality: '', scenario: '',
      first_mes: 'Hello.', mes_example: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tokens: 40,
      createdAt: '2026-10-13T01:00:00.000Z', updatedAt: '2026-10-13T02:00:00.000Z', spec: 'v3',
    } };
    const deliver = (event: unknown) => app.request('/api/archive/admin/v1/library-index', { method: 'POST',
      headers: { authorization: 'Bearer integration-admin', 'content-type': 'application/json' }, body: JSON.stringify(event) });
    expect((await deliver(mutation)).status).toBe(200);
    const headers = { authorization: 'Bearer integration-admin', 'x-unity-library-workspace': 'owner-a' };
    const own = await (await app.request(`${nativeReadPrefix}/cards?mode=semantic&q=woodland&limit=1`, { headers })).json() as { snapshot: string };
    expect(own).toMatchObject({ cards: [{ id: 'unity:owned-fork', libraryOwned: true, libraryCardId: 'owned-fork', versionId: 'own-revision' }], total: 3,
      matches: [{ section: 'card', score: 1 }] });
    const continuation = await (await app.request(`${nativeReadPrefix}/cards?mode=semantic&q=woodland&limit=1&offset=1&snapshot=${own.snapshot}`, { headers })).json();
    expect(continuation).toMatchObject({ cards: [{ id: '1234' }], total: 3 });
    expect(await (await app.request(`${nativeReadPrefix}/cards?mode=lexical&q=woodland`, { headers })).json()).toMatchObject({ total: 2 });
    expect(await (await app.request(`${nativeReadPrefix}/cards?mode=lexical&q=woodland`)).json()).toMatchObject({ total: 1 });
    expect((await app.request(`${nativeReadPrefix}/cards`, { headers: { 'x-unity-library-workspace': 'owner-a' } })).status).toBe(401);
    expect((await app.request(`${nativeReadPrefix}/cards?libraryWorkspaceId=owner-a`, { headers })).status).toBe(400);
    const names: string[] = [];
    let receipt: string | undefined;
    for (let offset = 0; offset < 3; offset++) {
      const page = await (await app.request(`${nativeReadPrefix}/cards?sort=name&limit=1&offset=${offset}${receipt ? `&snapshot=${receipt}` : ''}`, { headers })).json() as { cards: { name: string }[]; snapshot: string };
      receipt = page.snapshot; names.push(page.cards[0]!.name);
    }
    expect(names).toEqual(['My changed woodland', 'Ocean', 'Silver forest']);
    expect((await deliver({ workspaceId: 'owner-a', cardId: 'owned-fork', revisionId: 'own-revision', eventSequence: 2, operation: 'delete' })).status).toBe(200);
    expect((await app.request(`${nativeReadPrefix}/cards?mode=semantic&q=woodland&limit=1&offset=1&snapshot=${own.snapshot}`, { headers })).status).toBe(409);
    expect(await (await app.request(`${nativeReadPrefix}/cards?mode=semantic&q=woodland`, { headers })).json()).toMatchObject({ total: 2 });
    await libraryIndex.close();
  });

  it('serves exact grouped tags through real existing Archive HTTP searches without rewriting legacy files or projections', async () => {
    const tags = [
      ['Fantasy', 'Elf', 'Ä', 'sea, sky'], ['Fantasy', 'Mermaid', 'ä', 'sea', 'sky', `t${(999).toString(36)}`],
      ['Fantasy', 'Dragon', 'ä'], ['SciFi', 'Robot'], ['Fantasy', 'Elf', "creator's pick"],
    ];
    const names = ['Woodland Elf', 'Woodland Mermaid', 'Woodland Dragon', 'Woodland Robot', 'Woodland Artist'];
    for (const [index, name] of names.entries()) seed(index + 1, { name, source: 'ct', topics: tags[index]!.join(', '), description: 'A woodland map keeper.' });
    await original(1, 'json', json(names[0]));
    sql((db) => {
      db.prepare('DELETE FROM card_tags').run();
      const addTag = db.prepare('INSERT INTO card_tags(cardId,tag,normalizedTag) VALUES (?,?,?)');
      const addCard = db.prepare("INSERT INTO cards(id,name,source,topics) VALUES (?,'Outside the indexed fixture','chub','Ä')");
      const addProjection = db.prepare("INSERT INTO cards(id,name,description,source,topics,lastModified) VALUES (?,'Woodland candidate','A woodland map keeper.','wyvern','river, cloud','2026-10-01T00:00:00Z')");
      db.transaction(() => {
        for (const [index, members] of tags.entries()) for (const tag of members) addTag.run(index + 1, tag, tag.toLowerCase());
        // These nearest vectors are false positives for two separate tags.
        // Only the distant row has both exact members in Archive metadata.
        for (let id = 20_000; id <= 20_400; id++) { addProjection.run(id); addTag.run(id, 'river, cloud', 'river, cloud'); }
        addProjection.run(30_000); addTag.run(30_000, 'river', 'river'); addTag.run(30_000, 'cloud', 'cloud');
        // A wider exact metadata subset must refuse rather than truncate IDs
        // or trust the ambiguous Unicode-folded projection's top-k matches.
        for (let id = 100_000; id <= 110_000; id++) { addCard.run(id); addTag.run(id, 'Ä', 'ä'); }
      })();
      db.exec("CREATE TABLE card_embedding_meta(model_name TEXT,dims INTEGER); INSERT INTO card_embedding_meta VALUES ('group-http-fixture',2)");
    });
    const rows = sql((db) => db.prepare("SELECT * FROM cards WHERE source IN ('ct','wyvern') ORDER BY id").all()) as Record<string, unknown>[];
    const documents = rows.map((row) => buildSearchDocument(row, Date.UTC(2026, 9, 13)));
    const lanceDirectory = join(directory, 'search.lance'), connection = await connect(lanceDirectory);
    const lexical = await connection.createTable('cards', makeArrowTable(documents, { schema: searchDocumentSchema }));
    await lexical.createIndex('searchText', { config: Index.fts({ withPosition: true }) }); lexical.close();
    const schema = new Schema([new Field('card_id', new Utf8(), false), new Field('section', new Utf8(), false), new Field('matchText', new Utf8(), false),
      ...searchDocumentSchema.fields, new Field('vector', new FixedSizeList(2, new Field('item', new Float32(), false)), false)]);
    const positions = [[1, 0], [0, 1], [0.8, 0.6], [0.6, 0.8], [0.4, 0.9]];
    const vectors = await connection.createTable('card_vectors', makeArrowTable(documents.map((doc, index) => ({ ...doc,
      card_id: doc.id, section: 'description', matchText: doc.description, vector: positions[index] ?? (doc.id === '30000' ? [0, 1] : [1, 0]) })), { schema }));
    vectors.close(); connection.close();
    let embeddings = 0;
    const openSearch = () => openExistingSearch({ lanceDirectory, databasePath, embedder: {
      space: { model: 'group-http-fixture', dimensions: 2, sourceDimensions: 2, queryInstruction: '' },
      async embed() { embeddings++; return [1, 0]; },
    } });
    const store = await open(true, await openSearch());
    let app = createNativeArchiveApp(store, createScheduler(store, []), []);
    const request = (query: NativeArchiveQuery) => app.request(`${nativeReadPrefix}/cards?${serializeNativeArchiveQuery(query)}`);
    async function page(query: NativeArchiveQuery) {
      const response = await request({ provider: 'ct', ...query });
      const body = await response.json() as { cards: { id: string }[]; total: number; snapshot: string };
      expect(response.status, JSON.stringify({ query, body })).toBe(200);
      return body;
    }
    const tablesBefore = tableInventory(), filesBefore = await fileInventory(filesDirectory), objectsBefore = await fileInventory(objectsDirectory), indexBefore = await fileInventory(lanceDirectory);
    for (const mode of ['browse', 'semantic'] as const) {
      const base = { mode, ...(mode === 'semantic' ? { q: 'woodland' } : {}) };
      for (const [filter, ids] of [
        [{ tags: [' FANTASY '], tagGroups: [[' ELF ', 'mermaid']] }, ['1', '2', '5']],
        [{ tags: ['scifi'], tagGroups: [['mermaid']], tagMode: 'any' }, ['2', '4']],
        [{ tags: ['fantasy'], excludeTagGroups: [['elf', 'mermaid']] }, ['3']],
        [{ tagGroups: [['Ä']] }, ['1']], [{ tagGroups: [['ä']] }, ['2', '3']],
        [{ tagGroups: [['sea, sky']] }, ['1']], [{ tagGroups: [['sea'], ['sky']] }, ['2']],
        [{ tags: ['fantasy'], excludeTagGroups: [['sea']] }, ['1', '3', '5']],
        [{ tags: ['fantasy'], excludeTagGroups: [['Ä']] }, ['2', '3', '5']],
      ] satisfies [NativeArchiveQuery, string[]][]) {
        const result = await page({ ...base, ...filter });
        expect(result.total).toBe(ids.length);
        expect(result.cards.map((card) => card.id).sort()).toEqual(ids);
      }
    }
    const literalQuery = await page({ mode: 'lexical', q: 'woodland AND NOT robot', tags: ['scifi'], tagGroups: [['mermaid']], tagMode: 'any', filter: 'source = ct AND tokenCount >= 10' });
    expect(literalQuery).toMatchObject({ total: 1, cards: [{ id: '2' }] });
    const beforeTopK = await page({ provider: 'wyvern', mode: 'semantic', q: 'woodland', tagGroups: [['river'], ['cloud']], limit: 1 });
    expect(beforeTopK).toMatchObject({ total: 1, cards: [{ id: '30000' }] });
    const tagGroups = Array.from({ length: 10 }, (_, group) => Array.from({ length: 100 }, (_, index) => `t${(group * 100 + index).toString(36)}`));
    expect(JSON.stringify(tagGroups).length).toBeGreaterThan(4096);
    const large = await page({ mode: 'lexical', q: 'woodland', filter: 'source = ct', tagGroups, tagMode: 'any' });
    expect(large).toMatchObject({ total: 1, cards: [{ id: '2' }] });
    const firstQuery: NativeArchiveQuery = { provider: 'ct', mode: 'semantic', q: 'woodland', tagGroups: [['elf', 'mermaid']], limit: 1 };
    const first = await page(firstQuery);
    expect(first).toMatchObject({ total: 3, cards: [{ id: '1' }] });
    expect((await request({ ...firstQuery, offset: 1, snapshot: first.snapshot })).status).toBe(200);
    const changed = await request({ ...firstQuery, tagGroups: [['dragon']], offset: 1, snapshot: first.snapshot });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: { code: 'SNAPSHOT_CHANGED' } });
    const previousEmbeddings = embeddings;
    for (const mode of ['browse', 'semantic'] as const) {
      const refused = await request({ provider: 'chub', mode, tagGroups: [['Ä']], ...(mode === 'semantic' ? { q: 'woodland' } : {}) });
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({ error: { code: 'UNAVAILABLE' } });
    }
    expect(embeddings).toBe(previousEmbeddings);
    store.close(); archive = undefined;
    const reopened = await open(true, await openSearch());
    app = createNativeArchiveApp(reopened, createScheduler(reopened, []), []);
    expect(await page({ mode: 'semantic', q: 'woodland', tagGroups: [['sea, sky']] })).toMatchObject({ total: 1, cards: [{ id: '1' }] });
    expect(tableInventory()).toEqual(tablesBefore);
    expect(await fileInventory(filesDirectory)).toEqual(filesBefore);
    expect(await fileInventory(objectsDirectory)).toEqual(objectsBefore);
    expect(await fileInventory(lanceDirectory)).toEqual(indexBefore);
  });

  it('rejects writes in read-only mode and detects a legacy file changed after its object was registered', async () => {
    seed(1234);
    const bytes = json();
    const path = await original(1234, 'json', bytes);
    const store = await open(true);
    const ref = (await store.files('1234')).find((file) => file.role === 'card')!;
    await expect(store.put(scraped('1234'))).rejects.toThrow(/read.only/i);
    expect(new Uint8Array(await readFile(path))).toEqual(bytes);
    await writeFile(path, json('Changed externally'));
    await expect(store.object(ref.sha256)).rejects.toBeInstanceOf(Error);
    expect(await readdir(objectsDirectory)).toEqual([]);
  });

  it('keeps exact search queue rows after an indexing failure and acknowledges them after a successful retry', async () => {
    seed(1234);
    sql((db) => {
      db.prepare('DELETE FROM search_index_queue').run();
      db.prepare('INSERT INTO search_index_queue(cardId,action) VALUES (?,?)').run('1234', 'upsert');
    });
    let fail = true;
    const indexed: Record<string, unknown>[] = [];
    const store = await open(false, fakeSearch({ async upsertDocuments(rows) {
      if (fail) throw new Error('Synthetic index failure');
      indexed.push(...rows);
    } }));
    const before = sql((db) => db.prepare('SELECT * FROM search_index_queue').all());
    await expect(store.flushSearchQueue()).rejects.toThrow('Synthetic index failure');
    expect(sql((db) => db.prepare('SELECT * FROM search_index_queue').all())).toEqual(before);
    fail = false;
    expect(await store.flushSearchQueue()).toEqual({ processed: 1 });
    expect(indexed).toMatchObject([{ id: 1234, name: 'Aster' }]);
    expect(sql((db) => db.prepare('SELECT * FROM search_index_queue').all())).toEqual([]);
  });

  it('keeps queued work when a card changes during indexing and drains the newer state on retry', async () => {
    seed(1234);
    sql((db) => {
      db.exec(`DELETE FROM search_index_queue;
        CREATE TRIGGER test_card_search_update AFTER UPDATE ON cards
        BEGIN INSERT INTO search_index_queue(cardId,action) VALUES (NEW.id,'upsert'); END;`);
      db.prepare('INSERT INTO search_index_queue(cardId,action) VALUES (?,?)').run('1234', 'upsert');
    });
    const indexedNames: unknown[] = [];
    const store = await open(false, fakeSearch({ async upsertDocuments(rows) {
      indexedNames.push(rows[0]!.name);
      if (indexedNames.length === 1) sql((db) => db.prepare('UPDATE cards SET name = ? WHERE id = ?').run('Changed while indexing', 1234));
    } }));
    expect(await store.flushSearchQueue()).toEqual({ processed: 0 });
    expect(sql((db) => db.prepare('SELECT cardId,action FROM search_index_queue').all()))
      .toEqual([{ cardId: '1234', action: 'upsert' }, { cardId: '1234', action: 'upsert' }]);
    expect(await store.flushSearchQueue()).toEqual({ processed: 2 });
    expect(indexedNames).toEqual(['Aster', 'Changed while indexing']);
    expect(sql((db) => db.prepare('SELECT * FROM search_index_queue').all())).toEqual([]);
  });

  it('persists source settings and runs in the same database and closes interrupted runs on restart', async () => {
    const store = await open();
    const archiveId = store.archiveId;
    store.saveSource({ provider: 'chub', enabled: true, intervalMinutes: 60,
      settings: { pages: 2 }, secrets: { apiKey: 'fixture-secret' } });
    const id = store.startRun('chub', 'manual');
    store.progressRun(id, { listed: 3, added: 1, updated: 1, unchanged: 1, skipped: 0, blocked: 0, errors: 0 });
    store.close(); archive = undefined;
    const reopened = await open();
    expect(reopened.archiveId).toBe(archiveId);
    expect(reopened.source('chub')).toMatchObject({ enabled: true, intervalMinutes: 60,
      settings: { pages: 2 }, secrets: { apiKey: 'fixture-secret' } });
    expect(reopened.runs('chub')[0]).toMatchObject({ id, status: 'failed', listed: 3, added: 1,
      updated: 1, unchanged: 1, error: 'The Archive stopped during this run' });
    expect(reopened.lastFinishedRun('chub')).toMatchObject({ id, status: 'failed' });
    expect((await readdir(directory)).filter((name) => /\.(?:db|sqlite)$/.test(name))).toEqual(['cards.db']);
  });
});
