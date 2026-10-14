import { Hono } from 'hono';
import { CardError, type Actor } from '@character-unity/cards/contract';
import type { StatisticsService } from '@character-unity/cards/statistics';
import type { Authenticate } from './cards.js';

export function statisticsRoutes(options: { statistics?: StatisticsService; authenticate?: Authenticate }) {
  const routes = new Hono<{ Variables: { actor: Actor } }>();
  routes.use('/:workspaceId/statistics', async (c, next) => {
    c.header('cache-control', 'no-store');
    if (!options.statistics || !options.authenticate) return c.json({ error: { code: 'UNAVAILABLE', message: 'Workspace statistics are not configured' } }, 503);
    const actor = await options.authenticate(c.req.raw);
    if (!actor) return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Connect to this workspace first' } }, 401);
    c.set('actor', Object.freeze({ ...actor }));
    await next();
  });
  routes.get('/:workspaceId/statistics', async (c) => {
    if (new URL(c.req.url).search) throw new CardError('INVALID_INPUT', 'Workspace statistics take no query parameters');
    return c.json(await options.statistics!.read(c.get('actor'), c.req.param('workspaceId')));
  });
  routes.all('/:workspaceId/statistics', (c) => c.notFound());
  return routes;
}
