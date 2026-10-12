import { Hono } from 'hono';
import { ArchiveError, archivePrefix, input, limits, parseSearchQuery, isSearchSort } from '@character-unity/archive-client/contract';
import type { ArchiveReadSource } from './read-source.js';

/** Read transport with an explicit source; no scraper, refresh or repair routes. */
export function createArchiveApp(source?: ArchiveReadSource, options: { readOrigins?: readonly string[] } = {}) {
  const origins = new Set((options.readOrigins ?? []).map((value) => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) throw new Error('Archive read origins must be exact HTTP(S) origins');
    return value;
  }));
  const app = new Hono();
  app.get('/api/health', (c) => c.json({ service: 'unity-archive', status: 'ok', stage: 'scaffold' }));
  app.onError((error, c) => {
    if (error instanceof ArchiveError) {
      const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'SNAPSHOT_CHANGED' ? 409 : error.code === 'TOO_LARGE' ? 413 : ['UNAVAILABLE', 'INTEGRITY'].includes(error.code) ? 503 : 400;
      return c.json({ error: { code: error.code, message: error.message } }, status);
    }
    return c.json({ error: { code: 'UNAVAILABLE', message: 'Archive source unavailable' } }, 503);
  });
  function params(url: string, allowed: readonly string[], repeated?: string) {
    const result = new URL(url).searchParams;
    if (url.length > 20_000 || [...result.keys()].some((key) => !allowed.includes(key)
      || (key !== repeated && result.getAll(key).length !== 1))) throw new ArchiveError('INVALID_INPUT', 'Invalid Archive query');
    return result;
  }
  function connected() {
    if (!source) throw new ArchiveError('UNAVAILABLE', 'Archive read source is not configured');
    return source;
  }
  function json(value: unknown) {
    const body = JSON.stringify(value);
    if (new TextEncoder().encode(body).byteLength > limits.jsonBytes) throw new ArchiveError('TOO_LARGE', 'Archive metadata response exceeds 8 MiB; request fewer cards');
    return new Response(body, { headers: { 'content-type': 'application/json; charset=UTF-8' } });
  }
  app.use(`${archivePrefix}/*`, async (c, next) => {
    // Apply to the final response too: byte routes return a new Response object.
    await next();
    c.header('cache-control', 'no-store');
    const origin = c.req.header('origin');
    c.header('vary', 'Origin');
    if (origin && origins.has(origin) && ['GET', 'HEAD'].includes(c.req.method)) {
      c.header('access-control-allow-origin', origin);
      c.header('access-control-expose-headers', 'X-Archive-Id, X-Archive-Snapshot');
    }
  });
  app.get(`${archivePrefix}/status`, (c) => {
    params(c.req.url, []);
    return json(connected().status());
  });
  app.get(`${archivePrefix}/cards`, (c) => {
    const p = params(c.req.url, ['snapshot', 'cursor', 'q', 'provider', 'tag', 'limit']);
    const limit = p.get('limit');
    if (limit !== null && !/^[1-9][0-9]{0,2}$/.test(limit)) throw new ArchiveError('INVALID_INPUT', 'Invalid page limit');
    return json(connected().list({
      q: p.get('q') ?? '', provider: p.get('provider') ?? '', tag: p.get('tag') ?? '',
      ...(p.has('snapshot') ? { snapshot: p.get('snapshot') ?? '' } : {}),
      ...(p.has('cursor') ? { cursor: p.get('cursor') ?? '' } : {}),
      ...(limit === null ? {} : { limit: Number(limit) }),
    }));
  });
  app.get(`${archivePrefix}/cards/:id`, (c) => {
    const p = params(c.req.url, ['snapshot']);
    return json(connected().card(p.get('snapshot') ?? '', c.req.param('id')));
  });
  app.get(`${archivePrefix}/search`, async (c) => {
    const p = params(c.req.url, ['snapshot', 'cursor', 'text', 'mode', 'semanticRatio', 'rrfK', 'filter', 'provider', 'tag', 'sort', 'limit']);
    const limit = p.get('limit');
    if (limit !== null && !/^[1-9][0-9]{0,2}$/.test(limit)) throw new ArchiveError('INVALID_INPUT', 'Invalid page limit');
    if ((p.has('semanticRatio') && !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(p.get('semanticRatio')!)) || (p.has('rrfK') && !/^[1-9][0-9]{0,3}$/.test(p.get('rrfK')!))) throw new ArchiveError('INVALID_INPUT', 'Invalid hybrid parameters');
    const mode = p.get('mode') ?? 'text';
    if (mode !== 'text' && mode !== 'browse' && mode !== 'semantic' && mode !== 'hybrid') throw new ArchiveError('INVALID_INPUT', 'Invalid search mode');
    const sort = p.get('sort') ?? (mode === 'browse' ? 'id' : 'relevance');
    if (!isSearchSort(sort)) throw new ArchiveError('INVALID_INPUT', 'Invalid search order');
    const query = input(() => parseSearchQuery({ mode, ...(p.has('semanticRatio') ? { semanticRatio: Number(p.get('semanticRatio')) } : {}), ...(p.has('rrfK') ? { rrfK: Number(p.get('rrfK')) } : {}), text: p.get('text') ?? '', filter: p.get('filter') ?? '', provider: p.get('provider') ?? '', tag: p.get('tag') ?? '', sort }));
    return json(await connected().search({ ...query,
      ...(p.has('snapshot') ? { snapshot: p.get('snapshot') ?? '' } : {}),
      ...(p.has('cursor') ? { cursor: p.get('cursor') ?? '' } : {}),
      ...(limit === null ? {} : { limit: Number(limit) }),
    }, c.req.raw.signal));
  });
  app.get(`${archivePrefix}/manifest`, (c) => {
    const p = params(c.req.url, ['snapshot', 'id'], 'id');
    return json(connected().select(p.get('snapshot') ?? '', p.getAll('id')));
  });
  for (const kind of ['originals', 'assets'] as const) {
    app.get(`${archivePrefix}/${kind}/:hash`, async (c) => {
      const p = params(c.req.url, ['snapshot']);
      const result = await connected().object(kind, p.get('snapshot') ?? '', c.req.param('hash'));
      return new Response(result.bytes, { headers: {
        'content-type': result.object.mediaType, 'content-length': String(result.bytes.length),
        'content-disposition': 'attachment', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
        'x-archive-snapshot': result.snapshot, 'x-archive-id': result.archiveId, etag: `"${result.object.hash}"`,
      } });
    });
  }
  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404));
  return app;
}
