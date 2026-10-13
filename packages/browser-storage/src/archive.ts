import type { ArchiveAsset, ArchiveForkSource, ArchivePin, ArchiveReference, ArchiveReferenceInput, Asset, Card, CardSource, ImportIdentity, ImportMatch, Revision } from '@character-unity/store';
import { StoreError } from '@character-unity/store';
import * as validate from '@character-unity/store/validation';
import { request, transaction } from './transaction.js';

function* get<T>(tx: IDBTransaction, store: string, key: IDBValidKey) {
  return yield* request<T | undefined>(tx.objectStore(store).get(key));
}
function* reference(tx: IDBTransaction, workspaceId: string, id: string) {
  validate.text(workspaceId, 'workspaceId'); validate.text(id, 'referenceId');
  const row = yield* get<ArchiveReference>(tx, 'archiveReferences', id);
  if (!row || row.workspaceId !== workspaceId) throw new StoreError('NOT_FOUND', 'Archive reference not found in this workspace');
  return row;
}
const sourceKey = (workspaceId: string, pin: ArchivePin) => [workspaceId, pin.archiveId, pin.cardId];
export const importStores = ['cards', 'revisions', 'assets', 'sources', 'deletions', 'archiveReferences', 'archiveForks', 'importClaims'];
export function importClaims(workspaceId: string, cardId: string, revisionId: string, input: ImportIdentity & { fileHash: string; identity: NonNullable<ImportIdentity['identity']> }) {
  return [{ workspaceId, cardId, revisionId, kind: 'file', algorithm: 'sha256', hash: input.fileHash, moduleHash: '', lineageHash: '' },
    { workspaceId, cardId, revisionId, kind: 'content', algorithm: input.identity.algorithm, hash: input.identity.hash,
      moduleHash: input.moduleHash ?? '', lineageHash: input.lineageHash ?? '' }];
}
export function* deleteImportClaims(tx: IDBTransaction, cardId: string, kind?: 'content') {
  const claims = yield* request<{ workspaceId: string; kind: string; algorithm: string; hash: string; moduleHash: string; lineageHash: string }[]>(tx.objectStore('importClaims')
    .index('card').getAll(kind ? IDBKeyRange.only([cardId, kind]) : IDBKeyRange.bound([cardId], [cardId, []])));
  for (const claim of claims) yield* request(tx.objectStore('importClaims').delete([claim.workspaceId, claim.kind, claim.algorithm, claim.hash, claim.moduleHash, claim.lineageHash]));
}
export function* findImportMatchInTransaction(tx: IDBTransaction, workspaceId: string, input: ImportIdentity): Generator<IDBRequest, ImportMatch | null, unknown> {
  const cards = yield* request<Card[]>(tx.objectStore('cards').index('workspace').getAll(IDBKeyRange.bound([workspaceId], [workspaceId, []])));
  cards.sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1);
  const references = yield* request<ArchiveReference[]>(tx.objectStore('archiveReferences').index('workspace').getAll(IDBKeyRange.bound([workspaceId], [workspaceId, []])));
  references.sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1);
  if (input.fileHash) {
    const claimed = yield* get<{ cardId: string; revisionId: string }>(tx, 'importClaims', [workspaceId, 'file', 'sha256', input.fileHash, '', '']);
    if (claimed && !(yield* get(tx, 'deletions', claimed.cardId))) return { kind: 'card', cardId: claimed.cardId, revisionId: claimed.revisionId, match: 'file' };
    for (const card of cards) {
      if (!card.headRevisionId || (yield* get(tx, 'deletions', card.id))) continue;
      if (card.forkedFromRevisionId || (yield* get(tx, 'archiveForks', card.id))) continue;
      const source = yield* get<CardSource>(tx, 'sources', card.id);
      const asset = source ? yield* get<Asset>(tx, 'assets', source.assetId) : null;
      if (asset?.state === 'ready' && asset.hash === input.fileHash) return { kind: 'card', cardId: card.id, revisionId: card.headRevisionId, match: 'file' };
    }
    const ref = references.find((ref) => ref.fileHash === input.fileHash);
    if (ref) return { kind: 'reference', referenceId: ref.id, match: 'file' };
  }
  if (input.identity) {
    const claimed = yield* get<{ cardId: string; revisionId: string }>(tx, 'importClaims', [workspaceId, 'content', input.identity.algorithm,
      input.identity.hash, input.moduleHash ?? '', input.lineageHash ?? '']);
    const claimedCard = claimed ? yield* get<Card>(tx, 'cards', claimed.cardId) : undefined;
    if (claimed && claimedCard?.headRevisionId === claimed.revisionId && !(yield* get(tx, 'deletions', claimed.cardId))) {
      return { kind: 'card', cardId: claimed.cardId, revisionId: claimed.revisionId, match: 'content' };
    }
    for (const card of cards) {
      if (!card.headRevisionId || (yield* get(tx, 'deletions', card.id))) continue;
      const revision = yield* get<Revision>(tx, 'revisions', card.headRevisionId);
      if (!revision || revision.identity.algorithm !== input.identity.algorithm || revision.identity.hash !== input.identity.hash) continue;
      const moduleRef = revision.assets.find((asset) => asset.path === 'module.risum');
      const module = moduleRef ? yield* get<Asset>(tx, 'assets', moduleRef.assetId) : null;
      const lineage = (revision.document as { data?: { extensions?: { foundry?: { lineage?: { revisionHash?: unknown } } } } }).data?.extensions?.foundry?.lineage?.revisionHash;
      if ((module?.hash ?? null) === (input.moduleHash ?? null) && (lineage ?? null) === (input.lineageHash ?? null)) {
        return { kind: 'card', cardId: card.id, revisionId: revision.id, match: 'content' };
      }
    }
    const ref = references.find((ref) => ref.identity?.algorithm === input.identity!.algorithm && ref.identity.hash === input.identity!.hash
      && ref.moduleHash === (input.moduleHash ?? null) && ref.lineageHash === (input.lineageHash ?? null));
    if (ref) return { kind: 'reference', referenceId: ref.id, match: 'content' };
  }
  return null;
}
export function createBrowserArchiveOperations(db: IDBDatabase) {
  return {
    async addArchiveReference(input: ArchiveReferenceInput): Promise<ArchiveReference> {
      const pin = validate.archivePin(input.pin), workspaceId = validate.text(input.workspaceId, 'workspaceId');
      if (input.favorite !== undefined && typeof input.favorite !== 'boolean') validate.invalid('Expected favorite boolean');
      const value: ArchiveReference = { id: crypto.randomUUID(), workspaceId, pin, summary: validate.archiveSummary(input.summary),
        fileHash: input.fileHash === undefined ? null : validate.hash(input.fileHash), identity: input.identity ? validate.contentIdentity(input.identity) : null,
        moduleHash: input.moduleHash == null ? null : validate.hash(input.moduleHash), lineageHash: input.lineageHash == null ? null : validate.hash(input.lineageHash),
        favorite: input.favorite ?? false, createdAt: new Date().toISOString() };
      return transaction(db, ['workspaces', 'archiveReferences'], 'readwrite', function* (tx) {
        if (!(yield* get(tx, 'workspaces', workspaceId))) throw new StoreError('NOT_FOUND', 'Workspace not found');
        const previous = yield* request<ArchiveReference | undefined>(tx.objectStore('archiveReferences').index('source').get([...sourceKey(workspaceId, pin), pin.versionId]));
        if (previous) {
          if (value.favorite && !previous.favorite) { previous.favorite = true; yield* request(tx.objectStore('archiveReferences').put(previous)); }
          return previous;
        }
        yield* request(tx.objectStore('archiveReferences').add(value)); return value;
      });
    },
    getArchiveReference: (workspaceId: string, id: string) => transaction(db, ['archiveReferences'], 'readonly', (tx) => reference(tx, workspaceId, id)),
    async findArchiveReference(workspaceId: string, pin: ArchivePin): Promise<ArchiveReference | null> {
      validate.text(workspaceId, 'workspaceId'); const source = validate.archivePin(pin);
      return transaction(db, ['archiveReferences'], 'readonly', function* (tx) {
        return (yield* request<ArchiveReference | undefined>(tx.objectStore('archiveReferences').index('source').get([...sourceKey(workspaceId, source), source.versionId]))) ?? null;
      });
    },
    async archiveMemberships(workspaceId: string, archiveId: string, versions: readonly { cardId: string; versionId: string }[]): Promise<Record<string, ArchiveReference>> {
      validate.text(workspaceId, 'workspaceId'); validate.text(archiveId, 'archiveId');
      if (versions.length > 200) validate.invalid('At most 200 Archive versions per lookup');
      const pins = versions.map((pin) => validate.archivePin({ archiveId, ...pin }));
      return transaction(db, ['archiveReferences'], 'readonly', function* (tx) {
        const result: Record<string, ArchiveReference> = Object.create(null);
        for (const pin of pins) {
          const row = yield* request<ArchiveReference | undefined>(tx.objectStore('archiveReferences').index('source').get([...sourceKey(workspaceId, pin), pin.versionId]));
          if (row) result[pin.cardId] = row;
        }
        return result;
      });
    },
    async listArchiveReferences(workspaceId: string, options: { limit?: number; afterId?: string } = {}): Promise<ArchiveReference[]> {
      validate.text(workspaceId, 'workspaceId');
      const range = IDBKeyRange.bound([workspaceId, options.afterId === undefined ? '' : validate.text(options.afterId, 'afterId')], [workspaceId, []], true), limit = validate.limit(options.limit);
      return transaction(db, ['archiveReferences'], 'readonly', function* (tx) {
        return yield* request<ArchiveReference[]>(tx.objectStore('archiveReferences').index('workspace').getAll(range, limit));
      });
    },
    async setArchiveReferenceFavorite(workspaceId: string, id: string, favorite: boolean): Promise<void> {
      if (typeof favorite !== 'boolean') validate.invalid('Expected favorite boolean');
      await transaction(db, ['archiveReferences'], 'readwrite', function* (tx) {
        const row = yield* reference(tx, workspaceId, id); row.favorite = favorite;
        yield* request(tx.objectStore('archiveReferences').put(row));
      });
    },
    async removeArchiveReference(workspaceId: string, id: string): Promise<void> {
      await transaction(db, ['archiveReferences'], 'readwrite', function* (tx) {
        yield* reference(tx, workspaceId, id); yield* request(tx.objectStore('archiveReferences').delete(id));
      });
    },
    async registerArchiveAsset(input: { workspaceId: string; pin: ArchivePin; path: string; hash: string; byteLength: number; mediaType: string }): Promise<Asset> {
      const workspaceId = validate.text(input.workspaceId, 'workspaceId'), pin = validate.archivePin(input.pin), path = validate.assetPath(input.path);
      const id = crypto.randomUUID(), value: Asset = { id, workspaceId, hash: validate.hash(input.hash), byteLength: validate.count(input.byteLength, 'byteLength'),
        mediaType: validate.text(input.mediaType, 'mediaType'), storageKey: `archive-assets/${id}`, state: 'ready' };
      return transaction(db, ['workspaces', 'assets', 'archiveAssets'], 'readwrite', function* (tx) {
        if (!(yield* get(tx, 'workspaces', workspaceId))) throw new StoreError('NOT_FOUND', 'Workspace not found');
        const known = yield* request<ArchiveAsset | undefined>(tx.objectStore('archiveAssets').index('locator').get([...sourceKey(workspaceId, pin), pin.versionId, path]));
        if (known) {
          const asset = (yield* get<Asset>(tx, 'assets', known.assetId))!;
          if (asset.hash !== value.hash || asset.byteLength !== value.byteLength || asset.mediaType !== value.mediaType) throw new StoreError('INTEGRITY', 'An immutable Archive asset changed its measured identity');
          return asset;
        }
        yield* request(tx.objectStore('assets').add(value));
        yield* request(tx.objectStore('archiveAssets').add({ assetId: id, workspaceId, pin, path })); return value;
      });
    },
    async getArchiveAsset(workspaceId: string, assetId: string): Promise<ArchiveAsset | null> {
      validate.text(workspaceId, 'workspaceId'); validate.text(assetId, 'assetId');
      return transaction(db, ['archiveAssets'], 'readonly', function* (tx) {
        const row = yield* get<ArchiveAsset>(tx, 'archiveAssets', assetId); return row?.workspaceId === workspaceId ? row : null;
      });
    },
    async getArchiveForkSource(workspaceId: string, cardId: string): Promise<ArchiveForkSource | null> {
      validate.text(workspaceId, 'workspaceId'); validate.text(cardId, 'cardId');
      return transaction(db, ['archiveForks', 'deletions'], 'readonly', function* (tx) {
        if (yield* get(tx, 'deletions', cardId)) return null;
        const row = yield* get<ArchiveForkSource>(tx, 'archiveForks', cardId); return row?.workspaceId === workspaceId ? row : null;
      });
    },
    async findImportMatch(workspaceId: string, input: ImportIdentity): Promise<ImportMatch | null> {
      validate.text(workspaceId, 'workspaceId'); const identities = validate.importIdentity(input);
      return transaction(db, importStores, 'readonly', (tx) => findImportMatchInTransaction(tx, workspaceId, identities));
    },
  };
}
