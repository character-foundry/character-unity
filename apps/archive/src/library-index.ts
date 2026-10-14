import { createHash } from 'node:crypto';
import { connect, Index, makeArrowTable } from '@lancedb/lancedb';
import { Bool, DataType, Field, FixedSizeList, Float32, Float64, Schema, Utf8 } from 'apache-arrow';
import { ArchiveError } from '@character-unity/archive-client/contract';
import type { SearchMatch } from '@character-unity/archive-client';
import type { LibraryIndexMutation, LibraryIndexProjection } from '@character-unity/archive-client/native';
import { fold } from '@character-unity/store/library-query';
import type { ArchiveCardSummary } from './native/store.js';
import type { ArchiveQuery } from './native/query.js';
import { normalizedVector } from './embeddings.js';
import type { DocumentEmbedder, QueryEmbedder } from './embeddings.js';
import { buildSearchDocument, searchDocumentSchema, searchSourceColumns } from './search-document.js';
import { compileSearchFilterPlan, searchFilterFields } from './search-filter.js';
import { compileTagGroupFilter } from './tag-group-filter.js';
import { evaluateSearch, parseSearchExpression } from './search-query.js';
import { hybridRank } from './semantic-search.js';

export type LibraryProjection = LibraryIndexProjection;
export type LibraryIndexEvent = LibraryIndexMutation;
export interface LibrarySearchCard extends ArchiveCardSummary { libraryOwned: true; libraryCardId: string; hasPortrait: boolean }
export interface LibrarySearchResult {
  cards: LibrarySearchCard[]; scores: Map<string, number>; matches: Map<string, SearchMatch>; complete: boolean; snapshot: string;
}
export interface LibraryIndexOptions {
  lanceDirectory: string; space: { model: string; dimensions: number };
  queryEmbedder?: QueryEmbedder; documentEmbedder?: DocumentEmbedder;
}
const tableName = 'unity_library_search_v1';
const tagPolicyKey = 'unity.library.tag-policy', exactTagPolicy = 'exact-ascii-v1';
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const textFields = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions'] as const;
function invalid(message: string): never { throw new ArchiveError('INVALID_INPUT', message); }
function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) invalid(`Invalid library index ${label}`);
  return value;
}
function boundedText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || value.length > max) invalid(`Invalid library projection ${label}`);
  return value;
}
function date(value: unknown, label: string): string {
  const result = boundedText(value, 40, label);
  if (!Number.isFinite(Date.parse(result))) invalid(`Invalid library projection ${label}`);
  return new Date(result).toISOString();
}
/** Projection only. No original document, assets, arbitrary path or provider URL
 * is accepted by this Archive-owned write endpoint. */
