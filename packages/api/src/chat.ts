import { Hono } from 'hono';
import { CardError } from '@character-unity/cards/contract';
import type { Actor } from '@character-unity/cards';
import type { ChatService } from '@character-unity/cards/chat';
import type { Authenticate } from './cards.js';
import { json } from './body.js';

type Env = { Variables: { actor: Actor } };
const kinds = ['sillytavern', 'lumiverse', 'marinara'] as const;
type Kind = typeof kinds[number];

function fields(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new CardError('INVALID_INPUT', 'Unexpected request fields');
}
function optionalText(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (value !== undefined && typeof value !== 'string') throw new CardError('INVALID_INPUT', `${key} must be text`);
  return value as string | undefined;
}
function credentials(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CardError('INVALID_INPUT', 'Expected credentials');
  const body = value as Record<string, unknown>;
  fields(body, ['username', 'password', 'apiKey']);
  const out: { username?: string; password?: string; apiKey?: string } = {};
  for (const key of ['username', 'password', 'apiKey'] as const) {
    const item = optionalText(body, key);
    if (item !== undefined) out[key] = item;
  }
  return out;
}

/**
 * Local profile only: chat apps live on the owner's machine or LAN, and their credentials
 * never belong on a shared hub. Mounted at /api/workspaces/:workspaceId/chat.
 */
export function chatRoutes(options: { chat?: ChatService; authenticate?: Authenticate }) {
  const routes = new Hono<Env>();
  routes.use('/:workspaceId/chat/*', async (c, next) => {
    c.header('cache-control', 'no-store');
    if (!options.chat || !options.authenticate) return c.json({ error: { code: 'UNAVAILABLE', message: 'Chat apps are not available on this host' } }, 503);
    const actor = await options.authenticate(c.req.raw);
    if (!actor) return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Connect to this workspace first' } }, 401);
    c.set('actor', Object.freeze({ ...actor }));
    await next();
  });
  const chat = () => options.chat!;
  routes.get('/:workspaceId/chat/targets', async (c) => c.json({ targets: await chat().targets(c.get('actor'), c.req.param('workspaceId')) }));
  routes.post('/:workspaceId/chat/targets', async (c) => {
    const body = await json(c, 8192);
    fields(body, ['kind', 'name', 'baseUrl', 'credentials']);
    if (!kinds.includes(body.kind as Kind) || typeof body.baseUrl !== 'string') throw new CardError('INVALID_INPUT', 'Expected an app kind and URL');
    const name = optionalText(body, 'name');
    return c.json(await chat().addTarget(c.get('actor'), c.req.param('workspaceId'), {
      kind: body.kind as Kind, baseUrl: body.baseUrl, credentials: credentials(body.credentials) ?? {}, ...(name !== undefined ? { name } : {}),
    }), 201);
  });
  routes.patch('/:workspaceId/chat/targets/:targetId', async (c) => {
    const body = await json(c, 8192);
    fields(body, ['name', 'baseUrl', 'credentials']);
    const name = optionalText(body, 'name'), baseUrl = optionalText(body, 'baseUrl'), secrets = credentials(body.credentials);
    return c.json(await chat().updateTarget(c.get('actor'), c.req.param('workspaceId'), c.req.param('targetId'), {
      ...(name !== undefined ? { name } : {}), ...(baseUrl !== undefined ? { baseUrl } : {}), ...(secrets ? { credentials: secrets } : {}),
    }));
  });
  routes.delete('/:workspaceId/chat/targets/:targetId', async (c) => {
    await chat().removeTarget(c.get('actor'), c.req.param('workspaceId'), c.req.param('targetId'));
    return c.body(null, 204);
  });
  routes.post('/:workspaceId/chat/targets/:targetId/check', async (c) => c.json(await chat().check(c.get('actor'), c.req.param('workspaceId'), c.req.param('targetId'))));
  routes.post('/:workspaceId/chat/targets/:targetId/scan', async (c) => c.json(await chat().scan(c.get('actor'), c.req.param('workspaceId'), c.req.param('targetId'))));
  routes.post('/:workspaceId/chat/targets/:targetId/sends', async (c) => {
    const body = await json(c, 4096);
    fields(body, ['cardId', 'overwriteEdited']);
    if (typeof body.cardId !== 'string' || (body.overwriteEdited !== undefined && typeof body.overwriteEdited !== 'boolean')) throw new CardError('INVALID_INPUT', 'Expected a card ID');
    return c.json(await chat().send(c.get('actor'), c.req.param('workspaceId'), body.cardId, c.req.param('targetId'), { overwriteEdited: body.overwriteEdited === true }), 201);
  });
  routes.delete('/:workspaceId/chat/targets/:targetId/placements', async (c) => {
    const remoteId = c.req.query('remoteId');
    if (!remoteId) throw new CardError('INVALID_INPUT', 'Expected a remote ID');
    await chat().forget(c.get('actor'), c.req.param('workspaceId'), c.req.param('targetId'), remoteId);
    return c.body(null, 204);
  });
  routes.get('/:workspaceId/chat/placements', async (c) => {
    const params = new URL(c.req.url).searchParams;
    if ([...params.keys()].some((key) => key !== 'cardId')) throw new CardError('INVALID_INPUT', 'Invalid placement query');
    const ids = params.getAll('cardId');
    if (ids.length > 100) throw new CardError('INVALID_INPUT', 'Ask for at most 100 cards');
    return c.json({ placements: await chat().placements(c.get('actor'), c.req.param('workspaceId'), ids.length ? ids : undefined) });
  });
  return routes;
}
