import { readFile } from 'node:fs/promises';
import { createDocumentEmbedder, createQueryEmbedder } from './embeddings.js';
import { serve } from '@hono/node-server';
import { createArchiveApp } from './app.js';
import { openCopiedArchive } from './copied.js';
import { createDemoArchive } from './fixture.js';
import { openNativeArchive } from './native/store.js';
import { createScheduler } from './native/scheduler.js';
import { createNativeArchiveApp } from './native/app.js';
import { sources } from './sources/index.js';
import { openExistingArchive } from './existing/store.js';
import { openExistingSearch, readExistingVectorMetadata } from './existing/search.js';
import { openLibraryIndex } from './library-index.js';

const port = Number(process.env.PORT ?? 9313);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('PORT must be an integer between 0 and 65535');
}
const hostname = process.env.HOST ?? '127.0.0.1';
const mode = process.env.UNITY_ARCHIVE_MODE ?? 'off';
if (!['off', 'fixture', 'copy', 'native', 'existing'].includes(mode)) throw new Error('UNITY_ARCHIVE_MODE must be off, fixture, copy, native or existing');
if (['copy', 'native', 'existing'].includes(mode) && !['127.0.0.1', '::1', 'localhost'].includes(hostname)) throw new Error('Archive storage modes require a loopback listener');
// Native mode: the Archive's own store (scraped cards), its scheduler and admin routes.
const dataDirectory = process.env.UNITY_ARCHIVE_DATA_DIR;
if (mode === 'native' && !dataDirectory) throw new Error('Native mode requires UNITY_ARCHIVE_DATA_DIR');
const adminToken = process.env.UNITY_ARCHIVE_ADMIN_TOKEN;
if (adminToken !== undefined && adminToken.length < 24) throw new Error('UNITY_ARCHIVE_ADMIN_TOKEN must be at least 24 characters');
const copyRoot = process.env.UNITY_ARCHIVE_COPY_ROOT;
if (mode === 'copy' && !copyRoot) throw new Error('Copy mode requires an explicit UNITY_ARCHIVE_COPY_ROOT');
const embeddingConfig = process.env.UNITY_ARCHIVE_EMBEDDING_CONFIG;
if (embeddingConfig && !['copy', 'existing'].includes(mode)) throw new Error('Embedding configuration requires copied or existing Archive mode');
const embeddingOptions: unknown = embeddingConfig ? JSON.parse(await readFile(embeddingConfig, 'utf8')) : undefined;
const embedder = embeddingConfig ? createQueryEmbedder(embeddingOptions, process.env.UNITY_ARCHIVE_EMBEDDING_KEY ?? '') : undefined;
const source = mode === 'copy' ? await openCopiedArchive(copyRoot!, embedder) : mode === 'fixture' ? createDemoArchive() : undefined;
const databasePath = process.env.UNITY_ARCHIVE_DATABASE_PATH;
const filesDirectory = process.env.UNITY_ARCHIVE_FILES_DIR;
const objectsDirectory = process.env.UNITY_ARCHIVE_OBJECT_DIR;
const lanceDirectory = process.env.UNITY_ARCHIVE_LANCE_DIR;
const readOnly = process.env.UNITY_ARCHIVE_READ_ONLY === '1';
if (process.env.UNITY_ARCHIVE_READ_ONLY !== undefined && !['0', '1'].includes(process.env.UNITY_ARCHIVE_READ_ONLY)) throw new Error('UNITY_ARCHIVE_READ_ONLY must be 0 or 1');
if (readOnly && mode !== 'existing') throw new Error('UNITY_ARCHIVE_READ_ONLY=1 requires existing Archive mode');
const libraryIndexEnabled = process.env.UNITY_ARCHIVE_LIBRARY_INDEX === '1';
if (process.env.UNITY_ARCHIVE_LIBRARY_INDEX !== undefined && !['0', '1'].includes(process.env.UNITY_ARCHIVE_LIBRARY_INDEX)) throw new Error('UNITY_ARCHIVE_LIBRARY_INDEX must be 0 or 1');
if (libraryIndexEnabled && mode !== 'existing') throw new Error('Library indexing requires existing Archive mode and its shared LanceDB');
if (libraryIndexEnabled && (!lanceDirectory || !adminToken)) throw new Error('Library indexing requires UNITY_ARCHIVE_LANCE_DIR and UNITY_ARCHIVE_ADMIN_TOKEN');
const documentEmbedder = mode === 'existing' && (!readOnly || libraryIndexEnabled) && embeddingConfig ? createDocumentEmbedder(embeddingOptions, process.env.UNITY_ARCHIVE_EMBEDDING_KEY ?? '') : undefined;
if (mode === 'existing' && (!databasePath || !filesDirectory || (!readOnly && !objectsDirectory))) {
  throw new Error('Existing Archive mode requires UNITY_ARCHIVE_DATABASE_PATH, UNITY_ARCHIVE_FILES_DIR and, for writes, UNITY_ARCHIVE_OBJECT_DIR');
}
if (mode === 'existing' && embedder && !lanceDirectory) throw new Error('Existing Archive embedding configuration requires UNITY_ARCHIVE_LANCE_DIR');
const search = mode === 'existing' && lanceDirectory ? await openExistingSearch({ lanceDirectory, databasePath: databasePath!,
  ...(process.env.UNITY_ARCHIVE_LANCE_TABLE ? { tableName: process.env.UNITY_ARCHIVE_LANCE_TABLE } : {}),
  ...(process.env.UNITY_ARCHIVE_VECTOR_TABLE ? { vectorTableName: process.env.UNITY_ARCHIVE_VECTOR_TABLE } : {}),
  ...(embedder ? { embedder } : {}),
}) : undefined;
const libraryIndex = libraryIndexEnabled ? await openLibraryIndex({ lanceDirectory: lanceDirectory!, space: readExistingVectorMetadata(databasePath!),
  ...(embedder ? { queryEmbedder: embedder } : {}), ...(documentEmbedder ? { documentEmbedder } : {}),
}) : undefined;
let native;
try {
  native = mode === 'native' ? await openNativeArchive(dataDirectory!) : mode === 'existing' ? await openExistingArchive({
    databasePath: databasePath!, filesDirectory: filesDirectory!,
    ...(objectsDirectory ? { objectsDirectory } : {}), readOnly,
    ...(search ? { search } : {}),
    ...(documentEmbedder ? { documentEmbedder } : {}),
    ...(libraryIndex ? { libraryIndex } : {}),
    ...(process.env.UNITY_ARCHIVE_LEGACY_ROOT ? { legacyRoot: process.env.UNITY_ARCHIVE_LEGACY_ROOT } : {}),
  }) : undefined;
} catch (error) { search?.close(); await libraryIndex?.close(); throw error; }
const scheduler = native ? createScheduler(native, sources, {
  log: (event) => console.log(JSON.stringify(event)),
  ...('flushSearchQueue' in native ? { onFinished: async (signal: AbortSignal) => {
    while (!signal.aborted) {
      const lexical = await native.flushSearchQueue(100);
      signal.throwIfAborted();
      const vector = await native.flushVectorQueue(100, signal);
      if (!lexical.processed && !vector.processed) break;
    }
  } } : {}),
}) : undefined;
const app = native && scheduler
  ? createNativeArchiveApp(native, scheduler, sources, { ...(adminToken ? { adminToken } : {}), ...(libraryIndex ? { libraryIndex } : {}) })
  : createArchiveApp(source, { readOrigins: (process.env.UNITY_ARCHIVE_READ_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean) });
if (scheduler && !readOnly && process.env.UNITY_ARCHIVE_SCHEDULE !== 'off') scheduler.begin();
const server = serve({ fetch: app.fetch, hostname, port }, (address) => {
  console.log(JSON.stringify({ event: 'listening', service: 'unity-archive', host: hostname, port: address.port }));
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void (scheduler?.stop() ?? Promise.resolve()).finally(() => {
      server.close((error) => { native?.close(); search?.close(); process.exitCode = error ? 1 : 0; });
    });
  });
}
