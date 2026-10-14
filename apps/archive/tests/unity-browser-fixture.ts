import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { serve } from '@hono/node-server';
import { connect, Index, makeArrowTable } from '@lancedb/lancedb';
import { Field, FixedSizeList, Float32, Schema, Utf8 } from 'apache-arrow';
import { fixture } from '../../../e2e/unity-editor/fixtures.js';
import { openExistingArchive } from '../src/existing/store.js';
import { openExistingSearch } from '../src/existing/search.js';
import { buildSearchDocument, searchDocumentSchema } from '../src/search-document.js';
import { createDocumentEmbedder, createQueryEmbedder } from '../src/embeddings.js';
import { openLibraryIndex } from '../src/library-index.js';
import { createNativeArchiveApp } from '../src/native/app.js';
import { createScheduler } from '../src/native/scheduler.js';
import { sources } from '../src/sources/index.js';
import { captureNativeArchiveInvariant, assertNativeArchiveInvariant } from './native-fixture-invariant.js';

// Only a new directory created by e2e-unity-server may be passed here. No inherited
// Archive configuration or live corpus is read by this disposable fixture.
const directory = process.argv[2];
if (!directory) throw new Error('An isolated fixture directory is required');
const port = Number(process.argv[3] ?? 19431);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('A valid isolated fixture port is required');
const databasePath = join(directory, 'cards.db'), filesDirectory = join(directory, 'files'), objectsDirectory = join(directory, 'versions');
await mkdir(filesDirectory, { recursive: true }); await mkdir(objectsDirectory, { recursive: true });
const db = new Database(databasePath);
db.exec(`CREATE TABLE cards (
  id INTEGER PRIMARY KEY, author TEXT, name TEXT, tagline TEXT, description TEXT, topics TEXT,
  tokenCount INTEGER, tokenDescriptionCount INTEGER, tokenPersonalityCount INTEGER, tokenScenarioCount INTEGER,
  tokenMesExampleCount INTEGER, tokenFirstMessageCount INTEGER, tokenSystemPromptCount INTEGER, tokenPostHistoryCount INTEGER,
  lastModified TEXT, createdAt TEXT, firstDownloadedAt TEXT, nChats INTEGER, nMessages INTEGER, n_favorites INTEGER,
  starCount INTEGER, ratingsEnabled INTEGER, rating REAL, ratingCount INTEGER, ratings TEXT, fullPath TEXT,
  favorited INTEGER DEFAULT 0, language TEXT DEFAULT 'unknown', visibility TEXT DEFAULT 'unknown',
  hasAlternateGreetings INTEGER DEFAULT 0, hasLorebook INTEGER DEFAULT 0, hasEmbeddedLorebook INTEGER DEFAULT 0,
  hasLinkedLorebook INTEGER DEFAULT 0, hasExampleDialogues INTEGER DEFAULT 0, hasSystemPrompt INTEGER DEFAULT 0,
  hasGallery INTEGER DEFAULT 0, hasEmbeddedImages INTEGER DEFAULT 0, hasExpressions INTEGER DEFAULT 0,
  isFuzzed INTEGER DEFAULT 0, source TEXT DEFAULT 'chub', sourceId TEXT, sourcePath TEXT, sourceUrl TEXT);
CREATE TABLE card_tags(cardId INTEGER,tag TEXT,normalizedTag TEXT,PRIMARY KEY(cardId,normalizedTag));
CREATE TABLE cached_assets(id INTEGER PRIMARY KEY,cardId INTEGER,originalUrl TEXT,localPath TEXT,assetType TEXT,fileSize INTEGER,cachedAt TEXT,UNIQUE(cardId,originalUrl));
CREATE TABLE card_source_aliases(id INTEGER PRIMARY KEY,source TEXT,source_id TEXT,source_path TEXT,canonical_card_id INTEGER,retired_card_id INTEGER,created_at TEXT,UNIQUE(source,source_path,retired_card_id));
CREATE TABLE search_index_queue(id INTEGER PRIMARY KEY,cardId TEXT,action TEXT);
CREATE TABLE card_embedding_meta(cardId TEXT,embedder_name TEXT,model_name TEXT,dims INTEGER,section TEXT,chunk_index INTEGER,text_sha256 TEXT);`);
db.close();
let clock = 0;
const writer = await openExistingArchive({ databasePath, filesDirectory, objectsDirectory,
  now: () => new Date(Date.UTC(2026, 9, 13, 12, 0, clock++)).toISOString() });
