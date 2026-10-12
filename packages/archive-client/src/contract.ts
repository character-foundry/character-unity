import { isSearchSort } from './search-orders.js';
import type { IndexSearchSort, SearchSort } from './search-orders.js';
export { indexSearchOrders, isIndexSearchSort, isSearchSort } from './search-orders.js';
export type { IndexSearchSort, SearchSort } from './search-orders.js';
/** Internal read contract. This is not the Foundry federation protocol. */
export const archiveVersion = 'unity.archive-read.v1' as const;
export const archivePrefix = '/api/archive/v1';
export const limits = { page: 100, selection: 100, objectBytes: 32 * 1024 * 1024, jsonBytes: 8 * 1024 * 1024 } as const;

export interface OriginalObject {
  algorithm: 'sha256';
  hash: string;
  byteLength: number;
  mediaType: string;
}
/** Explicit relation to the unmodified source card; never inferred from an asset filename. */
export type AssetBinding = { kind: 'portrait' } | { kind: 'uri'; uri: string };
export type ArchiveAsset = ({ id: string; availability: 'available'; object: OriginalObject }
  | { id: string; availability: 'unavailable' }) & { binding?: AssetBinding };
export interface ArchiveCard {
  id: string;
  title: string;
  tags: string[];
  source: { provider: string; recordId: string; url: string | null };
  original: OriginalObject;
  assets: ArchiveAsset[];
}
export interface Snapshot {
  version: typeof archiveVersion;
  archiveId: string;
  snapshot: string;
}
export interface SearchFilterField { name: string; type: 'string' | 'strings' | 'number' | 'boolean' }
export interface SemanticCapability { version: 'lance-cosine-v1'; model: string; dimensions: number; indexedCards: number; indexedRows: number }
export interface SearchMatch { section: string; text: string; score: number }
export interface ArchiveStatus extends Snapshot { mode: 'fixture' | 'copy'; cardCount: number; search?: 'lance-fts-v1'; filterFields?: SearchFilterField[]; browse?: 'lance-filter-v1'; sorts?: IndexSearchSort[]; semantic?: SemanticCapability }
export interface ArchiveQuery { q?: string; provider?: string; tag?: string }
export interface ListRequest extends ArchiveQuery { snapshot?: string; cursor?: string; limit?: number }
export interface CardPage extends Snapshot { cards: ArchiveCard[]; nextCursor: string | null }
export interface SearchQuery { text: string; mode?: 'text' | 'browse' | 'semantic' | 'hybrid'; semanticRatio?: number; rrfK?: number; filter?: string; provider?: string; tag?: string; sort?: SearchSort }
export type ParsedSearchQuery = Required<Omit<SearchQuery, 'semanticRatio' | 'rrfK'>> & Pick<SearchQuery, 'semanticRatio' | 'rrfK'>;
export interface SearchRequest extends SearchQuery { snapshot?: string; cursor?: string; limit?: number }
export interface SearchPage extends CardPage { total: number; scores: number[]; matches?: (SearchMatch | null)[] }
export interface CardResult extends Snapshot { card: ArchiveCard }
export interface SelectionManifest extends Snapshot { cards: ArchiveCard[] }
export type ArchiveErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'SNAPSHOT_CHANGED' | 'UNAVAILABLE' | 'PROTOCOL' | 'INTEGRITY' | 'TOO_LARGE';
export class ArchiveError extends Error {
  constructor(public readonly code: ArchiveErrorCode, message: string, public readonly status?: number) {
    super(message);
    this.name = 'ArchiveError';
  }
}

