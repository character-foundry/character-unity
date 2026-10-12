import { BlobError, defaultMaxBytes } from '@character-unity/blob-store';
import type { BlobStore } from '@character-unity/blob-store';
import { StoreError } from '@character-unity/store';
import type { UnityStore } from '@character-unity/store';

export function createAssetService(store: Pick<UnityStore, 'stageAsset' | 'getAsset' | 'completeAsset'>,
  blobs: BlobStore, options: { maxBytes?: number; uploadTimeoutMs?: number } = {}) {
  const maxBytes = options.maxBytes ?? defaultMaxBytes;
  const timeoutMs = options.uploadTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new BlobError('INVALID_INPUT', 'Invalid asset service limits');
  }
  return {
    async stage(input: Parameters<UnityStore['stageAsset']>[0]) {
      if (input.byteLength > maxBytes) throw new BlobError('TOO_LARGE', 'Asset exceeds the configured byte limit');
      return store.stageAsset(input);
    },
    async upload(workspaceId: string, assetId: string, body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
      try {
        const asset = await store.getAsset(workspaceId, assetId);
        if (asset.byteLength > maxBytes) throw new BlobError('TOO_LARGE', 'Asset exceeds the configured byte limit');
        const timeout = AbortSignal.timeout(timeoutMs);
        const measured = await blobs.put(asset.storageKey, body, asset, {
          signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        });
        // Do not delete immutable bytes if SQL fails: a concurrent retry may already have completed.
        // Retrying verifies the existing bytes and completes the same staged metadata idempotently.
        return await store.completeAsset({ workspaceId, assetId, measuredHash: measured.hash, measuredByteLength: measured.byteLength });
      } finally { if (!body.locked) await body.cancel().catch(() => undefined); }
    },
    async download(workspaceId: string, assetId: string) {
      const asset = await store.getAsset(workspaceId, assetId);
      if (asset.state !== 'ready') throw new StoreError('ASSET_NOT_READY', 'Asset upload is not complete');
      const object = await blobs.get(asset.storageKey);
      if (!object) throw new StoreError('NOT_FOUND', 'Asset bytes are unavailable');
      if (object.byteLength !== asset.byteLength) {
        await object.body.cancel();
        throw new StoreError('INTEGRITY', 'Stored asset length has changed');
      }
      return { ...object, hash: asset.hash, mediaType: asset.mediaType };
    },
  };
}
export type AssetService = ReturnType<typeof createAssetService>;