for (const [index, format] of ['json', 'png', 'charx'].entries()) {
  const bytes = await fixture(`Archive ${format.toUpperCase()}`, format as 'json' | 'png' | 'charx');
  await writer.put({ provider: 'chub', recordId: String(1001 + index), url: `https://archive-fixture.invalid/${1001 + index}`,
    creator: 'Unity browser QA', tags: ['browser-regression'], objects: [{ role: 'card', name: `original.${format}`, mediaType: format === 'png' ? 'image/png' : format === 'json' ? 'application/json' : 'application/zip', bytes }] });
}
const first = JSON.parse((await fixture('Archive JSON', 'json')).toString());
for (const description of ['A silver forest beside the north gate.', 'A silver forest map keeper; historical version three.']) {
  await writer.put({ provider: 'chub', recordId: '1001', url: 'https://archive-fixture.invalid/1001', creator: 'Unity browser QA', tags: ['browser-regression'],
    objects: [{ role: 'card', name: 'original.json', mediaType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify({ ...first, data: { ...first.data, description } })) }] });
}
await writer.put({ provider: 'ct', recordId: 'equal-content', url: 'https://archive-fixture.invalid/ct/equal-content', creator: 'Unity browser QA', tags: ['browser-regression'],
  objects: [{ role: 'card', name: 'same.json', mediaType: 'application/json', bytes: await fixture('Archive JSON', 'json') }] });
writer.close();

const provider = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  const query = String(JSON.parse(body).input[0]);
  if (query === 'provider failure') { response.writeHead(503); response.end(); return; }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ embeddings: [/ocean/i.test(query) ? [0, 1] : [1, 0]] }));
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const address = provider.address();
if (!address || typeof address === 'string') throw new Error('Synthetic embedding listener is missing');
const embeddingOptions = { provider: 'ollama', baseUrl: `http://127.0.0.1:${address.port}`,
  space: { model: 'unity-browser-synthetic-v1', dimensions: 2, sourceDimensions: 2, queryInstruction: '' } };
const embedder = createQueryEmbedder(embeddingOptions);
const documentEmbedder = createDocumentEmbedder(embeddingOptions);
const metadata = new Database(databasePath);
const rows = metadata.prepare('SELECT * FROM cards ORDER BY id').all() as Record<string, unknown>[];
metadata.prepare('INSERT INTO card_embedding_meta(cardId,embedder_name,model_name,dims,section,chunk_index) VALUES (?,?,?,?,?,?)')
  .run('1001', 'browser-fixture', embedder.space.model, 2, 'card', 0);
metadata.close();
const documents = rows.map((row) => buildSearchDocument(row, Date.UTC(2026, 9, 13)));
const lanceDirectory = join(directory, 'search.lance'), connection = await connect(lanceDirectory);
const table = await connection.createTable('cards', makeArrowTable(documents, { schema: searchDocumentSchema }));
await table.createIndex('searchText', { config: Index.fts({ withPosition: true, lowercase: true, asciiFolding: true }) }); table.close();
const schema = new Schema([new Field('card_id', new Utf8(), false), new Field('section', new Utf8(), false), new Field('matchText', new Utf8(), false),
  ...searchDocumentSchema.fields, new Field('vector', new FixedSizeList(2, new Field('item', new Float32(), false)), false)]);
const vectors = await connection.createTable('card_vectors', makeArrowTable(documents.map((document, index) => ({ ...document, card_id: document.id,
  section: 'description', matchText: document.description, vector: index === 0 ? [1, 0] : index === 1 ? [0, 1] : [0.8, 0.6] })), { schema }));
vectors.close(); connection.close();
const search = await openExistingSearch({ lanceDirectory, databasePath, embedder });
const libraryIndex = await openLibraryIndex({ lanceDirectory, space: embedder.space, queryEmbedder: embedder, documentEmbedder });
const archive = await openExistingArchive({ databasePath, filesDirectory, objectsDirectory, search, libraryIndex });
const scheduler = createScheduler(archive, sources);
const app = createNativeArchiveApp(archive, scheduler, sources, { adminToken: 'unity-browser-test-admin-token', libraryIndex,
  readOrigins: (process.env.UNITY_ARCHIVE_READ_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean),
});
// Complete all fixture boot bookkeeping before recording logical SQL and the
// original file/index state. Unity projections use their own permitted table.
const before = await captureNativeArchiveInvariant(directory);
const invariantRoot = directory;
const runId = process.env.UNITY_E2E_ARCHIVE_RUN ?? randomUUID();
const reportPath = process.env.UNITY_E2E_ARCHIVE_REPORT ?? join(directory, '.unity-native-archive-report.json');
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await scheduler.stop();
    await Promise.all([
      new Promise<void>((done) => { provider.close(() => done()); provider.closeAllConnections(); }),
      new Promise<void>((done) => { server.close(() => done()); if ('closeAllConnections' in server) server.closeAllConnections(); }),
    ]);
    archive.close(); search.close(); libraryIndex.close();
    await assertNativeArchiveInvariant(invariantRoot, before);
    await writeFile(reportPath, JSON.stringify({ version: 'unity.native-archive-invariant.v1', runId, checkedAt: new Date().toISOString(),
      passed: true, logicalSql: true, acceptedOriginals: true, retainedVersions: true, originalLanceTables: true,
      permittedProjection: 'unity_library_search_v1',
    }) + '\n', { mode: 0o600 });
  } catch (error) {
    process.exitCode = 1;
    console.error('Native Archive fixture immutability verification failed:', error);
    await writeFile(reportPath, JSON.stringify({ version: 'unity.native-archive-invariant.v1', runId,
      checkedAt: new Date().toISOString(), passed: false, error: error instanceof Error ? error.message : String(error),
    }) + '\n', { mode: 0o600 }).catch(() => undefined);
  }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop(); });
