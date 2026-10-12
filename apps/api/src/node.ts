import { loadRemoteConnections } from './remote-config-node.js';
import { createSyncApi } from '@character-unity/api/sync';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { openLocalServices } from './services.js';
import { createLocalApi } from './local.js';
import { createAccountApi } from '@character-unity/api/sessions';
import { nodeConfig } from './node-config.js';

const { port, hostname, profile, publicOrigin, syncEnabled, syncWritesEnabled } = nodeConfig(process.env);
const urlHost = hostname.includes(':') ? `[${hostname}]` : hostname;
let origin = `http://${urlHost}:${port}`;
const databasePath = process.env.UNITY_DB_PATH ?? fileURLToPath(new URL('../runtime/unity.db', import.meta.url));
const blobDirectory = process.env.UNITY_BLOB_DIR ?? fileURLToPath(new URL('../runtime/blobs', import.meta.url));
const remoteConnections = await loadRemoteConnections(process.env.UNITY_REMOTE_CONNECTIONS_FILE);
const services = await openLocalServices({ databasePath, blobDirectory, remoteConnections,
  ...(process.env.UNITY_ARCHIVE_ORIGIN ? { archiveOrigin: process.env.UNITY_ARCHIVE_ORIGIN } : {}) });
const app = profile === 'hub'
  ? createAccountApi({ origin: publicOrigin!, accounts: services.accounts, store: services.store, forSession: services.forSession, ...(syncEnabled ? { sync: createSyncApi({ writes: syncWritesEnabled, origin: publicOrigin!, hub: services.hub, sync: services.sync }) } : {}) })
  : createLocalApi(services, { origin: () => origin });
// Optional same-origin production UI. Only index and Vite assets are served;
// API misses must never become HTML and runtime storage must never be exposed.
if (process.env.UNITY_WEB_DIR) {
  const root = resolve(process.env.UNITY_WEB_DIR);
  await access(resolve(root, 'index.html'));
  app.get('/', serveStatic({ path: resolve(root, 'index.html') }));
  app.get('/assets/*', serveStatic({ root }));
}
const server = serve({ fetch: app.fetch, hostname, port }, (address) => {
  origin = `http://${urlHost}:${address.port}`;
  console.log(JSON.stringify({ event: 'listening', service: 'unity-api', profile, host: hostname, port: address.port }));
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close((error) => {
      services.close();
      process.exitCode = error ? 1 : 0;
    });
  });
}
