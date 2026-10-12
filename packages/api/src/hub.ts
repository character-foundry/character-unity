import { Hono } from 'hono';
import type { Actor } from '@character-unity/cards/contract';
import { CardError } from '@character-unity/cards/contract';
import type { HubService } from '@character-unity/cards/hub';
import { publicationPolicy } from '@character-unity/store/hub';
import type { PublicationPolicy } from '@character-unity/store/hub';
import type { Authenticate } from './cards.js';
import { json } from './body.js';

function keys(body: Record<string, unknown>, expected: string[]) {
  if (Object.keys(body).some((key) => !expected.includes(key)) || expected.some((key) => !(key in body))) throw new CardError('INVALID_INPUT', 'Unexpected or missing request fields');
}
function policy(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CardError('INVALID_INPUT', 'Expected publication policy');
  keys(value as Record<string, unknown>, ['visibility', 'allowOriginal', 'allowFork']);
  return publicationPolicy(value as PublicationPolicy);
}

/** Initially mounted in the authenticated local profile. Public hosting needs its own authenticator. */
export function hubRoutes(options: { hub?: HubService; authenticate?: Authenticate }) {
  const routes = new Hono<{ Variables: { actor: Actor } }>();
  routes.use('*', async (c, next) => {
    c.header('cache-control', 'no-store');
    if (!options.hub || !options.authenticate) return c.json({ error: { code: 'UNAVAILABLE', message: 'Hub service is not configured' } }, 503);
    const actor = await options.authenticate(c.req.raw);
    if (!actor) return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Connect to this hub first' } }, 401);
    c.set('actor', Object.freeze({ ...actor }));
    await next();
  });
  routes.get('/publications', async (c) => {
    const params = new URL(c.req.url).searchParams;
    if ([...params.keys()].some((key) => !['afterId', 'limit', 'parentId'].includes(key) || params.getAll(key).length !== 1)) throw new CardError('INVALID_INPUT', 'Invalid publication query');
    const limit = params.get('limit');
    if (limit !== null && !/^[1-9][0-9]?$/.test(limit)) throw new CardError('INVALID_INPUT', 'Invalid page size');
    return c.json({ publications: await options.hub!.list(c.get('actor'), {
      ...(limit ? { limit: Number(limit) } : {}), ...(params.has('afterId') ? { afterId: params.get('afterId')! } : {}),
      ...(params.has('parentId') ? { parentId: params.get('parentId')! } : {}),
    }) });
  });
  routes.post('/publications', async (c) => {
    const body = await json(c, 8192);
    keys(body, ['workspaceId', 'revisionIds', 'policy']);
    if (typeof body.workspaceId !== 'string' || !Array.isArray(body.revisionIds) || body.revisionIds.some((id) => typeof id !== 'string')) throw new CardError('INVALID_INPUT', 'Expected workspace and selected revision IDs');
    return c.json({ publications: await options.hub!.publish(c.get('actor'), body.workspaceId, body.revisionIds as string[], policy(body.policy)) }, 201);
  });
  routes.get('/publications/:id', async (c) => c.json(await options.hub!.get(c.get('actor'), c.req.param('id'))));
  routes.get('/publications/:id/lineage', async (c) => {
    const params = new URL(c.req.url).searchParams;
    if ([...params.keys()].some((key) => !['afterId', 'limit'].includes(key) || params.getAll(key).length !== 1)) throw new CardError('INVALID_INPUT', 'Invalid lineage query');
    const limit = params.get('limit');
    if (limit !== null && !/^[1-9][0-9]?$/.test(limit)) throw new CardError('INVALID_INPUT', 'Invalid page size');
    return c.json(await options.hub!.lineage(c.get('actor'), c.req.param('id'), {
      ...(limit ? { limit: Number(limit) } : {}), ...(params.has('afterId') ? { afterId: params.get('afterId')! } : {}),
    }));
  });
  routes.patch('/publications/:id/policy', async (c) => {
    const body = await json(c, 4096);
    keys(body, ['expectedVersion', 'policy']);
    if (typeof body.expectedVersion !== 'number') throw new CardError('INVALID_INPUT', 'Expected policy version');
    return c.json(await options.hub!.updatePolicy(c.get('actor'), c.req.param('id'), body.expectedVersion, policy(body.policy)));
  });
  routes.post('/publications/:id/forks', async (c) => {
    const body = await json(c, 4096);
    keys(body, ['workspaceId']);
    if (typeof body.workspaceId !== 'string') throw new CardError('INVALID_INPUT', 'Expected target workspace');
    return c.json(await options.hub!.fork(c.get('actor'), c.req.param('id'), body.workspaceId), 201);
  });
  for (const kind of ['original', 'asset'] as const) routes.get(`/publications/:id/${kind}`, async (c) => {
    const params = new URL(c.req.url).searchParams;
    if ((kind === 'original' && params.size) || (kind === 'asset' && (params.size !== 1 || !params.get('path')))) throw new CardError('INVALID_INPUT', 'Invalid download query');
    const value = kind === 'original'
      ? await options.hub!.original(c.get('actor'), c.req.param('id'))
      : await options.hub!.asset(c.get('actor'), c.req.param('id'), params.get('path')!);
    return new Response(value.body, { headers: { 'content-type': value.mediaType, 'content-length': String(value.byteLength),
      'content-disposition': 'attachment', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" } });
  });
  return routes;
}
