import { createSyncCommandClient, decodeSyncForkSubmission, SYNC_FORK_MAX_BYTES } from '@character-foundry/character-foundry/sync';
import { hashBytes } from '@character-foundry/character-foundry/identity';
import type { UnityStore } from '@character-unity/store';
import { StoreError } from '@character-unity/store';
import { returnOperationId } from '@character-unity/store/sync-outbox';
import type { ReturnJob, SyncOutboxStore } from '@character-unity/store/sync-outbox';
import type { AssetService } from '@character-unity/assets';
import { readRemoteBytes, saveRemoteBytes } from './remote-bytes.js';
import type { RemoteCardConnection, RemoteCardService } from './remote.js';
import { CardError } from './types.js';
import type { Actor } from './types.js';

/** Explicit outbox operations. Enqueue never sends; send never prepares a replacement frame or publishes. */
export function createRemoteReturnService(store: UnityStore, assets: AssetService, outbox: SyncOutboxStore,
  remote: RemoteCardService, input: RemoteCardConnection) {
  const connection = { ...input }, client = createSyncCommandClient(connection);
  async function authorize(actor: Actor, workspaceId: string) {
    if (actor.uri !== connection.actor || (await store.getWorkspace(workspaceId)).ownerId !== actor.id) {
      throw new CardError('FORBIDDEN', 'Return connection does not belong to this workspace account');
    }
    return { accountId: actor.id, workspaceId };
  }
  function bound(job: ReturnJob) {
    if (job.actor !== connection.actor || job.baseUrl !== connection.baseUrl) throw new CardError('FORBIDDEN', 'Return job belongs to another remote connection');
    return job;
  }
  function deadline(signal?: AbortSignal) { return AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]); }
  return {
    async enqueue(actor: Actor, workspaceId: string, cardId: string, revisionId: string, requestId: string, signal?: AbortSignal) {
      actor = { ...actor }; returnOperationId(requestId); const active = deadline(signal); active.throwIfAborted();
      const owner = await authorize(actor, workspaceId), existing = await outbox.get(owner, requestId);
      if (existing) {
        bound(existing);
        if (existing.cardId !== cardId || existing.revisionId !== revisionId) throw new StoreError('OPERATION_CONFLICT', 'Operation ID is bound to another saved revision');
        return existing;
      }
      const prepared = await remote.prepareReturn(actor, workspaceId, cardId, revisionId, active);
      const frame = await saveRemoteBytes(assets, workspaceId, prepared.bytes, prepared.mediaType, active);
      active.throwIfAborted(); await authorize(actor, workspaceId);
      return outbox.enqueue({ ...owner, requestId, actor: actor.uri, baseUrl: connection.baseUrl, publicationId: prepared.publicationId,
        cardId, revisionId, assetId: frame.id, frameHash: prepared.hash, byteLength: prepared.bytes.length });
    },
    async get(actor: Actor, workspaceId: string, requestId: string) {
      actor = { ...actor }; const job = await outbox.get(await authorize(actor, workspaceId), requestId);
      return job ? bound(job) : null;
    },
    async list(actor: Actor, workspaceId: string, options: { afterId?: string; limit?: number } = {}) {
      actor = { ...actor }; options = { ...options };
      // List across configured connections so filtering cannot silently truncate pagination.
      return outbox.list(await authorize(actor, workspaceId), options);
    },
    async send(actor: Actor, workspaceId: string, requestId: string, signal?: AbortSignal) {
      actor = { ...actor }; const active = deadline(signal); active.throwIfAborted();
      const owner = await authorize(actor, workspaceId), found = await outbox.get(owner, requestId);
      if (!found) throw new StoreError('NOT_FOUND', 'Return job not found in this workspace');
      const job = bound(found);
      // This is a historical acknowledgment, not a fresh grant to read the remote draft.
      if (job.receipt) return job;
      const bytes = await readRemoteBytes(assets, workspaceId, job.assetId, SYNC_FORK_MAX_BYTES, active);
      if (bytes.length !== job.byteLength || await hashBytes(bytes) !== job.frameHash) throw new StoreError('INTEGRITY', 'Stored return frame changed');
      const submission = await decodeSyncForkSubmission(bytes);
      if (submission.manifest.publicationId !== job.publicationId) throw new StoreError('INTEGRITY', 'Stored return destination changed');
      active.throwIfAborted(); await authorize(actor, workspaceId);
      const attempt = await outbox.beginAttempt(owner, requestId);
      if (attempt.receipt) return attempt;
      active.throwIfAborted();
      const received = await client.submitFork(bytes, requestId, active);
      // A failed local acknowledgment leaves an uncertain job. The same frame/ID recovers the remote receipt.
      return outbox.acknowledge(owner, requestId, received);
    },
  };
}
