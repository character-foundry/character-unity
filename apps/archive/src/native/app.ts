import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { resolveSettings } from '@character-unity/scraper-kit';
import type { ScraperPlugin } from '@character-unity/scraper-kit';
import { NativeArchiveError } from './store.js';
import type { NativeArchive } from './store.js';
import { ArchiveError } from '@character-unity/archive-client/contract';
import { RunConflictError } from './scheduler.js';
import type { Scheduler } from './scheduler.js';
import { isArchiveFlag, isArchiveSort } from './query.js';
import type { ArchiveFlag, ArchiveQuery } from './query.js';
import { validateIdentityQuery } from '@character-unity/archive-client/native';
import { bodyLimit } from 'hono/body-limit';
import type { LibraryIndex } from '../library-index.js';
import { normalizeTagGroupFilters } from '@character-unity/store/library-query';

export const nativeReadPrefix = '/api/archive/v2';
export const nativeAdminPrefix = '/api/archive/admin/v1';

/** Public browser reads are opt-in exact origins, never patterns or credentials. */
export function validateReadOrigins(values: readonly string[]): string[] {
  return [...new Set(values.map(value => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== value) {
      throw new Error('Archive read origins must be exact HTTP(S) origins without credentials');
    }
    return value;
  }))];
}

class RequestError extends Error {
  constructor(public readonly status: 400 | 401 | 404 | 409 | 503, public readonly code: string, message: string) { super(message); }
}
function invalid(message: string): never { throw new RequestError(400, 'INVALID_INPUT', message); }
const list = (value: string | null) => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);

/** Both storage layouts expose the same read and administration interface. */
export type ArchiveBackend = Pick<NativeArchive, 'card' | 'identity' | 'object' | 'source' | 'saveSource' | 'lastFinishedRun' | 'runs' | 'block'> & {
  list(query?: ArchiveQuery): ReturnType<NativeArchive['list']> | Promise<ReturnType<NativeArchive['list']>>;
  files(id: string, versionId?: string): ReturnType<NativeArchive['files']> | Promise<ReturnType<NativeArchive['files']>>;
  tags(): ReturnType<NativeArchive['tags']>;
  status(): ReturnType<NativeArchive['status']>;
};

/** Parses the card query the read API accepts (the same names the web app uses). */
export function readQuery(url: string): ArchiveQuery {
  const params = new URL(url).searchParams;
  const allowed = ['q', 'mode', 'filter', 'snapshot', 'tags', 'match', 'exclude', 'tagGroups', 'excludeTagGroups', 'has', 'provider', 'minTokens', 'creators', 'sort', 'offset', 'limit'];
  if (url.length > 20_000 || [...params.keys()].some((key) => !allowed.includes(key) || params.getAll(key).length !== 1)) invalid('Invalid Archive query');
  const has = list(params.get('has'));
  if (has.some((flag) => !isArchiveFlag(flag))) invalid('Unknown Archive flag');
  const sort = params.get('sort') ?? 'updated';
  if (!isArchiveSort(sort)) invalid('Unknown Archive sort');
  const number = (key: string, max: number) => {
    const value = params.get(key);
    if (value === null) return undefined;
    if (!/^(0|[1-9][0-9]{0,8})$/.test(value) || Number(value) > max) invalid(`Invalid ${key}`);
    return Number(value);
  };
  const provider = params.get('provider') ?? '';
  const q = params.get('q') ?? '';
  if (q.length > 2000) invalid('Archive query text exceeds 2000 characters');
  const mode = params.get('mode');
  if (mode !== null && !['browse', 'lexical', 'semantic', 'hybrid'].includes(mode)) invalid('Unknown Archive search mode');
  if (mode && mode !== 'browse' && !params.get('q')?.trim()) invalid('A search mode requires a query');
  if (mode === 'browse' && params.get('q')?.trim()) invalid('Browse mode does not accept query text');
  const filter = params.get('filter') ?? '';
  if (filter.length > 4096 || [...filter].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) invalid('Invalid Archive filter');
  const snapshot = params.get('snapshot');
  if (snapshot !== null && !/^[a-f0-9]{64}$/.test(snapshot)) invalid('Invalid Archive snapshot');
  if (provider && !/^[a-z0-9-]{1,32}$/.test(provider)) invalid('Invalid provider');
  let groups: ReturnType<typeof normalizeTagGroupFilters>;
  try { groups = normalizeTagGroupFilters({
    ...(params.has('tagGroups') ? { tagGroups: JSON.parse(params.get('tagGroups')!) } : {}),
    ...(params.has('excludeTagGroups') ? { excludeTagGroups: JSON.parse(params.get('excludeTagGroups')!) } : {}),
  }); } catch (error) { invalid(error instanceof Error ? error.message : 'Invalid tag groups'); }
  const query: ArchiveQuery = { q, tags: list(params.get('tags')), tagMode: params.get('match') === 'any' ? 'any' : 'all', ...groups,
    exclude: list(params.get('exclude')), has: has as ArchiveFlag[], creators: list(params.get('creators')).slice(0, 500) };
  if (params.has('sort')) query.sort = sort;
  if (provider) query.provider = provider;
  if (mode) query.mode = mode as NonNullable<ArchiveQuery['mode']>;
  if (filter) query.filter = filter;
  if (snapshot) query.snapshot = snapshot;
  const minTokens = number('minTokens', 10_000_000), offset = number('offset', 10_000_000), limit = number('limit', 100);
  if (offset && !snapshot) invalid('Offset paging requires the first page snapshot');
  if (minTokens) query.minTokens = minTokens;
  if (offset !== undefined) query.offset = offset;
  if (limit !== undefined) query.limit = limit || 1;
  return query;
}

