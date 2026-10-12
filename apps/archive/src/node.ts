import { readFile } from 'node:fs/promises';
import { createQueryEmbedder } from './embeddings.js';
import { serve } from '@hono/node-server';
import { createArchiveApp } from './app.js';
import { openCopiedArchive } from './copied.js';
import { createDemoArchive } from './fixture.js';

const port = Number(process.env.PORT ?? 9313);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('PORT must be an integer between 0 and 65535');
}
const hostname = process.env.HOST ?? '127.0.0.1';
const mode = process.env.UNITY_ARCHIVE_MODE ?? 'off';
if (!['off', 'fixture', 'copy'].includes(mode)) throw new Error('UNITY_ARCHIVE_MODE must be off, fixture or copy');
if (mode === 'copy' && !['127.0.0.1', '::1', 'localhost'].includes(hostname)) throw new Error('Copied Archive mode requires a loopback listener');
const copyRoot = process.env.UNITY_ARCHIVE_COPY_ROOT;
if (mode === 'copy' && !copyRoot) throw new Error('Copy mode requires an explicit UNITY_ARCHIVE_COPY_ROOT');
const embeddingConfig = process.env.UNITY_ARCHIVE_EMBEDDING_CONFIG;
if (embeddingConfig && mode !== 'copy') throw new Error('Embedding configuration requires copied Archive mode');
const embedder = embeddingConfig ? createQueryEmbedder(JSON.parse(await readFile(embeddingConfig, 'utf8')), process.env.UNITY_ARCHIVE_EMBEDDING_KEY ?? '') : undefined;
const source = mode === 'copy' ? await openCopiedArchive(copyRoot!, embedder) : mode === 'fixture' ? createDemoArchive() : undefined;
const app = createArchiveApp(source,
  { readOrigins: (process.env.UNITY_ARCHIVE_READ_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean) });
const server = serve({ fetch: app.fetch, hostname, port }, (address) => {
  console.log(JSON.stringify({ event: 'listening', service: 'unity-archive', host: hostname, port: address.port }));
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close((error) => { process.exitCode = error ? 1 : 0; });
  });
}