function fail(): never { throw new ArchiveError('PROTOCOL', 'Invalid Archive read response'); }
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
export function string(value: unknown, max = 512): string {
  if (typeof value !== 'string' || value.length > max || [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) fail();
  return value;
}
export function identifier(value: unknown): string {
  const result = string(value, 128);
  if (!result || /[^a-zA-Z0-9_-]/.test(result)) fail();
  return result;
}
export function hash(value: unknown): string {
  const result = string(value, 64);
  if (result.length !== 64 || /[^a-f0-9]/.test(result)) fail();
  return result;
}
export function integer(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) fail();
  return value;
}
export function array<T>(value: unknown, max: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) fail();
  return value.map(parse);
}
export function parseObject(value: unknown): OriginalObject {
  const data = record(value);
  if (data.algorithm !== 'sha256') fail();
  const mediaType = string(data.mediaType, 128);
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) fail();
  return { algorithm: 'sha256', hash: hash(data.hash), byteLength: integer(data.byteLength, limits.objectBytes), mediaType };
}
export function parseCard(value: unknown): ArchiveCard {
  const data = record(value);
  const source = record(data.source);
  const assets = array(data.assets, 64, (item): ArchiveAsset => {
    const asset = record(item);
    const id = identifier(asset.id);
    let binding: AssetBinding | undefined;
    if (asset.binding !== undefined) {
      const value = record(asset.binding);
      if (value.kind === 'portrait') binding = { kind: 'portrait' };
      else if (value.kind === 'uri' && string(value.uri, 2048)) binding = { kind: 'uri', uri: string(value.uri, 2048) };
      else fail();
    }
    const extra = binding ? { binding } : {};
    if (asset.availability === 'available') return { id, availability: 'available', object: parseObject(asset.object), ...extra };
    if (asset.availability === 'unavailable') return { id, availability: 'unavailable', ...extra };
    return fail();
  });
  if (new Set(assets.map((asset) => asset.id)).size !== assets.length) fail();
  return {
    id: identifier(data.id), title: string(data.title),
    tags: array(data.tags, 64, (tag) => string(tag, 128)),
    source: { provider: identifier(source.provider), recordId: string(source.recordId), url: source.url === null ? null : string(source.url, 2048) },
    original: parseObject(data.original), assets,
  };
}
export function parseSnapshot(value: unknown): Snapshot {
  const data = record(value);
  if (data.version !== archiveVersion) fail();
  return { version: archiveVersion, archiveId: identifier(data.archiveId), snapshot: hash(data.snapshot) };
}
export function parseCards(value: unknown): ArchiveCard[] {
  const cards = array(value, limits.page, parseCard);
  if (new Set(cards.map((card) => card.id)).size !== cards.length) fail();
  return cards;
}

/** Same bounded input rules for server and client; response parsers fail closed. */
export function input<T>(parse: () => T): T {
  try { return parse(); } catch { throw new ArchiveError('INVALID_INPUT', 'Invalid Archive read request'); }
}
export function parseQuery(value: ArchiveQuery): Required<ArchiveQuery> {
  return { q: string(value.q ?? '', 200), provider: value.provider ? identifier(value.provider) : '', tag: string(value.tag ?? '', 128) };
}
export function parseSearchQuery(value: SearchQuery): ParsedSearchQuery {
  const text = string(value.text, 2048).trim(), mode = value.mode ?? 'text', sort = value.sort ?? (mode === 'browse' ? 'id' : 'relevance');
  if (!isSearchSort(sort) || !['text', 'browse', 'semantic', 'hybrid'].includes(mode) || (mode === 'browse' ? !!text || sort === 'relevance' : !text)) fail();
  if (mode !== 'hybrid' && (value.semanticRatio !== undefined || value.rrfK !== undefined)) fail();
  const semanticRatio = value.semanticRatio ?? 0.4, rrfK = value.rrfK ?? 60;
  if (typeof semanticRatio !== 'number' || !Number.isFinite(semanticRatio) || semanticRatio < 0 || semanticRatio > 1 || !Number.isSafeInteger(rrfK) || rrfK < 1 || rrfK > 1000) fail();
  return { text, mode, sort, ...(mode === 'hybrid' ? { semanticRatio, rrfK } : {}), filter: string(value.filter ?? '', 4096).trim(), provider: value.provider ? identifier(value.provider) : '', tag: string(value.tag ?? '', 128) };
}
