import type { Table } from '@lancedb/lancedb';
import { ArchiveError, identifier, integer, record, indexSearchOrders, isIndexSearchSort } from '@character-unity/archive-client/contract';
import type { IndexSearchSort, SearchSort } from '@character-unity/archive-client';
import { openCopiedSemantic } from './semantic-search.js';
import type { QueryEmbedder, EmbeddingSpace } from './embeddings.js';
import type { ParsedSearchQuery } from '@character-unity/archive-client';
import { openCopiedLance } from './copied-lance.js';
import { compileSearchFilter, searchFilterFields } from './search-filter.js';
import { evaluateSearch, parseSearchExpression } from './search-query.js';

export interface CopiedSearchManifest { path: string; table: string; version: number; files: { path: string; sha256: string }[]; vector?: { table: string; version: number; space: EmbeddingSpace } }
function invalid(message: string): never { throw new ArchiveError('INVALID_INPUT', message); }
function exact(value: Record<string, unknown>, names: string[]) {
  if (Object.keys(value).some((key) => !names.includes(key))) invalid('Unknown copied search manifest field');
}
/** Full file inventory, no directory traversal, remote URI, symlink or discovery
 * of active generations. Reads are bounded to an explicitly staged small copy. */
export async function openCopiedSearch(root: string, raw: unknown, selectedIds: readonly string[], embedder?: QueryEmbedder) {
  if (selectedIds.length > 10000 || new Set(selectedIds).size !== selectedIds.length) invalid('Copied search requires at most 10,000 unique selected IDs');
  const input = record(raw); exact(input, ['path', 'table', 'version', 'files', 'vector']);
  const tableName = identifier(input.table), version = integer(input.version, Number.MAX_SAFE_INTEGER);
  if (!version) invalid('Copied search requires a pinned version');
  const ids = [...selectedIds].sort(), idSet = new Set(ids), lance = await openCopiedLance(root, input);
  const withTable = <T>(operation: (table: Table) => Promise<T>) => lance.withTable(tableName, version, operation);
  const filterFields = await withTable(async (table) => {
    const schema = await table.schema(), fields = schema.fields;
    if (!['id', 'searchText'].every((name) => fields.some((field) => field.name === name && field.type.toString() === 'Utf8'))) invalid('Copied search requires UTF-8 id and searchText columns');
    if (!(await table.listIndices()).some((index) => index.indexType === 'FTS' && index.columns.includes('searchText'))) invalid('Copied search requires an existing searchText FTS index');
    const rows = await table.query().select(['id']).limit(10001).toArray({ timeoutMs: 15000 });
    const indexed = rows.map((row) => row.id);
    if (indexed.length !== ids.length || new Set(indexed).size !== ids.length || indexed.some((id) => typeof id !== 'string' || !idSet.has(id))) invalid('Copied search table must contain exactly the manifest selection');
    return searchFilterFields(schema);
  });
  const sorts = (Object.keys(indexSearchOrders) as IndexSearchSort[]).filter((key) => {
    const order = indexSearchOrders[key];
    return filterFields.some((field) => field.name === order.field && field.type === (order.field === 'lastModified' || order.field === 'createdAt' ? 'string' : 'number'));
  });
  if (embedder && input.vector === undefined) invalid('Embedding provider requires a copied vector table');
  const vectors = input.vector === undefined ? undefined : await openCopiedSemantic(lance, input.vector, selectedIds, embedder);
  const backend = {
    ...(vectors?.capability ? { semantic: vectors.capability } : {}),
    async semanticSearch(query: ParsedSearchQuery, cards: { id: string; title: string }[], signal?: AbortSignal) {
      if (!vectors) throw new ArchiveError('UNAVAILABLE', 'No copied vector table configured');
      return vectors.search(query, cards, backend.search, signal);
    },
    filterFields, sorts, browse: 'lance-filter-v1' as const,
    async search(text: string, filter = '', sort: SearchSort = 'relevance', mode: 'text' | 'browse' = 'text', deadlineAt = Date.now() + 15000) {
      if (mode === 'browse' && (text.trim() || sort === 'relevance')) invalid('Browse requires empty text and an explicit field order');
      const expression = mode === 'browse' ? null : parseSearchExpression(text), predicate = compileSearchFilter(filter, filterFields);
      const order = isIndexSearchSort(sort) ? indexSearchOrders[sort] : undefined;
      if (order && !sorts.includes(sort as IndexSearchSort)) invalid('This copy does not support that sort');
      const deadline = Math.min(deadlineAt, Date.now() + 15000);
      return withTable(async (table) => {
        function timeout() {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new ArchiveError('UNAVAILABLE', 'Copied search exceeded its query deadline');
          return { timeoutMs: remaining };
        }
        function checkedIds(rows: { id: unknown }[]) {
          const found = rows.map((row) => row.id);
          if (new Set(found).size !== found.length || found.some((id) => typeof id !== 'string' || !idSet.has(id))) throw new ArchiveError('INTEGRITY', 'Copied filter returned invalid IDs');
          return found as string[];
        }
        // NOT is relative to the entire filtered selection, never a page/top-k.
        let universe = ids;
        if (predicate || order) {
          let query = table.query().select(order ? ['id', order.field] : ['id']).limit(ids.length + 1);
          if (predicate) query = query.where(predicate);
          if (order) query = query.orderBy([{ columnName: order.field, ascending: order.ascending, nullsFirst: false }, { columnName: 'id', ascending: order.ascending }]);
          universe = checkedIds(await query.toArray(timeout()));
        }
        if (!expression) return new Map(universe.map((id) => [id, 0]));
        const allowed = new Set(universe);
        const scores = await evaluateSearch(expression, universe, async (term) => {
          let query = table.search(term, 'fts', 'searchText').select(['id', '_score']).limit(ids.length + 1);
          if (predicate) query = query.where(predicate);
          const hits = await query.toArray(timeout()), result = new Map<string, number>();
          for (const hit of hits) {
            if (typeof hit.id !== 'string' || !allowed.has(hit.id) || result.has(hit.id) || typeof hit._score !== 'number' || !Number.isFinite(hit._score) || hit._score < 0) {
              throw new ArchiveError('INTEGRITY', 'Copied search returned invalid results');
            }
            result.set(hit.id, hit._score);
          }
          return result;
        });
        return order ? new Map(universe.filter((id) => scores.has(id)).map((id) => [id, scores.get(id)!])) : scores;
      });
    },
  };
  return backend;
}
