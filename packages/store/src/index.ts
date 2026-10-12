import { commitSyncMutation, readSyncReceipt, requireSyncWrite, snapshotSyncContext } from './sync-operations.js';
import type { SyncWriteContext, SyncMutationTarget } from './sync-operations.js';
import { createHubStore } from './hub.js';
import type { Statement, StoreDriver } from './driver.js';
import { inspectSchema, schemaVersion } from './migrations.js';
import { StoreError } from './types.js';
import { fold, libraryFilterSql, librarySortSql, librarySourceSql, libraryTokensSql } from './library-query.js';

const notDeleted = 'NOT EXISTS (SELECT 1 FROM unity_card_deletions d WHERE d.card_id = c.id)';
import type { Asset, Card, CardSource, CardSourceInput, CardSummaryPage, CardSummaryQuery, ContentIdentity, PublicationForkGuard, Revision, RevisionAsset, RevisionInput, Workspace } from './types.js';
import * as validate from './validation.js';
export * from './types.js';
export { isLibraryFlag, isLibrarySort, libraryFlags, librarySorts, librarySources, parseLibraryQuery } from './library-query.js';
export type { LibraryFilter, LibraryFlag, LibrarySort, LibrarySource, QueryNode } from './library-query.js';

interface RevisionRow {
  id: string; sequence: number; cardId: string; workspaceId: string; parentRevisionId: string | null;
  authorId: string; algorithm: string; hash: string; document: string; createdAt: string;
}
const cardColumns = `id, workspace_id AS workspaceId, head_revision_id AS headRevisionId,
  original_hash AS originalHash, forked_from_revision_id AS forkedFromRevisionId, created_at AS createdAt`;
const assetColumns = `id, workspace_id AS workspaceId, content_hash AS hash, byte_length AS byteLength,
  media_type AS mediaType, storage_key AS storageKey, state`;
const revisionColumns = `id, sequence, card_id AS cardId, workspace_id AS workspaceId, parent_revision_id AS parentRevisionId,
  author_id AS authorId, content_algorithm AS algorithm, content_hash AS hash, document_json AS document, created_at AS createdAt`;

function translate(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('UNITY_PUBLICATION_ACCESS')) throw new StoreError('ACCESS_CHANGED', 'Publication access changed; reload before forking', { cause: error });
  if (message.includes('UNITY_HEAD_CONFLICT')) throw new StoreError('HEAD_CONFLICT', 'The card has a newer revision; reload before saving', { cause: error });
  if (message.includes('UNITY_ASSET_NOT_READY')) throw new StoreError('ASSET_NOT_READY', 'An asset is missing, staged, or belongs to another workspace', { cause: error });
  if (/constraint|UNITY_IMMUTABLE/i.test(message)) throw new StoreError('INTEGRITY', 'A store integrity constraint rejected the operation', { cause: error });
  throw error;
}

