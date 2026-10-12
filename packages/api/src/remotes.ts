import { Hono } from 'hono';
import type { Actor } from '@character-unity/cards/contract';
import { CardError } from '@character-unity/cards/contract';
import type { RemoteConnectionsService } from '@character-unity/cards/connections';
import type { Authenticate } from './cards.js';
import { json } from './body.js';

function fields(input: Record<string, unknown>, names: readonly string[]) {
  if (Object.keys(input).length !== names.length || names.some((key) => typeof input[key] !== 'string' || !input[key] || (input[key] as string).length > 200)) {
    throw new CardError('INVALID_INPUT', 'Unexpected or missing remote request fields');
  }
  return input as Record<string, string>;
}
function query(url: string, names: string[]) {
  const params = new URL(url).searchParams;
  if ([...params.keys()].some((key) => !names.includes(key) || params.getAll(key).length !== 1 || params.get(key)!.length > 200)) throw new CardError('INVALID_INPUT', 'Invalid remote query');
  const limit = params.get('limit');
  if (limit !== null && !/^([1-9]|1[0-9]|20)$/.test(limit)) throw new CardError('INVALID_INPUT', 'Select a page size from 1 to 20');
  return { params, limit: limit === null ? 20 : Number(limit) };
}

/** Authenticated browser routes. Signed peer routes remain a separate protocol and trust boundary. */
export function remoteRoutes(options: { remotes?: RemoteConnectionsService; authenticate?: Authenticate }) {
  const routes = new Hono<{ Variables: { actor: Actor } }>();
  routes.use('*', async (c, next) => {
    c.header('cache-control', 'no-store');
    if (!options.remotes || !options.authenticate) return c.json({ error: { code: 'UNAVAILABLE', message: 'Remote connections are not configured' } }, 503);
    const actor = await options.authenticate(c.req.raw);
    if (!actor) return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to manage remote connections' } }, 401);
    c.set('actor', Object.freeze({ ...actor })); await next();
  });
  routes.get('/connections', (c) => {
    query(c.req.url, []); return c.json({ connections: options.remotes!.list(c.get('actor')) });
  });
  routes.get('/connections/:id/publications', async (c) => {
    const { params, limit } = query(c.req.url, ['workspaceId', 'afterId', 'limit']);
    const workspace = params.get('workspaceId'); if (!workspace) throw new CardError('INVALID_INPUT', 'Choose a workspace');
    return c.json(await options.remotes!.publications(c.get('actor'), workspace, c.req.param('id'),
      { limit, ...(params.get('afterId') ? { after: params.get('afterId')! } : {}) }, c.req.raw.signal));
  });
  routes.post('/connections/:id/pulls', async (c) => {
    query(c.req.url, []);
    const input = fields(await json(c, 2048), ['workspaceId', 'publicationId']);
    return c.json(await options.remotes!.pull(c.get('actor'), input.workspaceId!, c.req.param('id'), input.publicationId!, c.req.raw.signal), 201);
  });
  routes.get('/workspaces/:workspace/jobs', async (c) => {
    const { params, limit } = query(c.req.url, ['afterId', 'limit']);
    const jobs = await options.remotes!.jobs(c.get('actor'), c.req.param('workspace'), { limit, ...(params.get('afterId') ? { afterId: params.get('afterId')! } : {}) });
    return c.json({ jobs, nextAfter: jobs.length === limit ? jobs.at(-1)!.requestId : null });
  });
  routes.get('/workspaces/:workspace/jobs/:id', async (c) => {
    query(c.req.url, []); return c.json(await options.remotes!.job(c.get('actor'), c.req.param('workspace'), c.req.param('id')));
  });
  routes.post('/workspaces/:workspace/jobs', async (c) => {
    query(c.req.url, []);
    const input = fields(await json(c, 2048), ['connectionId', 'cardId', 'revisionId', 'requestId']);
    return c.json(await options.remotes!.enqueue(c.get('actor'), c.req.param('workspace'), input.connectionId!, input.cardId!, input.revisionId!, input.requestId!, c.req.raw.signal), 201);
  });
  routes.post('/workspaces/:workspace/jobs/:id/send', async (c) => {
    query(c.req.url, []); fields(await json(c, 128), []);
    return c.json(await options.remotes!.send(c.get('actor'), c.req.param('workspace'), c.req.param('id'), c.req.raw.signal));
  });
  return routes;
}
