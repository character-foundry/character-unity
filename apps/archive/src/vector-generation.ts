import { createHash } from 'node:crypto';
import { toUSVString } from 'node:util';
import { makeArrowTable } from '@lancedb/lancedb';
import type { Connection } from '@lancedb/lancedb';
import { Field, FixedSizeList, Float32, Schema, Utf8 } from 'apache-arrow';
import { ArchiveError, identifier } from '@character-unity/archive-client/contract';
import { embeddingSpace, normalizedVector } from './embeddings.js';
import type { DocumentEmbedder } from './embeddings.js';

export interface SemanticGenerationOptions { embedder: DocumentEmbedder; batchSize?: number; tokenBudget?: number }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function invalid(message: string): never { throw new ArchiveError('INVALID_INPUT', message); }

/** Legacy Lance ETL uses a whole-card metadata text, not Meilisearch sections.
 * Plan and bound all model inputs before reserving output or making a request. */
export function prepareVectorGeneration(documents: readonly Record<string, unknown>[], options: SemanticGenerationOptions) {
  const space = embeddingSpace(options.embedder.space), batchSize = options.batchSize ?? 32, tokenBudget = options.tokenBudget ?? 24000;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 128 || !Number.isSafeInteger(tokenBudget) || tokenBudget < 512 || tokenBudget > 24000) invalid('Embedding batches require size 1–128 and token budget 512–24,000');
  const items: { id: string; text: string; matchText: string }[] = [];
  let truncatedCards = 0, excerptTruncatedCards = 0, excerptBytes = 0, inputCharacters = 0, skippedNoText = 0;
  const ids = new Set<string>();
  for (const document of documents) {
    const id = identifier(document.id), original = document.searchText;
    if (ids.has(id) || typeof original !== 'string') invalid('Embedding projection needs unique selected IDs and search text');
    ids.add(id);
    const text = toUSVString(original.slice(0, tokenBudget * 4));
    if (!text.trim()) { skippedNoText++; continue; }
    if (original.length > text.length) truncatedCards++;
    if (text.length > 8192) excerptTruncatedCards++;
    const matchText = toUSVString(text.slice(0, 8192));
    excerptBytes += Buffer.byteLength(matchText); inputCharacters += text.length;
    items.push({ id, text, matchText });
  }
  if (!items.length || items.length > 40000 || items.length * space.dimensions > 4000000 || excerptBytes > 32 * 1024 * 1024) invalid('Generated vectors exceed the copied reader row/dimension/excerpt limits or contain no usable text');
  const batches: typeof items[] = []; let batch: typeof items = [], estimatedTokens = 0;
  for (const item of items) {
    const tokens = Math.max(1, Math.ceil(item.text.length / 4));
    if (batch.length && (batch.length >= batchSize || estimatedTokens + tokens > tokenBudget)) { batches.push(batch); batch = []; estimatedTokens = 0; }
    batch.push(item); estimatedTokens += tokens;
  }
  if (batch.length) batches.push(batch);
  const summary = { projection: 'archive-lance-card-b99dcd1-v1', space, batchSize, tokenBudget, batches: batches.length,
    indexedCards: items.length, indexedRows: items.length, skippedNoText, truncatedCards, excerptTruncatedCards, inputCharacters,
    inputSha256: digest(items.map(({ id, text }) => ({ id, text }))) };
  return { summary, async write(connection: Connection, signal?: AbortSignal) {
    const rows: { id: string; card_id: string; section: string; matchText: string; vector: number[] }[] = [];
    for (const batch of batches) {
      signal?.throwIfAborted();
      const vectors = await options.embedder.embed(batch.map((item) => item.text), signal);
      signal?.throwIfAborted();
      if (!Array.isArray(vectors) || vectors.length !== batch.length) invalid('Document embedder returned an incomplete batch');
      for (const [index, item] of batch.entries()) {
        const vector = normalizedVector(vectors[index], space.dimensions).map(Math.fround);
        rows.push({ id: item.id, card_id: item.id, section: 'card', matchText: item.matchText, vector });
      }
    }
    const schema = new Schema([...['id', 'card_id', 'section', 'matchText'].map((name) => new Field(name, new Utf8(), false)),
      new Field('vector', new FixedSizeList(space.dimensions, new Field('item', new Float32(), false)), false)]);
    const table = await connection.createTable('vectors', makeArrowTable(rows, { schema }));
    try { return { manifest: { table: 'vectors', version: await table.version(), space }, report: { ...summary, rowsSha256: digest(rows) } }; }
    finally { table.close(); }
  } };
}
