import { Hono } from 'hono';
import { CardError } from '@character-unity/cards/contract';
import type { Actor } from '@character-unity/cards';
import type { NativeArchiveService } from '@character-unity/cards/native-archive';
import type { Authenticate } from './cards.js';
import { json } from './body.js';

type Env = { Variables: { actor: Actor } };
const queryKeys = ['q', 'mode', 'filter', 'snapshot', 'tags', 'match', 'exclude', 'has', 'provider', 'minTokens', 'sort', 'offset', 'limit'];

/**
 * The native Archive, read through this host: browsing, files for the library, and Settings' scraper
 * controls. Hosts grant administration separately from account-scoped reads.
 * Mounted at /api/workspaces/:workspaceId/archive/v2.
 */
export function nativeArchiveRoutes(options: { nativeArchive?: NativeArchiveService; authenticate?: Authenticate }) {
  const routes = new Hono<Env>();
  routes.use('/:workspaceId/archive/v2/*', async (c, next) => {
    c.header('cache-control', 'no-store');
    if (!options.nativeArchive || !options.authenticate) return c.json({ error: { code: 'UNAVAILABLE', message: 'The Archive is not connected to this host' } }, 503);
    const actor = await options.authenticate(c.req.raw);
    if (!actor) return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Connect to this workspace first' } }, 401);
    c.set('actor', Object.freeze({ ...actor }));
    await next();
  });
  const archive = () => options.nativeArchive!;
  const base = '/:workspaceId/archive/v2';
  routes.get(`${base}/status`, async (c) => c.json(await archive().status(c.get('actor'), c.req.param('workspaceId'), c.req.raw.signal)));
  routes.get(`${base}/cards`, async (c) => {
    const params = new URL(c.req.url).searchParams;
    if (c.req.url.length > 20_000 || [...params.keys()].some((key) => !queryKeys.includes(key) || params.getAll(key).length !== 1)) throw new CardError('INVALID_INPUT', 'Invalid Archive query');
    return c.json(await archive().list(c.get('actor'), c.req.param('workspaceId'), params, c.req.raw.signal));
  });
  routes.get(`${base}/cards/:id`, async (c) => {
    const params = new URL(c.req.url).searchParams, versionId = params.get('version') ?? undefined;
    if ([...params.keys()].some((key) => key !== 'version') || params.getAll('version').length > 1
      || (versionId !== undefined && (!versionId || versionId.length > 200))) throw new CardError('INVALID_INPUT', 'Expected an exact Archive version');
    return c.json(await archive().card(c.get('actor'), c.req.param('workspaceId'), c.req.param('id'), c.req.raw.signal, versionId));
  });
  routes.get(`${base}/tags`, async (c) => c.json(await archive().tags(c.get('actor'), c.req.param('workspaceId'))));
  routes.get(`${base}/objects/:hash`, async (c) => {
    const upstream = await archive().object(c.get('actor'), c.req.param('workspaceId'), c.req.param('hash'));
    // Workspace URLs require current session/expected-actor checks on every read.
    // Only the upstream Archive's unauthenticated object URL may be immutable.
    return new Response(upstream.body, { headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  });
  for (const method of ['post', 'put'] as const) routes[method](`${base}/cards/:id/${method === 'post' ? 'import' : 'favorite'}`, async (c) => {
    const body = c.req.header('content-type')?.includes('application/json') ? await json(c, 1024) : {};
    if (Object.keys(body).some((key) => key !== 'versionId') || (body.versionId !== undefined && (typeof body.versionId !== 'string' || !body.versionId || body.versionId.length > 200))) throw new CardError('INVALID_INPUT', 'Expected an exact Archive version');
    return c.json(await archive().import(c.get('actor'), c.req.param('workspaceId'), c.req.param('id'), body.versionId as string | undefined, method === 'put'), 201);
  });
  routes.post(`${base}/cards/:id/block`, async (c) => c.json(await archive().admin.block(c.get('actor'), c.req.param('workspaceId'), c.req.param('id'))));
  routes.get(`${base}/sources`, async (c) => c.json(await archive().admin.sources(c.get('actor'), c.req.param('workspaceId'))));
  routes.put(`${base}/sources/:provider`, async (c) => c.json(await archive().admin.saveSource(c.get('actor'), c.req.param('workspaceId'), c.req.param('provider'), await json(c, 65_536))));
  routes.post(`${base}/sources/:provider/runs`, async (c) => c.json(await archive().admin.run(c.get('actor'), c.req.param('workspaceId'), c.req.param('provider')), 202));
  routes.get(`${base}/runs`, async (c) => c.json(await archive().admin.runs(c.get('actor'), c.req.param('workspaceId'), c.req.query('provider'))));
  routes.post(`${base}/runs/:runId/cancel`, async (c) => {
    const runId = Number(c.req.param('runId'));
    if (!Number.isSafeInteger(runId) || runId < 1) throw new CardError('INVALID_INPUT', 'Invalid run');
    return c.json(await archive().admin.cancel(c.get('actor'), c.req.param('workspaceId'), runId));
  });
  return routes;
}
