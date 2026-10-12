import { saveRemoteBytes, readRemoteBytes } from './remote-bytes.js';
import { createSyncReadClient, parseSyncReadPublication, verifySyncReadPublication, encodeSyncForkSubmission,
  verifySyncForkSubmission, SYNC_FORK_VERSION, SYNC_FORK_MAX_BYTES, SYNC_FORK_MAX_ANCESTORS } from '@character-foundry/character-foundry/sync';
import type { SyncForkManifest, SyncReadAsset, SyncReadPublication } from '@character-foundry/character-foundry/sync';
import { canonicalJson, createCardRevision, hashBytes, readCardLineage, sanitizeCardForPublish } from '@character-foundry/character-foundry/identity';
import { publicAccountActorUri } from '@character-unity/store/accounts';
import { StoreError } from '@character-unity/store';
import type { UnityStore } from '@character-unity/store';
import type { AssetService } from '@character-unity/assets';
import { CardError } from './types.js';
import type { Actor } from './types.js';

export type RemoteCardConnection = Parameters<typeof createSyncReadClient>[0];
const sourceVersion = 'unity.sync-pull.v1';
const sourceLimit = 512 * 1024;

/** Hosts configure the signing identity and destination; request bodies never select keys or URLs. */
export function createRemoteCardService(store: UnityStore, assets: AssetService, input: RemoteCardConnection) {
  const connection = { ...input };
  const remoteActor = publicAccountActorUri(connection.actor);
  if (connection.baseUrl.length > 1024) throw new CardError('INVALID_INPUT', 'Remote base URL exceeds its limit');
  // The public SDK validates the exact HTTPS destination and owns request signing.
  const reader = createSyncReadClient(connection);
  async function authorize(actor: Actor, workspaceId: string) {
    if (actor.uri !== remoteActor || (await store.getWorkspace(workspaceId)).ownerId !== actor.id) {
      throw new CardError('FORBIDDEN', 'Remote connection does not belong to this workspace account');
    }
  }
  function storedPath(asset: SyncReadAsset) {
    return asset.binding.kind === 'portrait' ? 'portrait' : `declared/${asset.binding.pointer.split('/')[2]}`;
  }
  function deadline(signal?: AbortSignal) { return AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]); }
  function portable(publication: SyncReadPublication) {
    if (canonicalJson(sanitizeCardForPublish(publication.document).card) !== canonicalJson(publication.document)) {
      throw new CardError('INVALID_INPUT', 'Remote publication contains nonportable machine state');
    }
  }
  return {
    async list(actor: Actor, workspaceId: string, options: { after?: string; limit?: number } = {}, signal?: AbortSignal) {
      actor = { ...actor }; options = { ...options }; const active = deadline(signal);
      active.throwIfAborted(); await authorize(actor, workspaceId);
      const result = await reader.list(options, active);
      active.throwIfAborted(); await authorize(actor, workspaceId); return result;
    },
    /** One explicit local fork; repeating a pull intentionally creates another draft. */
    async pullFork(actor: Actor, workspaceId: string, publicationId: string, signal?: AbortSignal) {
      actor = { ...actor }; const active = deadline(signal); active.throwIfAborted();
      await authorize(actor, workspaceId);
      const parent = await reader.get(publicationId, active); portable(parent);
      if (!parent.policy.allowFork) throw new CardError('FORBIDDEN', 'Remote publication does not allow forks');
      if (parent.assets.reduce((sum, asset) => sum + asset.byteLength, 0) > SYNC_FORK_MAX_BYTES) throw new CardError('TOO_LARGE', 'Selected publication exceeds the return-bundle limit');
      const resourceBytes: Uint8Array[] = [];
      for (const asset of parent.assets) resourceBytes.push(await reader.asset(parent, asset.path, active));
      const current = await reader.get(parent.id, active);
      if (!current.policy.allowFork || canonicalJson(current) !== canonicalJson(parent)) throw new StoreError('ACCESS_CHANGED', 'Remote publication changed during the pull');
      const previous = readCardLineage(parent.document);
      const fork = await createCardRevision(parent.document, { originalHash: parent.originalHash, parents: previous ? [previous] : [],
        operation: 'fork', author: actor.uri, createdAt: new Date().toISOString(), nonce: crypto.randomUUID(),
        assets: parent.assets.flatMap((asset) => asset.binding.kind === 'uri' ? [{ pointer: asset.binding.pointer, hash: asset.hash }] : []),
        ...(parent.assets.some((asset) => asset.binding.kind === 'portrait') ? { portraitHash: parent.assets.find((asset) => asset.binding.kind === 'portrait')!.hash } : {}),
      });
      // Ensure the initial draft is representable before any storage writes.
      await encodeSyncForkSubmission({ manifest: { version: SYNC_FORK_VERSION, publicationId: parent.id, baseIdentity: parent.identity,
        originalHash: parent.originalHash, document: fork.card, identity: fork.lineage.content, ancestry: [], assets: parent.assets }, assets: resourceBytes });
      const sourceBytes = new TextEncoder().encode(canonicalJson(parent));
      if (sourceBytes.length > sourceLimit) throw new CardError('TOO_LARGE', 'Remote publication snapshot exceeds its limit');
      active.throwIfAborted(); await authorize(actor, workspaceId);
      const references = [];
      for (const [index, asset] of parent.assets.entries()) {
        active.throwIfAborted();
        const saved = await saveRemoteBytes(assets, workspaceId, resourceBytes[index]!, asset.mediaType, active);
        references.push({ path: storedPath(asset), assetId: saved.id });
      }
      const source = await saveRemoteBytes(assets, workspaceId, sourceBytes, 'application/json', active);
      active.throwIfAborted();
      return store.createCard({ workspaceId, authorId: actor.id, originalHash: parent.originalHash, document: fork.card,
        identity: fork.lineage.content, assets: references, source: { assetId: source.id, provenance: {
          kind: 'sync-pull', version: sourceVersion, baseUrl: connection.baseUrl, publicationId: parent.id, actor: actor.uri,
        } } });
    },
    /** Read-only preparation of one saved revision. Persist these exact bytes and an operation ID before sending. */
    async prepareReturn(actor: Actor, workspaceId: string, cardId: string, revisionId: string, signal?: AbortSignal) {
      actor = { ...actor }; const active = deadline(signal); active.throwIfAborted();
      await authorize(actor, workspaceId);
      const card = await store.getCard(workspaceId, cardId), source = await store.getSource(workspaceId, cardId);
      const provenance = source?.provenance;
      if (!source || provenance?.kind !== 'sync-pull' || provenance.version !== sourceVersion
        || provenance.baseUrl !== connection.baseUrl || provenance.actor !== actor.uri) throw new CardError('FORBIDDEN', 'Draft is not bound to this remote connection and actor');
      const sourceBytes = await readRemoteBytes(assets, workspaceId, source.assetId, sourceLimit, active);
      let parent: SyncReadPublication;
      try { parent = await verifySyncReadPublication(parseSyncReadPublication(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(sourceBytes)))); }
      catch { throw new StoreError('INTEGRITY', 'Stored remote publication snapshot failed verification'); }
      if (provenance.publicationId !== parent.id || card.originalHash !== parent.originalHash) throw new StoreError('INTEGRITY', 'Remote source/root binding changed');
      const revision = await store.getRevision(workspaceId, revisionId);
      if (revision.cardId !== card.id) throw new StoreError('NOT_FOUND', 'Revision does not belong to this remote draft');
      const ancestry = []; let cursor = revision;
      while (cursor.parentRevisionId !== null) {
        if (ancestry.length >= SYNC_FORK_MAX_ANCESTORS) throw new CardError('TOO_LARGE', 'Return chain exceeds the ancestor limit');
        cursor = await store.getRevision(workspaceId, cursor.parentRevisionId);
        if (cursor.cardId !== card.id) throw new StoreError('INTEGRITY', 'Remote draft history escaped its card');
        const record = readCardLineage(cursor.document);
        if (!record) throw new CardError('INVALID_LINEAGE', 'Remote draft has an unproven historical revision');
        ancestry.unshift(record);
      }
      const manifestAssets: SyncReadAsset[] = [], resourceBytes: Uint8Array[] = []; let total = 0;
      for (const reference of revision.assets) {
        const asset = await store.getAsset(workspaceId, reference.assetId);
        const bytes = await readRemoteBytes(assets, workspaceId, asset.id, SYNC_FORK_MAX_BYTES - total, active); total += bytes.length;
        const binding: SyncReadAsset['binding'] = reference.path === 'portrait' ? { kind: 'portrait' }
          : /^declared\/(0|[1-9][0-9]*)$/.test(reference.path) ? { kind: 'uri', pointer: `/assets/${reference.path.slice(9)}/uri` }
            : (() => { throw new CardError('UNSUPPORTED_FORMAT', 'Revision asset has no portable binding'); })();
        manifestAssets.push({ path: reference.path, hash: asset.hash, byteLength: asset.byteLength, mediaType: asset.mediaType, binding }); resourceBytes.push(bytes);
      }
      const manifest: SyncForkManifest = { version: SYNC_FORK_VERSION, publicationId: parent.id, baseIdentity: parent.identity,
        originalHash: parent.originalHash, document: sanitizeCardForPublish(revision.document).card,
        identity: revision.identity, ancestry, assets: manifestAssets };
      const verified = await verifySyncForkSubmission({ manifest, assets: resourceBytes }, parent, actor.uri);
      const bytes = await encodeSyncForkSubmission(verified); active.throwIfAborted(); await authorize(actor, workspaceId);
      return { bytes, hash: await hashBytes(bytes), mediaType: 'application/octet-stream' as const,
        baseUrl: connection.baseUrl, publicationId: parent.id, cardId, revisionId };
    },
  };
}
export type RemoteCardService = ReturnType<typeof createRemoteCardService>;