/** Trusted application repository. Authentication and source-publication access checks belong to the host. */
export function createStore(driver: StoreDriver) {
  async function batch(statements: readonly Statement[]) {
    try { return await driver.batch(statements); } catch (error) { translate(error); }
  }
  async function workspace(id: string): Promise<Workspace> {
    validate.text(id, 'workspaceId');
    const [row] = await driver.query<Workspace>({ sql: `SELECT id, owner_id AS ownerId, name, created_at AS createdAt
      FROM unity_workspaces WHERE id = ?`, params: [id] });
    if (!row) throw new StoreError('NOT_FOUND', 'Workspace not found');
    return row;
  }
  /** Read-after-write of a card this call just inserted; no tombstone can exist for it yet. */
  async function insertedCard(workspaceId: string, cardId: string): Promise<Card> {
    const [row] = await driver.query<Card>({ sql: `SELECT ${cardColumns} FROM unity_cards WHERE workspace_id = ? AND id = ?`, params: [workspaceId, cardId] });
    if (!row) throw new StoreError('NOT_FOUND', 'Card not found in this workspace');
    return row;
  }
  async function getCard(workspaceId: string, cardId: string): Promise<Card> {
    const [row] = await driver.query<Card>({ sql: `SELECT ${cardColumns} FROM unity_cards WHERE workspace_id = ? AND id = ?
      AND NOT EXISTS (SELECT 1 FROM unity_card_deletions d WHERE d.card_id = unity_cards.id)`, params: [workspaceId, cardId] });
    if (!row) throw new StoreError('NOT_FOUND', 'Card not found in this workspace');
    return row;
  }
  async function getRevision(workspaceId: string, revisionId: string): Promise<Revision> {
    const [row] = await driver.query<RevisionRow>({ sql: `SELECT ${revisionColumns} FROM unity_revisions
      WHERE workspace_id = ? AND id = ? AND id IN (SELECT revision_id FROM unity_revision_seals)`, params: [workspaceId, revisionId] });
    if (!row) throw new StoreError('NOT_FOUND', 'Revision not found in this workspace');
    const assets = await driver.query<RevisionAsset>({ sql: `SELECT path, asset_id AS assetId FROM unity_revision_assets
      WHERE workspace_id = ? AND revision_id = ? ORDER BY path`, params: [workspaceId, revisionId] });
    const { algorithm, hash, document, ...rest } = row;
    return { ...rest, document: JSON.parse(document) as Revision['document'], identity: { algorithm, hash }, assets };
  }
  async function getAsset(workspaceId: string, assetId: string): Promise<Asset> {
    const [row] = await driver.query<Asset>({ sql: `SELECT ${assetColumns} FROM unity_assets WHERE workspace_id = ? AND id = ?
      AND NOT EXISTS (SELECT 1 FROM unity_asset_retirements WHERE asset_id = unity_assets.id)`, params: [workspaceId, assetId] });
    if (!row) throw new StoreError('NOT_FOUND', 'Asset not found in this workspace');
    return row;
  }
  async function getSource(workspaceId: string, cardId: string): Promise<CardSource | null> {
    await getCard(workspaceId, cardId);
    const [row] = await driver.query<{ cardId: string; workspaceId: string; assetId: string; provenance: string }>({
      sql: `SELECT card_id AS cardId, workspace_id AS workspaceId, asset_id AS assetId, provenance_json AS provenance
        FROM unity_card_sources WHERE workspace_id = ? AND card_id = ?`, params: [workspaceId, cardId],
    });
    return row ? { ...row, provenance: JSON.parse(row.provenance) as CardSource['provenance'] } : null;
  }
  function sourceStatements(workspaceId: string, cardId: string, source?: CardSourceInput): Statement[] {
    if (!source) return [];
    validate.text(source.assetId, 'source assetId');
    const provenance = validate.document(source.provenance, 8192);
    return [{ sql: 'INSERT INTO unity_card_sources(card_id, workspace_id, asset_id, provenance_json) VALUES (?, ?, ?, ?)',
      params: [cardId, workspaceId, source.assetId, provenance] }];
  }
  function revisionStatements(workspaceId: string, cardId: string, parent: string | null, input: RevisionInput) {
    // Snapshot all caller-owned values before the first await; never store mutable references.
    const encoded = validate.revision(input);
    const id = crypto.randomUUID();
    const statements: Statement[] = [{
      sql: `INSERT INTO unity_revisions(id, card_id, workspace_id, parent_revision_id, author_id,
        content_algorithm, content_hash, document_json, created_at, sequence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT r.sequence FROM unity_revisions r
          JOIN unity_cards c ON c.head_revision_id = r.id WHERE c.id = ?), 0) + 1)`,
      params: [id, cardId, workspaceId, parent, input.authorId, input.identity.algorithm, input.identity.hash, encoded, new Date().toISOString(), cardId],
    }];
    for (const asset of input.assets ?? []) statements.push({
      sql: 'INSERT INTO unity_revision_assets(revision_id, workspace_id, path, asset_id) VALUES (?, ?, ?, ?)',
      params: [id, workspaceId, asset.path, asset.assetId],
    });
    statements.push({ sql: 'INSERT INTO unity_revision_seals(revision_id) VALUES (?)', params: [id] });
    return { id, statements };
  }
  async function createCard(input: RevisionInput & { workspaceId: string; originalHash?: string; source?: CardSourceInput }) {
    const { workspaceId } = input;
    const originalHash = input.originalHash === undefined ? null : validate.hash(input.originalHash);
    const id = crypto.randomUUID();
    const revision = revisionStatements(workspaceId, id, null, input);
    const source = sourceStatements(workspaceId, id, input.source);
    await workspace(workspaceId);
    await batch([
      { sql: `INSERT INTO unity_cards(id, workspace_id, original_hash, created_at) VALUES (?, ?, ?, ?)`,
        params: [id, workspaceId, originalHash, new Date().toISOString()] },
      ...source, ...revision.statements,
    ]);
    return { card: await insertedCard(workspaceId, id), revision: await getRevision(workspaceId, revision.id) };
  }
  async function saveRevision(input: RevisionInput & { workspaceId: string; cardId: string; expectedHead: string }) {
    const { workspaceId, cardId, expectedHead } = input;
    validate.text(expectedHead, 'expectedHead');
    const revision = revisionStatements(workspaceId, cardId, expectedHead, input);
    await getCard(workspaceId, cardId);
    await batch(revision.statements);
    return getRevision(workspaceId, revision.id);
  }
  async function syncForkResult(context: SyncWriteContext, target: SyncMutationTarget, ids: readonly string[]) {
    if (ids.length !== 2) throw new StoreError('INTEGRITY', 'Invalid sync fork receipt');
    const card = await getCard(target.workspaceId, ids[0]!);
    const revision = await getRevision(target.workspaceId, ids[1]!);
    const [source] = await driver.query<{ publicationId: string }>({ sql: 'SELECT publication_id AS publicationId FROM unity_publication_forks WHERE card_id = ?', params: [card.id] });
    if (!source || revision.cardId !== card.id || revision.authorId !== target.accountId) throw new StoreError('INTEGRITY', 'Sync fork receipt escaped its grant');
    await createHubStore(driver).canFork(target.accountId, source.publicationId);
    await requireSyncWrite(driver, context, target);
    return { card, revision };
  }
  async function forkCard(input: RevisionInput & { workspaceId: string; sourceWorkspaceId: string; sourceRevisionId: string; source?: CardSourceInput; publication?: PublicationForkGuard }, syncContext?: SyncWriteContext) {
    const context = snapshotSyncContext(syncContext);
    const { workspaceId, sourceWorkspaceId, sourceRevisionId } = input;
    const id = crypto.randomUUID();
    const revision = revisionStatements(workspaceId, id, sourceRevisionId, input);
    const sourceRows = sourceStatements(workspaceId, id, input.source);
    const guard = input.publication ? { ...input.publication } : undefined;
    if (guard) {
      validate.text(guard.publicationId, 'publicationId'); validate.text(guard.actorId, 'actorId');
      validate.count(guard.policyVersion, 'policyVersion');
    }
    const target: SyncMutationTarget = { scope: 'fork', accountId: input.authorId, workspaceId };
    if (context) {
      if (!guard || guard.actorId !== target.accountId) validate.invalid('Sync forks require an explicit publication guard for the granted account');
      const receipt = await readSyncReceipt(driver, context, target);
      if (receipt) return syncForkResult(context, target, receipt.result);
    }
    await workspace(workspaceId);
    const source = await getRevision(sourceWorkspaceId, sourceRevisionId);
    const parent = await getCard(sourceWorkspaceId, source.cardId);
    const statements: Statement[] = [
      { sql: `INSERT INTO unity_cards(id, workspace_id, original_hash, forked_from_revision_id, created_at) VALUES (?, ?, ?, ?, ?)`,
        params: [id, workspaceId, parent.originalHash, sourceRevisionId, new Date().toISOString()] },
      ...sourceRows, ...revision.statements,
      ...(guard ? [{ sql: 'INSERT INTO unity_publication_forks(card_id, publication_id, actor_id, policy_version) VALUES (?, ?, ?, ?)',
        params: [id, guard.publicationId, guard.actorId, guard.policyVersion] }] : []),
    ];
    if (context) {
      let ids: readonly string[];
      try { ids = await commitSyncMutation(driver, context, target, statements, [id, revision.id]); } catch (error) { translate(error); }
      return syncForkResult(context, target, ids);
    }
    await batch(statements);
    return { card: await insertedCard(workspaceId, id), revision: await getRevision(workspaceId, revision.id) };
  }
  return {
    async readiness() {
      const version = await inspectSchema(driver);
      if (version !== schemaVersion) throw new StoreError('SCHEMA_MISMATCH', 'Unity database requires migration');
      // Also prove the domain schema exists, not only the ledger.
      await driver.query({ sql: 'SELECT id FROM unity_cards LIMIT 0' });
      return { schemaVersion: version };
    },
    async createWorkspace(input: { ownerId: string; name: string }): Promise<Workspace> {
      const row = { id: crypto.randomUUID(), ownerId: validate.text(input.ownerId, 'ownerId'), name: validate.text(input.name, 'name'), createdAt: new Date().toISOString() };
      await batch([{ sql: 'INSERT INTO unity_workspaces(id, owner_id, name, created_at) VALUES (?, ?, ?, ?)', params: [row.id, row.ownerId, row.name, row.createdAt] }]);
      return row;
    },
    /** Host preflight: retry a committed fork before copying any more blobs. */
    async findSyncFork(authorId: string, workspaceId: string, syncContext: SyncWriteContext) {
      const context = snapshotSyncContext(syncContext)!;
      const target: SyncMutationTarget = { scope: 'fork', accountId: validate.text(authorId, 'authorId'), workspaceId: validate.text(workspaceId, 'workspaceId') };
      const receipt = await readSyncReceipt(driver, context, target);
      return receipt ? syncForkResult(context, target, receipt.result) : null;
    },
    getWorkspace: workspace,
    async listWorkspaces(ownerId: string) {
      validate.text(ownerId, 'ownerId');
      return driver.query<Workspace>({ sql: 'SELECT id, owner_id AS ownerId, name, created_at AS createdAt FROM unity_workspaces WHERE owner_id = ? ORDER BY created_at, id LIMIT 100', params: [ownerId] });
    },
    getCard, getRevision, getAsset, getSource, createCard, saveRevision, forkCard,
    async listCards(workspaceId: string, options: { limit?: number; afterId?: string } = {}) {
      return driver.query<Card>({ sql: `SELECT ${cardColumns} FROM unity_cards WHERE workspace_id = ? AND id > ?
        AND NOT EXISTS (SELECT 1 FROM unity_card_deletions d WHERE d.card_id = unity_cards.id) ORDER BY id LIMIT ?`,
        params: [workspaceId, options.afterId ?? '', validate.limit(options.limit)] });
    },
    /** Library browsing: filters and query syntax live in library-query.ts; newest-touched first by default. */
    async listCardSummaries(workspaceId: string, query: CardSummaryQuery = {}): Promise<CardSummaryPage> {
      const limit = validate.limit(query.limit ?? 48), offset = validate.count(query.offset ?? 0, 'offset');
      const where = ['c.workspace_id = ?', 'c.head_revision_id IS NOT NULL', notDeleted];
      const params: (string | number)[] = [validate.text(workspaceId, 'workspaceId')];
      const filter = libraryFilterSql({ ...query, tags: [...(query.tags ?? []), ...(query.tag?.trim() ? [query.tag] : [])] });
      where.push(...filter.where); params.push(...filter.params);
      if (query.forkOf) {
        where.push(`c.forked_from_revision_id IN (SELECT id FROM unity_revisions WHERE workspace_id = c.workspace_id AND card_id = ?)`);
        params.push(validate.text(query.forkOf, 'forkOf'));
      }
      if (query.ids) {
        if (query.ids.length === 0) return { items: [], total: 0 };
        if (query.ids.length > 100) throw new StoreError('INVALID_INPUT', 'At most 100 card IDs');
        where.push(`c.id IN (${query.ids.map(() => '?').join(', ')})`);
        params.push(...query.ids.map((id) => validate.text(id, 'cardId')));
      }
      const from = `FROM unity_cards c JOIN unity_revisions r ON r.id = c.head_revision_id
        LEFT JOIN unity_card_sources s ON s.card_id = c.id WHERE ${where.join(' AND ')}`;
      const [count] = await driver.query<{ total: number }>({ sql: `SELECT count(*) AS total ${from}`, params });
      const rows = await driver.query<Card & { sourceFormat: string | null; forkCount: number; favorite: number; tokensTotal: number | null; source: string }>({ sql: `SELECT
          c.id, c.workspace_id AS workspaceId, c.head_revision_id AS headRevisionId, c.original_hash AS originalHash,
          c.forked_from_revision_id AS forkedFromRevisionId, c.created_at AS createdAt,
          json_extract(s.provenance_json, '$.format') AS sourceFormat, ${librarySourceSql} AS source, ${libraryTokensSql} AS tokensTotal,
          EXISTS (SELECT 1 FROM unity_card_favorites v WHERE v.card_id = c.id) AS favorite,
          (SELECT count(*) FROM unity_cards f JOIN unity_revisions fr ON fr.id = f.forked_from_revision_id
            WHERE fr.card_id = c.id AND f.workspace_id = c.workspace_id
            AND NOT EXISTS (SELECT 1 FROM unity_card_deletions d WHERE d.card_id = f.id)) AS forkCount
        ${from} ORDER BY ${librarySortSql[query.sort ?? 'edited'] ?? librarySortSql.edited} LIMIT ? OFFSET ?`, params: [...params, limit, offset] });
      const items = await Promise.all(rows.map(async ({ sourceFormat, forkCount, favorite, tokensTotal, source, ...card }) =>
        ({ card, revision: await getRevision(workspaceId, card.headRevisionId), sourceFormat, forkCount: Number(forkCount),
          favorite: Boolean(favorite), tokensTotal: tokensTotal === null ? null : Number(tokensTotal), source })));
      return { items, total: Number(count?.total ?? 0) };
    },
    /** Every tag on current card versions with how many cards carry it, grouped case-insensitively. */
    async listCardTags(workspaceId: string, options: { limit?: number } = {}): Promise<{ tag: string; count: number }[]> {
      const limit = options.limit ?? 1000;
      if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new StoreError('INVALID_INPUT', 'Tag list size must be between 1 and 5000');
      const rows = await driver.query<{ tag: string; count: number }>({ sql: `SELECT max(t.value) AS tag, count(DISTINCT c.id) AS count
        FROM unity_cards c JOIN unity_revisions r ON r.id = c.head_revision_id, json_each(r.document_json, '$.data.tags') t
        WHERE c.workspace_id = ? AND t.type = 'text' AND trim(t.value) <> '' AND ${notDeleted}
        GROUP BY lower(t.value) ORDER BY count DESC, lower(t.value) LIMIT ?`, params: [validate.text(workspaceId, 'workspaceId'), limit] });
      return rows.map((row) => ({ tag: row.tag, count: Number(row.count) }));
    },
    /**
     * Deletes a card from the library. Revisions are immutable and may be referenced by forks, so the card is
     * tombstoned: every read skips it, and its favorite and chat-app placements are removed.
     */
    async deleteCard(workspaceId: string, cardId: string) {
      await getCard(workspaceId, cardId);
      await batch([
        { sql: 'INSERT INTO unity_card_deletions(card_id, workspace_id, deleted_at) VALUES (?, ?, ?)', params: [cardId, workspaceId, new Date().toISOString()] },
        { sql: 'DELETE FROM unity_card_favorites WHERE card_id = ?', params: [cardId] },
        { sql: 'DELETE FROM unity_chat_placements WHERE card_id = ? AND workspace_id = ?', params: [cardId, workspaceId] },
      ]);
    },
    async setFavorite(workspaceId: string, cardId: string, favorite: boolean) {
      await getCard(workspaceId, cardId);
      await batch([favorite
        ? { sql: 'INSERT INTO unity_card_favorites(card_id, workspace_id, created_at) VALUES (?, ?, ?) ON CONFLICT(card_id) DO NOTHING', params: [cardId, workspaceId, new Date().toISOString()] }
        : { sql: 'DELETE FROM unity_card_favorites WHERE card_id = ? AND workspace_id = ?', params: [cardId, workspaceId] }]);
    },
    /** Creators are matched case-insensitively on the card's trimmed `creator` field. */
    async followCreator(workspaceId: string, creator: string, follow: boolean) {
      const name = creator.replace(/^ +| +$/g, '');
      if (!name || name.length > 200) throw new StoreError('INVALID_INPUT', 'Creator name must be 1 to 200 characters');
      await workspace(validate.text(workspaceId, 'workspaceId'));
      await batch([follow
        ? { sql: `INSERT INTO unity_followed_creators(workspace_id, creator_key, creator, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(workspace_id, creator_key) DO NOTHING`, params: [workspaceId, fold(name), name, new Date().toISOString()] }
        : { sql: 'DELETE FROM unity_followed_creators WHERE workspace_id = ? AND creator_key = ?', params: [workspaceId, fold(name)] }]);
    },
    async listFollowedCreators(workspaceId: string): Promise<string[]> {
      const rows = await driver.query<{ creator: string }>({ sql: 'SELECT creator FROM unity_followed_creators WHERE workspace_id = ? ORDER BY creator_key LIMIT 5000', params: [workspaceId] });
      return rows.map((row) => row.creator);
    },
    /** Token counts for an immutable revision; written once by the card service. */
    async putRevisionMetrics(workspaceId: string, revisionId: string, metrics: { tokenizer: string; total: number; tokens: Record<string, number> }) {
      await getRevision(workspaceId, revisionId);
      validate.count(metrics.total, 'total');
      await batch([{ sql: `INSERT INTO unity_revision_metrics(revision_id, workspace_id, tokenizer, tokens_total, tokens_json) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(revision_id) DO UPDATE SET tokenizer = excluded.tokenizer, tokens_total = excluded.tokens_total, tokens_json = excluded.tokens_json`,
        params: [revisionId, workspaceId, validate.text(metrics.tokenizer, 'tokenizer'), metrics.total, JSON.stringify(metrics.tokens)] }]);
    },
    /** Head revisions of live cards that have no token counts yet, for background backfill. */
    async revisionsMissingMetrics(options: { limit?: number } = {}): Promise<{ workspaceId: string; revisionId: string }[]> {
      return driver.query({ sql: `SELECT c.workspace_id AS workspaceId, c.head_revision_id AS revisionId FROM unity_cards c
        WHERE c.head_revision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM unity_card_deletions d WHERE d.card_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM unity_revision_metrics m WHERE m.revision_id = c.head_revision_id) LIMIT ?`, params: [validate.limit(options.limit ?? 100)] });
    },
    async listRevisions(workspaceId: string, cardId: string, options: { limit?: number; afterSequence?: number } = {}) {
      const rows = await driver.query<{ id: string }>({ sql: `SELECT id FROM unity_revisions
        WHERE workspace_id = ? AND card_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`,
        params: [workspaceId, cardId, validate.count(options.afterSequence ?? 0, 'afterSequence'), validate.limit(options.limit)] });
      return Promise.all(rows.map(({ id }) => getRevision(workspaceId, id)));
    },
    async listForks(workspaceId: string, sourceRevisionId: string, options: { limit?: number; afterId?: string } = {}) {
      return driver.query<Card>({ sql: `SELECT ${cardColumns} FROM unity_cards WHERE workspace_id = ?
        AND forked_from_revision_id = ? AND id > ? AND NOT EXISTS (SELECT 1 FROM unity_card_deletions d WHERE d.card_id = unity_cards.id) ORDER BY id LIMIT ?`,
        params: [workspaceId, sourceRevisionId, options.afterId ?? '', validate.limit(options.limit)] });
    },
    async stageAsset(input: { workspaceId: string; hash: string; byteLength: number; mediaType: string }): Promise<Asset> {
      const id = crypto.randomUUID();
      const asset: Asset = { id, workspaceId: validate.text(input.workspaceId, 'workspaceId'), hash: validate.hash(input.hash),
        byteLength: validate.count(input.byteLength, 'byteLength'), mediaType: validate.text(input.mediaType, 'mediaType'), storageKey: `assets/${id}`, state: 'staged' };
      await workspace(asset.workspaceId);
      await batch([{ sql: `INSERT INTO unity_assets(id, workspace_id, content_hash, byte_length, media_type, storage_key, state)
        VALUES (?, ?, ?, ?, ?, ?, 'staged')`, params: [id, asset.workspaceId, asset.hash, asset.byteLength, asset.mediaType, asset.storageKey] }]);
      return asset;
    },
    /** Only a trusted blob service may provide measured bytes/hash after writing the staged object. */
    async completeAsset(input: { workspaceId: string; assetId: string; measuredHash: string; measuredByteLength: number }): Promise<Asset> {
      const { workspaceId, assetId, measuredHash, measuredByteLength } = input;
      validate.hash(measuredHash); validate.count(measuredByteLength, 'measuredByteLength');
      const asset = await getAsset(workspaceId, assetId);
      if (asset.hash !== measuredHash || asset.byteLength !== measuredByteLength) throw new StoreError('INTEGRITY', 'Uploaded bytes do not match the staged asset');
      await batch([{ sql: "UPDATE unity_assets SET state = 'ready' WHERE id = ? AND workspace_id = ?", params: [assetId, workspaceId] }]);
      return { ...asset, state: 'ready' };
    },
  };
}
export type UnityStore = ReturnType<typeof createStore>;
export type { ContentIdentity };
