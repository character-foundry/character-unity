import { sha256 } from '@noble/hashes/sha2.js';
import {
  ArchiveError, archivePrefix, array, hash, identifier, input, integer, isIndexSearchSort, limits, parseCard, parseCards,
  parseObject, parseQuery, parseSearchQuery, parseSnapshot, record, string,
} from './contract.js';
import type { ArchiveErrorCode, ArchiveStatus, CardPage, CardResult, ListRequest, OriginalObject, SelectionManifest, Snapshot, SearchRequest, SearchPage, SearchFilterField } from './contract.js';
export type * from './contract.js';
export type * from './native.js';
export { ArchiveError } from './contract.js';

/** Fully receive and verify before exposing original bytes to callers. Never follows redirects. */
export function createArchiveClient(baseUrl: string, options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new ArchiveError('INVALID_INPUT', 'Archive URL must be an HTTP(S) origin without credentials');
  }
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new ArchiveError('INVALID_INPUT', 'Invalid Archive request timeout');
  async function request(path: string, params: URLSearchParams, signal?: AbortSignal) {
    const url = new URL(`${archivePrefix}${path}`, base);
    url.search = params.toString();
    const init: RequestInit & { credentials: 'omit' } = {
      // workerd supports manual/follow but rejects redirect:error. A manual
      // redirect (or browser opaque redirect) fails the !ok check below; no
      // redirected destination receives a request on any host.
      method: 'GET', redirect: 'manual', credentials: 'omit',
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    };
    const response = await send(url, init);
    if (!response.ok) {
      await response.body?.cancel();
      const codes: Partial<Record<number, ArchiveErrorCode>> = { 400: 'INVALID_INPUT', 404: 'NOT_FOUND', 409: 'SNAPSHOT_CHANGED', 413: 'TOO_LARGE', 503: 'UNAVAILABLE' };
      const code = codes[response.status];
      throw new ArchiveError(code ?? 'PROTOCOL', `Archive read failed (${response.status})`, response.status);
    }
    return response;
  }
  async function read(response: Response, max: number): Promise<Uint8Array<ArrayBuffer>> {
    if (!response.body) throw new ArchiveError('PROTOCOL', 'Archive response has no body');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > max) throw new ArchiveError('TOO_LARGE', 'Archive response exceeds its byte limit');
        chunks.push(new Uint8Array(next.value));
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return bytes;
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  async function json(path: string, params: URLSearchParams, expected?: Snapshot, signal?: AbortSignal) {
    const response = await request(path, params, signal);
    if (response.headers.get('content-type')?.split(';')[0] !== 'application/json') {
      await response.body?.cancel();
      throw new ArchiveError('PROTOCOL', 'Archive response must be JSON');
    }
    const bytes = await read(response, limits.jsonBytes);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
    catch { throw new ArchiveError('PROTOCOL', 'Invalid Archive JSON'); }
    const data = record(value);
    const snapshot = parseSnapshot(data);
    if (expected && (snapshot.archiveId !== expected.archiveId || snapshot.snapshot !== expected.snapshot)) {
      throw new ArchiveError('SNAPSHOT_CHANGED', 'Archive snapshot changed');
    }
    return { data, snapshot };
  }
  function snapshotParams(snapshot: Snapshot) {
    return new URLSearchParams({ snapshot: input(() => parseSnapshot(snapshot)).snapshot });
  }
  async function download(kind: 'originals' | 'assets', snapshot: Snapshot, object: OriginalObject, signal?: AbortSignal) {
    const expected = input(() => parseObject(object));
    const response = await request(`/${kind}/${expected.hash}`, snapshotParams(snapshot), signal);
    if (response.headers.get('x-archive-snapshot') !== snapshot.snapshot || response.headers.get('x-archive-id') !== snapshot.archiveId) {
      await response.body?.cancel();
      throw new ArchiveError('SNAPSHOT_CHANGED', 'Archive object belongs to a different snapshot');
    }
    const bytes = await read(response, expected.byteLength);
    const digest = Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (bytes.length !== expected.byteLength || digest !== expected.hash) throw new ArchiveError('INTEGRITY', 'Archive bytes do not match their manifest');
    return bytes;
  }
  return {
    async status(signal?: AbortSignal): Promise<ArchiveStatus> {
      const { data, snapshot } = await json('/status', new URLSearchParams(), undefined, signal);
      if (data.mode !== 'fixture' && data.mode !== 'copy') throw new ArchiveError('PROTOCOL', 'Unsupported Archive source mode');
      if (data.search !== undefined && data.search !== 'lance-fts-v1') throw new ArchiveError('PROTOCOL', 'Unsupported Archive search capability');
      const filterFields = data.filterFields === undefined ? undefined : array<SearchFilterField>(data.filterFields, 64, (item) => {
        const field = record(item), name = identifier(field.name), type = field.type;
        if (type !== 'string' && type !== 'strings' && type !== 'number' && type !== 'boolean') throw new ArchiveError('PROTOCOL', 'Invalid filter field type');
        return { name, type };
      });
      if (filterFields && (data.search !== 'lance-fts-v1' || new Set(filterFields.map((field) => field.name)).size !== filterFields.length)) throw new ArchiveError('PROTOCOL', 'Invalid filter capability');
      if (data.browse !== undefined && (data.browse !== 'lance-filter-v1' || data.search !== 'lance-fts-v1')) throw new ArchiveError('PROTOCOL', 'Unsupported Archive browse capability');
      const sorts = data.sorts === undefined ? undefined : array(data.sorts, 22, (value) => {
        if (!isIndexSearchSort(value)) throw new ArchiveError('PROTOCOL', 'Unsupported Archive sort'); return value;
      });
      if (sorts && (data.search !== 'lance-fts-v1' || new Set(sorts).size !== sorts.length)) throw new ArchiveError('PROTOCOL', 'Invalid Archive sort capability');
      let semantic: ArchiveStatus['semantic'];
      if (data.semantic !== undefined) {
        const capability = record(data.semantic), dimensions = integer(capability.dimensions, 4096), model = string(capability.model, 256);
        if (data.search !== 'lance-fts-v1' || capability.version !== 'lance-cosine-v1' || !dimensions || !model.trim()) throw new ArchiveError('PROTOCOL', 'Invalid semantic capability');
        const indexedCards = integer(capability.indexedCards, 10000), indexedRows = integer(capability.indexedRows, 40000);
        if (!indexedCards || indexedCards > indexedRows || indexedCards > integer(data.cardCount, 10000) || indexedRows * dimensions > 4000000) throw new ArchiveError('PROTOCOL', 'Invalid vector coverage');
        semantic = { version: 'lance-cosine-v1', model, dimensions, indexedCards, indexedRows };
      }
      return { ...snapshot, ...(semantic ? { semantic } : {}), ...(data.browse === 'lance-filter-v1' ? { browse: data.browse } : {}), ...(sorts ? { sorts } : {}), ...(filterFields ? { filterFields } : {}), mode: data.mode, cardCount: integer(data.cardCount, Number.MAX_SAFE_INTEGER), ...(data.search === 'lance-fts-v1' ? { search: data.search } : {}) };
    },
    async search(query: SearchRequest, signal?: AbortSignal): Promise<SearchPage> {
      const params = new URLSearchParams(Object.entries(input(() => parseSearchQuery(query))).map(([key, value]) => [key, String(value)]));
      if (params.get('mode') !== 'hybrid') { params.delete('semanticRatio'); params.delete('rrfK'); }
      if (params.get('mode') === 'text') params.delete('mode');
      if (!params.get('filter')) params.delete('filter');
      if (query.snapshot !== undefined) params.set('snapshot', input(() => hash(query.snapshot)));
      if (query.cursor !== undefined) params.set('cursor', input(() => string(query.cursor, 2048)));
      const limit = input(() => integer(query.limit ?? 50, limits.page));
      if (!limit || (query.cursor !== undefined && query.snapshot === undefined)) throw new ArchiveError('INVALID_INPUT', 'Search needs a positive page limit and snapshot with a cursor');
      params.set('limit', String(limit));
      const { data, snapshot } = await json('/search', params, undefined, signal);
      if (query.snapshot !== undefined && query.snapshot !== snapshot.snapshot) throw new ArchiveError('SNAPSHOT_CHANGED', 'Archive snapshot changed');
      const cards = parseCards(data.cards), total = integer(data.total, 10000);
      if (cards.length > limit || cards.length > total || !Array.isArray(data.scores) || data.scores.length !== cards.length
        || data.scores.some((score) => typeof score !== 'number' || !Number.isFinite(score) || score < 0)) throw new ArchiveError('PROTOCOL', 'Invalid Archive search results');
      const semantic = query.mode === 'semantic' || query.mode === 'hybrid';
      let matches: SearchPage['matches'];
      if (semantic) {
        matches = array(data.matches, limits.page, (item) => {
          if (item === null) return null; const match = record(item);
          if (typeof match.text !== 'string' || match.text.length > 8192 || typeof match.score !== 'number' || !Number.isFinite(match.score) || match.score <= 0 || match.score > 1) throw new ArchiveError('PROTOCOL', 'Invalid semantic match');
          return { section: string(match.section, 128), text: match.text, score: match.score };
        });
        if (matches.length !== cards.length) throw new ArchiveError('PROTOCOL', 'Semantic matches do not align with cards');
      } else if (data.matches !== undefined) throw new ArchiveError('PROTOCOL', 'Unexpected semantic matches');
      return { ...snapshot, cards, total, scores: data.scores, ...(matches ? { matches } : {}),
        nextCursor: data.nextCursor === null ? null : string(data.nextCursor, 2048) };
    },
    async list(query: ListRequest = {}, signal?: AbortSignal): Promise<CardPage> {
      const params = new URLSearchParams(input(() => parseQuery(query)));
      if (query.snapshot !== undefined) params.set('snapshot', input(() => hash(query.snapshot)));
      if (query.cursor !== undefined) params.set('cursor', input(() => string(query.cursor, 2048)));
      if (query.limit !== undefined) {
        const limit = input(() => integer(query.limit, limits.page));
        if (!limit) throw new ArchiveError('INVALID_INPUT', 'Page limit must be positive');
        params.set('limit', String(limit));
      }
      const { data, snapshot } = await json('/cards', params, undefined, signal);
      if (query.snapshot !== undefined && query.snapshot !== snapshot.snapshot) throw new ArchiveError('SNAPSHOT_CHANGED', 'Archive snapshot changed');
      const cards = parseCards(data.cards);
      if (cards.length > (query.limit ?? 50)) throw new ArchiveError('PROTOCOL', 'Archive exceeded the requested page limit');
      return { ...snapshot, cards, nextCursor: data.nextCursor === null ? null : string(data.nextCursor, 2048) };
    },
    async card(snapshot: Snapshot, id: string, signal?: AbortSignal): Promise<CardResult> {
      input(() => identifier(id));
      const result = await json(`/cards/${id}`, snapshotParams(snapshot), snapshot, signal);
      const card = parseCard(result.data.card);
      if (card.id !== id) throw new ArchiveError('PROTOCOL', 'Archive returned a different card');
      return { ...result.snapshot, card };
    },
    async select(snapshot: Snapshot, ids: readonly string[], signal?: AbortSignal): Promise<SelectionManifest> {
      if (!ids.length || ids.length > limits.selection || new Set(ids).size !== ids.length) throw new ArchiveError('INVALID_INPUT', 'Select 1–100 unique Archive cards');
      const params = snapshotParams(snapshot);
      for (const id of ids) params.append('id', input(() => identifier(id)));
      const result = await json('/manifest', params, snapshot, signal);
      const cards = parseCards(result.data.cards);
      if (cards.length !== ids.length || cards.some((card) => !ids.includes(card.id))) throw new ArchiveError('PROTOCOL', 'Archive manifest does not match the selection');
      return { ...result.snapshot, cards };
    },
    original: (snapshot: Snapshot, object: OriginalObject, signal?: AbortSignal) => download('originals', snapshot, object, signal),
    asset: (snapshot: Snapshot, object: OriginalObject, signal?: AbortSignal) => download('assets', snapshot, object, signal),
  };
}
