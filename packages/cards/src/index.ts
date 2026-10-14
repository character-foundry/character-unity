import { canonicalJson, createCardRevision, hashBytes, readCardLineage, verifyCardLineage } from '@character-foundry/character-foundry/identity';
import { StoreError } from '@character-unity/store';
import { documentByteLimit } from '@character-unity/store/validation';
import type { CardDocument, CardSummaryQuery, ImportMatch, UnityStore } from '@character-unity/store';
import { summarizeCard, summarizeReference } from './summary.js';
import type { CardSummaryList } from './summary.js';
export type { CardSummary, CardSummaryList } from './summary.js';
import type { AssetService } from '@character-unity/assets';
import { prepareImport } from './import.js';
import { measureMissing, measureRevision } from './metrics.js';
import { revisionIdentityOptions } from './revision-assets.js';
import { exportRevision } from './export.js';
import { saveAssetRevision } from './asset-edit.js';
import { createAssetDraft } from './draft.js';
import { createReferenceService } from './references.js';
import { setChatImportReceipt, type ChatImportAuthorization } from './private-chat-receipt.js';
import type { NativeArchiveReader } from './native-reader.js';
import { CardError, importByteLimit } from './types.js';
import type { Actor, ImportAsset, ExportFormat, HistoryOptions, HistoryPage, AssetBinding, AssetUpload } from './types.js';
export { CardError } from './types.js';
export type { Actor, ImportAsset, ExportFormat, HistoryOptions, HistoryPage, AssetBinding, AssetUpload } from './types.js';
export { importByteLimit, declaredAssetLimit } from './types.js';

