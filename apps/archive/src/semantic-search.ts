import { DataType } from 'apache-arrow';
import { ArchiveError, identifier, integer, record, string, isIndexSearchSort } from '@character-unity/archive-client/contract';
import type { ParsedSearchQuery, SearchMatch, SemanticCapability, SearchSort } from '@character-unity/archive-client';
import type { CopiedLance } from './copied-lance.js';
import { embeddingSpace, normalizedVector } from './embeddings.js';
import type { QueryEmbedder } from './embeddings.js';
import { parseSearchExpression } from './search-query.js';
function invalid(message: string): never { throw new ArchiveError('INVALID_INPUT', message); }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export type LexicalSearch = (text: string, filter?: string, sort?: SearchSort, mode?: 'text' | 'browse', deadlineAt?: number) => Promise<Map<string, number>>;

/** Legacy weighted RRF (vector first for ties), then stable literal-title boost.
 * Scores describe rank fusion, not a probability or semantic similarity. */
export function hybridRank(vector: Map<string, number>, lexical: Map<string, number>, ratio: number, k: number, titles: Map<string, string>, text: string) {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1 || !Number.isSafeInteger(k) || k < 1 || k > 1000) invalid('Invalid hybrid ranking parameters');
  const scores = new Map<string, number>();
  if (ratio === 1) for (const [id, score] of vector) scores.set(id, score);
  else if (ratio === 0) for (const [id, score] of lexical) scores.set(id, score);
  else {
    for (const [ids, weight] of [[vector, ratio], [lexical, 1 - ratio]] as const) {
      let index = 0; for (const id of ids.keys()) scores.set(id, (scores.get(id) ?? 0) + weight / (k + ++index));
    }
  }
  const first = new Map([...scores.keys()].map((id, index) => [id, index]));
  const words = text.trim().toLowerCase().replace(/\s+/g, ' '), tokens = words.split(' ');
  const priority = (id: string) => {
    const name = (titles.get(id) ?? '').trim().toLowerCase();
    return name === words ? 0 : name.includes(words) ? 1 : tokens.length > 1 && tokens.every((token) => name.includes(token)) ? 2 : 3;
  };
  return new Map([...scores].sort(([a, x], [b, y]) => priority(a) - priority(b) || (ratio > 0 && ratio < 1 ? y - x : 0) || first.get(a)! - first.get(b)!));
}

