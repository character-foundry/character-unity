import { loadRemoteConnections } from './remote-config-node.js';
import { createSyncApi } from '@character-unity/api/sync';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { openLocalServices } from './services.js';
import { createLocalApi, localActor } from './local.js';
import { createAccountApi } from '@character-unity/api/sessions';
import { nodeConfig } from './node-config.js';
import { startChatRefresh } from './chat-refresh.js';

const { port, hostname, profile, publicOrigin, syncEnabled, syncWritesEnabled } = nodeConfig(process.env);
const urlHost = hostname.includes(':') ? `[${hostname}]` : hostname;
let origin = `http://${urlHost}:${port}`;
const databasePath = process.env.UNITY_DB_PATH ?? fileURLToPath(new URL('../runtime/unity.db', import.meta.url));
const blobDirectory = process.env.UNITY_BLOB_DIR ?? fileURLToPath(new URL('../runtime/blobs', import.meta.url));
const remoteConnections = await loadRemoteConnections(process.env.UNITY_REMOTE_CONNECTIONS_FILE);
const libraryIndexFlag = process.env.UNITY_ARCHIVE_LIBRARY_INDEX ?? '0';
if (!['0', '1'].includes(libraryIndexFlag)) throw new Error('UNITY_ARCHIVE_LIBRARY_INDEX must be 0 or 1');
const services = await openLocalServices({ databasePath, blobDirectory, remoteConnections,
  ...(process.env.UNITY_ARCHIVE_ORIGIN ? { archiveOrigin: process.env.UNITY_ARCHIVE_ORIGIN } : {}),
  // The native Archive (scraped cards): its loopback address and the admin token it was started with.
  ...(process.env.UNITY_ARCHIVE_NATIVE_ORIGIN ? { nativeArchive: { origin: process.env.UNITY_ARCHIVE_NATIVE_ORIGIN,
    libraryIndex: libraryIndexFlag === '1',
    ...(process.env.UNITY_ARCHIVE_ADMIN_TOKEN ? { adminToken: process.env.UNITY_ARCHIVE_ADMIN_TOKEN } : {}) } } : {}) });
const app = profile === 'hub'
  ? createAccountApi({ origin: publicOrigin!, accounts: services.accounts, store: services.store, forSession: services.forSession, ...(syncEnabled ? { sync: createSyncApi({ writes: syncWritesEnabled, origin: publicOrigin!, hub: services.hub, sync: services.sync }) } : {}) })
  : createLocalApi(services, { origin: () => origin });
// Optional same-origin production UI. Only known client routes and Vite assets are served;
// API misses must never become HTML and runtime storage must never be exposed.
if (process.env.UNITY_WEB_DIR) {
  const root = resolve(process.env.UNITY_WEB_DIR);
  await access(resolve(root, 'index.html'));
  app.get('/', serveStatic({ path: resolve(root, 'index.html') }));
  for (const route of ['/explore', '/archive', '/new', '/search', '/settings', '/content', '/stats', '/sharing', '/remotes', '/chat-apps', '/card/:id', '/card/:id/edit', '/card/:id/fork']) {
    app.get(route, serveStatic({ path: resolve(root, 'index.html') }));
  }
  app.get('/assets/*', serveStatic({ root }));
}
// Local profile: rescan connected chat apps so "where it lives" stays current (UNITY_CHAT_SCAN_SECONDS=0 turns it off).
const scanSeconds = Number(process.env.UNITY_CHAT_SCAN_SECONDS ?? 300);
const stopChatRefresh = profile !== 'hub' && services.chat && scanSeconds > 0
  ? startChatRefresh({ chat: services.chat, workspaces: (actor) => services.cards.workspaces(actor), actor: localActor,
    intervalMs: scanSeconds * 1000, log: (event) => console.log(JSON.stringify(event)) })
  : undefined;
let stopping = false;
// Token counts for cards stored before counting existed (and anything a write path missed), in small batches.
let measuring: ReturnType<typeof setTimeout> | undefined;
const measure = async () => {
  try { while (!stopping && await services.cards.measureMissing(50) === 50); }
  catch (error) { console.log(JSON.stringify({ event: 'token-backfill-failed', message: error instanceof Error ? error.message : String(error) })); }
  if (!stopping) { measuring = setTimeout(() => void measure(), 60_000); measuring.unref(); }
};
measuring = setTimeout(() => void measure(), 2_000); measuring.unref();
const server = serve({ fetch: app.fetch, hostname, port }, (address) => {
  origin = `http://${urlHost}:${address.port}`;
  console.log(JSON.stringify({ event: 'listening', service: 'unity-api', profile, host: hostname, port: address.port }));
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    stopChatRefresh?.();
    clearTimeout(measuring);
    server.close((error) => {
      services.close();
      process.exitCode = error ? 1 : 0;
    });
  });
}
