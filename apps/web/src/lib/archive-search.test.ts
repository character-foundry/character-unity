import { describe, expect, it } from 'vitest';
import { archiveMode, archiveSearchParams, modeAvailable } from './archive-search';
import type { ArchiveStatus } from './archive-search';
import { emptySearch, readSearch, writeSearch } from './library-search';
import { archivePageOffset, mergeArchivePage, validateArchivePage } from './archive';
import type { ArchiveCard } from './archive';

const hidden = { tags: ['blocked'], hideNsfw: true };
const status: ArchiveStatus = { archiveId: 'existing', cards: 146000, providers: { chub: 146000 }, capabilities: {
  lexical: true, semantic: true, browse: true, sorts: ['updated', 'name', 'tokens_desc'], browseSorts: ['updated', 'tokens_desc'], has: ['lorebook', 'greetings'],
  filterFields: [{ name: 'tokenCount', type: 'number' }, { name: 'hasLorebook', type: 'boolean' }],
  embedding: { model: 'existing-model', dimensions: 1024, indexedCards: 140000, indexedRows: 300000 },
} };
const card = (id: string): ArchiveCard => ({ id, provider: 'chub', recordId: id, url: '', name: id, creator: '', tagline: '', tags: [], spec: 'v3', tokens: 1,
  altGreetings: 0, lorebookEntries: 0, flags: { gallery: false, expressions: false, embeddedImages: false, systemPrompt: false, exampleDialogues: false },
  stats: {}, portrait: null, remoteCreatedAt: null, remoteUpdatedAt: null, firstSeenAt: '', changedAt: '', versionId: '1', versions: 1, libraryCardId: null });

describe('native Archive submitted search contract', () => {
  it('retains mode, typed filter and unavailable ordering through header/URL round trips', () => {
    const search = { ...emptySearch, q: 'forest', archiveMode: 'hybrid', archiveFilter: 'tokenCount >= 1200', sort: 'withdrawn-sort' };
    const url = writeSearch(search);
    const changedByHeader = writeSearch({ ...readSearch(url), q: 'new query' });
    expect(readSearch(changedByHeader)).toEqual({ ...search, q: 'new query' });
    expect(archiveMode(readSearch(new URLSearchParams()))).toBe('lexical');
  });

  it('preserves literal/Boolean query text and metadata constraints without library field translation', () => {
    const params = archiveSearchParams({ ...emptySearch, q: '"silver forest" AND NOT spaceship', tags: ['Fantasy', 'Adventure'], exclude: ['gore'],
      source: 'chub', has: ['lorebook'], minTokens: '1200', sort: 'tokens_desc', archiveFilter: 'hasLorebook = true' }, hidden, status);
    expect(Object.fromEntries(params)).toEqual({ q: '"silver forest" AND NOT spaceship', mode: 'lexical', tags: 'Fantasy,Adventure',
      exclude: 'gore,blocked,nsfw', provider: 'chub', has: 'lorebook', minTokens: '1200', sort: 'tokens_desc', filter: 'hasLorebook = true' });
  });

  it.each(['semantic', 'hybrid'])('keeps %s relevance ordering by omitting the metadata default', (archiveMode) => {
    const params = archiveSearchParams({ ...emptySearch, q: 'a forest guardian who dislikes crowds', archiveMode }, hidden, status);
    expect(params.get('mode')).toBe(archiveMode);
    expect(params.has('sort')).toBe(false);
    expect(params.get('q')).toBe('a forest guardian who dislikes crowds');
  });

  it('supports explicit index-only browsing with typed filters and no query', () => {
    const params = archiveSearchParams({ ...emptySearch, archiveMode: 'browse', archiveFilter: 'tokenCount 1000 TO 2000' }, hidden, status);
    expect(params.get('mode')).toBe('browse'); expect(params.has('q')).toBe(false);
    expect(params.get('filter')).toBe('tokenCount 1000 TO 2000');
    expect(params.get('sort')).toBe('updated');
  });

  it('uses only advertised indexed browse orders, including a schema without recently-updated order', () => {
    const constrained = { ...status, capabilities: { ...status.capabilities!, browseSorts: ['tokens_desc'] } };
    const params = archiveSearchParams({ ...emptySearch, archiveMode: 'browse' }, hidden, constrained);
    expect(params.get('sort')).toBe('tokens_desc');
    expect(() => archiveSearchParams({ ...emptySearch, archiveMode: 'browse', sort: 'name' }, hidden, constrained)).toThrow('order “name” is unavailable');
  });

  it('keeps empty metadata browsing usable with no search capabilities', () => {
    const params = archiveSearchParams(emptySearch, { tags: [], hideNsfw: false }, { archiveId: 'no-index', cards: 10, providers: {} });
    expect(params.toString()).toBe('');
  });

  it.each([
    [{ archiveMode: 'semantic', q: 'forest' }, { ...status, capabilities: { ...status.capabilities!, semantic: false } }, 'Semantic is unavailable'],
    [{ archiveMode: 'hybrid', q: 'forest' }, { ...status, capabilities: { ...status.capabilities!, semantic: false } }, 'Hybrid is unavailable'],
    [{ archiveMode: 'browse' }, { ...status, capabilities: { ...status.capabilities!, browse: false } }, 'Indexed filters only is unavailable'],
    [{ q: 'forest', archiveFilter: 'id = 1' }, { ...status, capabilities: { ...status.capabilities!, filterFields: [] } }, 'Typed Archive filters are unavailable'],
    [{ q: 'forest', sort: 'downloads' }, status, 'order “downloads” is unavailable'],
    [{ has: ['portrait'] }, status, 'does not support the portrait filter'],
    [{ archiveMode: 'typo', q: 'forest' }, status, 'Unknown Archive search mode'],
    [{ archiveMode: 'semantic' }, status, 'need query text'],
    [{ archiveMode: 'browse', q: 'forest' }, status, 'does not search card text'],
    [{ archiveFilter: 'tokenCount > 1' }, status, 'Choose Indexed filters only'],
  ])('rejects unavailable or contradictory queries without falling back', (changes, capabilities, message) => {
    expect(() => archiveSearchParams({ ...emptySearch, ...changes }, hidden, capabilities)).toThrow(message);
  });

  it('advertises only explicit search capabilities', () => {
    expect(modeAvailable('semantic', status.capabilities)).toBe(true);
    expect(modeAvailable('hybrid', undefined)).toBe(false);
    expect(modeAvailable('browse', { ...status.capabilities!, browse: false })).toBe(false);
  });
});

