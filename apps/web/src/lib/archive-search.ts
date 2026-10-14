import type { LibrarySearch } from './library-search';

export type ArchiveSearchMode = 'lexical' | 'semantic' | 'hybrid' | 'browse';
export interface ArchiveFilterField { name: string; type: 'string' | 'strings' | 'number' | 'boolean' }
export interface ArchiveCapabilities {
  lexical: boolean;
  semantic: boolean;
  browse?: boolean;
  sorts: readonly string[];
  browseSorts?: readonly string[];
  has: readonly string[];
  filterFields?: readonly ArchiveFilterField[];
  embedding?: { model: string; dimensions: number; indexedCards: number | null; indexedRows: number | null };
}
export interface ArchiveStatus {
  archiveId: string;
  cards: number;
  providers: Record<string, number>;
  capabilities?: ArchiveCapabilities;
}

export const archiveModes: readonly { value: ArchiveSearchMode; label: string }[] = [
  { value: 'lexical', label: 'Card text / Boolean' },
  { value: 'semantic', label: 'Semantic' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'browse', label: 'Indexed filters only' },
];

export function archiveMode(search: Pick<LibrarySearch, 'archiveMode'>): string {
  return search.archiveMode || 'lexical';
}

export function modeAvailable(mode: string, capabilities?: ArchiveCapabilities): boolean {
  if (mode === 'lexical') return capabilities?.lexical === true;
  if (mode === 'semantic' || mode === 'hybrid') return capabilities?.semantic === true;
  return mode === 'browse' && capabilities?.browse === true;
}

export function archiveOrders(mode: string, capabilities?: ArchiveCapabilities): readonly string[] {
  return (mode === 'browse' ? capabilities?.browseSorts : capabilities?.sorts) ?? [];
}

/** One explicit native query: no mode, filter or ordering silently falls back. */
export function archiveSearchParams(search: LibrarySearch, hidden: { tags: readonly string[]; hideNsfw: boolean }, status: ArchiveStatus,
  groups: { tagGroups?: readonly (readonly string[])[]; excludeTagGroups?: readonly (readonly string[])[] } = {}): URLSearchParams {
  const params = new URLSearchParams();
  const mode = archiveMode(search);
  const parts = [search.q.trim(), search.expr.trim()].filter(Boolean);
  const q = parts.length > 1 ? parts.map((part) => `(${part})`).join(' ') : parts[0] ?? '';
  const capabilities = status.capabilities;
  if (!archiveModes.some((option) => option.value === mode)) throw new Error(`Unknown Archive search mode: ${mode}. Choose a supported mode and search again.`);
  // An empty ordinary query is metadata browsing, including Archives without a search index.
  if ((q || mode !== 'lexical') && !modeAvailable(mode, capabilities)) throw new Error(`${archiveModes.find((option) => option.value === mode)!.label} is unavailable. Choose another mode and search again.`);
  if (mode === 'browse' && q) throw new Error('Indexed filters only does not search card text. Clear the query or choose a text mode.');
  if ((mode === 'semantic' || mode === 'hybrid') && !q) throw new Error('Semantic and hybrid search need query text.');
  if (q.length > 2000) throw new Error('Archive query text must be at most 2,000 characters.');
  if (search.archiveFilter.trim()) {
    if (!capabilities?.filterFields?.length) throw new Error('Typed Archive filters are unavailable. Clear the filter or reconnect a compatible index.');
    if (search.archiveFilter.length > 4096) throw new Error('Archive filters must be at most 4,096 characters.');
    params.set('filter', search.archiveFilter.trim());
    if (!q && mode !== 'browse') throw new Error('Choose Indexed filters only to run a typed filter without card text.');
  }
  const invalidFlag = search.has.find((flag) => !capabilities?.has.includes(flag));
  if (invalidFlag) throw new Error(`The Archive does not support the ${invalidFlag} filter. Remove it and search again.`);
  const sorts = archiveOrders(mode, capabilities);
  if (search.sort && !sorts.includes(search.sort)) throw new Error(`The Archive order “${search.sort}” is unavailable. Choose another order and search again.`);
  if (q) { params.set('q', q); params.set('mode', mode); }
  else if (mode === 'browse') params.set('mode', mode);
  if (search.tags.length) params.set('tags', search.tags.join(','));
  if (search.tagMode === 'any') params.set('match', 'any');
  const exclude = [...new Set([...search.exclude, ...hidden.tags, ...(hidden.hideNsfw ? ['nsfw'] : [])].map((tag) => tag.toLowerCase()))];
  if (exclude.length) params.set('exclude', exclude.join(','));
  if (search.metaTags.length && !groups.tagGroups?.length || search.excludeMetaTags.length && !groups.excludeTagGroups?.length) {
    throw new Error('The selected meta-tags must be loaded before searching. Reload their definitions and try again.');
  }
  if (groups.tagGroups?.length) params.set('tagGroups', JSON.stringify(groups.tagGroups));
  if (groups.excludeTagGroups?.length) params.set('excludeTagGroups', JSON.stringify(groups.excludeTagGroups));
  if (search.has.length) params.set('has', search.has.join(','));
  if (search.source) params.set('provider', search.source);
  if (search.minTokens) {
    if (!/^(0|[1-9][0-9]{0,7})$/.test(search.minTokens) || Number(search.minTokens) > 10_000_000) throw new Error('Minimum tokens must be a whole number from 0 to 10,000,000.');
    params.set('minTokens', search.minTokens);
  }
  // In particular, omit sort for semantic/hybrid relevance. Never force the metadata default.
  if (search.sort) params.set('sort', search.sort);
  else if (mode === 'browse') {
    const order = sorts.includes('updated') ? 'updated' : sorts[0];
    if (!order) throw new Error('No indexed browse order is available. Choose another mode and search again.');
    params.set('sort', order);
  }
  if (params.toString().length > 8000) throw new Error('This search expands to too many tag names for one request. Select fewer meta-tags or shorten their member lists.');
  return params;
}

export function archiveIsFiltered(search: LibrarySearch) {
  return !!(search.q.trim() || search.expr.trim() || search.tags.length || search.metaTags.length || search.exclude.length || search.excludeMetaTags.length || search.has.length
    || search.source || search.minTokens || search.archiveFilter.trim());
}
