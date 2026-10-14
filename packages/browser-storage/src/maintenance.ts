import { StoreError } from '@character-unity/store';
import type { Asset, Card, CardSource, Revision, Workspace } from '@character-unity/store';
import * as validate from '@character-unity/store/validation';
import { request, transaction } from './transaction.js';

const day = 86_400_000;
const names = ['workspaces', 'cards', 'revisions', 'sources', 'deletions', 'assets', 'archiveAssets', 'blobs', 'meta', 'sharedAssets'];
export const retirementKey = (storageKey: string) => `maintenance:retired:${storageKey}`;
export const assetAgeKey = (assetId: string) => `maintenance:age:${assetId}`;
export interface BrowserCleanupItem {
  assetId: string; storageKey: string; hash: string; byteLength: number; storedByteLength: number;
  state: 'ready' | 'staged'; mediaType: string; reason: 'orphan' | 'deleted-card'; lastRequiredAt: string | null;
}
export interface BrowserCleanupPreview {
  before: string; items: BrowserCleanupItem[]; unknownAge: BrowserCleanupItem[]; hasMore: boolean; unknownMore: boolean;
}
export interface BrowserRetirement {
  key: string; assetId: string; workspaceId: string; storageKey: string; hash: string; byteLength: number;
  retiredAt: string; review: BrowserCleanupItem;
}
interface Age { key: string; createdAt: string }
interface BlobRow { key: string; hash: string; byteLength: number; bytes: Blob }
const fields = ['assetId', 'storageKey', 'hash', 'byteLength', 'storedByteLength', 'state', 'mediaType', 'reason', 'lastRequiredAt'] as const;
const same = (one: BrowserCleanupItem, two: BrowserCleanupItem) => fields.every((key) => one[key] === two[key]);
function time(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new StoreError('INTEGRITY', 'Browser asset age metadata is invalid');
  return parsed;
}
function cutoff(input?: string) {
  const value = input ?? new Date(Date.now() - day).toISOString();
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value || Date.parse(value) > Date.now() - day) {
    throw new StoreError('INVALID_INPUT', 'Cleanup cutoff must be at least 24 hours old');
  }
  return value;
}
function ids(input: readonly string[]) {
  if (!Array.isArray(input) || !input.length || input.length > 100 || new Set(input).size !== input.length) throw new StoreError('INVALID_INPUT', 'Select between 1 and 100 distinct assets');
  return input.map((id) => validate.text(id, 'assetId'));
}
function* get<T>(tx: IDBTransaction, name: string, key: string) { return yield* request<T | undefined>(tx.objectStore(name).get(key)); }
function* owner(tx: IDBTransaction, actorId: string, workspaceId: string) {
  const workspace = yield* get<Workspace>(tx, 'workspaces', workspaceId);
  if (!workspace) throw new StoreError('NOT_FOUND', 'Workspace not found');
  if (workspace.ownerId !== actorId) throw new StoreError('FORBIDDEN', 'Workspace belongs to another account');
}
/** Do not retain full card documents while walking potentially large histories. */
function* scan<T>(tx: IDBTransaction, name: string, visit: (value: T) => void): Generator<IDBRequest, void, unknown> {
  const query = tx.objectStore(name).openCursor();
  let cursor = yield* request(query);
  while (cursor) { visit(cursor.value as T); cursor.continue(); cursor = yield* request(query); }
}
function* graph(tx: IDBTransaction, workspaceId: string, before: string) {
  const cards = new Map<string, Card>(), revisions = new Map<string, string>(), deletions = new Map<string, string>();
  yield* scan<Card>(tx, 'cards', (card) => { cards.set(card.id, card); });
  yield* scan<Revision>(tx, 'revisions', (revision) => { revisions.set(revision.id, revision.cardId); });
  yield* scan<{ cardId: string; deletedAt: string }>(tx, 'deletions', (row) => { time(row.deletedAt); deletions.set(row.cardId, row.deletedAt); });
  const reachable = new Set([...cards.values()].filter((card) => !deletions.has(card.id)).map((card) => card.id));
  const queue = [...reachable];
  for (let index = 0; index < queue.length; index++) {
    const card = cards.get(queue[index]!)!;
    if (!card.forkedFromRevisionId) continue;
    const parent = revisions.get(card.forkedFromRevisionId);
    if (!parent || !cards.has(parent)) throw new StoreError('INTEGRITY', 'Browser fork ancestry is incomplete; no assets were removed');
    if (!reachable.has(parent)) { reachable.add(parent); queue.push(parent); }
  }
  const references = new Map<string, Set<string>>();
  const reference = (assetId: string, cardId: string) => {
    if (!cards.has(cardId)) throw new StoreError('INTEGRITY', 'Browser asset ancestry is incomplete; no assets were removed');
    const owners = references.get(assetId) ?? new Set<string>(); owners.add(cardId); references.set(assetId, owners);
  };
  yield* scan<Revision>(tx, 'revisions', (revision) => { for (const binding of revision.assets) reference(binding.assetId, revision.cardId); });
  yield* scan<CardSource>(tx, 'sources', (source) => reference(source.assetId, source.cardId));
  const external = new Set<string>();
  yield* scan<{ assetId: string }>(tx, 'archiveAssets', (row) => { external.add(row.assetId); });
  const assets: Asset[] = [];
  yield* scan<Asset>(tx, 'assets', (asset) => { if (asset.workspaceId === workspaceId) assets.push(asset); });
  const eligible = new Map<string, BrowserCleanupItem>(), unknown = new Map<string, BrowserCleanupItem>();
  for (const asset of assets.sort((a, b) => a.id.localeCompare(b.id))) {
    if (external.has(asset.id) || !asset.storageKey.startsWith('assets/') || (yield* get(tx, 'meta', retirementKey(asset.storageKey)))) continue;
    const owners = references.get(asset.id) ?? new Set<string>();
    if ([...owners].some((id) => reachable.has(id))) continue;
    const age = yield* get<Age>(tx, 'meta', assetAgeKey(asset.id));
    let lastRequiredAt = age?.createdAt ?? null;
    if (lastRequiredAt) time(lastRequiredAt);
    for (const id of owners) {
      const deletedAt = deletions.get(id);
      if (!deletedAt) throw new StoreError('INTEGRITY', 'Browser asset has an unrecognized owner; no assets were removed');
      if (!lastRequiredAt || deletedAt > lastRequiredAt) lastRequiredAt = deletedAt;
    }
    const stored = yield* get<BlobRow>(tx, 'blobs', asset.storageKey);
    if (stored && (stored.hash !== asset.hash || stored.byteLength !== asset.byteLength || stored.bytes.size !== asset.byteLength)) throw new StoreError('INTEGRITY', 'Stored browser object does not match its immutable asset');
    if (!stored && asset.state === 'ready') throw new StoreError('INTEGRITY', 'A ready browser object is missing; no cleanup preview was produced');
    const item: BrowserCleanupItem = { assetId: asset.id, storageKey: asset.storageKey, hash: asset.hash, byteLength: asset.byteLength,
      storedByteLength: stored?.bytes.size ?? 0, state: asset.state, mediaType: asset.mediaType, reason: owners.size ? 'deleted-card' : 'orphan', lastRequiredAt };
    if (!lastRequiredAt) unknown.set(asset.id, item);
    else if (lastRequiredAt <= before) eligible.set(asset.id, item);
  }
  return { eligible, unknown };
}

