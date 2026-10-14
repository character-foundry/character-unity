import { Hono } from 'hono';
import { StoreError } from '@character-unity/store';
import { metaTagCatalogByteLimit, validateMetaTagWrite } from '@character-unity/store/meta-tags';
import type { Actor } from '@character-unity/cards/contract';
import type { Authenticate } from './cards.js';
import type { MetaTagService } from './meta-tags-service.js';
import { json } from './body.js';
export { createMetaTagService } from './meta-tags-service.js';
export type { MetaTagService } from './meta-tags-service.js';

export function metaTagRoutes(options: { metaTags?: MetaTagService; authenticate?: Authenticate }) {
  const routes = new Hono<{ Variables: { actor: Actor } }>();
  routes.use('/:workspaceId/meta-tags', async (c, next) => {
    c.header('cache-control', 'no-store');
    if (!options.metaTags || !options.authenticate) return c.json({ error: { code: 'UNAVAILABLE', message: 'Workspace meta-tags are not configured' } }, 503);
    const actor = await options.authenticate(c.req.raw);
    if (!actor) return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Connect to this workspace first' } }, 401);
    if (new URL(c.req.url).search) throw new StoreError('INVALID_INPUT', 'Workspace meta-tags take no query parameters');
    c.set('actor', Object.freeze({ ...actor }));
    await next();
  });
  routes.get('/:workspaceId/meta-tags', async (c) => c.json(await options.metaTags!.read(c.get('actor'), c.req.param('workspaceId'))));
  routes.put('/:workspaceId/meta-tags', async (c) => {
    const input = validateMetaTagWrite(await json(c, metaTagCatalogByteLimit));
    return c.json(await options.metaTags!.write(c.get('actor'), c.req.param('workspaceId'), input));
  });
  routes.all('/:workspaceId/meta-tags', (c) => c.notFound());
  return routes;
}
