import { ArchiveError } from './contract.js';

/** Read-only native Archive contracts. Source identities are never merged by content. */
export const nativeArchiveSorts = ['updated', 'added', 'newest', 'oldest', 'name', 'name_desc', 'tokens_desc', 'tokens_asc',
  'stars', 'favorites', 'chats', 'downloads', 'greetings', 'lorebook'] as const;
export type NativeArchiveSort = typeof nativeArchiveSorts[number];
export const nativeArchiveFlags = ['greetings', 'lorebook', 'gallery', 'embeddedImages', 'expressions', 'portrait', 'systemPrompt', 'exampleDialogues', 'followed'] as const;
export type NativeArchiveFlag = typeof nativeArchiveFlags[number];
export interface NativeArchiveQuery {
  /** Semantic modes require a compatible configured query embedder. */
  mode?: 'browse' | 'lexical' | 'semantic' | 'hybrid';
  /** Library syntax; resolved groups never rewrite this user-authored text. */
  q?: string;
  /** Typed Lance metadata expression, never raw SQL. */
  filter?: string;
  /** Pin subsequent pages to the first page's data/index/query generation. */
  snapshot?: string;
  tags?: readonly string[];
  tagMode?: 'all' | 'any';
  exclude?: readonly string[];
  tagGroups?: readonly (readonly string[])[];
  excludeTagGroups?: readonly (readonly string[])[];
  has?: readonly NativeArchiveFlag[];
  provider?: string;
  minTokens?: number;
  /** Explicit creator follow list for the followed flag. */
  creators?: readonly string[];
  sort?: NativeArchiveSort;
  offset?: number;
  limit?: number;
}

/** Lossless GET serialization: resolved groups never become raw query/filter text.
 * Host/server parsers validate their structure and the complete URL independently. */
export function serializeNativeArchiveQuery(query: NativeArchiveQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const name of ['q', 'mode', 'filter', 'snapshot', 'provider', 'sort', 'minTokens', 'offset', 'limit'] as const) {
    if (query[name] !== undefined) params.set(name, String(query[name]));
  }
  for (const name of ['tags', 'exclude', 'has', 'creators'] as const) if (query[name]?.length) params.set(name, query[name].join(','));
  if (query.tagMode !== undefined) params.set('match', query.tagMode);
  for (const name of ['tagGroups', 'excludeTagGroups'] as const) if (query[name]?.length) params.set(name, JSON.stringify(query[name]));
  if (params.toString().length > 20_000) throw new ArchiveError('INVALID_INPUT', 'Archive query URL exceeds 20000 characters; narrow the selected filters');
  return params;
}
export interface ArchiveIdentityQuery { fileHash?: string; contentHash?: string; name?: string }
export interface ArchiveIdentityMatch {
  cardId: string; versionId: string; fileHash: string; contentHash: string | null;
  provider: string; recordId: string; url: string; matchedBy: 'bytes' | 'content';
}
export interface ArchiveIdentityResult { archiveId: string; matches: ArchiveIdentityMatch[]; complete: boolean; unresolved: number }

export interface LibraryIndexProjection {
  name: string; creator: string; tags: string[]; description: string; personality: string; scenario: string;
  first_mes: string; mes_example: string; system_prompt: string; post_history_instructions: string; alternate_greetings: string[];
  tokens: number; createdAt: string; updatedAt: string; spec: 'v2' | 'v3'; lorebookEntries?: number; hasPortrait?: boolean;
  flags?: { gallery: boolean; expressions: boolean; embeddedImages: boolean; systemPrompt: boolean; exampleDialogues: boolean };
}
export interface LibraryIndexMutation {
  workspaceId: string; cardId: string; revisionId: string; operation: 'upsert' | 'delete'; eventSequence: number; projection?: LibraryIndexProjection;
}
export interface LibraryIndexReceipt { eventSequence: number; applied: boolean; semantic: boolean }

export function validateIdentityQuery(query: ArchiveIdentityQuery): ArchiveIdentityQuery {
  if ((!query.fileHash && !query.contentHash) || [query.fileHash, query.contentHash].some((value) => value !== undefined && !/^[a-f0-9]{64}$/.test(value))
    || (query.name !== undefined && (typeof query.name !== 'string' || query.name.length > 500 || [...query.name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)))) {
    throw new Error('Identity lookup needs a valid file or content SHA-256 digest');
  }
  return { ...query };
}
