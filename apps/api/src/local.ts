import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createApi } from '@character-unity/api';
import type { openLocalServices } from './services.js';

/** The single owner of a local install. */
export const localActor = Object.freeze({ id: 'local', uri: 'urn:unity:user:local' });

/** Local single-owner access. Hosted accounts must supply a different authenticator. */
export function createLocalApi(services: Awaited<ReturnType<typeof openLocalServices>>, options: { origin: () => string }) {
  const actor = localActor;
  const secret = randomBytes(32).toString('base64url');
  const webOrigins = ['http://127.0.0.1:9310', 'http://127.0.0.1:9311', 'http://localhost:9310', 'http://localhost:9311',
    // Extra loopback dev origins, e.g. the unified web app: UNITY_WEB_ORIGINS=http://127.0.0.1:9430
    ...(process.env.UNITY_WEB_ORIGINS ?? '').split(',').map((value) => value.trim()).filter((value) => /^http:\/\/(127\.0\.0\.1|localhost):[0-9]{2,5}$/.test(value))];
  function trusted(request: Request, mutation: boolean) {
    const allowed = new Set([options.origin(), ...webOrigins]);
    if (!allowed.has(new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') return false;
    const origin = request.headers.get('origin');
    return origin ? allowed.has(origin) : !mutation;
  }
  const app = createApi({ store: services.store, cards: services.cards, hub: services.hub, ...(services.archive ? { archive: services.archive } : {}), ...(services.nativeArchive ? { nativeArchive: services.nativeArchive } : {}),
    ...(services.libraryIndex ? { libraryIndex: services.libraryIndex } : {}),
    ...(services.statistics ? { statistics: services.statistics } : {}),
    metaTags: services.metaTags,
    ...(services.content ? { content: services.content } : {}),
    ...(services.chat ? { chat: services.chat } : {}), authenticate(request) {
    if (!trusted(request, !['GET', 'HEAD'].includes(request.method))) return null;
    const cookies = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith('unity_session='));
    const token = cookies.length === 1 ? cookies[0]!.slice('unity_session='.length) : '';
    return token.length === secret.length && !/[^A-Za-z0-9_-]/.test(token) && timingSafeEqual(Buffer.from(token), Buffer.from(secret)) ? actor : null;
  } });
  app.get('/api/client', (c) => {
    c.header('cache-control', 'no-store');
    if (!trusted(c.req.raw, false)) return c.json({ error: { code: 'FORBIDDEN', message: 'Request origin is not allowed' } }, 403);
    return c.json({ profile: 'local', capabilities: { browserLLM: true } });
  });
  app.post('/api/local-session', (c) => {
    if (!trusted(c.req.raw, true) || c.req.header('x-unity-session') !== 'local') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Local sessions require an allowed local origin' } }, 403);
    }
    c.header('cache-control', 'no-store');
    c.header('set-cookie', `unity_session=${secret}; Path=/api; HttpOnly; SameSite=Strict`);
    return c.json({ actor });
  });
  return app;
}