describe('native Archive candidate pagination', () => {
  it('keeps bounded candidate status and aligned matches across pages', () => {
    const first = { cards: [card('1')], total: 3, complete: false, scores: [0.9], matches: [{ section: 'personality', text: 'First match', score: 0.9 }] };
    const next = { cards: [card('2')], total: 3, complete: false, scores: [0.8], matches: [null] };
    const result = mergeArchivePage(first, next);
    expect(result.cards.map((item) => item.id)).toEqual(['1', '2']); expect(result.complete).toBe(false);
    expect(result.matches).toEqual([...first.matches, null]); expect(result.scores).toEqual([0.9, 0.8]);
  });

  it('rejects changed totals, duplicates, empty pages and misaligned excerpts instead of hiding shifts', () => {
    const first = { cards: [card('1')], total: 3, complete: false, matches: [null] };
    expect(() => mergeArchivePage(first, { cards: [card('2')], total: 4, complete: false, matches: [null] })).toThrow('results changed');
    expect(() => mergeArchivePage(first, { cards: [card('1')], total: 3, complete: false, matches: [null] })).toThrow('order changed');
    expect(() => mergeArchivePage(first, { cards: [], total: 3, complete: false, matches: [] })).toThrow('results changed');
    expect(() => mergeArchivePage(first, { cards: [card('2')], total: 3, complete: false })).toThrow('excerpts changed');
    expect(() => mergeArchivePage({ ...first, snapshot: 'a'.repeat(64) }, { cards: [card('2')], total: 3, complete: false, matches: [null], snapshot: 'b'.repeat(64) })).toThrow('snapshot changed');
  });

  it('advances the raw cursor across hidden stale owned hits, including empty visible pages, without skipping or repeating results', () => {
    const first = { cards: [], total: 5, complete: false, nextOffset: 2, staleLibraryHits: 2, snapshot: 'a'.repeat(64), matches: [], scores: [] };
    const second = { ...first, nextOffset: 4 };
    const hidden = mergeArchivePage(first, second);
    expect(hidden.cards).toEqual([]);
    expect(archivePageOffset(hidden)).toBe(4);
    expect(hidden.staleLibraryHits).toBe(4);
    const final = mergeArchivePage(hidden, { cards: [card('last')], total: 5, complete: true, nextOffset: 5, staleLibraryHits: 0,
      snapshot: first.snapshot, matches: [null], scores: [0.8] });
    expect(final.cards.map((item) => item.id)).toEqual(['last']);
    expect(final.matches).toEqual([null]);
    expect(final.scores).toEqual([0.8]);
    expect(final.complete).toBe(false);
    expect(archivePageOffset(final)).toBe(5);
    expect(archivePageOffset(final)).not.toBe(final.cards.length);
    expect(() => mergeArchivePage(hidden, { ...second, nextOffset: 4 })).toThrow('results changed');
    expect(() => mergeArchivePage(hidden, { ...second, nextOffset: 5, snapshot: 'b'.repeat(64) })).toThrow('snapshot changed');
  });

  it('rejects malformed native result envelopes before rendering', () => {
    expect(() => validateArchivePage({ cards: [card('1'), card('1')], total: 3 })).toThrow('invalid result page');
    expect(() => validateArchivePage({ cards: [card('1')], total: 0 })).toThrow('invalid result page');
    expect(() => validateArchivePage({ cards: [card('1')], total: 1, matches: [] })).toThrow('invalid result page');
    expect(() => validateArchivePage({ cards: [card('1')], total: 1, scores: [NaN] })).toThrow('invalid result page');
  });
});
