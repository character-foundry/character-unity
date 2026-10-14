import { fold, normalizeTagGroupFilters, parseLibraryQuery } from '@character-unity/store/library-query';
import type { QueryNode } from '@character-unity/store/library-query';
import type { SearchFilterField } from '@character-unity/archive-client';
import { nativeArchiveSorts, nativeArchiveFlags } from '@character-unity/archive-client/native';
import type { NativeArchiveQuery } from '@character-unity/archive-client/native';

export const archiveSorts = nativeArchiveSorts;
export type ArchiveSort = typeof archiveSorts[number];
export const archiveFlags = nativeArchiveFlags;
export type ArchiveFlag = typeof archiveFlags[number];
export interface ArchiveCapabilities {
  lexical: boolean; semantic: boolean; browse: boolean;
  sorts: readonly ArchiveSort[]; browseSorts: readonly ArchiveSort[]; has: readonly ArchiveFlag[]; filterFields: readonly SearchFilterField[];
  embedding?: { model: string; dimensions: number; indexedCards: number | null; indexedRows: number | null };
  libraryIndex?: { enabled: boolean; semantic: boolean; reason?: string };
}
export const isArchiveSort = (value: string): value is ArchiveSort => (archiveSorts as readonly string[]).includes(value);
export const isArchiveFlag = (value: string): value is ArchiveFlag => (archiveFlags as readonly string[]).includes(value);

export interface ArchiveQuery extends NativeArchiveQuery {
  /** HTTP-owned cancellation; never accepted as a caller-supplied query parameter. */
  signal?: AbortSignal;
  /** Trusted API proxy only, never a URL parameter. */
  libraryWorkspaceId?: string;
}

const columns: Record<string, string> = { name: 'name', creator: 'creator', description: 'description' };

/** One FTS5 string: quoted so punctuation and keywords stay literal, prefix-matched on its last word. */
function ftsString(value: string): string | null {
  if (!/[\p{L}\p{N}]/u.test(value)) return null;
  return `"${value.replace(/"/g, '""')}"*`;
}

function termSql(node: Extract<QueryNode, { kind: 'term' }>, params: (string | number)[]): string {
  if (node.field === 'tag') {
    params.push(fold(node.value.trim()));
    return 'EXISTS (SELECT 1 FROM card_tags t WHERE t.card_id = c.id AND lower(t.tag) = ?)';
  }
  const match = ftsString(node.value);
  if (!match) return '0';
  params.push(node.field === 'text' ? match : `${columns[node.field]} : ${match}`);
  return 'c.seq IN (SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?)';
}

function nodeSql(node: QueryNode, params: (string | number)[]): string {
  if (node.kind === 'term') return termSql(node, params);
  if (node.kind === 'not') return `NOT (${nodeSql(node.node, params)})`;
  return `(${node.nodes.map((child) => nodeSql(child, params)).join(node.kind === 'and' ? ' AND ' : ' OR ')})`;
}

const flagSql: Record<Exclude<ArchiveFlag, 'followed'>, string> = {
  greetings: 'c.alt_greetings > 0', lorebook: 'c.lorebook_entries > 0', gallery: 'c.has_gallery = 1',
  embeddedImages: 'c.has_embedded_images = 1', expressions: 'c.has_expressions = 1', portrait: 'c.portrait_sha256 IS NOT NULL',
  systemPrompt: 'c.has_system_prompt = 1', exampleDialogues: 'c.has_examples = 1',
};

export const archiveSortSql: Record<ArchiveSort, string> = {
  updated: 'coalesce(c.remote_updated_at, c.changed_at) DESC', added: 'c.first_seen_at DESC',
  newest: 'coalesce(c.remote_created_at, c.first_seen_at) DESC', oldest: 'coalesce(c.remote_created_at, c.first_seen_at) ASC',
  name: 'c.name COLLATE NOCASE ASC', name_desc: 'c.name COLLATE NOCASE DESC',
  tokens_desc: 'c.tokens DESC', tokens_asc: 'c.tokens ASC',
  stars: 'coalesce(c.stars, -1) DESC', favorites: 'coalesce(c.favorites, -1) DESC', chats: 'coalesce(c.chats, -1) DESC',
  downloads: 'coalesce(c.downloads, -1) DESC', greetings: 'c.alt_greetings DESC', lorebook: 'c.lorebook_entries DESC',
};

/** WHERE clauses (blocked records always excluded) and their parameters, in order. */
export function archiveFilterSql(query: ArchiveQuery): { where: string[]; params: (string | number)[] } {
  const where = ['NOT EXISTS (SELECT 1 FROM blocked b WHERE b.provider = c.provider AND b.record_id = c.record_id)'];
  const params: (string | number)[] = [];
  const parsed = query.q ? parseLibraryQuery(query.q) : null;
  if (parsed) where.push(nodeSql(parsed, params));
  const tags = [...new Set((query.tags ?? []).map((tag) => fold(tag.trim())).filter(Boolean))];
  const groups = normalizeTagGroupFilters(query), included: string[] = [];
  for (const group of [...tags.map((tag) => [tag]), ...groups.tagGroups]) {
    included.push('EXISTS (SELECT 1 FROM card_tags t WHERE t.card_id = c.id AND lower(t.tag) IN (SELECT value FROM json_each(?)))');
    params.push(JSON.stringify(group));
  }
  if (included.length) where.push(`(${included.join(query.tagMode === 'any' ? ' OR ' : ' AND ')})`);
  const exclude = [...new Set((query.exclude ?? []).map((tag) => fold(tag.trim())).filter(Boolean))];
  for (const group of [exclude, ...groups.excludeTagGroups]) if (group.length) {
    where.push('NOT EXISTS (SELECT 1 FROM card_tags t WHERE t.card_id = c.id AND lower(t.tag) IN (SELECT value FROM json_each(?)))');
    params.push(JSON.stringify(group));
  }
  if (query.provider) { where.push('c.provider = ?'); params.push(query.provider); }
  if (query.minTokens) { where.push('c.tokens >= ?'); params.push(query.minTokens); }
  for (const flag of new Set(query.has ?? [])) {
    if (flag !== 'followed') { where.push(flagSql[flag]); continue; }
    const creators = [...new Set((query.creators ?? []).map((creator) => creator.trim().toLowerCase()).filter(Boolean))];
    if (!creators.length) { where.push('0'); continue; }
    where.push(`lower(trim(c.creator)) IN (${creators.map(() => '?').join(', ')})`);
    params.push(...creators);
  }
  return { where, params };
}
