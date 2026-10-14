import { canonicalJson, readCardLineage } from '@character-foundry/character-foundry/identity';
import { StoreError } from '@character-unity/store';
import type { ArchiveReference, ArchiveReferenceInput, Card, CardDocument, Revision, UnityStore } from '@character-unity/store';
import type { AssetService } from '@character-unity/assets';
import { saveAssetRevision } from './asset-edit.js';
import { exportRevision } from './export.js';
import { NativeArchiveUnavailable } from './native-reader.js';
import type { NativeArchiveCard, NativeArchiveReader } from './native-reader.js';
import { CardError } from './types.js';
import type { Actor, AssetBinding, AssetUpload, ExportFormat } from './types.js';
import { chatImportCommit, type ChatImportAuthorization } from './private-chat-receipt.js';

const text = (value: unknown) => typeof value === 'string' ? value : '';
function summary(detail: NativeArchiveCard): ArchiveReferenceInput['summary'] {
  const item = detail as NativeArchiveCard & { tokens?: number; spec?: 'v2' | 'v3'; tagline?: string; altGreetings?: number; lorebookEntries?: number;
    flags?: Record<string, boolean>; document?: { data?: Record<string, unknown> } };
  const data = item.document?.data ?? {};
  const alternateGreetingCount = Array.isArray(data.alternate_greetings) ? data.alternate_greetings.length : item.altGreetings ?? 0;
  return { name: (text(detail.name) || text(data.name) || 'Untitled').slice(0, 500), creator: text(detail.creator).slice(0, 500),
    description: (text(data.description) || text(detail.description) || text(item.tagline)).slice(0, 4000),
    tags: (detail.tags ?? []).filter((value): value is string => typeof value === 'string').slice(0, 100).map((tag) => tag.slice(0, 200)),
    source: detail.provider, format: detail.versionList.find((version) => version.id === detail.versionId)?.objects.find((object) => object.role === 'card')?.mediaType === 'image/png' ? 'png'
      : detail.versionList.find((version) => version.id === detail.versionId)?.objects.find((object) => object.role === 'card')?.mediaType === 'application/zip' ? 'charx' : 'json',
    changedAt: detail.changedAt ?? new Date().toISOString(), portrait: Boolean(detail.portrait), tokensTotal: item.tokens ?? detail.tokensTotal ?? null,
    flags: Object.entries(item.flags ?? {}).filter(([, enabled]) => enabled).map(([flag]) => flag),
    greetingCount: (text(data.first_mes).trim() ? 1 : 0) + alternateGreetingCount + (Array.isArray(data.group_only_greetings) ? data.group_only_greetings.length : 0),
    alternateGreetingCount, lorebookEntryCount: item.lorebookEntries ?? 0, versionCount: detail.versions ?? 1,
    assetCount: Array.isArray(data.assets) ? data.assets.length : 0, spec: item.spec ?? 'v3' };
}

/** A library reference stores only membership and a bounded projection. Full
 * documents and assets are resolved at their exact Archive version on demand. */
