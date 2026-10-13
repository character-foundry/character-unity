import type { StoreDriver } from './driver.js';
import type { Asset } from './types.js';
import { StoreError } from './types.js';
import { limit, text } from './validation.js';

export interface AssetCandidate extends Asset { createdAt: string }
export interface RetiredAsset extends AssetCandidate { retiredAt: string }
const columns = `a.id, a.workspace_id AS workspaceId, a.content_hash AS hash, a.byte_length AS byteLength,
  a.media_type AS mediaType, a.storage_key AS storageKey, a.state, l.created_at AS createdAt`;
const unused = `NOT EXISTS (SELECT 1 FROM unity_revision_assets WHERE asset_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM unity_card_sources WHERE asset_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM unity_sync_outbox WHERE asset_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM unity_archive_assets WHERE asset_id = a.id)`;
function date(value: string) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new StoreError('INVALID_INPUT', 'Use a canonical UTC timestamp, for example 2026-10-01T00:00:00.000Z');
  }
  return value;
}
/** Operator capability; deliberately absent from account/session HTTP services. */
export function createAssetMaintenanceStore(driver: StoreDriver, options: { now?: () => Date } = {}) {
  function cutoff(value: string) {
    const before = date(value), now = (options.now?.() ?? new Date()).toISOString();
    if (Date.parse(before) > Date.parse(now) - 86_400_000) throw new StoreError('INVALID_INPUT', 'Cleanup cutoff must be at least 24 hours old');
    return { before, now };
  }
  return {
    async preview(before: string, page: { afterId?: string; limit?: number } = {}) {
      const cut = cutoff(before);
      return driver.query<AssetCandidate>({ sql: `SELECT ${columns} FROM unity_assets a JOIN unity_asset_lifetimes l ON l.asset_id = a.id
        WHERE l.created_at <= ? AND a.id > ? AND ${unused}
        AND NOT EXISTS (SELECT 1 FROM unity_asset_retirements WHERE asset_id = a.id) ORDER BY a.id LIMIT ?`,
      params: [cut.before, page.afterId === undefined ? '' : text(page.afterId, 'afterId'), limit(page.limit)] });
    },
    async retire(ids: readonly string[], before: string) {
      const cut = cutoff(before), selected = [...ids];
      if (!selected.length || selected.length > 100 || new Set(selected).size !== selected.length) throw new StoreError('INVALID_INPUT', 'Retire 1–100 unique asset IDs from the preview');
      selected.forEach((id) => text(id, 'assetId'));
      try {
        await driver.batch(selected.map((id) => ({ sql: `INSERT INTO unity_asset_retirements(asset_id, eligible_before, retired_at)
          SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM unity_asset_retirements WHERE asset_id = ?)`, params: [id, cut.before, cut.now, id] })));
      } catch (cause) {
        if (String(cause).includes('UNITY_ASSET_IN_USE')) throw new StoreError('ACCESS_CHANGED', 'An asset is referenced, missing or newer than the cutoff; refresh the preview', { cause });
        throw cause;
      }
      return { retired: selected };
    },
    async retired(page: { afterId?: string; limit?: number } = {}) {
      return driver.query<RetiredAsset>({ sql: `SELECT ${columns}, r.retired_at AS retiredAt FROM unity_asset_retirements r
        JOIN unity_assets a ON a.id = r.asset_id JOIN unity_asset_lifetimes l ON l.asset_id = a.id WHERE a.id > ? ORDER BY a.id LIMIT ?`,
      params: [page.afterId === undefined ? '' : text(page.afterId, 'afterId'), limit(page.limit)] });
    },
  };
}
export type AssetMaintenanceStore = ReturnType<typeof createAssetMaintenanceStore>;
