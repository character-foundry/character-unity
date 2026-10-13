import { readFile } from 'node:fs/promises';
import { createQueryEmbedder } from './embeddings.js';
import { serve } from '@hono/node-server';
import { createArchiveApp } from './app.js';
import { openCopiedArchive } from './copied.js';
import { createDemoArchive } from './fixture.js';
import { openNativeArchive } from './native/store.js';
import { createScheduler } from './native/scheduler.js';
import { createNativeArchiveApp } from './native/app.js';
import { sources } from './sources/index.js';

const port = Number(process.env.PORT ?? 9313);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('PORT must be an integer between 0 and 65535');
}
const hostname = process.env.HOST ?? '127.0.0.1';
const mode = process.env.UNITY_ARCHIVE_MODE ?? 'off';
if (!['off', 'fixture', 'copy', 'native'].includes(mode)) throw new Error('UNITY_ARCHIVE_MODE must be off, fixture, copy or native');
if ((mode === 'copy' || mode === 'native') && !['127.0.0.1', '::1', 'localhost'].includes(hostname)) throw new Error(`${mode === 'copy' ? 'Copied' : 'Native'} Archive mode requires a loopback listener`);
// Native mode: the Archive's own store (scraped cards), its scheduler and admin routes.
const dataDirectory = process.env.UNITY_ARCHIVE_DATA_DIR;
if (mode === 'native' && !dataDirectory) throw new Error('Native mode requires UNITY_ARCHIVE_DATA_DIR');
const adminToken = process.env.UNITY_ARCHIVE_ADMIN_TOKEN;
if (adminToken !== undefined && adminToken.length < 24) throw new Error('UNITY_ARCHIVE_ADMIN_TOKEN must be at least 24 characters');
const copyRoot = process.env.UNITY_ARCHIVE_COPY_ROOT;
if (mode === 'copy' && !copyRoot) throw new Error('Copy mode requires an explicit UNITY_ARCHIVE_COPY_ROOT');
const embeddingConfig = process.env.UNITY_ARCHIVE_EMBEDDING_CONFIG;
if (embeddingConfig && mode !== 'copy') throw new Error('Embedding configuration requires copied Archive mode');
const embedder = embeddingConfig ? createQueryEmbedder(JSON.parse(await readFile(embeddingConfig, 'utf8')), process.env.UNITY_ARCHIVE_EMBEDDING_KEY ?? '') : undefined;
const source = mode === 'copy' ? await openCopiedArchive(copyRoot!, embedder) : mode === 'fixture' ? createDemoArchive() : undefined;
const native = mode === 'native' ? await openNativeArchive(dataDirectory!) : undefined;
const scheduler = native ? createScheduler(native, sources, { log: (event) => console.log(JSON.stringify(event)) }) : undefined;
const app = native && scheduler
  ? createNativeArchiveApp(native, scheduler, sources, adminToken ? { adminToken } : {})
  : createArchiveApp(source, { readOrigins: (process.env.UNITY_ARCHIVE_READ_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean) });
if (scheduler && process.env.UNITY_ARCHIVE_SCHEDULE !== 'off') scheduler.begin();
const server = serve({ fetch: app.fetch, hostname, port }, (address) => {
  console.log(JSON.stringify({ event: 'listening', service: 'unity-archive', host: hostname, port: address.port }));
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void (scheduler?.stop() ?? Promise.resolve()).finally(() => {
      server.close((error) => { native?.close(); process.exitCode = error ? 1 : 0; });
    });
  });
}