export function libraryIndexEvent(raw: unknown): LibraryIndexEvent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('Expected library index event');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['workspaceId', 'cardId', 'revisionId', 'operation', 'eventSequence', 'projection'].includes(key))) invalid('Unknown library index event field');
  const event: LibraryIndexEvent = { workspaceId: identity(value.workspaceId, 'workspace'), cardId: identity(value.cardId, 'card'),
    revisionId: identity(value.revisionId, 'revision'), operation: value.operation as LibraryIndexEvent['operation'], eventSequence: value.eventSequence as number };
  if (!['upsert', 'delete'].includes(event.operation) || !Number.isSafeInteger(event.eventSequence) || event.eventSequence < 1) invalid('Invalid library index operation or sequence');
  if (event.operation === 'delete') {
    if (value.projection !== undefined) invalid('A deleted library index entry has no projection');
    return event;
  }
  if (!value.projection || typeof value.projection !== 'object' || Array.isArray(value.projection)) invalid('An upsert needs its revision projection');
  const p = value.projection as Record<string, unknown>;
  if (Object.keys(p).some((key) => !['name', 'creator', 'tags', 'spec', 'tokens', ...textFields, 'alternate_greetings', 'createdAt', 'updatedAt', 'lorebookEntries', 'flags', 'hasPortrait'].includes(key))) invalid('Unknown library projection field');
  if (p.spec !== 'v2' && p.spec !== 'v3') invalid('Invalid library projection format');
  if (typeof p.tokens !== 'number' || !Number.isSafeInteger(p.tokens) || p.tokens < 0 || p.tokens > 10_000_000) invalid('Invalid library projection tokens');
  if (!Array.isArray(p.tags) || p.tags.length > 200 || !Array.isArray(p.alternate_greetings) || p.alternate_greetings.length > 1000) invalid('Invalid library projection lists');
  const projection: LibraryProjection = { name: boundedText(p.name, 500, 'name'), creator: boundedText(p.creator, 200, 'creator'),
    tags: p.tags.map((tag) => boundedText(tag, 120, 'tag')), spec: p.spec, tokens: p.tokens,
    description: '', personality: '', scenario: '', first_mes: '', mes_example: '', system_prompt: '', post_history_instructions: '',
    alternate_greetings: p.alternate_greetings.map((greeting) => boundedText(greeting, 1_000_000, 'greeting')),
    createdAt: date(p.createdAt, 'createdAt'), updatedAt: date(p.updatedAt, 'updatedAt') };
  for (const key of textFields) projection[key] = boundedText(p[key], 1_000_000, key);
  if (p.hasPortrait !== undefined && typeof p.hasPortrait !== 'boolean') invalid('Invalid library portrait flag');
  projection.hasPortrait = p.hasPortrait === true;
  if (p.lorebookEntries !== undefined) {
    if (typeof p.lorebookEntries !== 'number' || !Number.isSafeInteger(p.lorebookEntries) || p.lorebookEntries < 0 || p.lorebookEntries > 100_000) invalid('Invalid lorebook entry count');
    projection.lorebookEntries = p.lorebookEntries;
  }
  if (p.flags !== undefined) {
    if (!p.flags || typeof p.flags !== 'object' || Array.isArray(p.flags)) invalid('Invalid library flags');
    const flags = p.flags as Record<string, unknown>;
    if (Object.keys(flags).some((key) => !['gallery', 'expressions', 'embeddedImages', 'systemPrompt', 'exampleDialogues'].includes(key) || typeof flags[key] !== 'boolean')) invalid('Invalid library flag');
    projection.flags = { gallery: flags.gallery === true, expressions: flags.expressions === true, embeddedImages: flags.embeddedImages === true,
      systemPrompt: flags.systemPrompt === true, exampleDialogues: flags.exampleDialogues === true };
  }
  if (JSON.stringify(projection).length > 1_000_000) invalid('Library search projection exceeds 1 MiB');
  event.projection = projection;
  return event;
}
function summary(event: LibraryIndexEvent): LibrarySearchCard {
  const p = event.projection!;
  return { id: `unity:${event.cardId}`, libraryOwned: true, libraryCardId: event.cardId, provider: 'unity', recordId: event.cardId,
    url: '', name: p.name, creator: p.creator, tagline: '', tags: p.tags, spec: p.spec, tokens: p.tokens,
    altGreetings: p.alternate_greetings.length, lorebookEntries: p.lorebookEntries ?? 0,
    flags: { gallery: p.flags?.gallery ?? false, expressions: p.flags?.expressions ?? false, embeddedImages: p.flags?.embeddedImages ?? false,
      systemPrompt: p.flags?.systemPrompt ?? !!p.system_prompt.trim(), exampleDialogues: p.flags?.exampleDialogues ?? !!p.mes_example.trim() },
    stats: {}, portrait: null, hasPortrait: p.hasPortrait === true, remoteCreatedAt: p.createdAt, remoteUpdatedAt: p.updatedAt,
    firstSeenAt: p.createdAt, changedAt: p.updatedAt, versionId: event.revisionId, versions: 1 };
}
function projectionDocument(event: LibraryIndexEvent) {
  const p = event.projection, card = p ? summary(event) : undefined;
  const source: Record<string, unknown> = Object.fromEntries(searchSourceColumns.map((column) => [column, null]));
  Object.assign(source, { id: event.cardId, name: p?.name ?? '', author: p?.creator ?? '', source: 'unity', sourceId: event.cardId,
    topics: p?.tags.join(', ') ?? '', tokenCount: p?.tokens ?? 0, description: p?.description ?? '', createdAt: p?.createdAt ?? '', lastModified: p?.updatedAt ?? '',
    hasAlternateGreetings: !!p?.alternate_greetings.length, hasLorebook: !!p?.lorebookEntries, hasGallery: !!card?.flags.gallery,
    hasExpressions: !!card?.flags.expressions, hasEmbeddedImages: !!card?.flags.embeddedImages, hasSystemPrompt: !!card?.flags.systemPrompt, hasExampleDialogues: !!card?.flags.exampleDialogues });
  const document = buildSearchDocument(source, Date.now());
  if (p) {
    // Owned projections already have exact arrays. The legacy CSV projection
    // must not split literal commas or apply Unicode-wide case folding here.
    document.tags = document.topics = p.tags.map(fold);
    document.searchText = [p.name, p.creator, p.tags.join(' '), ...textFields.map((key) => p[key]), ...p.alternate_greetings].filter(Boolean).join('\n');
  }
  return { ...document, searchText: String(document.searchText), workspaceId: event.workspaceId, revisionId: event.revisionId, eventSequence: event.eventSequence,
    deleted: event.operation === 'delete', libraryHasPortrait: p?.hasPortrait === true,
    summary: card ? JSON.stringify(card) : '', matchText: String(document.searchText).slice(0, 8192) };
}

