import { Hono } from 'hono';
import type { ContentActor, ContentService } from '@character-unity/content';
import { ContentError, contentByteLimit } from '@character-unity/content';
import { StoreError } from '@character-unity/store';
import { contentKind, contentPolicy } from '@character-unity/store/content';
import type { Authenticate } from './cards.js';
import { bytes, json } from './body.js';

function query(url: string, keys: readonly string[]) {
  const params = new URL(url).searchParams;
  if ([...params.keys()].some((key) => !keys.includes(key) || params.getAll(key).length !== 1 || params.get(key)!.length > 500)) throw new ContentError('INVALID_INPUT','Invalid standalone content query');
  return params;
}
function fields(body: Record<string,unknown>, keys: readonly string[]) {
  if (Object.keys(body).length !== keys.length || keys.some((key) => !(key in body))) throw new ContentError('INVALID_INPUT','Unexpected or missing content fields');
  return body;
}
function string(value: unknown) { if (typeof value !== 'string') throw new ContentError('INVALID_INPUT','Expected text'); return value; }
function integer(value: unknown) { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new ContentError('INVALID_INPUT','Expected a positive version'); return value as number; }
function policy(body: Record<string,unknown>) {
  return contentPolicy({ visibility: body.visibility as 'private' | 'members' | 'public',allowFork: body.allowFork as boolean,allowOriginal: body.allowOriginal as boolean });
}
function download(value: { bytes: Uint8Array; filename: string }) {
  const filename = encodeURIComponent(value.filename.replace(/[\r\n]/g,'')).replace(/[!'()*]/g,(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Response(new Uint8Array(value.bytes),{ headers: { 'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename*=UTF-8''${filename}`,'cache-control': 'no-store','x-content-type-options': 'nosniff' } });
}
export function contentRoutes(options: { content?: ContentService; authenticate?: Authenticate }) {
  const routes = new Hono<{ Variables: { actor: ContentActor | null } }>();
  routes.use('*',async (c,next) => {
    c.header('cache-control','no-store');
    if (!options.content) return c.json({ error: { code: 'UNAVAILABLE',message: 'Standalone content is not configured' } },503);
    const actor = await options.authenticate?.(c.req.raw); c.set('actor',actor ? Object.freeze({ id: actor.id }) : null); await next();
  });
  const authenticated = (actor: ContentActor | null) => { if (!actor) throw new StoreError('UNAUTHENTICATED','Connect to this workspace first'); return actor; };
  routes.use('/workspaces/*',async (c,next) => { authenticated(c.get('actor')); await next(); });
  const service = options.content!;
  const workspace = '/workspaces/:workspaceId', item = `${workspace}/documents/:id`;
  routes.get(`${workspace}/documents`,async (c) => {
    const params = query(c.req.url,['kind','q','afterId','limit']), limit = params.get('limit');
    if (limit !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(limit)) throw new ContentError('INVALID_INPUT','Choose a page size from 1 to 100');
    return c.json(await service.list(authenticated(c.get('actor')),c.req.param('workspaceId'),{
      ...(params.get('kind') ? { kind: contentKind(params.get('kind')!) } : {}),...(params.get('q') ? { q: params.get('q')! } : {}),
      ...(params.get('afterId') ? { afterId: params.get('afterId')! } : {}),...(limit ? { limit: Number(limit) } : {}),
    }));
  });
  routes.post(`${workspace}/imports`,async (c) => {
    const params = query(c.req.url,['kind']), kind = params.get('kind'); if (!kind) throw new ContentError('INVALID_INPUT','Choose a content kind');
    let filename = c.req.header('x-file-name') ?? `${kind}.json`;
    const encoding = c.req.header('x-file-name-encoding');
    if (encoding !== undefined && encoding !== 'uri') throw new ContentError('INVALID_INPUT','Unknown filename encoding');
    if (encoding === 'uri') { try { filename = decodeURIComponent(filename); } catch { throw new ContentError('INVALID_INPUT','Invalid filename encoding'); } }
    return c.json(await service.import(authenticated(c.get('actor')),c.req.param('workspaceId'),kind,await bytes(c,contentByteLimit),filename,c.req.raw.signal),201);
  });
  routes.get(item,async (c) => { query(c.req.url,[]); return c.json(await service.open(authenticated(c.get('actor')),c.req.param('workspaceId'),c.req.param('id'))); });
  routes.put(item,async (c) => {
    query(c.req.url,[]); const body = fields(await json(c,contentByteLimit*2+8192),['expectedHead','title','text']);
    return c.json(await service.save(authenticated(c.get('actor')),c.req.param('workspaceId'),c.req.param('id'),string(body.expectedHead),string(body.title),string(body.text)));
  });
  routes.delete(item,async (c) => { query(c.req.url,[]); await service.remove(authenticated(c.get('actor')),c.req.param('workspaceId'),c.req.param('id')); return c.body(null,204); });
  routes.post(`${item}/forks`,async (c) => { query(c.req.url,[]); const body = fields(await json(c,2048),['revisionId']);
    return c.json(await service.fork(authenticated(c.get('actor')),c.req.param('workspaceId'),c.req.param('id'),string(body.revisionId)),201); });
  routes.get(`${item}/revisions`,async (c) => {
    const params = query(c.req.url,['afterSequence','limit']);
    if (params.has('afterSequence') && !/^(?:0|[1-9][0-9]{0,8})$/.test(params.get('afterSequence')!)) throw new ContentError('INVALID_INPUT','Invalid history cursor');
    if (params.has('limit') && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(params.get('limit')!)) throw new ContentError('INVALID_INPUT','Invalid history page size');
    return c.json(await service.history(authenticated(c.get('actor')),c.req.param('workspaceId'),c.req.param('id'),{
      ...(params.has('afterSequence') ? { afterSequence: Number(params.get('afterSequence')) } : {}),...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
    }));
  });
  routes.get(`${item}/revisions/:revisionId`,async (c) => { query(c.req.url,[]);
    return c.json(await service.revision(authenticated(c.get('actor')),c.req.param('workspaceId'),c.req.param('id'),c.req.param('revisionId'))); });
  routes.get(`${item}/original`,async (c) => { query(c.req.url,[]); return download(await service.original(authenticated(c.get('actor')),c.req.param('workspaceId'),c.req.param('id'))); });
  routes.get(`${item}/export`,async (c) => { const params = query(c.req.url,['revisionId']); if (!params.get('revisionId')) throw new ContentError('INVALID_INPUT','Select an exact saved revision');
    return download(await service.export(authenticated(c.get('actor')),c.req.param('workspaceId'),c.req.param('id'),params.get('revisionId')!)); });
  routes.post(`${item}/publications`,async (c) => { query(c.req.url,[]); const body = fields(await json(c,4096),['revisionId','visibility','allowFork','allowOriginal']);
    return c.json(await service.publish(authenticated(c.get('actor')),c.req.param('workspaceId'),c.req.param('id'),string(body.revisionId),policy(body)),201); });
  routes.get('/publications',async (c) => {
    const params = query(c.req.url,['kind','mine','afterId','limit']);
    if (params.has('mine') && params.get('mine') !== 'true') throw new ContentError('INVALID_INPUT','Invalid ownership filter');
    if (params.has('limit') && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(params.get('limit')!)) throw new ContentError('INVALID_INPUT','Invalid page size');
    return c.json(await service.shared(c.get('actor'),{
      ...(params.get('kind') ? { kind: contentKind(params.get('kind')!) } : {}),...(params.has('mine') ? { mine: true } : {}),
      ...(params.get('afterId') ? { afterId: params.get('afterId')! } : {}),...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
    }));
  });
  routes.get('/publications/:id',async (c) => { query(c.req.url,[]); return c.json(await service.publication(c.get('actor'),c.req.param('id'))); });
  routes.put('/publications/:id',async (c) => { query(c.req.url,[]); const body = fields(await json(c,4096),['expectedVersion','visibility','allowFork','allowOriginal']);
    return c.json(await service.updatePublication(authenticated(c.get('actor')),c.req.param('id'),integer(body.expectedVersion),policy(body))); });
  routes.get('/publications/:id/original',async (c) => { query(c.req.url,[]); return download(await service.publicationOriginal(c.get('actor'),c.req.param('id'))); });
  routes.post('/publications/:id/forks',async (c) => { query(c.req.url,[]); const body = fields(await json(c,2048),['workspaceId','expectedVersion']);
    return c.json(await service.forkPublication(authenticated(c.get('actor')),string(body.workspaceId),c.req.param('id'),integer(body.expectedVersion)),201); });
  return routes;
}
