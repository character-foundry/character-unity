import { createHash } from 'node:crypto';
import { ArchiveError, archiveVersion, hash, identifier, input, integer, isIndexSearchSort, limits, parseCard, parseQuery, parseSearchQuery, string } from '@character-unity/archive-client/contract';
import type { ArchiveCard, ArchiveQuery, ArchiveStatus, ListRequest, OriginalObject, Snapshot, SearchRequest, SearchFilterField, IndexSearchSort, SearchSort, ParsedSearchQuery, SemanticCapability, SearchMatch } from '@character-unity/archive-client';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export interface ArchiveObject extends Snapshot { bytes: Uint8Array<ArrayBuffer>; object: OriginalObject }
export function createArchiveIndex<T extends ArchiveObject | Promise<ArchiveObject>>(archiveId: string, inputCards: readonly ArchiveCard[], mode: ArchiveStatus['mode'],
  readObject: (kind: 'originals' | 'assets', hash: string, snapshot: Snapshot) => T, sourceFingerprint?: string,
  searchBackend?: { filterFields?: SearchFilterField[]; sorts?: IndexSearchSort[]; browse?: 'lance-filter-v1'; semantic?: SemanticCapability; semanticSearch?(query: ParsedSearchQuery, cards: { id: string; title: string }[], signal?: AbortSignal): Promise<{ scores: Map<string, number>; matches: Map<string, SearchMatch> }>; search(text: string, filter?: string, sort?: SearchSort, mode?: 'text' | 'browse'): Promise<Map<string, number>> }) {
  input(() => identifier(archiveId));
  const cards = inputCards.map((card) => input(() => parseCard(structuredClone(card)))).sort((a, b) => compare(a.id, b.id));
  const byId = new Map(cards.map((card) => [card.id, card]));
  if (byId.size !== cards.length) throw new ArchiveError('INVALID_INPUT', 'Duplicate Archive card IDs');
  const snapshot = digest(JSON.stringify({ version: archiveVersion, archiveId, cards, ...(sourceFingerprint ? { sourceFingerprint } : {}) }));
  const envelope = { version: archiveVersion, archiveId, snapshot };
  function checkSnapshot(expected: string) {
    input(() => hash(expected));
    if (expected !== snapshot) throw new ArchiveError('SNAPSHOT_CHANGED', 'Archive snapshot is no longer available');
  }
  function getCard(id: string) {
    input(() => identifier(id));
    const card = byId.get(id);
    if (!card) throw new ArchiveError('NOT_FOUND', 'Archive card not found');
    return structuredClone(card);
  }
  function matching(query: Required<ArchiveQuery>) {
    const search = query.q.toLowerCase();
    return cards.filter((card) => (!query.provider || card.source.provider === query.provider)
      && (!query.tag || card.tags.includes(query.tag))
      && (!search || [card.title, card.source.recordId, ...card.tags].some((value) => value.toLowerCase().includes(search))));
  }
  return {
    status: () => ({ ...envelope, mode, cardCount: cards.length, ...(searchBackend ? { search: 'lance-fts-v1' as const, ...(searchBackend.semantic ? { semantic: { ...searchBackend.semantic } } : {}), ...(searchBackend.browse ? { browse: searchBackend.browse } : {}), ...(searchBackend.sorts ? { sorts: [...searchBackend.sorts] } : {}), ...(searchBackend.filterFields ? { filterFields: structuredClone(searchBackend.filterFields) } : {}) } : {}) }),
    async search(request: SearchRequest, signal?: AbortSignal) {
      if (!searchBackend) throw new ArchiveError('UNAVAILABLE', 'This Archive copy has no lexical search index');
      // Capture all inputs before awaiting the native query.
      const query = input(() => parseSearchQuery(request)), expected = request.snapshot, cursor = request.cursor;
      const limit = input(() => integer(request.limit ?? 50, limits.page));
      if (!limit) throw new ArchiveError('INVALID_INPUT', 'Page limit must be positive');
      if (expected !== undefined) checkSnapshot(expected);
      const queryHash = digest(JSON.stringify({ kind: 'search', ...query }));
      const semantic = query.mode === 'semantic' || query.mode === 'hybrid';
      let resultDigest: string | undefined, offset = 0;
      if (cursor !== undefined) {
        if (!expected) throw new ArchiveError('INVALID_INPUT', 'A cursor requires its snapshot');
        offset = input(() => {
          const value = string(cursor, 2048);
          if (!value || /[^A-Za-z0-9_-]/.test(value)) throw new Error('Invalid cursor');
          const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
          if (!Array.isArray(decoded) || decoded.length !== (semantic ? 4 : 3) || decoded[0] !== snapshot || decoded[1] !== queryHash) throw new Error('Cursor does not match search');
          if (semantic) resultDigest = hash(decoded[3]);
          return integer(decoded[2], cards.length);
        });
      }
      if (query.filter && !searchBackend.filterFields) throw new ArchiveError('INVALID_INPUT', 'This search source does not support advanced filters');
      if (query.mode === 'browse' && !searchBackend.browse) throw new ArchiveError('INVALID_INPUT', 'This source does not support indexed browsing');
      const indexedSort = isIndexSearchSort(query.sort);
      if (indexedSort && !searchBackend.sorts?.includes(query.sort as IndexSearchSort)) throw new ArchiveError('INVALID_INPUT', 'This copy does not support that sort');
      const eligible = matching({ q: '', provider: query.provider, tag: query.tag });
      if (semantic && (!searchBackend.semantic || !searchBackend.semanticSearch)) throw new ArchiveError('UNAVAILABLE', 'Semantic search is not configured');
      const result = semantic ? await searchBackend.semanticSearch!(query, eligible, signal) : null;
      const scores = result ? result.scores : await searchBackend.search(query.text, query.filter, query.sort, query.mode === 'browse' ? 'browse' : 'text');
      signal?.throwIfAborted();
      const rank = new Map([...scores.keys()].map((id, index) => [id, index]));
      const found = eligible.filter((card) => scores.has(card.id));
      found.sort((a, b) => (indexedSort || (semantic && query.sort === 'relevance') ? rank.get(a.id)! - rank.get(b.id)! : query.sort === 'relevance' ? scores.get(b.id)! - scores.get(a.id)!
        : query.sort === 'title' ? compare(a.title, b.title) : 0) || compare(a.id, b.id));
      if (offset > found.length) throw new ArchiveError('INVALID_INPUT', 'Search cursor exceeds results');
      const rankedDigest = semantic ? digest(JSON.stringify(found.map((card) => [card.id, scores.get(card.id), result?.matches.get(card.id) ?? null]))) : undefined;
      if (resultDigest && resultDigest !== rankedDigest) throw new ArchiveError('SNAPSHOT_CHANGED', 'Semantic results changed; start a new search');
      const page = found.slice(offset, offset + limit), end = offset + limit;
      return { ...envelope, cards: structuredClone(page), total: found.length, scores: page.map((card) => scores.get(card.id)!), ...(result ? { matches: page.map((card) => result.matches.get(card.id) ?? null) } : {}),
        nextCursor: end < found.length ? Buffer.from(JSON.stringify([snapshot, queryHash, end, ...(rankedDigest ? [rankedDigest] : [])])).toString('base64url') : null };
    },
    list(request: ListRequest = {}) {
      if (request.snapshot !== undefined) checkSnapshot(request.snapshot);
      const query = input(() => parseQuery(request));
      const limit = input(() => integer(request.limit ?? 50, limits.page));
      if (!limit) throw new ArchiveError('INVALID_INPUT', 'Page limit must be positive');
      const queryHash = digest(JSON.stringify(query));
      const matches = matching(query);
      let offset = 0;
      if (request.cursor !== undefined) {
        if (!request.snapshot) throw new ArchiveError('INVALID_INPUT', 'A cursor requires its snapshot');
        offset = input(() => {
          const cursor = string(request.cursor, 2048);
          if (!cursor || /[^A-Za-z0-9_-]/.test(cursor)) throw new Error('Invalid cursor');
          const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
          if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== snapshot || decoded[1] !== queryHash) throw new Error('Cursor does not match query');
          return integer(decoded[2], matches.length);
        });
      }
      const end = offset + limit;
      return { ...envelope, cards: structuredClone(matches.slice(offset, end)),
        nextCursor: end < matches.length ? Buffer.from(JSON.stringify([snapshot, queryHash, end])).toString('base64url') : null };
    },
    card(expected: string, id: string) { checkSnapshot(expected); return { ...envelope, card: getCard(id) }; },
    select(expected: string, ids: readonly string[]) {
      checkSnapshot(expected);
      if (!ids.length || ids.length > limits.selection || new Set(ids).size !== ids.length) throw new ArchiveError('INVALID_INPUT', 'Select 1–100 unique Archive cards');
      return { ...envelope, cards: [...ids].sort(compare).map(getCard) };
    },
    object(kind: 'originals' | 'assets', expected: string, objectHash: string) {
      checkSnapshot(expected);
      input(() => hash(objectHash));
      return readObject(kind, objectHash, envelope);
    },
  };
}
export type ArchiveReadSource = ReturnType<typeof createArchiveIndex>;
