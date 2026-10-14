import { createApi } from '@character-unity/api';
import { createMetaTagService } from '@character-unity/api/meta-tags';
import { createAssetService } from '@character-unity/assets';
import { openBrowserStorage } from '@character-unity/browser-storage';
import { createCardService } from '@character-unity/cards';
import { createNativeArchiveReader, createNativeArchiveAssetResolver, type NativeArchiveOptions } from '@character-unity/cards/native-reader';
import { createNativeArchiveService } from '@character-unity/cards/native-archive';
import { createStatisticsService } from '@character-unity/cards/statistics';
import { createContentService } from '@character-unity/content';
import { createSessionRuntime } from '../lib/session';
import { createBrowserMaintenanceRoutes } from './maintenance';

const actor = Object.freeze({ id: 'browser', uri: 'urn:unity:user:browser' });
const origin = 'https://unity-browser.invalid';

/** The native UI's in-process HTTP adapter. Its storage identity deliberately
 * remains the old browser profile's identity; opening this host moves no data.
 * SQL-only sharing, peers and chat targets are not mounted or simulated. */
export function createBrowserRuntime(options: { archive?: Pick<NativeArchiveOptions, 'origin' | 'fetch'> } = {}) {
  const archive = options.archive ? { origin: options.archive.origin, ...(options.archive.fetch ? { fetch: options.archive.fetch } : {}) } : undefined;
  const archiveReader = archive ? createNativeArchiveReader(archive) : undefined;
  let storage: ReturnType<typeof openBrowserStorage> | undefined;
  let api: Promise<ReturnType<typeof createApi>> | undefined;
  let closed = false;
  function open() {
    if (closed) throw new Error('The browser host was closed');
    api ??= (async () => {
      storage ??= openBrowserStorage();
      const current = await storage;
      if (closed) { current.close(); throw new Error('The browser host was closed'); }
      const cards = createCardService(current.store, createAssetService(current.store, current.blobs, {
        external: createNativeArchiveAssetResolver(current.store, archiveReader),
      }),
        archiveReader ? { archive: archiveReader } : {});
      const app = createApi({ store: current.store, cards,
        metaTags: createMetaTagService(current.store),
        statistics: createStatisticsService(current.store, current.statistics),
        content: createContentService(current.store, current.content, { sharing: false }),
        ...(archive ? { nativeArchive: createNativeArchiveService(cards, archive) } : {}),
        authenticate: (request) => request.headers.get('x-unity-actor') === actor.id ? actor : null });
      const cleanup = createBrowserMaintenanceRoutes(current.maintenance, actor.id);
      app.all('/api/workspaces/:workspaceId/browser-storage/*', (c) => cleanup(c.req.raw));
      return app;
    })().catch((error: unknown) => { api = undefined; storage = undefined; throw error; });
    return api;
  }
  const transport: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(new URL(input, origin), init);
    request.signal.throwIfAborted();
    if (new URL(request.url).origin !== origin || !new URL(request.url).pathname.startsWith('/api/')) {
      return Response.json({ error: { code: 'INVALID_INPUT', message: 'Only native browser API paths are allowed' } }, { status: 400 });
    }
    const app = await open();
    request.signal.throwIfAborted();
    if (new URL(request.url).pathname === '/api/client' && request.method === 'GET') {
      return Response.json({ profile: 'browser', capabilities: { browserLLM: true } }, { headers: { 'cache-control': 'no-store' } });
    }
    if (new URL(request.url).pathname === '/api/local-session' && request.method === 'POST') {
      return request.headers.get('x-unity-session') === 'local'
        ? Response.json({ actor }, { headers: { 'cache-control': 'no-store' } })
        : Response.json({ error: { code: 'UNAUTHENTICATED', message: 'Open the browser owner session first' } }, { status: 401 });
    }
    const response = await app.fetch(request);
    if (request.signal.aborted) { await response.body?.cancel(); request.signal.throwIfAborted(); }
    return response;
  };
  return {
    runtime: createSessionRuntime({ fetch: transport }),
    fetch: transport,
    async close() { closed = true; (await storage?.catch(() => undefined))?.close(); },
  };
}