function sameToken(given: string, expected: string) {
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The native Archive's HTTP surface. Reads are open to the local app; the admin routes (source settings,
 * credentials, runs, blocking) need the admin token and exist so the app's Settings page can drive scraping.
 */
export function createNativeArchiveApp(archive: ArchiveBackend, scheduler: Scheduler, plugins: readonly ScraperPlugin[], options: { adminToken?: string; libraryIndex?: LibraryIndex; readOrigins?: readonly string[] } = {}) {
  const origins = new Set(validateReadOrigins(options.readOrigins ?? []));
  const app = new Hono();
  app.get('/api/health', (c) => c.json({ service: 'unity-archive', status: 'ok', stage: 'native' }));
  app.onError((error, c) => {
    if (error instanceof RequestError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
    if (error instanceof NativeArchiveError) return c.json({ error: { code: error.code, message: error.message } }, error.code === 'NOT_FOUND' ? 404 : error.code === 'SNAPSHOT_CHANGED' ? 409 : 400);
    if (error instanceof ArchiveError) return c.json({ error: { code: error.code, message: error.message } },
      error.code === 'NOT_FOUND' ? 404 : error.code === 'INVALID_INPUT' ? 400 : error.code === 'SNAPSHOT_CHANGED' ? 409 : error.code === 'TOO_LARGE' ? 413 : 503);
    if (error instanceof RunConflictError) return c.json({ error: { code: 'RUNNING', message: error.message, runId: error.runId } }, 409);
    console.log(JSON.stringify({ event: 'archive-request-failed', message: error instanceof Error ? error.message : String(error) }));
    return c.json({ error: { code: 'UNAVAILABLE', message: 'The Archive could not answer' } }, 503);
  });

  app.use(`${nativeReadPrefix}/*`, async (c, next) => {
    await next();
    const vary = c.res.headers.get('vary')?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
    if (!vary.some(value => value.toLowerCase() === 'origin')) vary.push('Origin');
    c.header('vary', vary.join(', '));
    const origin = c.req.header('origin');
    // Public readers use simple GETs with credentials:'omit'. In particular,
    // never expose trusted-proxy workspace searches or token-bearing requests.
    const publicPath = /^\/api\/archive\/v2\/(?:status|identity|tags|cards(?:\/[^/]+(?:\/files)?)?|objects\/[^/]+)$/.test(c.req.path);
    if (origin && origins.has(origin) && publicPath && ['GET', 'HEAD'].includes(c.req.method) &&
        ['authorization', 'cookie', 'x-unity-library-workspace'].every(header => c.req.header(header) === undefined)) {
      c.header('access-control-allow-origin', origin);
    }
    // No credentials, write methods, admin routes or preflight grants.
  });

  // ---- Read ----
  const plugin = (provider: string) => plugins.find((item) => item.provider === provider) ?? (() => { throw new RequestError(404, 'NOT_FOUND', 'Unknown source'); })();
  const sourceStatus = (source: ScraperPlugin) => {
    const record = archive.source(source.provider);
    return { provider: source.provider, label: source.label, enabled: record.enabled, running: scheduler.running(source.provider), lastRun: archive.lastFinishedRun(source.provider) };
  };
  app.get(`${nativeReadPrefix}/status`, (c) => c.json({ ...archive.status(), sources: plugins.map(sourceStatus) }));
  app.get(`${nativeReadPrefix}/cards`, async (c) => {
    const workspaceId = c.req.header('x-unity-library-workspace');
    if (workspaceId !== undefined) {
      const given = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      if (!options.adminToken || !sameToken(given, options.adminToken)) throw new RequestError(401, 'UNAUTHORIZED', 'Library search scope requires the trusted Unity proxy');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) invalid('Invalid library search workspace');
    }
    return c.json(await archive.list({ ...readQuery(c.req.url), signal: c.req.raw.signal, ...(workspaceId ? { libraryWorkspaceId: workspaceId } : {}) }));
  });
  const requestedVersion = (url: string) => {
    const params = new URL(url).searchParams;
    if ([...params.keys()].some((key) => key !== 'version') || params.getAll('version').length > 1) invalid('Invalid Archive version query');
    const version = params.get('version');
    if (version !== null && !/^[A-Za-z0-9:_-]{1,256}$/.test(version)) invalid('Invalid Archive version');
    return version ?? undefined;
  };
  app.get(`${nativeReadPrefix}/cards/:id`, async (c) => c.json(await archive.card(c.req.param('id'), requestedVersion(c.req.url))));
  app.get(`${nativeReadPrefix}/cards/:id/files`, async (c) => c.json({ files: await archive.files(c.req.param('id'), requestedVersion(c.req.url)) }));
  app.get(`${nativeReadPrefix}/identity`, async (c) => {
    const params = new URL(c.req.url).searchParams;
    if (c.req.url.length > 4096 || [...params.keys()].some((key) => !['fileHash', 'contentHash', 'name'].includes(key) || params.getAll(key).length !== 1)) invalid('Invalid Archive identity query');
    let query;
    try { query = validateIdentityQuery({ ...(params.has('fileHash') ? { fileHash: params.get('fileHash')! } : {}),
      ...(params.has('contentHash') ? { contentHash: params.get('contentHash')! } : {}), ...(params.has('name') ? { name: params.get('name')! } : {}) }); }
    catch { invalid('Invalid Archive identity query'); }
    return c.json(await archive.identity(query));
  });
  app.get(`${nativeReadPrefix}/tags`, (c) => c.json({ tags: archive.tags() }));
  app.get(`${nativeReadPrefix}/objects/:hash`, async (c) => {
    const hash = c.req.param('hash');
    if (!/^[a-f0-9]{64}$/.test(hash)) invalid('Invalid object hash');
    const object = await archive.object(hash);
    // Content-addressed: the bytes behind a hash never change.
    return new Response(object.bytes, { headers: { 'content-type': object.mediaType, 'content-length': String(object.bytes.byteLength),
      'cache-control': 'private, max-age=31536000, immutable', etag: `"${hash}"`, 'x-content-type-options': 'nosniff' } });
  });

  // ---- Admin ----
  app.use(`${nativeAdminPrefix}/*`, async (c, next) => {
    if (!options.adminToken) throw new RequestError(503, 'UNAVAILABLE', 'Archive administration is not configured');
    const given = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!sameToken(given, options.adminToken)) throw new RequestError(401, 'UNAUTHORIZED', 'Archive administration needs the admin token');
    await next();
  });
  app.post(`${nativeAdminPrefix}/library-index`, bodyLimit({ maxSize: 2 * 1024 * 1024,
    onError: (c) => c.json({ error: { code: 'TOO_LARGE', message: 'Library index event exceeds 2 MiB' } }, 413) }), async (c) => {
    if (!options.libraryIndex) throw new RequestError(503, 'UNAVAILABLE', 'Library projection indexing is not enabled for this Archive');
    const event: unknown = await c.req.json().catch(() => invalid('Expected a library index event'));
    return c.json(await options.libraryIndex.apply(event, c.req.raw.signal));
  });
  const describe = (source: ScraperPlugin) => {
    const record = archive.source(source.provider);
    return { ...sourceStatus(source), intervalMinutes: record.intervalMinutes, settings: resolveSettings(source, record.settings),
      settingSpecs: source.settings, secretSpecs: source.secrets,
      // Secrets never leave the Archive; the app only learns which ones are set.
      secretsSet: Object.keys(record.secrets).filter((key) => record.secrets[key]) };
  };
  app.get(`${nativeAdminPrefix}/sources`, (c) => c.json({ sources: plugins.map(describe) }));
  app.put(`${nativeAdminPrefix}/sources/:provider`, async (c) => {
    const source = plugin(c.req.param('provider'));
    const body = await c.req.json().catch(() => invalid('Expected JSON')) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Object.keys(body).some((key) => !['enabled', 'intervalMinutes', 'settings', 'secrets'].includes(key))) invalid('Unknown source field');
    const current = archive.source(source.provider);
    const interval = body.intervalMinutes ?? current.intervalMinutes;
    if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 15 || interval > 10_080) invalid('The interval must be 15 minutes to 7 days');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') invalid('enabled must be true or false');
    const settings = body.settings === undefined ? current.settings : body.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) invalid('settings must be an object');
    const secrets = { ...current.secrets };
    if (body.secrets !== undefined) {
      if (!body.secrets || typeof body.secrets !== 'object' || Array.isArray(body.secrets)) invalid('secrets must be an object');
      for (const [key, value] of Object.entries(body.secrets as Record<string, unknown>)) {
        if (!source.secrets.some((spec) => spec.key === key)) invalid(`Unknown secret ${key}`);
        if (value === null || value === '') delete secrets[key];
        else if (typeof value === 'string' && value.length <= 4096) secrets[key] = value.trim();
        else invalid(`Invalid secret ${key}`);
      }
    }
    archive.saveSource({ provider: source.provider, enabled: body.enabled === undefined ? current.enabled : body.enabled as boolean,
      intervalMinutes: interval, settings: resolveSettings(source, settings as Record<string, unknown>), secrets });
    scheduler.reschedule();
    return c.json(describe(source));
  });
  app.post(`${nativeAdminPrefix}/sources/:provider/runs`, (c) => {
    const source = plugin(c.req.param('provider'));
    return c.json({ runId: scheduler.start(source.provider, 'manual') }, 202);
  });
  app.get(`${nativeAdminPrefix}/runs`, (c) => {
    const params = new URL(c.req.url).searchParams;
    const provider = params.get('provider') ?? undefined;
    const limit = Math.min(Math.max(Number(params.get('limit') ?? 20) || 20, 1), 100);
    return c.json({ runs: archive.runs(provider, limit) });
  });
  app.post(`${nativeAdminPrefix}/runs/:id/cancel`, (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || !scheduler.cancel(id)) throw new RequestError(404, 'NOT_FOUND', 'That run is not running');
    return c.json({ cancelled: true });
  });
  app.post(`${nativeAdminPrefix}/cards/:id/block`, async (c) => {
    const card = await archive.card(c.req.param('id'));
    const body = await c.req.json().catch(() => ({})) as { reason?: unknown };
    archive.block(card.provider, card.recordId, typeof body.reason === 'string' ? body.reason : undefined);
    return c.json({ blocked: true });
  });

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404));
  return app;
}
