import { Hono } from 'hono';
import type { Actor } from '@character-unity/cards';
import type { Authenticate } from './cards.js';

export interface LibraryIndexStatus {
  enabled: boolean; running: boolean; pending: number; failed: number; bounded: boolean;
  reason: string | null; lastError: string | null; semantic: boolean | null;
}
export interface LibraryIndexService {
  status(actor: Actor, workspaceId: string): Promise<LibraryIndexStatus>;
  retry(actor: Actor, workspaceId: string): Promise<LibraryIndexStatus>;
}
export function libraryIndexRoutes(options: { libraryIndex?: LibraryIndexService; authenticate?: Authenticate }) {
  const routes = new Hono<{ Variables: { actor: Actor } }>();
  routes.use('/:workspaceId/search-index*', async (c, next) => {
    c.header('cache-control', 'no-store');
    if (!options.libraryIndex || !options.authenticate) return c.json({ error: { code: 'UNAVAILABLE', message: 'Library search indexing is not configured' } }, 503);
    const actor = await options.authenticate(c.req.raw);
    if (!actor) return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Connect to this workspace first' } }, 401);
    c.set('actor', Object.freeze({ ...actor }));
    await next();
  });
  routes.get('/:workspaceId/search-index', async (c) => c.json(await options.libraryIndex!.status(c.get('actor'), c.req.param('workspaceId'))));
  routes.post('/:workspaceId/search-index/retry', async (c) => c.json(await options.libraryIndex!.retry(c.get('actor'), c.req.param('workspaceId'))));
  return routes;
}