export async function openCopiedSemantic(lance: CopiedLance, raw: unknown, selectedIds: readonly string[], embedder?: QueryEmbedder) {
  const value = record(raw);
  if (Object.keys(value).some((key) => !['table', 'version', 'space'].includes(key))) invalid('Unknown copied vector manifest field');
  const tableName = identifier(value.table), version = integer(value.version, Number.MAX_SAFE_INTEGER), space = embeddingSpace(value.space);
  if (!version) invalid('Copied vectors require a pinned table version');
  if (embedder && JSON.stringify(embeddingSpace(embedder.space)) !== JSON.stringify(space)) invalid('Embedding provider space does not match the copied vector manifest');
  const selected = new Set(selectedIds);
  const census = await lance.withTable(tableName, version, async (table) => {
    const fields = (await table.schema()).fields, vector = fields.find((field) => field.name === 'vector');
    if (!['id', 'card_id', 'section', 'matchText'].every((name) => fields.some((field) => field.name === name && DataType.isUtf8(field.type)))
      || !vector || !DataType.isFixedSizeList(vector.type) || vector.type.listSize !== space.dimensions || vector.type.valueType.toString() !== 'Float32') invalid('Copied vector table has an incompatible schema');
    const count = await table.countRows();
    if (!Number.isSafeInteger(count) || count < 1 || count > 40_000 || count * space.dimensions > 4_000_000) invalid('Copied vectors exceed the row or dimension budget');
    const rows = await table.query().select(['id', 'card_id', 'section', 'matchText', 'vector']).limit(count + 1).toArray({ timeoutMs: 15000 });
    const ids = new Set<string>(), cards = new Set<string>(); let textSize = 0;
    for (const row of rows) {
      const id = string(row.id, 256), cardId = identifier(row.card_id); string(row.section, 128);
      if (!id || ids.has(id) || !selected.has(cardId) || typeof row.matchText !== 'string' || row.matchText.length > 8192 || !row.vector) invalid('Copied vector rows must be unique, bounded and belong to the selected cards');
      textSize += new TextEncoder().encode(row.matchText).length;
      if (textSize > 32 * 1024 * 1024) invalid('Copied vector excerpts exceed 32 MiB');
      normalizedVector(Array.from(row.vector), space.dimensions);
      ids.add(id); cards.add(cardId);
    }
    if (rows.length !== count) invalid('Copied vector row count changed');
    return { count, ids, cards: cards.size };
  });
  const capability: SemanticCapability = { version: 'lance-cosine-v1', model: space.model, dimensions: space.dimensions, indexedCards: census.cards, indexedRows: census.count };
  return {
    capability: embedder ? capability : undefined,
    async search(query: ParsedSearchQuery, cards: { id: string; title: string }[], lexical: LexicalSearch, signal?: AbortSignal) {
      if (!embedder) throw new ArchiveError('UNAVAILABLE', 'No embedding provider is configured for this copy');
      if (query.mode !== 'semantic' && query.mode !== 'hybrid') invalid('Expected a semantic search mode');
      if (query.mode === 'hybrid' && (query.text.includes('"') || parseSearchExpression(query.text).type !== 'term')) invalid('Hybrid search requires plain text; use card text for Boolean or phrase queries');
      const deadlineAt = Date.now() + 25_000;
      const deadline = AbortSignal.any([AbortSignal.timeout(25_000), ...(signal ? [signal] : [])]);
      const ratio = query.semanticRatio ?? 0.4, rrfK = query.rrfK ?? 60;
      const metadata = new Set(cards.map((card) => card.id));
      const universe = await lexical('', query.filter, isIndexSearchSort(query.sort) ? query.sort : 'id', 'browse', deadlineAt);
      const allowed = new Set([...universe.keys()].filter((id) => metadata.has(id)));
      const vectorScores = new Map<string, number>(), matches = new Map<string, SearchMatch>();
      const needsVector = query.mode === 'semantic' || ratio > 0;
      if (allowed.size && needsVector) {
        const queryVector = normalizedVector(await embedder.embed(query.text, deadline), space.dimensions);
        deadline.throwIfAborted();
        const hits = await lance.withTable(tableName, version, (table) => {
          deadline.throwIfAborted(); const remaining = Math.min(15000, deadlineAt - Date.now());
          if (remaining <= 0) throw new ArchiveError('UNAVAILABLE', 'Semantic query exceeded its deadline');
          return table.vectorSearch(queryVector).column('vector').distanceType('cosine').bypassVectorIndex()
            .select(['id', 'card_id', 'section', 'matchText', '_distance']).limit(census.count + 1).toArray({ timeoutMs: remaining });
        });
        deadline.throwIfAborted();
        const seen = new Set<string>();
        for (const hit of hits) {
          if (typeof hit.id !== 'string' || !census.ids.has(hit.id) || seen.has(hit.id) || !selected.has(hit.card_id)
            || typeof hit._distance !== 'number' || !Number.isFinite(hit._distance) || hit._distance < -0.00001 || hit._distance > 2.00001) throw new ArchiveError('INTEGRITY', 'Copied vector search returned invalid rows');
          seen.add(hit.id);
        }
        if (seen.size !== census.count) throw new ArchiveError('INTEGRITY', 'Copied vector search did not return the full row set');
        hits.sort((a, b) => a._distance - b._distance || compare(a.card_id, b.card_id) || compare(a.id, b.id));
        for (const hit of hits) {
          if (!allowed.has(hit.card_id) || vectorScores.has(hit.card_id)) continue;
          const score = 1 / (1 + Math.max(0, hit._distance));
          vectorScores.set(hit.card_id, score); matches.set(hit.card_id, { section: hit.section, text: hit.matchText, score });
        }
      }
      let scores = vectorScores;
      if (query.mode === 'hybrid') {
        let lexicalScores = new Map<string, number>();
        if (ratio < 1 && allowed.size) {
          const found = await lexical(query.text, query.filter, 'relevance', 'text', deadlineAt);
          lexicalScores = new Map([...found].filter(([id]) => allowed.has(id)).sort(([a, x], [b, y]) => y - x || compare(a, b)));
        }
        scores = hybridRank(vectorScores, lexicalScores, ratio, rrfK, new Map(cards.map((card) => [card.id, card.title])), query.text);
      }
      deadline.throwIfAborted();
      if (isIndexSearchSort(query.sort)) scores = new Map([...universe.keys()].filter((id) => scores.has(id)).map((id) => [id, scores.get(id)!]));
      return { scores, matches };
    },
  };
}