export function createCardService(store: UnityStore, assets: AssetService, options: { archive?: NativeArchiveReader } = {}) {
  const references = createReferenceService(store, assets, options.archive);
  async function authorize(actor: Actor, workspaceId: string) {
    const workspace = await store.getWorkspace(workspaceId);
    if (workspace.ownerId !== actor.id) throw new CardError('FORBIDDEN', 'Workspace belongs to another account');
  }
  async function persistBytes(workspaceId: string, input: { bytes: Uint8Array; hash: string; mediaType: string }) {
    const staged = await store.stageSharedAsset({ workspaceId, hash: input.hash, byteLength: input.bytes.length, mediaType: input.mediaType });
    if (staged.state === 'ready') return staged;
    return assets.upload(workspaceId, staged.id, new ReadableStream({ start(controller) { controller.enqueue(input.bytes); controller.close(); } }));
  }
  async function open(actor: Actor, workspaceId: string, cardId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await authorize(actor, workspaceId);
    const reference = await references.get(workspaceId, cardId);
    if (reference) { const result = await references.open(reference, signal); await authorize(actor, workspaceId); return result; }
    const card = await store.getCard(workspaceId, cardId);
    const revision = await store.getRevision(workspaceId, card.headRevisionId);
    const [source, favorite] = await Promise.all([store.getSource(workspaceId, cardId), store.getFavorite(workspaceId, cardId)]);
    const original = source ? await store.getAsset(workspaceId, source.assetId) : null;
    const external = await store.getArchiveForkSource(workspaceId, cardId);
    return { card, revision, ...(external ? { archiveSource: external.pin } : {}), source: source && original ? { ...source, mediaType: original.mediaType,
      byteLength: original.byteLength, hash: original.hash } : null, favorite };
  }
  async function measured<T extends { revision: { id: string; workspaceId: string } }>(result: T): Promise<T> {
    await measureRevision(store, result.revision.workspaceId, result.revision.id).catch(() => undefined);
    return result;
  }
  /** The document carrying `lineageSource`'s foundry lineage in place of its own. */
  function withLineage(input: CardDocument, lineageSource: CardDocument): CardDocument {
    const document = JSON.parse(canonicalJson(input)) as { data?: { extensions?: { foundry?: Record<string, unknown> } } };
    const lineage = (lineageSource.data as { extensions?: { foundry?: { lineage?: unknown } } } | undefined)?.extensions?.foundry?.lineage;
    const data = document.data ??= {}, extensions = data.extensions ??= {}, foundry = extensions.foundry ??= {};
    if (lineage === undefined) delete foundry.lineage; else foundry.lineage = lineage;
    return document as CardDocument;
  }
  const service = {
    async workspaces(actor: Actor) { return store.listWorkspaces(actor.id); },
    async createWorkspace(actor: Actor, name: string) { return store.createWorkspace({ ownerId: actor.id, name }); },
    async list(actor: Actor, workspaceId: string, options: { limit?: number; afterId?: string } = {}) {
      await authorize(actor, workspaceId);
      return store.listCards(workspaceId, options);
    },
    async summaries(actor: Actor, workspaceId: string, query: CardSummaryQuery = {}): Promise<CardSummaryList> {
      await authorize(actor, workspaceId);
      // Token filters and sorts need counts; measure anything new first (a bounded amount per request).
      if (query.minTokens || query.sort === 'tokens_desc' || query.sort === 'tokens_asc') for (let round = 0; round < 5 && await measureMissing(store, 100) === 100; round++);
      const page = await store.listLibrarySummaries(workspaceId, query);
      return { cards: page.items.map((item) => 'reference' in item ? summarizeReference(item.reference, item.forkCount) : summarizeCard(item)), total: page.total };
    },
    /** Removes a card from the library (tombstoned; its revisions stay for forks and history integrity). */
    async delete(actor: Actor, workspaceId: string, cardId: string) {
      await authorize(actor, workspaceId);
      if (await references.get(workspaceId, cardId)) return store.removeArchiveReference(workspaceId, cardId);
      await store.deleteCard(workspaceId, cardId);
    },
    async favorite(actor: Actor, workspaceId: string, cardId: string, favorite: boolean) {
      await authorize(actor, workspaceId);
      if (await references.get(workspaceId, cardId)) return store.setArchiveReferenceFavorite(workspaceId, cardId, favorite);
      await store.setFavorite(workspaceId, cardId, favorite);
    },
    async follow(actor: Actor, workspaceId: string, creator: string, follow: boolean) {
      await authorize(actor, workspaceId);
      await store.followCreator(workspaceId, creator, follow);
    },
    /** Which of these Archive cards are already in the library (Archive card id → library card id). */
    async archiveLinks(actor: Actor, workspaceId: string, archiveCardIds: readonly string[]) {
      await authorize(actor, workspaceId);
      return store.archiveLinks(workspaceId, archiveCardIds);
    },
    async addArchiveReference(actor: Actor, workspaceId: string, cardId: string, versionId?: string, favorite = false) {
      await authorize(actor, workspaceId);
      const reference = await references.add(workspaceId, cardId, versionId, favorite);
      await authorize(actor, workspaceId);
      return reference;
    },
    async libraryFavorites(actor: Actor, workspaceId: string, ids: readonly string[]) {
      await authorize(actor, workspaceId);
      const result: Record<string, boolean> = {};
      for (const id of new Set(ids)) {
        const reference = await references.get(workspaceId, id);
        try { result[id] = reference ? reference.favorite : await store.getFavorite(workspaceId, id); }
        catch (error) {
          // The async search projection can outlive a deleted library card.
          // Its absence is not an error for the other results on this page.
          if (!(error instanceof StoreError) || error.code !== 'NOT_FOUND') throw error;
        }
      }
      return result;
    },
    async archiveMemberships(actor: Actor, workspaceId: string, archiveId: string, pins: readonly { cardId: string; versionId: string }[]) {
      await authorize(actor, workspaceId);
      return store.archiveMemberships(workspaceId, archiveId, pins);
    },
    async followed(actor: Actor, workspaceId: string) {
      await authorize(actor, workspaceId);
      return store.listFollowedCreators(workspaceId);
    },
    /** Background backfill of token counts for cards stored before counting existed. */
    measureMissing: (limit?: number) => measureMissing(store, limit),
    /** Tags on current card versions with card counts, for filter pickers. */
    async tags(actor: Actor, workspaceId: string) {
      await authorize(actor, workspaceId);
      return store.listCardTags(workspaceId);
    },
    /**
     * Copies a library card's current revision into a new card in the same workspace. With `edit`, the editor's
     * unsaved fork draft is saved onto the new card as its first edit; nothing is created if that save fails.
     */
    async fork(actor: Actor, workspaceId: string, cardId: string, edit?: { expectedHead: string; document: CardDocument }) {
      actor = { ...actor };
      const current = await open(actor, workspaceId, cardId);
      if ('reference' in current) {
        const reference = (await references.get(workspaceId, cardId))!;
        const result = await references.fork(actor, reference, edit?.expectedHead ?? current.revision.id, edit?.document ?? current.revision.document,
          current.revision.assets.filter((asset) => asset.path !== 'module.risum').map((asset) => ({ path: asset.path, source: { kind: 'existing', path: asset.path } })), []);
        return { card: result.cardId === cardId ? current.card : await store.getCard(workspaceId, result.cardId), revision: result.revision };
      }
      if (edit) {
        if (current.card.headRevisionId !== edit.expectedHead) throw new StoreError('HEAD_CONFLICT', 'The card has changed since the fork was opened; reload before saving');
        if (canonicalJson(readCardLineage(edit.document)) !== canonicalJson(readCardLineage(current.revision.document))) throw new CardError('INVALID_LINEAGE', 'Draft cannot replace its lineage');
      }
      if (!current.card.originalHash) throw new CardError('INVALID_LINEAGE', 'Card has no accepted original root');
      const options = await revisionIdentityOptions(store, current.revision);
      const previous = readCardLineage(current.revision.document);
      if (previous && !await verifyCardLineage(current.revision.document, options)) throw new CardError('INVALID_LINEAGE', 'Stored lineage failed verification');
      const forked = await createCardRevision(setChatImportReceipt(JSON.parse(canonicalJson(current.revision.document)) as CardDocument), { ...options, originalHash: current.card.originalHash,
        parents: previous ? [previous] : [], operation: 'fork', author: actor.uri, createdAt: new Date().toISOString(), nonce: crypto.randomUUID() });
      // Same workspace: the fork references the parent's stored assets; no bytes are copied or changed.
      const created = await measured(await store.forkCard({ workspaceId, sourceWorkspaceId: workspaceId, sourceRevisionId: current.revision.id, authorId: actor.id,
        document: forked.card, identity: forked.lineage.content, assets: current.revision.assets }));
      if (!edit) return created;
      try {
        const revision = await service.save(actor, workspaceId, created.card.id, created.revision.id, withLineage(edit.document, created.revision.document));
        return { ...created, card: { ...created.card, headRevisionId: revision.id }, revision };
      } catch (error) {
        await store.deleteCard(workspaceId, created.card.id).catch(() => undefined);
        throw error;
      }
    },
    /** The card this one was forked from (if any) and the cards forked from it. */
    async family(actor: Actor, workspaceId: string, cardId: string) {
      const current = await open(actor, workspaceId, cardId);
      const external = await store.getArchiveForkSource(workspaceId, cardId);
      const parentCardId = external?.referenceId ?? (current.card.forkedFromRevisionId
        ? (await store.getRevision(workspaceId, current.card.forkedFromRevisionId).catch(() => null))?.cardId ?? null : null);
      const [parent, forks] = await Promise.all([
        parentCardId ? store.listLibrarySummaries(workspaceId, { ids: [parentCardId] }) : null,
        store.listLibrarySummaries(workspaceId, { forkOf: cardId, limit: 100 }),
      ]);
      const parentItem = parent?.items[0];
      return { parent: parentItem ? 'reference' in parentItem ? summarizeReference(parentItem.reference, parentItem.forkCount) : summarizeCard(parentItem) : null,
        forks: forks.items.map((item) => 'reference' in item ? summarizeReference(item.reference, item.forkCount) : summarizeCard(item)), forkTotal: forks.total };
    },
    open,
    async history(actor: Actor, workspaceId: string, cardId: string, options: HistoryOptions = {}): Promise<HistoryPage> {
      actor = { ...actor }; options = { ...options };
      const current = await open(actor, workspaceId, cardId);
      if ('reference' in current) {
        return { revisions: [{ id: current.revision.id, sequence: current.revision.sequence, authorId: current.revision.authorId, createdAt: current.revision.createdAt }],
          headRevisionId: current.revision.id, throughSequence: current.revision.sequence, nextAfter: null };
      }
      const limit = options.limit ?? 20, afterSequence = options.afterSequence ?? 0;
      const throughSequence = options.throughSequence ?? current.revision.sequence;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 || !Number.isSafeInteger(afterSequence) || afterSequence < 0
        || !Number.isSafeInteger(throughSequence) || throughSequence < 1 || throughSequence > current.revision.sequence || afterSequence > throughSequence) {
        throw new CardError('INVALID_INPUT', 'Invalid revision history page');
      }
      const rows = (await store.listRevisions(workspaceId, cardId, { limit, afterSequence })).filter((row) => row.sequence <= throughSequence);
      await authorize(actor, workspaceId);
      const last = rows.at(-1)?.sequence;
      return { revisions: rows.map(({ id, sequence, authorId, createdAt }) => ({ id, sequence, authorId, createdAt })),
        headRevisionId: current.revision.id, throughSequence, nextAfter: last !== undefined && last < throughSequence ? last : null };
    },
    async revision(actor: Actor, workspaceId: string, cardId: string, revisionId: string, signal?: AbortSignal) {
      actor = { ...actor };
      await authorize(actor, workspaceId);
      const reference = await references.get(workspaceId, cardId);
      if (reference) {
        if (revisionId !== reference.pin.versionId) throw new StoreError('NOT_FOUND', 'Revision does not belong to this reference');
        const opened = await references.open(reference, signal); await authorize(actor, workspaceId); return opened.revision;
      }
      const revision = await store.getRevision(workspaceId, revisionId);
      if (revision.cardId !== cardId) throw new StoreError('NOT_FOUND', 'Revision does not belong to this card');
      await authorize(actor, workspaceId);
      return revision;
    },
    async assetList(actor: Actor, workspaceId: string, cardId: string, revisionId: string, signal?: AbortSignal) {
      actor = { ...actor };
      await authorize(actor, workspaceId);
      const reference = await references.get(workspaceId, cardId);
      if (reference) {
        if (revisionId !== reference.pin.versionId) throw new StoreError('NOT_FOUND', 'Revision does not belong to this reference');
        const { prepared } = await references.resolve(reference, signal);
        await authorize(actor, workspaceId);
        return { revisionId, assets: prepared.resources.map((resource) => ({ path: resource.path, hash: resource.hash, byteLength: resource.bytes.length, mediaType: resource.mediaType })) };
      }
      const revision = await store.getRevision(workspaceId, revisionId);
      if (revision.cardId !== cardId) throw new StoreError('NOT_FOUND', 'Revision does not belong to this card');
      const entries = await Promise.all(revision.assets.map(async (reference) => {
        const asset = await store.getAsset(workspaceId, reference.assetId);
        if (asset.state !== 'ready') throw new CardError('ASSET_UNAVAILABLE', 'Revision asset is unavailable');
        return { path: reference.path, hash: asset.hash, byteLength: asset.byteLength, mediaType: asset.mediaType };
      }));
      await authorize(actor, workspaceId);
      return { revisionId: revision.id, assets: entries };
    },
    async asset(actor: Actor, workspaceId: string, cardId: string, revisionId: string, path: string, signal?: AbortSignal) {
      actor = { ...actor };
      await authorize(actor, workspaceId);
      const reference = await references.get(workspaceId, cardId);
      if (reference) {
        if (revisionId !== reference.pin.versionId || !options.archive) throw new StoreError('NOT_FOUND', 'Revision does not belong to this reference');
        const result = await options.archive.resource(reference.pin, path, signal);
        try { await authorize(actor, workspaceId); return result; } catch (error) { await result.body.cancel(); throw error; }
      }
      const revision = await store.getRevision(workspaceId, revisionId);
      if (revision.cardId !== cardId) throw new StoreError('NOT_FOUND', 'Revision does not belong to this card');
      const binding = revision.assets.find((reference) => reference.path === path);
      if (!binding) throw new StoreError('NOT_FOUND', 'Asset is not in this revision');
      const result = await assets.download(workspaceId, binding.assetId, signal);
      try { await authorize(actor, workspaceId); return result; }
      catch (error) { await result.body.cancel(); throw error; }
    },
    saveAssets: (actor: Actor, workspaceId: string, cardId: string, expectedHead: string, document: CardDocument,
      bindings: readonly AssetBinding[], uploads: readonly AssetUpload[], signal?: AbortSignal) =>
      saveAssetRevision(store, assets, actor, workspaceId, cardId, expectedHead, document, bindings, uploads, signal),
    createDraft: (actor: Actor, workspaceId: string, document: CardDocument, bindings: readonly AssetBinding[], uploads: readonly AssetUpload[], signal?: AbortSignal) =>
      createAssetDraft(store, assets, actor, workspaceId, document, bindings, uploads, signal).then(measured),
    async forkAssets(actor: Actor, workspaceId: string, cardId: string, expectedHead: string, document: CardDocument,
      bindings: readonly AssetBinding[], uploads: readonly AssetUpload[], signal?: AbortSignal, chatImport?: ChatImportAuthorization) {
      await authorize(actor, workspaceId);
      const reference = await references.get(workspaceId, cardId);
      if (reference) {
        const result = await references.fork(actor, reference, expectedHead, document, bindings, uploads, signal, chatImport);
        if (result.cardId !== reference.id) await measureRevision(store, workspaceId, result.revisionId).catch(() => undefined);
        return result;
      }
      const revision = await saveAssetRevision(store, assets, actor, workspaceId, cardId, expectedHead, document, bindings, uploads, signal, 'fork', undefined, chatImport);
      await measureRevision(store, workspaceId, revision.id).catch(() => undefined);
      return { cardId: revision.cardId, revisionId: revision.id, revision };
    },
    async restore(actor: Actor, workspaceId: string, cardId: string, expectedHead: string, revisionId: string) {
      actor = { ...actor };
      const current = await open(actor, workspaceId, cardId);
      if (current.revision.id !== expectedHead) throw new StoreError('HEAD_CONFLICT', 'The card has changed; reload before restoring');
      const historical = await store.getRevision(workspaceId, revisionId);
      if (historical.cardId !== cardId) throw new StoreError('NOT_FOUND', 'Revision does not belong to this card');
      if (historical.id === expectedHead) return current.revision;
      if (!current.card.originalHash) throw new CardError('INVALID_LINEAGE', 'Card has no accepted original root');
      const options = await revisionIdentityOptions(store, historical);
      const currentOptions = await revisionIdentityOptions(store, current.revision);
      const previous = readCardLineage(current.revision.document);
      const target = readCardLineage(historical.document);
      if ((previous && !await verifyCardLineage(current.revision.document, currentOptions))
        || (target && !await verifyCardLineage(historical.document, options))) throw new CardError('INVALID_LINEAGE', 'Stored lineage failed verification');
      const saved = await createCardRevision(setChatImportReceipt(withLineage(historical.document, current.revision.document), current.revision.document), { ...options,
        originalHash: current.card.originalHash, parents: previous ? [previous] : [], operation: 'edit', author: actor.uri,
        createdAt: new Date().toISOString(), nonce: crypto.randomUUID() });
      const revision = await store.saveRevision({ workspaceId, cardId, expectedHead, authorId: actor.id,
        document: saved.card, identity: saved.lineage.content, assets: historical.assets });
      await measureRevision(store, workspaceId, revision.id).catch(() => undefined);
      return revision;
    },
    async export(actor: Actor, workspaceId: string, cardId: string, revisionId: string, format: ExportFormat, signal?: AbortSignal) {
      actor = { ...actor };
      await authorize(actor, workspaceId);
      const reference = await references.get(workspaceId, cardId);
      if (reference) { const result = await references.export(reference, revisionId, format, signal); await authorize(actor, workspaceId); return result; }
      const revision = await store.getRevision(workspaceId, revisionId);
      if (revision.cardId !== cardId) throw new StoreError('NOT_FOUND', 'Revision does not belong to this card');
      const result = await exportRevision(store, assets, revision, format, signal);
      await authorize(actor, workspaceId);
      return result;
    },
    async import(actor: Actor, workspaceId: string, input: Uint8Array, provenance: CardDocument = { kind: 'file' }, supplied: readonly ImportAsset[] = []) {
      // Own both inputs before any await, then check access before parsing or storing bytes.
      if (input.byteLength > importByteLimit) throw new CardError('TOO_LARGE', `Card import exceeds ${importByteLimit / 1024 / 1024} MiB`);
      actor = { ...actor };
      const bytes = new Uint8Array(input);
      if (supplied.length > 64 || supplied.reduce((size, asset) => size + asset.bytes.byteLength, 0) > importByteLimit) throw new CardError('TOO_LARGE', 'Supplied assets exceed import limits');
      const sourceAssets = supplied.map((asset) => ({ ...asset, binding: { ...asset.binding }, bytes: new Uint8Array(asset.bytes) }));
      const sourceProvenance = JSON.parse(canonicalJson(provenance)) as CardDocument;
      if (new TextEncoder().encode(JSON.stringify(sourceProvenance)).length > 8192) throw new CardError('TOO_LARGE', 'Import provenance exceeds 8 KiB');
      await authorize(actor, workspaceId);
      // Explicit supplemental bytes can distinguish otherwise identical JSON
      // originals; those source-bound imports are not standalone-file claims.
      const dedupe = sourceProvenance.kind === 'file' && sourceAssets.length === 0;
      async function existingResult(existing: ImportMatch) {
        const result = await open(actor, workspaceId, existing.kind === 'card' ? existing.cardId : existing.referenceId);
        return { ...result, import: { created: false, match: existing.match } };
      }
      if (dedupe) {
        const fileHash = await hashBytes(bytes);
        const exact = await store.findImportMatch(workspaceId, { fileHash });
        if (exact) return existingResult(exact);
        const reference = await references.matchFile(workspaceId, fileHash);
        if (reference) { await authorize(actor, workspaceId); return { ...await references.open(reference), import: { created: false, match: 'file' as const } }; }
      }
      const prepared = await prepareImport(bytes, sourceAssets);
      const identity = { fileHash: prepared.acceptedHash, identity: prepared.identity,
        moduleHash: prepared.resources.find((resource) => resource.path === 'module.risum')?.hash ?? null,
        lineageHash: readCardLineage(prepared.document)?.revisionHash ?? null };
      // Explicit old snapshot/copy imports retain their distinct source provenance.
      if (dedupe) {
        const existing = await store.findImportMatch(workspaceId, identity);
        if (existing) return existingResult(existing);
        const archiveMatch = await references.matchImport(workspaceId, prepared);
        if (archiveMatch) {
          await authorize(actor, workspaceId);
          return { ...await references.open(archiveMatch.reference), import: { created: false, match: archiveMatch.match } };
        }
      }
      const original = await persistBytes(workspaceId, { bytes: prepared.bytes, hash: prepared.acceptedHash, mediaType: prepared.mediaType });
      const storedReferences = [];
      for (const resource of prepared.resources) {
        const stored = await persistBytes(workspaceId, resource);
        storedReferences.push({ path: resource.path, assetId: stored.id });
      }
      const creation = { workspaceId, authorId: actor.id, document: prepared.document, identity: prepared.identity,
        originalHash: prepared.rootHash ?? prepared.acceptedHash, assets: storedReferences,
        source: { assetId: original.id, provenance: { ...sourceProvenance, format: prepared.format } } };
      if (!dedupe) return { ...await measured(await store.createCard(creation)), import: { created: true, match: null } };
      const result = await store.createImportedCard({ ...creation, fileHash: prepared.acceptedHash, moduleHash: identity.moduleHash, lineageHash: identity.lineageHash });
      if (!result.created) return existingResult(result.existing);
      return { ...await measured(result), import: { created: true, match: null } };
    },
    /** File-upload outcome needs only the existing library target. Exact bytes
     * are checked before asking an uploaded file to carry all asset bindings. */
    async importFile(actor: Actor, workspaceId: string, input: Uint8Array, filename: string): Promise<{ card: { id: string }; import: { created: boolean; match: 'file' | 'content' | 'archive' | null } }> {
      if (input.byteLength > importByteLimit) throw new CardError('TOO_LARGE', 'Card file exceeds the import limit');
      const bytes = new Uint8Array(input);
      await authorize(actor, workspaceId);
      const fileHash = await hashBytes(bytes);
      const existing = await store.findImportMatch(workspaceId, { fileHash });
      if (existing) return { card: { id: existing.kind === 'card' ? existing.cardId : existing.referenceId }, import: { created: false, match: 'file' } };
      const reference = await references.matchFile(workspaceId, fileHash);
      if (reference) { await authorize(actor, workspaceId); return { card: { id: reference.id }, import: { created: false, match: 'archive' } }; }
      return service.import(actor, workspaceId, bytes, { kind: 'file', filename });
    },
    async save(actor: Actor, workspaceId: string, cardId: string, expectedHead: string, input: CardDocument) {
      actor = { ...actor };
      const document = JSON.parse(canonicalJson(input)) as CardDocument;
      if (new TextEncoder().encode(JSON.stringify(document)).length > documentByteLimit) throw new CardError('TOO_LARGE', 'Draft exceeds the save limit');
      const current = await open(actor, workspaceId, cardId);
      if (current.card.headRevisionId !== expectedHead) throw new StoreError('HEAD_CONFLICT', 'The card has changed; reload before saving');
      setChatImportReceipt(document, 'reference' in current ? undefined : current.revision.document);
      if ('reference' in current) {
        const reference = (await references.get(workspaceId, cardId))!;
        return (await references.fork(actor, reference, expectedHead, document,
          current.revision.assets.filter((asset) => asset.path !== 'module.risum').map((asset) => ({ path: asset.path, source: { kind: 'existing', path: asset.path } })), [])).revision;
      }
      if (!current.card.originalHash) throw new CardError('INVALID_LINEAGE', 'Card has no accepted original root');
      const options = await revisionIdentityOptions(store, current.revision);
      const previous = readCardLineage(current.revision.document);
      const submitted = readCardLineage(document);
      if (canonicalJson(previous) !== canonicalJson(submitted)) throw new CardError('INVALID_LINEAGE', 'Draft cannot replace its lineage');
      if (previous && !await verifyCardLineage(current.revision.document, options)) throw new CardError('INVALID_LINEAGE', 'Stored lineage failed verification');
      // Asset replacement needs an explicit asset-edit operation; a prompt save cannot relabel references.
      const oldData = current.revision.document.data as CardDocument;
      const newData = document.data as CardDocument;
      if (canonicalJson(oldData?.assets ?? []) !== canonicalJson(newData?.assets ?? [])) throw new CardError('INVALID_INPUT', 'Change assets through an asset-edit operation');
      if (canonicalJson(document) === canonicalJson(current.revision.document)) {
        if ((await store.getCard(workspaceId, cardId)).headRevisionId !== expectedHead) throw new StoreError('HEAD_CONFLICT', 'The card has changed; reload before saving');
        return current.revision;
      }
      const saved = await createCardRevision(document, { ...options, originalHash: current.card.originalHash,
        parents: previous ? [previous] : [], operation: 'edit', author: actor.uri, createdAt: new Date().toISOString(), nonce: crypto.randomUUID() });
      const revision = await store.saveRevision({ workspaceId, cardId, expectedHead, authorId: actor.id,
        document: saved.card, identity: saved.lineage.content, assets: current.revision.assets });
      await measureRevision(store, workspaceId, revision.id).catch(() => undefined);
      return revision;
    },
    async original(actor: Actor, workspaceId: string, cardId: string, signal?: AbortSignal) {
      await authorize(actor, workspaceId);
      async function authorized(result: Awaited<ReturnType<AssetService['download']>>) {
        try { await authorize(actor, workspaceId); }
        catch (error) { await result.body.cancel(); throw error; }
        return result;
      }
      const reference = await references.get(workspaceId, cardId);
      if (reference) {
        // Original download is a raw pinned read, independent of whether its
        // format or external asset bindings can be opened by the editor.
        return authorized(await references.original(reference, signal));
      }
      const current = await open(actor, workspaceId, cardId, signal);
      if (!current.source) {
        const source = await store.getArchiveForkSource(workspaceId, cardId);
        if (source && options.archive) return authorized(await options.archive.resource(source.pin, 'original', signal));
        throw new StoreError('NOT_FOUND', 'Accepted source bytes are not available');
      }
      return authorized(await assets.download(workspaceId, current.source.assetId, signal));
    },
  };
  return service;
}
export type CardService = ReturnType<typeof createCardService>;
