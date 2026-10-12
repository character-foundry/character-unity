import { canonicalJson, createCardRevision, readCardLineage, verifyCardLineage } from '@character-foundry/character-foundry/identity';
import { StoreError } from '@character-unity/store';
import type { CardDocument, CardSummaryQuery, UnityStore } from '@character-unity/store';
import { summarizeCard } from './summary.js';
import type { CardSummaryList } from './summary.js';
export type { CardSummary, CardSummaryList } from './summary.js';
import type { AssetService } from '@character-unity/assets';
import { prepareImport } from './import.js';
import { revisionIdentityOptions } from './revision-assets.js';
import { exportRevision } from './export.js';
import { saveAssetRevision } from './asset-edit.js';
import { CardError, importByteLimit } from './types.js';
import type { Actor, ImportAsset, ExportFormat, HistoryOptions, HistoryPage, AssetBinding, AssetUpload } from './types.js';
export { CardError } from './types.js';
export type { Actor, ImportAsset, ExportFormat, HistoryOptions, HistoryPage, AssetBinding, AssetUpload } from './types.js';
export { importByteLimit } from './types.js';

export function createCardService(store: UnityStore, assets: AssetService) {
  async function authorize(actor: Actor, workspaceId: string) {
    const workspace = await store.getWorkspace(workspaceId);
    if (workspace.ownerId !== actor.id) throw new CardError('FORBIDDEN', 'Workspace belongs to another account');
  }
  async function persistBytes(workspaceId: string, input: { bytes: Uint8Array; hash: string; mediaType: string }) {
    const staged = await assets.stage({ workspaceId, hash: input.hash, byteLength: input.bytes.length, mediaType: input.mediaType });
    return assets.upload(workspaceId, staged.id, new ReadableStream({ start(controller) { controller.enqueue(input.bytes); controller.close(); } }));
  }
  async function open(actor: Actor, workspaceId: string, cardId: string) {
    await authorize(actor, workspaceId);
    const card = await store.getCard(workspaceId, cardId);
    const revision = await store.getRevision(workspaceId, card.headRevisionId);
    return { card, revision, source: await store.getSource(workspaceId, cardId) };
  }
  return {
    async workspaces(actor: Actor) { return store.listWorkspaces(actor.id); },
    async createWorkspace(actor: Actor, name: string) { return store.createWorkspace({ ownerId: actor.id, name }); },
    async list(actor: Actor, workspaceId: string, options: { limit?: number; afterId?: string } = {}) {
      await authorize(actor, workspaceId);
      return store.listCards(workspaceId, options);
    },
    async summaries(actor: Actor, workspaceId: string, query: CardSummaryQuery = {}): Promise<CardSummaryList> {
      await authorize(actor, workspaceId);
      const page = await store.listCardSummaries(workspaceId, query);
      return { cards: page.items.map(summarizeCard), total: page.total };
    },
    /** Copies a library card's current revision into a new card in the same workspace. */
    async fork(actor: Actor, workspaceId: string, cardId: string) {
      actor = { ...actor };
      const current = await open(actor, workspaceId, cardId);
      if (!current.card.originalHash) throw new CardError('INVALID_LINEAGE', 'Card has no accepted original root');
      const options = await revisionIdentityOptions(store, current.revision);
      const previous = readCardLineage(current.revision.document);
      if (previous && !await verifyCardLineage(current.revision.document, options)) throw new CardError('INVALID_LINEAGE', 'Stored lineage failed verification');
      const forked = await createCardRevision(current.revision.document, { ...options, originalHash: current.card.originalHash,
        parents: previous ? [previous] : [], operation: 'fork', author: actor.uri, createdAt: new Date().toISOString(), nonce: crypto.randomUUID() });
      // Same workspace: the fork references the parent's stored assets; no bytes are copied or changed.
      return store.forkCard({ workspaceId, sourceWorkspaceId: workspaceId, sourceRevisionId: current.revision.id, authorId: actor.id,
        document: forked.card, identity: forked.lineage.content, assets: current.revision.assets });
    },
    /** The card this one was forked from (if any) and the cards forked from it. */
    async family(actor: Actor, workspaceId: string, cardId: string) {
      const current = await open(actor, workspaceId, cardId);
      const parentCardId = current.card.forkedFromRevisionId
        ? (await store.getRevision(workspaceId, current.card.forkedFromRevisionId).catch(() => null))?.cardId ?? null : null;
      const [parent, forks] = await Promise.all([
        parentCardId ? store.listCardSummaries(workspaceId, { ids: [parentCardId] }) : null,
        store.listCardSummaries(workspaceId, { forkOf: cardId, limit: 100 }),
      ]);
      return { parent: parent?.items[0] ? summarizeCard(parent.items[0]) : null, forks: forks.items.map(summarizeCard), forkTotal: forks.total };
    },
    open,
    async history(actor: Actor, workspaceId: string, cardId: string, options: HistoryOptions = {}): Promise<HistoryPage> {
      actor = { ...actor }; options = { ...options };
      const current = await open(actor, workspaceId, cardId);
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
    async revision(actor: Actor, workspaceId: string, cardId: string, revisionId: string) {
      actor = { ...actor };
      await authorize(actor, workspaceId);
      const revision = await store.getRevision(workspaceId, revisionId);
      if (revision.cardId !== cardId) throw new StoreError('NOT_FOUND', 'Revision does not belong to this card');
      await authorize(actor, workspaceId);
      return revision;
    },
    async assetList(actor: Actor, workspaceId: string, cardId: string, revisionId: string) {
      actor = { ...actor };
      await authorize(actor, workspaceId);
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
    async asset(actor: Actor, workspaceId: string, cardId: string, revisionId: string, path: string) {
      actor = { ...actor };
      await authorize(actor, workspaceId);
      const revision = await store.getRevision(workspaceId, revisionId);
      if (revision.cardId !== cardId) throw new StoreError('NOT_FOUND', 'Revision does not belong to this card');
      const reference = revision.assets.find((reference) => reference.path === path);
      if (!reference) throw new StoreError('NOT_FOUND', 'Asset is not in this revision');
      const result = await assets.download(workspaceId, reference.assetId);
      try { await authorize(actor, workspaceId); return result; }
      catch (error) { await result.body.cancel(); throw error; }
    },
    saveAssets: (actor: Actor, workspaceId: string, cardId: string, expectedHead: string, document: CardDocument,
      bindings: readonly AssetBinding[], uploads: readonly AssetUpload[], signal?: AbortSignal) =>
      saveAssetRevision(store, assets, actor, workspaceId, cardId, expectedHead, document, bindings, uploads, signal),
    async export(actor: Actor, workspaceId: string, cardId: string, revisionId: string, format: ExportFormat, signal?: AbortSignal) {
      actor = { ...actor };
      await authorize(actor, workspaceId);
      const revision = await store.getRevision(workspaceId, revisionId);
      if (revision.cardId !== cardId) throw new StoreError('NOT_FOUND', 'Revision does not belong to this card');
      const result = await exportRevision(store, assets, revision, format, signal);
      await authorize(actor, workspaceId);
      return result;
    },
    async import(actor: Actor, workspaceId: string, input: Uint8Array, provenance: CardDocument = { kind: 'file' }, supplied: readonly ImportAsset[] = []) {
      // Own both inputs before any await, then check access before parsing or storing bytes.
      if (input.byteLength > importByteLimit) throw new CardError('TOO_LARGE', 'Card import exceeds 32 MiB');
      actor = { ...actor };
      const bytes = new Uint8Array(input);
      if (supplied.length > 64 || supplied.reduce((size, asset) => size + asset.bytes.byteLength, 0) > importByteLimit) throw new CardError('TOO_LARGE', 'Supplied assets exceed import limits');
      const sourceAssets = supplied.map((asset) => ({ ...asset, binding: { ...asset.binding }, bytes: new Uint8Array(asset.bytes) }));
      const sourceProvenance = JSON.parse(canonicalJson(provenance)) as CardDocument;
      if (new TextEncoder().encode(JSON.stringify(sourceProvenance)).length > 8192) throw new CardError('TOO_LARGE', 'Import provenance exceeds 8 KiB');
      await authorize(actor, workspaceId);
      const prepared = await prepareImport(bytes, sourceAssets);
      const original = await persistBytes(workspaceId, { bytes: prepared.bytes, hash: prepared.acceptedHash, mediaType: prepared.mediaType });
      const references = [];
      for (const resource of prepared.resources) {
        const stored = await persistBytes(workspaceId, resource);
        references.push({ path: resource.path, assetId: stored.id });
      }
      return store.createCard({ workspaceId, authorId: actor.id, document: prepared.document, identity: prepared.identity,
        originalHash: prepared.rootHash ?? prepared.acceptedHash, assets: references,
        source: { assetId: original.id, provenance: { ...sourceProvenance, format: prepared.format } } });
    },
    async save(actor: Actor, workspaceId: string, cardId: string, expectedHead: string, input: CardDocument) {
      actor = { ...actor };
      const document = JSON.parse(canonicalJson(input)) as CardDocument;
      if (new TextEncoder().encode(JSON.stringify(document)).length > 250_000) throw new CardError('TOO_LARGE', 'Draft exceeds the save limit');
      const current = await open(actor, workspaceId, cardId);
      if (current.card.headRevisionId !== expectedHead) throw new StoreError('HEAD_CONFLICT', 'The card has changed; reload before saving');
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
      return store.saveRevision({ workspaceId, cardId, expectedHead, authorId: actor.id,
        document: saved.card, identity: saved.lineage.content, assets: current.revision.assets });
    },
    async original(actor: Actor, workspaceId: string, cardId: string) {
      const current = await open(actor, workspaceId, cardId);
      if (!current.source) throw new StoreError('NOT_FOUND', 'Accepted source bytes are not available');
      return assets.download(workspaceId, current.source.assetId);
    },
  };
}
export type CardService = ReturnType<typeof createCardService>;