export function createReferenceService(store: UnityStore, assets: AssetService, configured?: NativeArchiveReader) {
  const reader = () => configured ?? (() => { throw new NativeArchiveUnavailable(503, 'SOURCE_UNAVAILABLE', 'The referenced Archive is not connected'); })();
  async function get(workspaceId: string, id: string): Promise<ArchiveReference | null> {
    try { return await store.getArchiveReference(workspaceId, id); }
    catch (error) { if (error instanceof StoreError && error.code === 'NOT_FOUND') return null; throw error; }
  }
  async function add(workspaceId: string, id: string, versionId?: string, favorite = false) {
    const detail = await reader().card(id, versionId);
    const archiveId = detail.archiveId ?? (await reader().status()).archiveId;
    const current = detail.versionList.find((version) => version.id === detail.versionId);
    const original = current?.objects.find((object) => object.role === 'card');
    if (!archiveId || !original || (versionId && versionId !== detail.versionId)) throw new NativeArchiveUnavailable(404, 'SOURCE_UNAVAILABLE', 'The selected Archive version is unavailable');
    return store.addArchiveReference({ workspaceId, pin: { archiveId, cardId: detail.id, versionId: detail.versionId },
      summary: summary(detail), fileHash: original.sha256, favorite });
  }
  async function resolve(reference: ArchiveReference, signal?: AbortSignal) {
    const { prepared, detail, version } = await reader().load(reference.pin, signal);
    const resources = new Map(prepared.resources.map((resource) => [`archive:${resource.path}`, resource]));
    const card: Card = { id: reference.id, workspaceId: reference.workspaceId, headRevisionId: reference.pin.versionId,
      originalHash: prepared.rootHash ?? prepared.acceptedHash, forkedFromRevisionId: null, createdAt: reference.createdAt };
    const revision: Revision = { id: reference.pin.versionId, cardId: reference.id, workspaceId: reference.workspaceId, parentRevisionId: null,
      authorId: 'archive', sequence: version.sequence ?? 1, identity: prepared.identity, document: prepared.document,
      createdAt: version.createdAt ?? version.fetchedAt ?? detail.changedAt ?? reference.createdAt,
      assets: prepared.resources.map((resource) => ({ path: resource.path, assetId: `archive:${resource.path}` })) };
    const opened = { card, revision, favorite: reference.favorite, reference: reference.pin,
      source: { cardId: reference.id, workspaceId: reference.workspaceId, assetId: 'archive:original', mediaType: prepared.mediaType,
        byteLength: prepared.bytes.length, hash: prepared.acceptedHash, provenance: { kind: 'archive', contract: 'unity.archive.native.v2',
          archiveId: reference.pin.archiveId, cardId: reference.pin.cardId, versionId: reference.pin.versionId,
          format: prepared.format, filename: version.objects.find((object) => object.role === 'card')?.name || `original.${prepared.mediaType === 'image/png' ? 'png' : prepared.mediaType === 'application/zip' ? 'charx' : 'json'}`,
          source: { provider: detail.provider, recordId: detail.recordId, url: detail.url } } as CardDocument } };
    const virtualStore: UnityStore = { ...store, async getAsset(workspaceId, assetId) {
      const resource = resources.get(assetId);
      if (workspaceId !== reference.workspaceId || !resource) return store.getAsset(workspaceId, assetId);
      return { id: assetId, workspaceId, hash: resource.hash, byteLength: resource.bytes.length, mediaType: resource.mediaType, state: 'ready', storageKey: assetId };
    } };
    const virtualAssets: AssetService = { ...assets, async download(workspaceId, assetId, signal) {
      signal?.throwIfAborted();
      const resource = resources.get(assetId);
      if (workspaceId !== reference.workspaceId || !resource) return assets.download(workspaceId, assetId, signal);
      return { body: new Blob([new Uint8Array(resource.bytes)]).stream(), hash: resource.hash, byteLength: resource.bytes.length, mediaType: resource.mediaType };
    } };
    return { opened, prepared, virtualStore, virtualAssets, resources };
  }
  return { get, add, resolve,
    async matchFile(workspaceId: string, fileHash: string) {
      if (!configured) return null;
      const result = await configured.identity({ fileHash });
      for (const candidate of result.matches) {
        if (candidate.fileHash !== fileHash) continue;
        const { version } = await configured.pinned({ archiveId: result.archiveId, cardId: candidate.cardId, versionId: candidate.versionId });
        const original = version.objects.find((object) => object.role === 'card');
        if (original?.sha256 !== fileHash) throw new CardError('INVALID_INPUT', 'Archive identity no longer matches its pinned original');
        await configured.object(original);
        return add(workspaceId, candidate.cardId, candidate.versionId);
      }
      return null;
    },
    async open(reference: ArchiveReference, signal?: AbortSignal) { return (await resolve(reference, signal)).opened; },
    async original(reference: ArchiveReference, signal?: AbortSignal) { return reader().resource(reference.pin, 'original', signal); },
    async fork(actor: Actor, reference: ArchiveReference, expectedHead: string, document: CardDocument,
      bindings: readonly AssetBinding[], uploads: readonly AssetUpload[], signal?: AbortSignal, chatImport?: ChatImportAuthorization) {
      if (reference.pin.versionId !== expectedHead) throw new StoreError('HEAD_CONFLICT', 'The referenced version changed; reopen before saving');
      const loaded = await resolve(reference, signal), { card, revision: current } = loaded.opened;
      const revision = await saveAssetRevision(loaded.virtualStore, assets, actor, reference.workspaceId, reference.id,
        expectedHead, document, bindings, uploads, signal, 'fork', { card, revision: current,
          async commit(input) {
            const inherited = await Promise.all((input.assets ?? []).map(async (binding) => {
              const resource = loaded.resources.get(binding.assetId);
              if (!resource) return binding;
              const asset = await store.registerArchiveAsset({ workspaceId: reference.workspaceId, pin: reference.pin, path: resource.path,
                hash: resource.hash, byteLength: resource.bytes.length, mediaType: resource.mediaType });
              return { path: binding.path, assetId: asset.id };
            }));
            const original = await store.registerArchiveAsset({ workspaceId: reference.workspaceId, pin: reference.pin, path: 'original',
              hash: loaded.prepared.acceptedHash, byteLength: loaded.prepared.bytes.length, mediaType: loaded.prepared.mediaType });
            signal?.throwIfAborted();
            return (await store.createArchiveFork({ ...input, workspaceId: reference.workspaceId, pin: reference.pin, referenceId: reference.id,
              originalHash: card.originalHash!, assets: inherited, source: { assetId: original.id, provenance: loaded.opened.source.provenance },
              ...(chatImport ? { chatImport: chatImportCommit(chatImport)! } : {}) })).revision;
          },
        }, chatImport);
      return { cardId: revision.cardId, revisionId: revision.id, revision,
        ...(revision.cardId === reference.id ? { reference: reference.pin } : {}) };
    },
    async export(reference: ArchiveReference, revisionId: string, format: ExportFormat, signal?: AbortSignal) {
      if (revisionId !== reference.pin.versionId) throw new StoreError('NOT_FOUND', 'Revision does not belong to this reference');
      const value = await resolve(reference, signal);
      return exportRevision(value.virtualStore, value.virtualAssets, value.opened.revision, format, signal);
    },
    async matchImport(workspaceId: string, prepared: Awaited<ReturnType<NativeArchiveReader['load']>>['prepared']) {
      if (!configured) return null;
      const result = await configured.identity({ fileHash: prepared.acceptedHash, contentHash: prepared.identity.hash,
        name: text((prepared.document.data as Record<string, unknown>).name) });
      const moduleHash = prepared.resources.find((resource) => resource.path === 'module.risum')?.hash ?? null;
      const lineageHash = readCardLineage(prepared.document)?.revisionHash ?? null;
      for (const candidate of result.matches) {
        const loaded = await configured.load({ archiveId: result.archiveId, cardId: candidate.cardId, versionId: candidate.versionId });
        if (candidate.fileHash !== prepared.acceptedHash && (canonicalJson(loaded.prepared.identity) !== canonicalJson(prepared.identity)
          || (loaded.prepared.resources.find((resource) => resource.path === 'module.risum')?.hash ?? null) !== moduleHash
          || (readCardLineage(loaded.prepared.document)?.revisionHash ?? null) !== lineageHash)) continue;
        const reference = await add(workspaceId, candidate.cardId, candidate.versionId);
        return { reference, match: candidate.fileHash === prepared.acceptedHash ? 'file' as const : 'content' as const };
      }
      if (!result.complete) throw new NativeArchiveUnavailable(409, 'ARCHIVE_IDENTITY_INCOMPLETE', 'Archive identity indexing is incomplete for this card. No duplicate was stored. Run the bounded Archive identity index command, then retry.');
      return null;
    },
  };
}