/** Explicit owner maintenance only: no startup sweep, timers, Archive I/O or
 * database reset. Review is read-only and apply rechecks the graph atomically. */
export function createBrowserMaintenance(db: IDBDatabase) {
  async function run<T>(mode: IDBTransactionMode, operation: (tx: IDBTransaction) => Generator<IDBRequest, T, unknown>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    let current: IDBTransaction | undefined;
    const abort = () => { try { current?.abort(); } catch { /* The atomic transaction already completed. */ } };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      return await transaction(db, names, mode, function* (tx) { current = tx; signal?.throwIfAborted(); return yield* operation(tx); });
    } finally { signal?.removeEventListener('abort', abort); }
  }
  return {
    async preview(actorId: string, workspaceId: string, input: { before?: string; limit?: number } = {}, signal?: AbortSignal): Promise<BrowserCleanupPreview> {
      actorId = validate.text(actorId, 'actorId'); workspaceId = validate.text(workspaceId, 'workspaceId');
      const before = cutoff(input.before), limit = validate.limit(input.limit ?? 100);
      return run('readonly', function* (tx) {
        yield* owner(tx, actorId, workspaceId);
        const state = yield* graph(tx, workspaceId, before), items = [...state.eligible.values()], unknown = [...state.unknown.values()];
        return { before, items: items.slice(0, limit), unknownAge: unknown.slice(0, limit), hasMore: items.length > limit, unknownMore: unknown.length > limit };
      }, signal);
    },
    /** Start a conservative 24h clock for legacy orphan metadata with no age.
     * It removes nothing, and never refreshes/restarts an existing clock. */
    async observe(actorId: string, workspaceId: string, assetIds: readonly string[], signal?: AbortSignal) {
      actorId = validate.text(actorId, 'actorId'); workspaceId = validate.text(workspaceId, 'workspaceId');
      const selected = ids(assetIds), createdAt = new Date().toISOString(), before = cutoff();
      return run('readwrite', function* (tx) {
        yield* owner(tx, actorId, workspaceId);
        const state = yield* graph(tx, workspaceId, before); let observed = 0;
        for (const id of selected) {
          if (!state.unknown.has(id)) throw new StoreError('ACCESS_CHANGED', 'An orphan changed after review; refresh the cleanup preview');
          yield* request(tx.objectStore('meta').add({ key: assetAgeKey(id), createdAt })); observed++;
        }
        return { observed, eligibleAfter: new Date(Date.parse(createdAt) + day).toISOString() };
      }, signal);
    },
    async apply(actorId: string, workspaceId: string, input: Pick<BrowserCleanupPreview, 'before' | 'items'>, signal?: AbortSignal) {
      actorId = validate.text(actorId, 'actorId'); workspaceId = validate.text(workspaceId, 'workspaceId');
      const before = cutoff(input.before), selected = structuredClone(input.items);
      ids(selected.map((item) => item.assetId));
      for (const item of selected) { validate.hash(item.hash); validate.text(item.storageKey, 'storage key', 512); }
      return run('readwrite', function* (tx) {
        yield* owner(tx, actorId, workspaceId);
        const state = yield* graph(tx, workspaceId, before), pending: BrowserCleanupItem[] = []; let alreadyRemoved = 0;
        for (const item of selected) {
          const previous = yield* get<BrowserRetirement>(tx, 'meta', retirementKey(item.storageKey));
          if (previous) {
            if (previous.workspaceId !== workspaceId || !same(previous.review, item)) throw new StoreError('ACCESS_CHANGED', 'The retired object does not match this review');
            alreadyRemoved++; continue;
          }
          const current = state.eligible.get(item.assetId);
          if (!current || !same(current, item)) throw new StoreError('ACCESS_CHANGED', 'An asset became live or changed after review; refresh before cleanup');
          pending.push(current);
        }
        let bytesRemoved = 0;
        for (const item of pending) {
          const receipt: BrowserRetirement = { key: retirementKey(item.storageKey), assetId: item.assetId, workspaceId, storageKey: item.storageKey,
            hash: item.hash, byteLength: item.byteLength, retiredAt: new Date().toISOString(), review: item };
          yield* request(tx.objectStore('meta').add(receipt));
          yield* request(tx.objectStore('blobs').delete(item.storageKey)); bytesRemoved += item.storedByteLength;
        }
        // Drop only stale dedupe locators, not the immutable asset catalog.
        const retired = new Set(pending.map((item) => item.assetId));
        const claims = yield* request<{ workspaceId: string; hash: string; byteLength: number; mediaType: string; assetId: string }[]>(tx.objectStore('sharedAssets').getAll());
        for (const claim of claims) if (retired.has(claim.assetId)) yield* request(tx.objectStore('sharedAssets').delete([claim.workspaceId, claim.hash, claim.byteLength, claim.mediaType]));
        return { removed: pending.length, alreadyRemoved, bytesRemoved };
      }, signal);
    },
  };
}
export type BrowserMaintenance = ReturnType<typeof createBrowserMaintenance>;
