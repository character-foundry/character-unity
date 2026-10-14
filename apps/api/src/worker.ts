import { parseRemoteConnections } from './remote-config.js';
import { createSyncOutboxStore } from '@character-unity/store/sync-outbox';
import { createSyncApi } from '@character-unity/api/sync';
import { createSyncStore } from '@character-unity/store/sync';
import { createApi } from '@character-unity/api';
import { createAccountApi, hubOrigin } from '@character-unity/api/sessions';
import { createD1Driver } from '@character-unity/store/d1';
import { createStore, StoreError } from '@character-unity/store';
import { createStatisticsStore } from '@character-unity/store/statistics';
import { createContentStore } from '@character-unity/store/content';
import { createHubStore } from '@character-unity/store/hub';
import { createAccountStore, createSessionDriver } from '@character-unity/store/accounts';
import { createR2BlobStore } from '@character-unity/blob-store/r2';
import { composeServices } from './compose.js';
import { workerArchive } from './worker-archive.js';

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path !== '/api' && !path.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (path === '/api') return Response.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, { status: 404, headers: { 'cache-control': 'no-store' } });
    if (path === '/api/health') return createApi().fetch(request);
    try {
      const origin = hubOrigin(env.UNITY_PUBLIC_ORIGIN).origin;
      if (new URL(request.url).origin !== origin) return Response.json({ error: { code: 'FORBIDDEN', message: 'Request origin is not allowed' } },
        { status: 403, headers: { 'cache-control': 'no-store' } });
      if (!env.UNITY_DB || !env.UNITY_BLOBS || !env.UNITY_LOGIN_LIMITER) throw new Error('Missing Worker binding');
      // Direct D1 access stays on the primary. Do not use unconstrained replicas for
      // authorization/policy checks or reuse sessions/bindings across requests.
      const syncFlag = String(env.UNITY_SYNC_ENABLED ?? 'false');
      if (!['true', 'false'].includes(syncFlag)) throw new Error('Invalid sync flag');
      const syncEnabled = syncFlag === 'true';
      const writesFlag = String(env.UNITY_SYNC_WRITES_ENABLED ?? 'false');
      if (!['true', 'false'].includes(writesFlag) || (writesFlag === 'true' && !syncEnabled)) throw new Error('Invalid sync write configuration');
      const syncWritesEnabled = writesFlag === 'true';
      if (syncEnabled && (!origin.startsWith('https://') || !env.UNITY_SYNC_LIMITER)) throw new Error('Signed sync requires HTTPS and admission binding');
      const driver = createD1Driver(env.UNITY_DB);
      const store = createStore(driver);
      await store.readiness(); // Fail closed on absent, older or modified schemas; never migrate here.
      const connections = await parseRemoteConnections(env.UNITY_REMOTE_CONNECTIONS_JSON);
      const archive = workerArchive(env.UNITY_ARCHIVE_ORIGIN, origin);
      const nativeArchive = archive ? { origin: env.UNITY_ARCHIVE_ORIGIN, maxReadBytes: 8 * 1024 * 1024 } : undefined;
      const blobs = createR2BlobStore(env.UNITY_BLOBS, (length) => new FixedLengthStream(length));
      const sync = syncEnabled ? createSyncApi({ origin, writes: syncWritesEnabled, sync: createSyncStore(driver),
        hub: composeServices({ store, hub: createHubStore(driver), outbox: createSyncOutboxStore(driver) }, blobs).hub,
        admit: async () => (await env.UNITY_SYNC_LIMITER.limit({ key: `unity:sync:${origin}` })).success }) : undefined;
      const app = createAccountApi({ origin, store, ...(sync ? { sync } : {}), accounts: createAccountStore(driver),
        admitLogin: async () => (await env.UNITY_LOGIN_LIMITER.limit({ key: `unity:login:${origin}` })).success,
        forSession(proof) {
          const scoped = createSessionDriver(driver, proof);
          return composeServices({ store: createStore(scoped), hub: createHubStore(scoped), outbox: createSyncOutboxStore(scoped), statistics: createStatisticsStore(scoped), content: createContentStore(scoped) },
            blobs, archive, connections, { maxSelectionBytes: 8 * 1024 * 1024 }, undefined, nativeArchive);
        },
      });
      return await app.fetch(request);
    } catch (error) {
      console.error(JSON.stringify({ event: 'worker_unavailable', code: error instanceof StoreError ? error.code : 'CONFIGURATION' }));
      return Response.json({ error: { code: 'UNAVAILABLE', message: 'Worker service unavailable' } },
        { status: 503, headers: { 'cache-control': 'no-store' } });
    }
  },
} satisfies ExportedHandler<Env>;
