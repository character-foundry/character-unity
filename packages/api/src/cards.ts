import { bytes, json } from './body.js';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { CardError, importByteLimit } from '@character-unity/cards/contract';
import type { Actor, CardService } from '@character-unity/cards';
import type { CardDocument, LibraryFlag, LibrarySort, LibrarySource } from '@character-unity/store';
import { isLibraryFlag, isLibrarySort, librarySources } from '@character-unity/store';
import { normalizeTagGroupFilters } from '@character-unity/store/library-query';
import type { ArchiveImportService } from '@character-unity/cards/archive';
import { input, parseSearchQuery, isSearchSort, parseSnapshot } from '@character-unity/archive-client/contract';
import { assetRevisionBody } from './asset-body.js';
import { documentByteLimit } from '@character-unity/store/validation';

export type Authenticate = (request: Request) => Actor | null | Promise<Actor | null>;
type Env = { Variables: { actor: Actor } };
export function cardRoutes(options: { cards?: CardService; archive?: ArchiveImportService; authenticate?: Authenticate; uploadByteLimit?: number }) {
  const uploadLimit = options.uploadByteLimit ?? importByteLimit;
  const routes = new Hono<Env>();
  routes.use('*', async (c, next) => {
    c.header('cache-control', 'no-store');
    if (!options.cards || !options.authenticate) return c.json({ error: { code: 'UNAVAILABLE', message: 'Card service is not configured' } }, 503);
    const actor = await options.authenticate(c.req.raw);
    if (!actor) return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Connect to this workspace first' } }, 401);
    c.set('actor', Object.freeze({ ...actor }));
    await next();
  });
  function required(c: Context<Env>) {
    if (!options.cards) throw new CardError('FORBIDDEN', 'Card service is unavailable');
    return { cards: options.cards, actor: c.get('actor') };
  }
  routes.get('/', async (c) => {
    const { cards, actor } = await required(c);
    return c.json({ workspaces: await cards.workspaces(actor) });
  });
  routes.post('/', async (c) => {
    const { cards, actor } = await required(c);
    const input = await json(c, 8192);
    if (typeof input.name !== 'string' || Object.keys(input).some((key) => key !== 'name')) throw new CardError('INVALID_INPUT', 'Expected a workspace name');
    return c.json(await cards.createWorkspace(actor, input.name), 201);
  });
  routes.get('/:workspaceId/cards', async (c) => {
    const { cards, actor } = await required(c);
    const limit = c.req.query('limit');
    if (limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(limit)) throw new CardError('INVALID_INPUT', 'Invalid page size');
    return c.json({ cards: await cards.list(actor, c.req.param('workspaceId'), {
      ...(limit ? { limit: Number(limit) } : {}), ...(c.req.query('afterId') ? { afterId: c.req.query('afterId')! } : {}),
    }) });
  });
  routes.get('/:workspaceId/card-summaries', async (c) => {
    const { cards, actor } = await required(c);
    const params = new URL(c.req.url).searchParams;
    const keys = ['q', 'tag', 'tags', 'tagGroups', 'excludeTagGroups', 'tagMode', 'exclude', 'has', 'fork', 'favorite', 'source', 'minTokens', 'sort', 'offset', 'limit'];
    const list = (key: string) => (params.get(key) ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    const tags = list('tags'), exclude = list('exclude'), has = list('has');
    if ([...params.keys()].some((key) => !keys.includes(key) || params.getAll(key).length !== 1)
      || (params.has('offset') && !/^(0|[1-9][0-9]{0,6})$/.test(params.get('offset')!))
      || (params.has('limit') && !/^[1-9][0-9]{0,2}$/.test(params.get('limit')!))
      || (params.get('q')?.length ?? 0) > 500 || (params.get('tag')?.length ?? 0) > 200
      || tags.length > 20 || exclude.length > 100 || [...tags, ...exclude].some((tag) => tag.length > 200)
      || !has.every(isLibraryFlag) || (params.has('sort') && !isLibrarySort(params.get('sort')!))
      || (params.has('tagMode') && !['all', 'any'].includes(params.get('tagMode')!))
      || (params.has('fork') && !['only', 'none'].includes(params.get('fork')!))
      || (params.has('favorite') && !['fav', 'not_fav'].includes(params.get('favorite')!))
      || (params.has('source') && !(librarySources as readonly string[]).includes(params.get('source')!))
      || (params.has('minTokens') && !/^(0|[1-9][0-9]{0,6})$/.test(params.get('minTokens')!))) throw new CardError('INVALID_INPUT', 'Invalid library query');
    const parseGroups = (key: string): unknown => {
      const value = params.get(key);
      if (value === null) return undefined;
      if (value.length > 256 * 1024) throw new CardError('TOO_LARGE', 'Meta-tag filters are too large');
      try { return JSON.parse(value) as unknown; }
      catch { throw new CardError('INVALID_INPUT', 'Expected JSON meta-tag groups'); }
    };
    const groups = normalizeTagGroupFilters({ tagGroups: parseGroups('tagGroups'), excludeTagGroups: parseGroups('excludeTagGroups') });
    return c.json(await cards.summaries(actor, c.req.param('workspaceId'), {
      ...groups,
      ...(params.get('q') ? { q: params.get('q')! } : {}), ...(params.get('tag') ? { tag: params.get('tag')! } : {}),
      ...(tags.length ? { tags } : {}), ...(exclude.length ? { excludeTags: exclude } : {}),
      ...(has.length ? { has: has as LibraryFlag[] } : {}),
      ...(params.has('tagMode') ? { tagMode: params.get('tagMode') as 'all' | 'any' } : {}),
      ...(params.has('fork') ? { fork: params.get('fork') as 'only' | 'none' } : {}),
      ...(params.has('sort') ? { sort: params.get('sort') as LibrarySort } : {}),
      ...(params.has('favorite') ? { favorite: params.get('favorite') as 'fav' | 'not_fav' } : {}),
      ...(params.has('source') ? { source: params.get('source') as LibrarySource } : {}),
      ...(Number(params.get('minTokens')) > 0 ? { minTokens: Number(params.get('minTokens')) } : {}),
      ...(params.has('offset') ? { offset: Number(params.get('offset')) } : {}), ...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
    }));
  });
  routes.delete('/:workspaceId/cards/:cardId', async (c) => {
    const { cards, actor } = await required(c);
    await cards.delete(actor, c.req.param('workspaceId'), c.req.param('cardId'));
    return c.body(null, 204);
  });
  for (const method of ['put', 'delete'] as const) {
    routes[method]('/:workspaceId/cards/:cardId/favorite', async (c) => {
      const { cards, actor } = await required(c);
      await cards.favorite(actor, c.req.param('workspaceId'), c.req.param('cardId'), method === 'put');
      return c.body(null, 204);
    });
    routes[method]('/:workspaceId/followed-creators', async (c) => {
      const { cards, actor } = await required(c);
      const body = await json(c, 2_000);
      if (Object.keys(body).some((key) => key !== 'creator') || typeof body.creator !== 'string') throw new CardError('INVALID_INPUT', 'Expected { creator }');
      await cards.follow(actor, c.req.param('workspaceId'), body.creator, method === 'put');
      return c.body(null, 204);
    });
  }
  routes.get('/:workspaceId/followed-creators', async (c) => {
    const { cards, actor } = await required(c);
    return c.json({ creators: await cards.followed(actor, c.req.param('workspaceId')) });
  });
  routes.get('/:workspaceId/card-tags', async (c) => {
    const { cards, actor } = await required(c);
    if (new URL(c.req.url).search) throw new CardError('INVALID_INPUT', 'Card tags take no query parameters');
    return c.json({ tags: await cards.tags(actor, c.req.param('workspaceId')) });
  });
  routes.post('/:workspaceId/imports', async (c) => {
    const { cards, actor } = await required(c);
    let filename = c.req.header('x-file-name') ?? 'original';
    const encoding = c.req.header('x-file-name-encoding');
    if (encoding !== undefined && encoding !== 'uri') throw new CardError('INVALID_INPUT', 'Unknown file name encoding');
    if (encoding === 'uri') {
      if (filename.length > 6144) throw new CardError('INVALID_INPUT', 'File name is too long');
      try { filename = decodeURIComponent(filename); }
      catch { throw new CardError('INVALID_INPUT', 'Invalid file name encoding'); }
    }
    if (filename.length > 512) throw new CardError('INVALID_INPUT', 'File name is too long');
    return c.json(await cards.importFile(actor, c.req.param('workspaceId'), await bytes(c, uploadLimit), filename), 201);
  });
  routes.get('/:workspaceId/archive/status', async (c) => {
    const { actor } = await required(c);
    if (!options.archive) return c.json({ error: { code: 'UNAVAILABLE', message: 'Archive read source is not configured' } }, 503);
    if (new URL(c.req.url).search) throw new CardError('INVALID_INPUT', 'Archive status takes no query parameters');
    return c.json(await options.archive.status(actor, c.req.param('workspaceId'), c.req.raw.signal));
  });
  routes.get('/:workspaceId/archive/search', async (c) => {
    const { actor } = await required(c);
    if (!options.archive) return c.json({ error: { code: 'UNAVAILABLE', message: 'Archive read source is not configured' } }, 503);
    const params = new URL(c.req.url).searchParams;
    if (c.req.url.length > 20000 || [...params.keys()].some((key) => !['text', 'mode', 'semanticRatio', 'rrfK', 'filter', 'provider', 'tag', 'sort', 'limit', 'cursor', 'snapshot'].includes(key) || params.getAll(key).length !== 1)) throw new CardError('INVALID_INPUT', 'Invalid Archive search');
    if ((params.has('semanticRatio') && !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(params.get('semanticRatio')!)) || (params.has('rrfK') && !/^[1-9][0-9]{0,3}$/.test(params.get('rrfK')!))) throw new CardError('INVALID_INPUT', 'Invalid hybrid parameters');
    const mode = params.get('mode') ?? 'text';
    if (mode !== 'text' && mode !== 'browse' && mode !== 'semantic' && mode !== 'hybrid') throw new CardError('INVALID_INPUT', 'Invalid Archive search mode');
    const limit = params.get('limit'), sort = params.get('sort') ?? (mode === 'browse' ? 'id' : 'relevance');
    if ((limit !== null && !/^[1-9][0-9]{0,2}$/.test(limit)) || (!isSearchSort(sort))) throw new CardError('INVALID_INPUT', 'Invalid Archive search order or page size');
    const query = input(() => parseSearchQuery({ mode, ...(params.has('semanticRatio') ? { semanticRatio: Number(params.get('semanticRatio')) } : {}), ...(params.has('rrfK') ? { rrfK: Number(params.get('rrfK')) } : {}), text: params.get('text') ?? '', filter: params.get('filter') ?? '', provider: params.get('provider') ?? '', tag: params.get('tag') ?? '', sort }));
    return c.json(await options.archive.search(actor, c.req.param('workspaceId'), { ...query,
      ...(limit ? { limit: Number(limit) } : {}), ...(params.has('snapshot') ? { snapshot: params.get('snapshot')! } : {}),
      ...(params.has('cursor') ? { cursor: params.get('cursor')! } : {}),
    }, c.req.raw.signal));
  });
  routes.get('/:workspaceId/archive/cards', async (c) => {
    const { actor } = await required(c);
    if (!options.archive) return c.json({ error: { code: 'UNAVAILABLE', message: 'Archive read source is not configured' } }, 503);
    const params = new URL(c.req.url).searchParams;
    if (c.req.url.length > 5000 || [...params.keys()].some((key) => !['q', 'provider', 'tag', 'limit', 'cursor', 'snapshot'].includes(key) || params.getAll(key).length !== 1)) throw new CardError('INVALID_INPUT', 'Invalid Archive query');
    const limit = params.get('limit');
    if (limit !== null && !/^[1-9][0-9]{0,2}$/.test(limit)) throw new CardError('INVALID_INPUT', 'Invalid Archive page size');
    return c.json(await options.archive.list(actor, c.req.param('workspaceId'), {
      q: params.get('q') ?? '', provider: params.get('provider') ?? '', tag: params.get('tag') ?? '',
      ...(limit ? { limit: Number(limit) } : {}), ...(params.has('snapshot') ? { snapshot: params.get('snapshot')! } : {}),
      ...(params.has('cursor') ? { cursor: params.get('cursor')! } : {}),
    }, c.req.raw.signal));
  });
  for (const action of ['selection', 'imports'] as const) routes.post(`/:workspaceId/archive/${action}`, async (c) => {
    const { actor } = await required(c);
    if (!options.archive) return c.json({ error: { code: 'UNAVAILABLE', message: 'Archive read source is not configured' } }, 503);
    const body = await json(c, 20_000);
    if (Object.keys(body).some((key) => !['snapshot', 'ids'].includes(key)) || !Array.isArray(body.ids)
      || !body.ids.length || body.ids.length > 100 || body.ids.some((id) => typeof id !== 'string')) throw new CardError('INVALID_INPUT', 'Expected an Archive snapshot and selected IDs');
    const snapshot = input(() => parseSnapshot(body.snapshot));
    const ids = body.ids as string[];
    return c.json(action === 'selection'
      ? await options.archive.select(actor, c.req.param('workspaceId'), snapshot, ids, c.req.raw.signal)
      : await options.archive.import(actor, c.req.param('workspaceId'), snapshot, ids, c.req.raw.signal));
  });
  routes.get('/:workspaceId/cards/:cardId', async (c) => {
    const { cards, actor } = await required(c);
    return c.json(await cards.open(actor, c.req.param('workspaceId'), c.req.param('cardId'), c.req.raw.signal));
  });
  routes.post('/:workspaceId/cards', async (c) => {
    const { cards, actor } = await required(c);
    const value = await assetRevisionBody(c, uploadLimit, { requireHead: false });
    const created = await cards.createDraft(actor, c.req.param('workspaceId'), value.document, value.bindings, value.uploads, c.req.raw.signal);
    return c.json({ cardId: created.card.id, revisionId: created.revision.id, revision: created.revision }, 201);
  });
  routes.post('/:workspaceId/cards/:cardId/fork-assets', async (c) => {
    const { cards, actor } = await required(c);
    const value = await assetRevisionBody(c, uploadLimit);
    return c.json(await cards.forkAssets(actor, c.req.param('workspaceId'), c.req.param('cardId'), value.expectedHead!,
      value.document, value.bindings, value.uploads, c.req.raw.signal), 201);
  });
  routes.post('/:workspaceId/cards/:cardId/forks', async (c) => {
    const { cards, actor } = await required(c);
    // An empty body copies the card as is; `{ expectedHead, document }` saves an edited fork draft in one step.
    if (!c.req.header('content-type')?.includes('json')) return c.json(await cards.fork(actor, c.req.param('workspaceId'), c.req.param('cardId')), 201);
    const input = await json(c, documentByteLimit + 65_536);
    if (typeof input.expectedHead !== 'string' || !input.document || typeof input.document !== 'object' || Array.isArray(input.document)
      || Object.keys(input).some((key) => !['expectedHead', 'document'].includes(key))) throw new CardError('INVALID_INPUT', 'Expected a document and revision head');
    return c.json(await cards.fork(actor, c.req.param('workspaceId'), c.req.param('cardId'), { expectedHead: input.expectedHead, document: input.document as CardDocument }), 201);
  });
  routes.get('/:workspaceId/cards/:cardId/family', async (c) => {
    const { cards, actor } = await required(c);
    return c.json(await cards.family(actor, c.req.param('workspaceId'), c.req.param('cardId')));
  });
  routes.post('/:workspaceId/cards/:cardId/revisions', async (c) => {
    const { cards, actor } = await required(c);
    const input = await json(c, documentByteLimit + 65_536);
    if (typeof input.expectedHead !== 'string' || !input.document || typeof input.document !== 'object' || Array.isArray(input.document)
      || Object.keys(input).some((key) => !['expectedHead', 'document'].includes(key))) throw new CardError('INVALID_INPUT', 'Expected a document and revision head');
    return c.json(await cards.save(actor, c.req.param('workspaceId'), c.req.param('cardId'), input.expectedHead, input.document as CardDocument));
  });
  routes.post('/:workspaceId/cards/:cardId/restores', async (c) => {
    const { cards, actor } = await required(c);
    const input = await json(c, 8192);
    if (Object.keys(input).some((key) => !['expectedHead', 'revisionId'].includes(key))
      || typeof input.expectedHead !== 'string' || !input.expectedHead || input.expectedHead.length > 200
      || typeof input.revisionId !== 'string' || !input.revisionId || input.revisionId.length > 200) throw new CardError('INVALID_INPUT', 'Expected a saved revision and current head');
    return c.json(await cards.restore(actor, c.req.param('workspaceId'), c.req.param('cardId'), input.expectedHead, input.revisionId));
  });
  routes.get('/:workspaceId/cards/:cardId/revisions', async (c) => {
    const { cards, actor } = await required(c);
    const params = new URL(c.req.url).searchParams;
    if ([...params.keys()].some((key) => !['limit', 'afterSequence', 'throughSequence'].includes(key) || params.getAll(key).length !== 1)
      || [...params.values()].some((value) => !/^(0|[1-9][0-9]{0,15})$/.test(value))) throw new CardError('INVALID_INPUT', 'Invalid revision history query');
    return c.json(await cards.history(actor, c.req.param('workspaceId'), c.req.param('cardId'), Object.fromEntries([...params].map(([key, value]) => [key, Number(value)]))));
  });
  routes.get('/:workspaceId/cards/:cardId/revisions/:revisionId', async (c) => {
    const { cards, actor } = await required(c);
    if (new URL(c.req.url).search || c.req.param('revisionId').length > 200) throw new CardError('INVALID_INPUT', 'Expected an explicit saved revision');
    return c.json(await cards.revision(actor, c.req.param('workspaceId'), c.req.param('cardId'), c.req.param('revisionId'), c.req.raw.signal));
  });
  routes.post('/:workspaceId/cards/:cardId/asset-revisions', async (c) => {
    const { cards, actor } = await required(c);
    const value = await assetRevisionBody(c, uploadLimit);
    return c.json(await cards.saveAssets(actor, c.req.param('workspaceId'), c.req.param('cardId'), value.expectedHead!,
      value.document, value.bindings, value.uploads, c.req.raw.signal));
  });
  for (const action of ['assets', 'asset'] as const) routes.get(`/:workspaceId/cards/:cardId/${action}`, async (c) => {
    const { cards, actor } = await required(c);
    const params = new URL(c.req.url).searchParams;
    const revisionId = params.get('revisionId'), path = params.get('path');
    if (!revisionId || revisionId.length > 200 || [...params.keys()].some((key) => !(action === 'asset' ? ['revisionId', 'path'] : ['revisionId']).includes(key) || params.getAll(key).length !== 1)
      || (action === 'asset' && (!path || !/^(portrait|module\.risum|declared\/(0|[1-9][0-9]{0,3}))$/.test(path) || (path.startsWith('declared/') && Number(path.slice(9)) >= 8191)))) throw new CardError('INVALID_INPUT', 'Expected an explicit revision and asset path');
    if (action === 'assets') return c.json(await cards.assetList(actor, c.req.param('workspaceId'), c.req.param('cardId'), revisionId, c.req.raw.signal));
    const value = await cards.asset(actor, c.req.param('workspaceId'), c.req.param('cardId'), revisionId, path!, c.req.raw.signal);
    return new Response(value.body, { headers: { 'content-type': value.mediaType, 'content-length': String(value.byteLength),
      'content-disposition': 'attachment; filename="asset"', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; sandbox", etag: `"${value.hash}"` } });
  });
  routes.get('/:workspaceId/cards/:cardId/original', async (c) => {
    const { cards, actor } = await required(c);
    const original = await cards.original(actor, c.req.param('workspaceId'), c.req.param('cardId'), c.req.raw.signal);
    return new Response(original.body, { headers: { 'content-type': original.mediaType, 'content-length': String(original.byteLength),
      'content-disposition': 'attachment; filename="original"', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', etag: `"${original.hash}"` } });
  });
  routes.get('/:workspaceId/cards/:cardId/export', async (c) => {
    const { cards, actor } = await required(c);
    const params = new URL(c.req.url).searchParams;
    const format = params.get('format'); const revisionId = params.get('revisionId');
    if (!revisionId || revisionId.length > 200 || !['json', 'png', 'charx', 'sillytavern-json', 'sillytavern-png'].includes(format ?? '')
      || [...params.keys()].some((key) => !['format', 'revisionId'].includes(key) || params.getAll(key).length !== 1)) throw new CardError('INVALID_INPUT', 'Expected an explicit revision ID and export format');
    const value = await cards.export(actor, c.req.param('workspaceId'), c.req.param('cardId'), revisionId, format as 'json' | 'png' | 'charx' | 'sillytavern-json' | 'sillytavern-png', c.req.raw.signal);
    return new Response(new Uint8Array(value.bytes), { headers: { 'content-type': value.mediaType, 'content-length': String(value.bytes.byteLength),
      'content-disposition': `attachment; filename="${value.filename}"`, 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'no-store', 'x-unity-revision': value.revisionId, etag: `"${value.hash}"` } });
  });
  return routes;
}
