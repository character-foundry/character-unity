import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { toUSVString } from 'node:util';
import { connect, makeArrowTable } from '@lancedb/lancedb';
import { DataType } from 'apache-arrow';
import Database from 'better-sqlite3';
import type { SearchMatch } from '@character-unity/archive-client';
import { ArchiveError } from '@character-unity/archive-client/contract';
import { normalizedVector } from '../embeddings.js';
import type { DocumentEmbedder, QueryEmbedder } from '../embeddings.js';
import { compileSearchFilter, searchFilterFields } from '../search-filter.js';
import { compileTagGroupFilter } from '../tag-group-filter.js';
import type { TagGroupFilter } from '../tag-group-filter.js';
import { evaluateSearch, parseSearchExpression } from '../search-query.js';
import { hybridRank } from '../semantic-search.js';
import { buildSearchDocument } from '../search-document.js';
import type { ArchiveSort } from '../native/query.js';

export interface ExistingSearchOptions {
  lanceDirectory: string;
  tableName?: string;
  vectorTableName?: string;
  embedder?: QueryEmbedder;
  /** Required with an embedder: its old SQLite metadata identifies the vector space. */
  databasePath?: string;
}
export interface ExistingSearchQuery extends TagGroupFilter {
  mode?: 'lexical' | 'semantic' | 'hybrid';
  /** Legacy typed fields: source = chub, topics = fantasy, tokenCount >= 100;
   * AND/OR/NOT, parentheses, IN lists and ranges. Never raw SQL. Text search
   * accepts words, quoted phrases and Boolean operators; field prefixes belong
   * in this filter rather than the full-text query. Explicit semantic/hybrid
   * modes accept raw natural language; and/or/not are ordinary query text. */
  filter?: string;
  /** An already-filtered, bounded subset; applied before native top-k selection. */
  eligibleIds?: readonly string[];
  /** Blocked/otherwise excluded records, applied before native top-k selection. */
  excludedIds?: readonly string[];
  semanticRatio?: number;
  rrfK?: number;
  /** Maximum projected hits, never a limit on the underlying Archive's size. */
  maxCandidates?: number;
  signal?: AbortSignal;
}
export interface ExistingSearchResult {
  ids: string[];
  scores: Map<string, number>;
  matches: Map<string, SearchMatch>;
  /** Semantic results are a top-k candidate set, not a complete corpus count. */
  complete: boolean;
}
export interface IndexedVectorMetadata { cardId: string; textHash: string; model: string; dimensions: number }
const browseOrders: Partial<Record<ArchiveSort, { column: string; ascending: boolean }>> = {
  updated: { column: 'lastModified', ascending: false }, added: { column: 'added', ascending: false },
  newest: { column: 'createdAt', ascending: false }, oldest: { column: 'createdAt', ascending: true },
  name: { column: 'name', ascending: true }, name_desc: { column: 'name', ascending: false },
  tokens_desc: { column: 'tokenCount', ascending: false }, tokens_asc: { column: 'tokenCount', ascending: true },
  stars: { column: 'starCount', ascending: false }, favorites: { column: 'n_favorites', ascending: false },
  chats: { column: 'nChats', ascending: false }, greetings: { column: 'hasAlternateGreetings', ascending: false },
  lorebook: { column: 'hasLorebook', ascending: false },
};
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function invalid(message: string): never { throw new ArchiveError('INVALID_INPUT', message); }
function tableName(value: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) invalid('Invalid existing Lance table name');
  return value;
}
function cardId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) throw new ArchiveError('INTEGRITY', 'Existing Lance table contains a nonnumeric Archive ID');
  return value;
}
const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;
function batchIds(ids: readonly string[]) {
  if (ids.length > 512 || new Set(ids).size !== ids.length) invalid('Existing index writes require at most 512 unique IDs');
  return ids.map(cardId);
}
/** Reads only bounded generation/model metadata, without legacy initialization. */
export function readExistingVectorMetadata(databasePath: string): { model: string; dimensions: number; cardsIndex?: string; chunksIndex?: string } {
  const db = new Database(resolve(databasePath), { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON'); db.pragma('trusted_schema = OFF');
    const physical = (name: string) => {
      const row = db.prepare('SELECT type FROM sqlite_schema WHERE name = ?').get(name) as { type: string } | undefined;
      return row?.type === 'table';
    };
    if (physical('vector_generations')) {
      const active = db.prepare('SELECT model_name, dimensions, cards_index, chunks_index, status FROM vector_generations WHERE active = 1 LIMIT 2').all() as Record<string, unknown>[];
      if (active.length > 1) invalid('Existing Archive has ambiguous active vector generations');
      if (active.length === 1) {
        const row = active[0]!;
        if (row.status !== 'active' || typeof row.model_name !== 'string' || !row.model_name.trim() || typeof row.dimensions !== 'number'
          || !Number.isSafeInteger(row.dimensions) || row.dimensions < 1 || row.dimensions > 4096 || typeof row.cards_index !== 'string') invalid('Existing Archive active vector generation metadata is invalid');
        const cardsIndex = tableName(row.cards_index);
        const chunksIndex = row.chunks_index === null || row.chunks_index === '' ? undefined : typeof row.chunks_index === 'string' ? tableName(row.chunks_index) : invalid('Existing Archive chunk table metadata is invalid');
        return { model: row.model_name, dimensions: row.dimensions, cardsIndex, ...(chunksIndex ? { chunksIndex } : {}) };
      }
    }
    if (!physical('card_embedding_meta')) throw new ArchiveError('UNAVAILABLE', 'Existing Archive has no vector model metadata');
    const spaces = db.prepare('SELECT DISTINCT model_name, dims FROM card_embedding_meta LIMIT 2').all() as { model_name: unknown; dims: unknown }[];
    if (spaces.length !== 1 || typeof spaces[0]!.model_name !== 'string' || !spaces[0]!.model_name.trim()
      || typeof spaces[0]!.dims !== 'number' || !Number.isSafeInteger(spaces[0]!.dims) || spaces[0]!.dims < 1 || spaces[0]!.dims > 4096) invalid('Existing Archive vector model metadata is missing or ambiguous');
    return { model: spaces[0]!.model_name, dimensions: spaces[0]!.dims };
  } finally { db.close(); }
}

/** Opens the Archive's existing tables in place. No table/index creation, corpus
 * census, embedding builds, manifests or generation imports happen on open. */
export async function openExistingSearch(options: ExistingSearchOptions) {
  const directory = resolve(options.lanceDirectory);
  if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) invalid('Existing Lance path must be a real existing directory');
  const baseName = tableName(options.tableName ?? 'cards');
  if (options.embedder && !options.databasePath) invalid('Existing semantic search requires the Archive database model metadata');
  const space = options.embedder ? readExistingVectorMetadata(options.databasePath!) : undefined;
  if (space?.cardsIndex && options.vectorTableName && options.vectorTableName !== space.cardsIndex) invalid('Configured vector table does not match the active existing generation');
  const vectorName = tableName(space?.cardsIndex ?? options.vectorTableName ?? 'card_vectors');
  let activeName = baseName;
  const pointerPath = join(directory, `.${baseName}.active.json`);
  try {
    const stat = await lstat(pointerPath);
    if (!stat.isFile() || stat.size > 8192) invalid('Existing Lance active-table pointer is invalid');
    const pointer: unknown = JSON.parse(await readFile(pointerPath, 'utf8'));
    if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)) invalid('Existing Lance active-table pointer is invalid');
    const candidate = (pointer as Record<string, unknown>).tableName;
    if (typeof candidate !== 'string' || (candidate !== baseName && !candidate.startsWith(`${baseName}_build_`))) invalid('Existing Lance pointer names an unrelated table');
    activeName = tableName(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const connection = await connect(directory, { readConsistencyInterval: 0 });
  let table: Awaited<ReturnType<typeof connection.openTable>> | undefined;
  let vectors: typeof table;
  try {
    const names = await connection.tableNames();
    if (!names.includes(activeName)) throw new ArchiveError('UNAVAILABLE', `Existing Lance search table ${activeName} is not available`);
    table = await connection.openTable(activeName);
    const schema = await table.schema();
    if (!['id', 'name', 'searchText'].every((name) => schema.fields.some((field) => field.name === name && DataType.isUtf8(field.type)))) invalid('Existing Lance search schema is incompatible');
    if (!(await table.listIndices()).some((index) => index.indexType === 'FTS' && index.columns.includes('searchText'))) throw new ArchiveError('UNAVAILABLE', 'Existing Lance table has no searchText full-text index');
    const lexicalFields = searchFilterFields(schema);
    let dimensions: number | undefined;
    if (names.includes(vectorName)) {
      vectors = await connection.openTable(vectorName);
      const fields = (await vectors.schema()).fields, vector = fields.find((field) => field.name === 'vector');
      if (!['id', 'card_id', 'section', 'matchText'].every((name) => fields.some((field) => field.name === name && DataType.isUtf8(field.type)))
        || !vector || !DataType.isFixedSizeList(vector.type) || vector.type.valueType.toString() !== 'Float32') invalid('Existing Lance vector schema is incompatible');
      dimensions = vector.type.listSize;
      if (options.embedder && (!space || space.model !== options.embedder.space.model || space.dimensions !== dimensions
        || dimensions !== options.embedder.space.dimensions)) invalid('Embedding model/dimensions do not match the existing Archive vector metadata');
    } else if (options.embedder) throw new ArchiveError('UNAVAILABLE', `Existing Lance vector table ${vectorName} is not available`);
    const lexical = table, vectorTable = vectors, vectorFields = vectors ? searchFilterFields(await vectors.schema()) : [];
    const sorts = Object.entries(browseOrders).filter(([, order]) => schema.fields.some((field) => field.name === order.column)).map(([sort]) => sort as ArchiveSort);
    let closed = false;
    function ready() { if (closed) throw new ArchiveError('UNAVAILABLE', 'Existing Lance connection is closed'); }
    function predicate(query: Pick<ExistingSearchQuery, 'filter' | 'eligibleIds' | 'excludedIds'> & TagGroupFilter, fields = lexicalFields) {
      if (query.eligibleIds && (query.eligibleIds.length > 10_000 || new Set(query.eligibleIds).size !== query.eligibleIds.length)) invalid('Existing search accepts at most 10,000 unique eligible IDs; use metadata filters for broader subsets');
      if (query.excludedIds && (query.excludedIds.length > 10_000 || new Set(query.excludedIds).size !== query.excludedIds.length)) invalid('Existing search accepts at most 10,000 unique excluded IDs');
      const eligible = query.eligibleIds?.map(cardId), excluded = query.excludedIds?.map(cardId);
      return [compileSearchFilter(query.filter ?? '', fields), compileTagGroupFilter(query, fields), eligible ? eligible.length ? `id IN (${eligible.map(quoted).join(', ')})` : 'false' : '',
        excluded?.length ? `id NOT IN (${excluded.map(quoted).join(', ')})` : ''].filter(Boolean).map((value) => `(${value})`).join(' AND ');
    }
    return {
      tableName: activeName,
      vectorTableName: vectorTable ? vectorName : null,
      semantic: !!(vectorTable && options.embedder),
      filterFields: options.embedder && vectorTable ? lexicalFields.filter((field) => vectorFields.some((other) => other.name === field.name && other.type === field.type)) : lexicalFields,
      sorts,
      // Coverage has not been counted. Do not turn a status read or startup into
      // an index-wide census, and do not pretend the metadata sample is coverage.
      embedding: space && dimensions ? { model: space.model, dimensions, indexedCards: null, indexedRows: null } : undefined,
      async snapshot(): Promise<string> {
        ready();
        let currentName = baseName;
        try {
          const stat = await lstat(pointerPath);
          if (!stat.isFile() || stat.size > 8192) invalid('Existing Lance active-table pointer is invalid');
          const pointer: unknown = JSON.parse(await readFile(pointerPath, 'utf8'));
          if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer) || typeof (pointer as Record<string, unknown>).tableName !== 'string') invalid('Existing Lance active-table pointer is invalid');
          currentName = (pointer as { tableName: string }).tableName;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (currentName !== activeName) throw new ArchiveError('SNAPSHOT_CHANGED', 'The Archive search generation changed; reconnect and search again');
        if (space) {
          const current = readExistingVectorMetadata(options.databasePath!);
          if (JSON.stringify(current) !== JSON.stringify(space)) throw new ArchiveError('SNAPSHOT_CHANGED', 'The Archive embedding generation changed; reconnect and search again');
        }
        return createHash('sha256').update(JSON.stringify([activeName, await lexical.version(), vectorName, vectorTable ? await vectorTable.version() : null, space])).digest('hex');
      },
      /** Server-side filtered paging, including broad subsets larger than the
       * search candidate budget. Only this page's IDs cross the Lance boundary. */
      async browse(query: Pick<ExistingSearchQuery, 'filter' | 'eligibleIds' | 'excludedIds' | 'signal'> & TagGroupFilter & { sort?: ArchiveSort; offset?: number; limit?: number; mergeCandidates?: boolean } = {}) {
        ready();
        const offset = query.offset ?? 0, limit = query.limit ?? 48, sort = query.sort ?? 'updated';
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > (query.mergeCandidates ? 10_100 : 100)) invalid('Invalid existing Archive browse page');
        if (!sorts.includes(sort)) invalid('This existing index does not support that browse sort');
        const signal = AbortSignal.any([AbortSignal.timeout(25_000), ...(query.signal ? [query.signal] : [])]);
        signal.throwIfAborted();
        const filter = predicate(query), order = browseOrders[sort]!;
        const total = await lexical.countRows(filter || undefined);
        let request = lexical.query().select([...new Set(['id', order.column])]).orderBy([{ columnName: order.column, ascending: order.ascending, nullsFirst: false }, { columnName: 'id', ascending: false }]).offset(offset).limit(limit);
        if (filter) request = request.where(filter);
        const rows = await request.toArray({ timeoutMs: 15_000 });
        signal.throwIfAborted();
        const ids = rows.map((row) => cardId(row.id));
        if (new Set(ids).size !== ids.length) throw new ArchiveError('INTEGRITY', 'Existing Lance browse returned duplicate card IDs');
        return { ids, total };
      },
      async search(text: string, query: ExistingSearchQuery = {}): Promise<ExistingSearchResult> {
        ready();
        const mode = query.mode ?? 'lexical';
        if (!['lexical', 'semantic', 'hybrid'].includes(mode)) invalid('Unsupported existing Archive search mode');
        if (typeof text !== 'string' || !text.trim() || text.length > 2048) invalid('Existing search needs 1–2048 characters of query text');
        const expression: ReturnType<typeof parseSearchExpression> = mode === 'lexical' ? parseSearchExpression(text) : { type: 'term', value: text.trim() };
        const limit = query.maxCandidates ?? (mode === 'lexical' ? 10_000 : 400);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) invalid('Existing search accepts 1–10,000 candidates');
        if (query.eligibleIds && (query.eligibleIds.length > 10_000 || new Set(query.eligibleIds).size !== query.eligibleIds.length)) invalid('Existing search accepts at most 10,000 unique eligible IDs; use metadata filters for broader subsets');
        if (query.excludedIds && (query.excludedIds.length > 10_000 || new Set(query.excludedIds).size !== query.excludedIds.length)) invalid('Existing search accepts at most 10,000 unique excluded IDs');
        const eligible = query.eligibleIds?.map(cardId);
        const excluded = query.excludedIds?.map(cardId);
        if (eligible?.length === 0) return { ids: [], scores: new Map(), matches: new Map(), complete: true };
        const restrict = (filter: string, column = 'id') => [filter, eligible ? `${column} IN (${eligible.map(quoted).join(', ')})` : '', excluded?.length ? `${column} NOT IN (${excluded.map(quoted).join(', ')})` : ''].filter(Boolean).map((value) => `(${value})`).join(' AND ');
        const ratio = query.semanticRatio ?? 0.4, k = query.rrfK ?? 60;
        if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1 || !Number.isSafeInteger(k) || k < 1 || k > 1000) invalid('Invalid existing hybrid ranking parameters');
        const signal = AbortSignal.any([AbortSignal.timeout(25_000), ...(query.signal ? [query.signal] : [])]);
        const deadlineAt = Date.now() + 25_000;
        function timeout() { signal.throwIfAborted(); return { timeoutMs: Math.max(1, Math.min(15_000, deadlineAt - Date.now())) }; }
        const usesLexical = mode === 'lexical' || mode === 'hybrid' && ratio < 1;
        const predicate = restrict([compileSearchFilter(query.filter ?? '', lexicalFields), usesLexical ? compileTagGroupFilter(query, lexicalFields) : '']
          .filter(Boolean).map((value) => `(${value})`).join(' AND '));
        const matches = new Map<string, SearchMatch>();
        const titles = new Map<string, string>();
        let complete = true;
        async function lexicalSearch() {
          const terms = new Map<string, Map<string, number> | undefined>();
          async function termSearch(term: string, domain?: Set<string>): Promise<Map<string, number> | undefined> {
            if (terms.has(term)) {
              const cached = terms.get(term);
              if (cached) return domain ? new Map([...cached].filter(([id]) => domain.has(id))) : cached;
              if (!domain) return undefined;
            }
            let request = lexical.search(term, 'fts', 'searchText').select(['id', 'name', '_score']).limit(limit + 1);
            const scope = [predicate, domain ? `id IN (${[...domain].map(quoted).join(', ')})` : ''].filter(Boolean).map((value) => `(${value})`).join(' AND ');
            if (scope) request = request.where(scope);
            const rows = await request.toArray(timeout());
            if (rows.length > limit) {
              if (domain) throw new ArchiveError('INTEGRITY', 'Existing Lance search exceeds its bounded ID universe');
              terms.set(term, undefined); return undefined;
            }
            const scores = new Map<string, number>();
            for (const row of rows) {
              const id = cardId(row.id);
              if (scores.has(id) || (domain && !domain.has(id)) || typeof row._score !== 'number' || !Number.isFinite(row._score) || row._score < 0) throw new ArchiveError('INTEGRITY', 'Existing Lance lexical search returned invalid scores or duplicate IDs');
              if (typeof row.name !== 'string' || row.name.length > 4096) throw new ArchiveError('INTEGRITY', 'Existing Lance card title exceeds its metadata budget');
              scores.set(id, row._score); titles.set(id, row.name);
            }
            if (!domain) terms.set(term, scores);
            return scores;
          }
          // Plan an upper bound on satisfying IDs. AND needs one bounded child;
          // OR needs both. Pushing negation through the plan (De Morgan) lets
          // positive anchors bound nested complements without enumerating the
          // corpus or retrieving a broad excluded term's complete matches.
          async function bound(node: ReturnType<typeof parseSearchExpression>, negated = false): Promise<Set<string> | undefined> {
            if (node.type === 'term') {
              if (negated) return undefined;
              const matches = await termSearch(node.value);
              return matches ? new Set(matches.keys()) : undefined;
            }
            if (node.type === 'not') return bound(node.child, !negated);
            const conjunction = (node.type === 'and') !== negated;
            const left = await bound(node.left, negated);
            if (conjunction && left) return left;
            if (!conjunction && !left) return undefined;
            const right = await bound(node.right, negated);
            if (conjunction) return right;
            if (!right) return undefined;
            const union = new Set([...left!, ...right]);
            return union.size <= limit ? union : undefined;
          }
          let universe = await bound(expression);
          if (!universe) {
            let request = lexical.query().select(['id']).limit(limit + 1);
            if (predicate) request = request.where(predicate);
            const rows = await request.toArray(timeout());
            if (rows.length > limit) throw new ArchiveError('TOO_LARGE', 'Boolean search needs a narrower positive term or Archive filter to fit its complete candidate budget');
            universe = new Set(rows.map((row) => cardId(row.id)));
            if (universe.size !== rows.length) throw new ArchiveError('INTEGRITY', 'Existing Lance search contains duplicate card IDs');
          }
          if (!universe.size) return new Map<string, number>();
          const domain = universe;
          const result = await evaluateSearch(expression, [...domain], async (term) => (await termSearch(term, domain))!);
          if (result.size > limit) throw new ArchiveError('TOO_LARGE', 'Boolean search exceeds its complete candidate budget; narrow the Archive filters');
          return new Map([...result].sort(([a, x], [b, y]) => y - x || compare(a, b)));
        }
        let scores: Map<string, number>;
        if (mode === 'lexical' || (mode === 'hybrid' && ratio === 0)) scores = await lexicalSearch();
        else {
          if (!vectorTable || !options.embedder || !dimensions) throw new ArchiveError('UNAVAILABLE', 'Existing Archive semantic search needs its vector table and embedding provider');
          const predicate = restrict([compileSearchFilter(query.filter ?? '', vectorFields), compileTagGroupFilter(query, vectorFields)]
            .filter(Boolean).map((value) => `(${value})`).join(' AND '), 'card_id');
          const vector = normalizedVector(await options.embedder.embed(text, signal), dimensions);
          let request = vectorTable.vectorSearch(vector).column('vector').distanceType('cosine')
            .select(['card_id', 'section', 'matchText', '_distance']).limit(limit + 1);
          if (predicate) request = request.where(predicate);
          const rows = await request.toArray(timeout());
          // A vector query always describes top-k coverage, including ANN recall.
          complete = false;
          scores = new Map();
          let textBytes = 0;
          for (const row of rows.slice(0, limit)) {
            const id = cardId(row.card_id), distance: unknown = row._distance;
            if (typeof distance !== 'number' || !Number.isFinite(distance) || distance < -0.00001 || distance > 2.00001
              || typeof row.section !== 'string' || row.section.length > 128 || typeof row.matchText !== 'string') throw new ArchiveError('INTEGRITY', 'Existing Lance vector search returned invalid matches');
            textBytes += Buffer.byteLength(row.matchText);
            if (textBytes > 32 * 1024 * 1024) throw new ArchiveError('TOO_LARGE', 'Existing vector candidate excerpts exceed 32 MiB; request fewer candidates');
            if (scores.has(id)) continue;
            const score = 1 / (1 + Math.max(0, distance));
            scores.set(id, score); matches.set(id, { section: row.section, text: row.matchText.slice(0, 8192), score });
          }
          if (mode === 'hybrid') {
            const lexicalScores = ratio < 1 ? await lexicalSearch() : new Map<string, number>();
            const ids = [...new Set([...scores.keys(), ...lexicalScores.keys()])];
            // Only candidate titles are read, never complete metadata or vectors.
            for (let offset = 0; offset < ids.length; offset += 512) {
              const batch = ids.slice(offset, offset + 512);
              const names = await lexical.query().where(`id IN (${batch.map(quoted).join(', ')})`).select(['id', 'name']).limit(batch.length + 1).toArray(timeout());
              for (const row of names) {
                if (typeof row.name !== 'string' || row.name.length > 4096) throw new ArchiveError('INTEGRITY', 'Existing Lance card title exceeds its metadata budget');
                titles.set(cardId(row.id), row.name);
              }
            }
            scores = hybridRank(scores, lexicalScores, ratio, k, titles, text);
            if (scores.size > limit) scores = new Map([...scores].slice(0, limit));
          }
        }
        signal.throwIfAborted();
        return { ids: [...scores.keys()], scores, matches: new Map([...matches].filter(([id]) => scores.has(id))), complete };
      },
      /** Explicit queue-drain batch. Rows are from the old cards schema. */
      async upsertDocuments(rows: readonly Record<string, unknown>[]) {
        ready(); batchIds(rows.map((row) => String(row.id)));
        if (!rows.length) return;
        const documents = rows.map((row) => buildSearchDocument(row, Date.now()));
        await lexical.mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(makeArrowTable(documents, { schema }));
      },
      async deleteDocuments(ids: readonly string[]) {
        ready(); const selected = batchIds(ids);
        if (selected.length) await lexical.delete(`id IN (${selected.map(quoted).join(', ')})`);
      },
      /** Only explicitly supplied embeddings are written; reads never reembed. */
      async upsertVectorDocuments(rows: readonly { document: Record<string, unknown>; vector: number[]; section?: string; text?: string }[]) {
        ready(); batchIds(rows.map((row) => String(row.document.id)));
        if (!rows.length) return;
        if (!vectorTable || !dimensions) throw new ArchiveError('UNAVAILABLE', 'Existing Archive has no vector table to update');
        const documents = rows.map((row) => {
          const document = buildSearchDocument(row.document, Date.now());
          return { ...document, card_id: document.id, section: row.section ?? 'card', matchText: row.text ?? String(document.description), vector: normalizedVector(row.vector, dimensions!) };
        });
        await vectorTable.mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(makeArrowTable(documents, { schema: await vectorTable.schema() }));
      },
      /** Incremental vector queue work only. The old ETL embeds normalized
       * searchText, capped at 24k estimated tokens (96k characters), without the
       * query instruction. Existing rows elsewhere are never reembedded. */
      async indexVectorDocuments(rows: readonly Record<string, unknown>[], embedder: DocumentEmbedder, signal?: AbortSignal): Promise<IndexedVectorMetadata[]> {
        ready(); batchIds(rows.map((row) => String(row.id)));
        if (!rows.length) return [];
        if (!vectorTable || !dimensions || !options.databasePath) throw new ArchiveError('UNAVAILABLE', 'Incremental vector indexing needs the existing vector table and database metadata');
        const stored = readExistingVectorMetadata(options.databasePath);
        if (stored.model !== embedder.space.model || stored.dimensions !== dimensions || dimensions !== embedder.space.dimensions
          || (stored.cardsIndex && stored.cardsIndex !== vectorName)) invalid('Document embedding provider does not match the existing vector generation');
        const prepared = rows.map((row) => {
          const document = buildSearchDocument(row, Date.now());
          const text = toUSVString(String(document.searchText).slice(0, 96_000));
          if (!text.trim()) invalid('Existing Archive card has no text to embed');
          return { document, text, textHash: createHash('sha256').update(text).digest('hex') };
        });
        signal?.throwIfAborted();
        // Stats-only updates also enter the old queue. Match its durable text
        // digest/model/embedder and reuse a present vector while refreshing the
        // filter/sort metadata; a missing vector still needs provider work.
        const reusable = new Set<string>();
        const db = new Database(resolve(options.databasePath), { readonly: true, fileMustExist: true });
        try {
          db.pragma('query_only = ON'); db.pragma('trusted_schema = OFF');
          const columns = new Set((db.prepare("PRAGMA table_info('card_embedding_meta')").all() as { name: string }[]).map((row) => row.name));
          if (['cardId', 'embedder_name', 'model_name', 'dims', 'section', 'chunk_index', 'text_sha256'].every((name) => columns.has(name))) {
            const generationColumns = new Set((db.prepare("PRAGMA table_info('vector_generations')").all() as { name: string }[]).map((row) => row.name));
            const generation = generationColumns.has('embedder_name')
              ? db.prepare('SELECT embedder_name FROM vector_generations WHERE active = 1 LIMIT 1').get() as { embedder_name: string } | undefined : undefined;
            const names = generation ? [generation] : db.prepare('SELECT DISTINCT embedder_name FROM card_embedding_meta WHERE model_name = ? AND dims = ? LIMIT 2').all(stored.model, dimensions) as { embedder_name: string }[];
            if (names.length === 1 && names[0]!.embedder_name) {
              const ids = prepared.map((row) => String(row.document.id));
              const metadata = db.prepare(`SELECT CAST(cardId AS TEXT) AS cardId,text_sha256 FROM card_embedding_meta
                WHERE cardId IN (${ids.map(() => '?').join(',')}) AND embedder_name = ? AND model_name = ? AND dims = ? AND section = 'card' AND chunk_index = 0`)
                .all(...ids, names[0]!.embedder_name, stored.model, dimensions) as { cardId: string; text_sha256: string }[];
              const hashes = new Map(metadata.map((row) => [row.cardId, row.text_sha256]));
              for (const row of prepared) if (hashes.get(String(row.document.id)) === row.textHash) reusable.add(String(row.document.id));
            }
          }
        } finally { db.close(); }
        const retained = new Map<string, number[]>();
        // Legacy Lance ETL did not write whole-card SQLite digests. An active
        // generation proves this table's model identity; its exact existing
        // matchText can establish the missing digest without provider work.
        const probeIds = stored.cardsIndex === vectorName ? new Set(prepared.map((row) => String(row.document.id))) : reusable;
        if (probeIds.size) {
          const sourceTexts = new Map(prepared.map((row) => [String(row.document.id), row.text]));
          const previous = await vectorTable.query().where(`id IN (${[...probeIds].map(quoted).join(',')}) AND section = 'card'`)
            .select(['id', 'card_id', 'matchText', 'vector']).limit(probeIds.size + 1).toArray({ timeoutMs: 15_000 });
          const seen = new Set<string>();
          for (const row of previous) {
            const id = cardId(row.id);
            if (!probeIds.has(id) || row.card_id !== id || seen.has(id) || !row.vector) throw new ArchiveError('INTEGRITY', 'Existing vector reuse returned invalid or duplicate IDs');
            seen.add(id);
            if (!reusable.has(id) && row.matchText !== sourceTexts.get(id)) continue;
            const vector = Array.from(row.vector as Iterable<number>);
            normalizedVector(vector, dimensions); // Validate, then retain the stored Float32 values exactly.
            retained.set(id, vector);
          }
          const refresh = prepared.filter((row) => retained.has(String(row.document.id))).map(({ document, text }) => ({ ...document,
            card_id: document.id, section: 'card', matchText: text, vector: retained.get(String(document.id))! }));
          signal?.throwIfAborted();
          if (refresh.length) await vectorTable.mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(makeArrowTable(refresh, { schema: await vectorTable.schema() }));
        }
        const pending = prepared.filter((row) => !retained.has(String(row.document.id)));
        let offset = 0;
        while (offset < pending.length) {
          signal?.throwIfAborted();
          const batch: typeof prepared = []; let characters = 0;
          while (offset < pending.length && batch.length < 128) {
            const row = pending[offset]!;
            if (batch.length && characters + row.text.length > 96_000) break;
            batch.push(row); characters += row.text.length; offset++;
          }
          const embedded = await embedder.embed(batch.map((row) => row.text), signal);
          if (embedded.length !== batch.length) invalid('Document embedding response does not match its existing-card batch');
          signal?.throwIfAborted();
          const documents = batch.map(({ document, text }, index) => ({ ...document, card_id: document.id, section: 'card', matchText: text,
            vector: normalizedVector(embedded[index], dimensions!) }));
          await vectorTable.mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(makeArrowTable(documents, { schema: await vectorTable.schema() }));
        }
        signal?.throwIfAborted();
        return prepared.map(({ document, textHash }) => ({ cardId: String(document.id), textHash, model: stored.model, dimensions }));
      },
      async deleteVectorDocuments(ids: readonly string[]) {
        ready(); const selected = batchIds(ids);
        if (selected.length && vectorTable) await vectorTable.delete(`card_id IN (${selected.map(quoted).join(', ')})`);
      },
      close() {
        if (closed) return;
        closed = true; vectorTable?.close(); lexical.close(); connection.close();
      },
    };
  } catch (error) { vectors?.close(); table?.close(); connection.close(); throw error; }
}
export type ExistingSearch = Awaited<ReturnType<typeof openExistingSearch>>;
