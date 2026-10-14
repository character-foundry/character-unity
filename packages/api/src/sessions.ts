import type { createSyncReadApi } from './sync.js';
import { Hono } from 'hono';
import { CardError, hostedUploadByteLimit } from '@character-unity/cards/contract';
import { StoreError } from '@character-unity/store';
import { sessionLifetimeMs, validSessionToken } from '@character-unity/store/accounts';
import type { AccountStore, SessionProof } from '@character-unity/store/accounts';
import { createApi } from './index.js';
import { json } from './body.js';

type Services = Omit<NonNullable<Parameters<typeof createApi>[0]>, 'authenticate'>;
/** Explicit canonical origin: forwarded headers never choose cookies or allowed browser origins. */
export function hubOrigin(value: string): URL {
  const origin = new URL(value);
  if (value !== origin.origin || origin.username || origin.password
    || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) {
    throw new Error('UNITY_PUBLIC_ORIGIN must be an exact HTTPS origin or loopback HTTP origin');
  }
  return origin;
}

export function createAccountApi(options: {
  origin: string; accounts: AccountStore; store: NonNullable<Services['store']>;
  forSession: (proof: SessionProof) => Services; clock?: () => number;
  admitLogin?: () => Promise<boolean>; sync?: ReturnType<typeof createSyncReadApi>;
}) {
  const origin = hubOrigin(options.origin);
  const clock = options.clock ?? Date.now;
  const secure = origin.protocol === 'https:';
  const cookieName = secure ? '__Host-unity_hub' : 'unity_hub_session';
  const cookiePath = secure ? '/' : '/api';
  function cookie(request: Request) {
    const matches = (request.headers.get('cookie') ?? '').split(';').map((value) => value.trim()).filter((value) => value.startsWith(`${cookieName}=`));
    const value = matches.length === 1 ? matches[0]!.slice(cookieName.length + 1) : '';
    return validSessionToken(value) ? value : '';
  }
  function setCookie(value: string, maxAge: number) {
    return `${cookieName}=${value}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }
  const app = new Hono();
  const publicApi = createApi({ store: options.store });
  app.onError((error, c) => {
    const status = error instanceof CardError && error.code === 'TOO_LARGE' ? 413
      : error instanceof StoreError && error.code === 'UNAUTHENTICATED' ? 401
      : error instanceof CardError || error instanceof StoreError ? 400 : 503;
    return c.json({ error: { code: status === 503 ? 'UNAVAILABLE' : status === 401 ? 'UNAUTHENTICATED' : 'INVALID_INPUT',
      message: status === 503 ? 'Account service unavailable' : status === 401 ? 'Sign in again' : 'Invalid session request' } }, status);
  });
  if (options.sync) app.route('/api/sync/v1', options.sync);
  app.all('/api/sync/*', (c) => c.json({ error: { code: 'NOT_FOUND', message: 'Sync route not enabled' } }, 404));
  app.use('/api/*', async (c, next) => {
    c.header('cache-control', 'no-store');
    if (['/api/health', '/api/ready'].includes(c.req.path)) return next();
    const url = new URL(c.req.url);
    const requestOrigin = c.req.header('origin');
    const mutation = !['GET', 'HEAD'].includes(c.req.method);
    // TLS may terminate at the reverse proxy. The configured origin, Host
    // and browser Origin must still match; forwarded Host/Proto are not trusted.
    if (url.host !== origin.host || (!secure && url.protocol !== origin.protocol)
      || c.req.header('sec-fetch-site') === 'cross-site'
      || (requestOrigin ? requestOrigin !== origin.origin : mutation)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Request origin is not allowed' } }, 403);
    }
    await next();
  });
  // Bounded per-process admission control, independent of attacker-supplied IP headers.
  let windowStart = clock(), loginAttempts = 0;
  app.get('/api/client', (c) => c.json({ profile: 'hub', capabilities: { browserLLM: false } }));
  app.post('/api/session', async (c) => {
    const now = clock();
    if (now - windowStart >= 60_000) { windowStart = now; loginAttempts = 0; }
    const admitted = options.admitLogin ? await options.admitLogin() : ++loginAttempts <= 60;
    if (!admitted) { c.header('retry-after', '60'); return c.json({ error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts; try again in a minute' } }, 429); }
    const input = await json(c, 1024);
    if (typeof input.key !== 'string' || Object.keys(input).length !== 1) throw new CardError('INVALID_INPUT', 'Expected an access key');
    const session = await options.accounts.login(input.key, cookie(c.req.raw));
    if (!session) return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Access key is invalid or disabled' } }, 401);
    c.header('set-cookie', setCookie(session.token, sessionLifetimeMs / 1000));
    return c.json({ actor: { id: session.account.id, uri: session.account.uri }, name: session.account.name, expiresAt: session.expiresAt });
  });
  app.get('/api/session', async (c) => {
    const session = await options.accounts.authenticate(cookie(c.req.raw));
    if (!session) return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to this hub' } }, 401);
    return c.json({ actor: { id: session.account.id, uri: session.account.uri }, name: session.account.name, expiresAt: session.expiresAt });
  });
  app.delete('/api/session', async (c) => {
    const expected = c.req.header('x-unity-actor');
    const session = expected ? await options.accounts.authenticate(cookie(c.req.raw)) : null;
    if (session && expected !== session.account.id) return c.json({ error: { code: 'ACCOUNT_CHANGED', message: 'This browser is signed in as another account; reconnect before continuing' } }, 409);
    await options.accounts.logout(cookie(c.req.raw));
    c.header('set-cookie', setCookie('', 0));
    return c.body(null, 204);
  });
  app.all('/api/*', async (c) => {
    if (['/api/health', '/api/ready'].includes(c.req.path)) return publicApi.fetch(c.req.raw);
    // There is deliberately no local-session shortcut in the account profile.
    if (c.req.path === '/api/local-session') return c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404);
    const session = await options.accounts.authenticate(cookie(c.req.raw));
    if (!session) return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to this hub' } }, 401);
    const expected = c.req.header('x-unity-actor');
    if (expected && expected !== session.account.id) return c.json({ error: { code: 'ACCOUNT_CHANGED', message: 'This browser is signed in as another account; reconnect before continuing' } }, 409);
    const actor = Object.freeze({ id: session.account.id, uri: session.account.uri });
    return createApi({ ...options.forSession(session.proof), authenticate: () => actor, uploadByteLimit: hostedUploadByteLimit }).fetch(c.req.raw);
  });
  return app;
}