/** A supplementary projection in the same Lance directory, never another
 * authoritative corpus. Opening and reads create nothing and embed nothing but
 * query text; only explicit outbox deliveries write/compute document vectors. */
export async function openLibraryIndex(options: LibraryIndexOptions) {
  if (!options.space.model.trim() || !Number.isSafeInteger(options.space.dimensions) || options.space.dimensions < 1 || options.space.dimensions > 4096) invalid('Invalid library embedding space');
  for (const provider of [options.queryEmbedder, options.documentEmbedder]) if (provider && (provider.space.model !== options.space.model || provider.space.dimensions !== options.space.dimensions)) invalid('Library embeddings must use the existing Archive model and dimensions');
  const schema = new Schema([...searchDocumentSchema.fields,
    new Field('workspaceId', new Utf8(), false), new Field('revisionId', new Utf8(), false), new Field('eventSequence', new Float64(), false),
    new Field('deleted', new Bool(), false), new Field('summary', new Utf8(), false),
    new Field('libraryHasPortrait', new Bool(), false),
    new Field('matchText', new Utf8(), false),
    new Field('vector', new FixedSizeList(options.space.dimensions, new Field('item', new Float32(), true)), true),
  ], new Map([['unity.library.model', options.space.model], ['unity.library.dimensions', String(options.space.dimensions)],
    // Creation only: a later partial upsert must never bless an old table.
    [tagPolicyKey, exactTagPolicy]]));
  const connection = await connect(options.lanceDirectory, { readConsistencyInterval: 0 });
  let table: Awaited<ReturnType<typeof connection.openTable>> | undefined, closed = false;
  let writes = Promise.resolve();
  const verifiedTags = new Map<string, number>();
  const semantic = !!(options.queryEmbedder && options.documentEmbedder);
  async function getTable(create = false) {
    if (closed) throw new ArchiveError('UNAVAILABLE', 'Library search index is closed');
    if (!table) {
      const candidate = (await connection.tableNames()).includes(tableName) ? await connection.openTable(tableName)
        : create ? await connection.createEmptyTable(tableName, schema) : undefined;
      if (!candidate) return undefined;
      try {
        const actual = await candidate.schema(), vector = actual.fields.find((field) => field.name === 'vector');
        if (actual.metadata.get('unity.library.model') !== options.space.model || actual.metadata.get('unity.library.dimensions') !== String(options.space.dimensions)
          || !vector || !DataType.isFixedSizeList(vector.type) || vector.type.listSize !== options.space.dimensions) throw new ArchiveError('UNAVAILABLE', 'Library search index uses another embedding space; explicitly rebuild its projections before switching models');
        table = candidate;
      } catch (error) { candidate.close(); throw error; }
    }
    return table;
  }
  async function ensureFts(selected: NonNullable<typeof table>) {
    if (!(await selected.listIndices()).some((index) => index.indexType === 'FTS' && index.columns.includes('searchText'))) {
      await selected.createIndex('searchText', { config: Index.fts({ withPosition: true, lowercase: true, asciiFolding: true }) });
    }
  }
  async function verifyLegacyTags(selected: NonNullable<typeof table>, workspaceId: string, version: number, columns: string[], signal: AbortSignal) {
    if (verifiedTags.get(workspaceId) === version) return;
    const refuse = () => { throw new ArchiveError('UNAVAILABLE', 'This workspace has unverified legacy tag projections; explicitly rebuild its owned search projections before using tag filters'); };
    let count = 0, bytes = 0;
    const deadline = Date.now() + 15_000;
    for (let offset = 0; offset <= 10_000; offset += 64) {
      signal.throwIfAborted();
      const limit = Math.min(64, 10_001 - offset);
      const rows = await selected.query().where(`workspaceId = ${quote(workspaceId)} AND deleted = false`)
        .select(['summary', ...columns]).offset(offset).limit(limit).toArray({ timeoutMs: Math.max(1, deadline - Date.now()) });
      for (const row of rows) {
        if (++count > 10_000 || typeof row.summary !== 'string' || row.summary.length > 65_536 || (bytes += Buffer.byteLength(row.summary)) > 8 * 1024 * 1024) refuse();
        let raw: unknown;
        try { raw = JSON.parse(row.summary); } catch { refuse(); }
        if (!raw || typeof raw !== 'object' || !('tags' in raw) || !Array.isArray(raw.tags) || raw.tags.length > 200
          || raw.tags.some((tag: unknown) => typeof tag !== 'string' || tag.length > 120)) refuse();
        const expected = (raw as { tags: string[] }).tags.map(fold);
        for (const column of columns) {
          const value: unknown = row[column];
          if (!value || typeof value !== 'object' || !(Symbol.iterator in value) || typeof value[Symbol.iterator] !== 'function') refuse();
          let index = 0;
          for (const tag of value as Iterable<unknown>) if (typeof tag !== 'string' || tag !== expected[index++]) refuse();
          if (index !== expected.length) refuse();
          for (const tag of expected) bytes += Buffer.byteLength(tag);
          if (bytes > 8 * 1024 * 1024) refuse();
        }
      }
      if (rows.length < limit) break;
      if (Date.now() >= deadline) refuse();
    }
    signal.throwIfAborted();
    if (version !== await selected.version()) throw new ArchiveError('SNAPSHOT_CHANGED', 'Library projections changed during tag validation; retry the search');
    if (verifiedTags.size >= 128) verifiedTags.clear();
    verifiedTags.set(workspaceId, version);
  }
  return {
    capabilities: { enabled: true, semantic, ...(!semantic ? { reason: 'The existing Archive embedding provider is not configured; library upserts remain pending' } : {}) },
    async apply(raw: unknown, signal?: AbortSignal) {
      const event = libraryIndexEvent(raw);
      if (event.operation === 'upsert' && !options.documentEmbedder) throw new ArchiveError('UNAVAILABLE', 'Library indexing needs the existing Archive document embedding provider; the delivery must remain pending for retry');
      let response = { eventSequence: event.eventSequence, applied: false, semantic };
      const operation = writes.then(async () => {
        signal?.throwIfAborted();
        const existing = await getTable();
        const predicate = `workspaceId = ${quote(event.workspaceId)} AND id = ${quote(event.cardId)}`;
        const current = existing ? await existing.query().where(predicate).select(['eventSequence', 'revisionId', 'deleted']).limit(2).toArray({ timeoutMs: 15_000 }) : [];
        if (current.length > 1) throw new ArchiveError('INTEGRITY', 'Duplicate library projection identity');
        if (current[0] && Number(current[0].eventSequence) >= event.eventSequence) {
          if (Number(current[0].eventSequence) === event.eventSequence && (current[0].revisionId !== event.revisionId || current[0].deleted !== (event.operation === 'delete'))) invalid('A library index sequence cannot identify two different events');
          await ensureFts(existing!); return;
        }
        const document = projectionDocument(event);
        let vector: number[] | null = null;
        if (event.operation === 'upsert') {
          const vectors = await options.documentEmbedder!.embed([String(document.searchText).slice(0, 96_000)], signal);
          if (vectors.length !== 1) throw new ArchiveError('INTEGRITY', 'Library embedding response did not match its projection');
          vector = normalizedVector(vectors[0], options.space.dimensions);
        }
        signal?.throwIfAborted();
        const selected = await getTable(true);
        const result = await selected!.mergeInsert(['workspaceId', 'id']).whenMatchedUpdateAll({ where: 'target.eventSequence < source.eventSequence' }).whenNotMatchedInsertAll()
          .execute(makeArrowTable([{ ...document, vector }], { schema }), { timeoutMs: 25_000 });
        await ensureFts(selected!);
        signal?.throwIfAborted();
        response = { eventSequence: event.eventSequence, applied: result.numInsertedRows + result.numUpdatedRows > 0, semantic: !!vector || event.operation === 'delete' && semantic };
      });
      writes = operation.catch(() => undefined);
      await operation; return response;
    },
    async search(workspaceId: string, query: ArchiveQuery): Promise<LibrarySearchResult> {
      identity(workspaceId, 'workspace'); query.signal?.throwIfAborted();
      const selected = await getTable();
      if (!selected) return { cards: [], scores: new Map(), matches: new Map(), complete: true, snapshot: 'absent' };
      const signal = AbortSignal.any([AbortSignal.timeout(25_000), ...(query.signal ? [query.signal] : [])]);
      const before = await selected.version(), actualSchema = await selected.schema(), fields = searchFilterFields(actualSchema), filters = [`workspaceId = ${quote(workspaceId)}`, 'deleted = false'];
      const filterPlan = compileSearchFilterPlan(query.filter ?? '', fields, { listCase: 'ascii' });
      filters.push(filterPlan.sql);
      if (query.provider) filters.push(`source = ${quote(query.provider)}`);
      if (query.minTokens) filters.push(`tokenCount >= ${query.minTokens}`);
      const tagFilter = compileTagGroupFilter(query, fields);
      if ((tagFilter || filterPlan.listFields.length) && actualSchema.metadata.get(tagPolicyKey) !== exactTagPolicy) {
        await verifyLegacyTags(selected, workspaceId, before, fields.filter((field) => ['tags', 'topics'].includes(field.name) && field.type === 'strings').map((field) => field.name), signal);
      }
      filters.push(tagFilter);
      const flagFields = { greetings: 'hasAlternateGreetings', lorebook: 'hasLorebook', gallery: 'hasGallery', expressions: 'hasExpressions', embeddedImages: 'hasEmbeddedImages', systemPrompt: 'hasSystemPrompt', exampleDialogues: 'hasExampleDialogues' };
      for (const flag of query.has ?? []) {
        if (flag === 'portrait') filters.push('libraryHasPortrait = true');
        else if (flag === 'followed') filters.push(query.creators?.length ? `LOWER(author) IN (${query.creators.map((creator) => quote(creator.trim().toLowerCase())).join(',')})` : 'false');
        else filters.push(`${flagFields[flag]} = true`);
      }
      const predicate = filters.filter(Boolean).map((value) => `(${value})`).join(' AND '), cards = new Map<string, LibrarySearchCard>();
      const matches = new Map<string, SearchMatch>();
      function remember(row: Record<string, unknown>): string {
        if (typeof row.id !== 'string' || typeof row.summary !== 'string') throw new ArchiveError('INTEGRITY', 'Invalid library projection metadata');
        const card = JSON.parse(row.summary) as LibrarySearchCard;
        if (card.libraryOwned !== true || card.libraryCardId !== row.id || card.id !== `unity:${row.id}`) throw new ArchiveError('INTEGRITY', 'Library projection identity does not match its row');
        cards.set(card.id, card); return card.id;
      }
      async function lexical(): Promise<Map<string, number>> {
        const universe = await selected!.query().where(predicate).select(['id', 'summary']).limit(10_001).toArray({ timeoutMs: 15_000 });
        if (universe.length > 10_000) throw new ArchiveError('TOO_LARGE', 'Narrow library projection filters to at most 10,000 candidates');
        const ids = universe.map(remember);
        if (!query.q?.trim()) return new Map(ids.map((id) => [id, 0]));
        const result = await evaluateSearch(parseSearchExpression(query.q), ids, async (term) => {
          signal.throwIfAborted();
          const rows = await selected!.search(term, 'fts', 'searchText').where(predicate).select(['id', 'summary', '_score']).limit(10_001).toArray({ timeoutMs: 15_000 });
          if (rows.length > 10_000) throw new ArchiveError('TOO_LARGE', 'Narrow library lexical search to at most 10,000 candidates');
          return new Map(rows.map((row) => [remember(row), Number(row._score)]));
        });
        return new Map([...result].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)));
      }
      let scores: Map<string, number>, complete = true;
      if (!query.mode || query.mode === 'lexical' || query.mode === 'browse') scores = await lexical();
      else {
        if (!options.queryEmbedder) throw new ArchiveError('UNAVAILABLE', 'Library semantic search requires the existing Archive embedding provider');
        const vector = normalizedVector(await options.queryEmbedder.embed(query.q!, signal), options.space.dimensions);
        const rows = await selected.vectorSearch(vector).column('vector').distanceType('cosine').where(predicate)
          .select(['id', 'summary', 'matchText', '_distance']).limit(400).toArray({ timeoutMs: 15_000 });
        scores = new Map(); complete = false;
        for (const row of rows) {
          const id = remember(row), distance = Number(row._distance);
          if (!Number.isFinite(distance) || distance < -0.00001 || distance > 2.00001 || typeof row.matchText !== 'string') throw new ArchiveError('INTEGRITY', 'Invalid library semantic match');
          const score = 1 / (1 + Math.max(0, distance));
          scores.set(id, score); matches.set(id, { section: 'card', text: row.matchText.slice(0, 8192), score });
        }
        if (query.mode === 'hybrid') scores = hybridRank(scores, await lexical(), 0.4, 60, new Map([...cards].map(([id, card]) => [id, card.name])), query.q!);
      }
      signal.throwIfAborted();
      if (before !== await selected.version()) throw new ArchiveError('SNAPSHOT_CHANGED', 'Library projections changed during the search; start from the first page');
      return { cards: [...scores.keys()].map((id) => cards.get(id)!), scores, matches, complete,
        snapshot: createHash('sha256').update(JSON.stringify([workspaceId, before, [...scores]])).digest('hex') };
    },
    async snapshot() { const selected = await getTable(); return selected ? String(await selected.version()) : 'absent'; },
    async close() { if (closed) return; closed = true; await writes; table?.close(); connection.close(); },
  };
}
export type LibraryIndex = Awaited<ReturnType<typeof openLibraryIndex>>;
