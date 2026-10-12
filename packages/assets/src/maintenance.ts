import type { AssetMaintenanceStore } from '@character-unity/store/asset-maintenance';
import type { BlobRemover } from '@character-unity/blob-store/maintenance';

/** Revisits every selected retirement, including previously deleted keys. A late
 * upload can recreate physical bytes but can never regain a SQL reference. */
export async function sweepRetiredAssets(store: AssetMaintenanceStore, blobs: BlobRemover,
  options: { afterId?: string; limit?: number } = {}) {
  const records = await store.retired(options), results: { assetId: string; status: 'removed' | 'failed' }[] = [];
  for (const asset of records) {
    try { await blobs.removeRetired(asset.storageKey); results.push({ assetId: asset.id, status: 'removed' }); }
    catch { results.push({ assetId: asset.id, status: 'failed' }); }
  }
  return { results, nextAfter: records.length === (options.limit ?? 50) ? records.at(-1)!.id : null };
}
