import { StoreError } from '@character-unity/store';
import type { Asset, Card, CardSource, CardSourceInput, Revision, RevisionInput, UnityStore, Workspace } from '@character-unity/store';
import * as validate from '@character-unity/store/validation';
import { fold, libraryComparator, libraryMatcher, librarySource } from '@character-unity/store/library-query';
import { inspectDatabase } from './database.js';
import { request, transaction } from './transaction.js';

function* get<T>(tx: IDBTransaction, store: string, id: string): Generator<IDBRequest, T | undefined, unknown> {
  return yield* request<T | undefined>(tx.objectStore(store).get(id));
}
function* workspace(tx: IDBTransaction, id: string) {
  validate.text(id, 'workspaceId');
  const value = yield* get<Workspace>(tx, 'workspaces', id);
  if (!value) throw new StoreError('NOT_FOUND', 'Workspace not found');
  return value;
}
function* scoped<T extends { workspaceId: string }>(tx: IDBTransaction, table: string, workspaceId: string, id: string) {
  const row = yield* get<T>(tx, table, id);
  if (!row || row.workspaceId !== workspaceId) throw new StoreError('NOT_FOUND', 'Record not found in this workspace');
  // Deleted cards are tombstoned (revisions are immutable); every transaction that reads cards also reads deletions.
  if (table === 'cards' && (yield* get(tx, 'deletions', id))) throw new StoreError('NOT_FOUND', 'Record not found in this workspace');
  return row;
}
function* ready(tx: IDBTransaction, workspaceId: string, assetId: string) {
  const asset = yield* get<Asset>(tx, 'assets', assetId);
  if (!asset || asset.workspaceId !== workspaceId || asset.state !== 'ready') {
    throw new StoreError('ASSET_NOT_READY', 'An asset is missing, staged, or belongs to another workspace');
  }
}
function snapshot(input: RevisionInput): RevisionInput {
  const document = JSON.parse(validate.revision(input));
  return { authorId: input.authorId, identity: { ...input.identity }, document, assets: structuredClone(input.assets ?? []) };
}
function sourceSnapshot(input?: CardSourceInput): CardSourceInput | undefined {
  if (!input) return undefined;
  return { assetId: validate.text(input.assetId, 'source assetId'), provenance: JSON.parse(validate.document(input.provenance, 8192)) };
}
function revision(card: Card, input: RevisionInput, sequence: number, parent: string | null): Revision {
  return { id: card.headRevisionId, cardId: card.id, workspaceId: card.workspaceId, sequence,
    parentRevisionId: parent, authorId: input.authorId, identity: input.identity, document: input.document,
    assets: [...(input.assets ?? [])].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), createdAt: new Date().toISOString() };
}
function* insertRevision(tx: IDBTransaction, value: Revision) {
  for (const asset of value.assets) yield* ready(tx, value.workspaceId, asset.assetId);
  yield* request(tx.objectStore('revisions').add(value));
}
function* insertSource(tx: IDBTransaction, card: Card, source?: CardSourceInput) {
  if (!source) return;
  yield* ready(tx, card.workspaceId, source.assetId);
  yield* request(tx.objectStore('sources').add({ ...source, cardId: card.id, workspaceId: card.workspaceId }));
}
const writeStores = ['workspaces', 'cards', 'revisions', 'assets', 'sources', 'deletions'];

/** Same trusted domain contract as SQL; each write is one native IDB transaction. */
export function createBrowserStore(db: IDBDatabase): UnityStore {
  function headRows(workspaceId: string) {
    return transaction(db, ['cards', 'revisions', 'sources', 'deletions', 'favorites', 'metrics'], 'readonly', function* (tx) {
      const cards = yield* request<Card[]>(tx.objectStore('cards').index('workspace').getAll(IDBKeyRange.bound([workspaceId], [workspaceId, []])));
      const rows: { card: Card; revision: Revision; source: CardSource | undefined; favorite: boolean; tokens: number | null }[] = [];
      for (const card of cards) {
        if (!card.headRevisionId || (yield* get(tx, 'deletions', card.id))) continue;
        const metrics = yield* get<{ total: number }>(tx, 'metrics', card.headRevisionId);
        rows.push({ card, revision: yield* scoped<Revision>(tx, 'revisions', workspaceId, card.headRevisionId), source: yield* get<CardSource>(tx, 'sources', card.id),
          favorite: !!(yield* get(tx, 'favorites', card.id)), tokens: metrics ? metrics.total : null });
      }
      return rows;
    });
  }
  async function followedKeys(workspaceId: string) {
    return new Set((await transaction(db, ['follows'], 'readonly', function* (tx) {
      return yield* request<{ key: string }[]>(tx.objectStore('follows').index('workspace').getAll(IDBKeyRange.bound([workspaceId], [workspaceId, []])));
    })).map((row) => row.key));
  }
  return {
    readiness: () => inspectDatabase(db),
    async findSyncFork() { throw new StoreError('INVALID_INPUT', 'Signed sync writes require a SQL host'); },
    async createWorkspace(input) {
      const value: Workspace = { id: crypto.randomUUID(), ownerId: validate.text(input.ownerId, 'ownerId'),
        name: validate.text(input.name, 'name'), createdAt: new Date().toISOString() };
      return transaction(db, ['workspaces'], 'readwrite', function* (tx) { yield* request(tx.objectStore('workspaces').add(value)); return value; });
    },
    getWorkspace: (id) => transaction(db, ['workspaces'], 'readonly', (tx) => workspace(tx, id)),
    async listWorkspaces(ownerId) {
      validate.text(ownerId, 'ownerId');
      return transaction(db, ['workspaces'], 'readonly', function* (tx) {
        return yield* request<Workspace[]>(tx.objectStore('workspaces').index('owner').getAll(IDBKeyRange.bound([ownerId], [ownerId, []]), 100));
      });
    },
    getCard: (workspaceId, id) => transaction(db, ['cards', 'deletions'], 'readonly', (tx) => scoped<Card>(tx, 'cards', workspaceId, id)),
    getRevision: (workspaceId, id) => transaction(db, ['revisions'], 'readonly', (tx) => scoped<Revision>(tx, 'revisions', workspaceId, id)),
    getAsset: (workspaceId, id) => transaction(db, ['assets'], 'readonly', (tx) => scoped<Asset>(tx, 'assets', workspaceId, id)),
    getSource: (workspaceId, cardId) => transaction(db, ['cards', 'sources', 'deletions'], 'readonly', function* (tx) {
      yield* scoped<Card>(tx, 'cards', workspaceId, cardId);
      return (yield* get<CardSource>(tx, 'sources', cardId)) ?? null;
    }),
    async createCard(input) {
      const data = snapshot(input), source = sourceSnapshot(input.source);
      const card: Card = { id: crypto.randomUUID(), workspaceId: input.workspaceId, headRevisionId: crypto.randomUUID(),
        originalHash: input.originalHash === undefined ? null : validate.hash(input.originalHash), forkedFromRevisionId: null, createdAt: new Date().toISOString() };
      const value = revision(card, data, 1, null);
      return transaction(db, writeStores, 'readwrite', function* (tx) {
        yield* workspace(tx, card.workspaceId);
        yield* request(tx.objectStore('cards').add(card));
        yield* insertSource(tx, card, source);
        yield* insertRevision(tx, value);
        return { card, revision: value };
      });
    },
    async saveRevision(input) {
      const data = snapshot(input);
      const { workspaceId, cardId } = input;
      const expectedHead = validate.text(input.expectedHead, 'expectedHead');
      return transaction(db, writeStores, 'readwrite', function* (tx) {
        const card = yield* scoped<Card>(tx, 'cards', workspaceId, cardId);
        if (card.headRevisionId !== expectedHead) throw new StoreError('HEAD_CONFLICT', 'The card has a newer revision; reload before saving');
        const parent = yield* scoped<Revision>(tx, 'revisions', workspaceId, expectedHead);
        card.headRevisionId = crypto.randomUUID();
        const value = revision(card, data, parent.sequence + 1, expectedHead);
        yield* insertRevision(tx, value);
        yield* request(tx.objectStore('cards').put(card));
        return value;
      });
    },
    async forkCard(input, syncContext) {
      if (syncContext) throw new StoreError('INVALID_INPUT', 'Signed sync writes require a SQL host');
      if (input.publication) throw new StoreError('INVALID_INPUT', 'Hub publication guards require the shared SQL store');
      const data = snapshot(input), source = sourceSnapshot(input.source);
      const { workspaceId, sourceWorkspaceId, sourceRevisionId } = input;
      return transaction(db, writeStores, 'readwrite', function* (tx) {
        yield* workspace(tx, workspaceId);
        const parent = yield* scoped<Revision>(tx, 'revisions', sourceWorkspaceId, sourceRevisionId);
        const original = yield* scoped<Card>(tx, 'cards', sourceWorkspaceId, parent.cardId);
        const card: Card = { id: crypto.randomUUID(), workspaceId, headRevisionId: crypto.randomUUID(),
          originalHash: original.originalHash, forkedFromRevisionId: parent.id, createdAt: new Date().toISOString() };
        const value = revision(card, data, 1, parent.id);
        yield* request(tx.objectStore('cards').add(card));
        yield* insertSource(tx, card, source);
        yield* insertRevision(tx, value);
        return { card, revision: value };
      });
    },
    async listCards(workspaceId, options = {}) {
      const range = IDBKeyRange.bound([workspaceId, options.afterId ?? ''], [workspaceId, []], true);
      const limit = validate.limit(options.limit);
      // Tombstoned cards are skipped, so a page can be short; callers page by the last returned id.
      return transaction(db, ['cards', 'deletions'], 'readonly', function* (tx) {
        const rows = yield* request<Card[]>(tx.objectStore('cards').index('workspace').getAll(range, limit));
        const live: Card[] = [];
        for (const row of rows) if (!(yield* get(tx, 'deletions', row.id))) live.push(row);
        return live;
      });
    },
    /** Same ordering and filters as the SQL store (library-query.ts); a browser library is small enough to scan. */
    async listCardSummaries(workspaceId, query = {}) {
      const limit = validate.limit(query.limit ?? 48), offset = validate.count(query.offset ?? 0, 'offset');
      const scan = await headRows(workspaceId);
      const revisionCards = new Map(scan.map(({ revision }) => [revision.id, revision.cardId]));
      const forks = new Map<string, number>();
      for (const { card } of scan) {
        const parentCard = card.forkedFromRevisionId ? revisionCards.get(card.forkedFromRevisionId) : undefined;
        if (parentCard) forks.set(parentCard, (forks.get(parentCard) ?? 0) + 1);
      }
      const matcher = libraryMatcher({ ...query, tags: [...(query.tags ?? []), ...(query.tag?.trim() ? [query.tag] : [])] }, await followedKeys(workspaceId));
      const ids = query.ids ? new Set(query.ids) : null;
      const rows = scan.filter(({ card }) => (!ids || ids.has(card.id))
        && (!query.forkOf || (card.forkedFromRevisionId !== null && revisionCards.get(card.forkedFromRevisionId) === query.forkOf)))
        .map((entry) => ({ ...entry, row: { cardId: entry.card.id, cardCreatedAt: entry.card.createdAt, forkedFromRevisionId: entry.card.forkedFromRevisionId,
          revisionCreatedAt: entry.revision.createdAt, sequence: entry.revision.sequence, document: entry.revision.document,
          assetPaths: entry.revision.assets.map((asset) => asset.path), forkCount: forks.get(entry.card.id) ?? 0,
          provenance: entry.source?.provenance ?? null, favorite: entry.favorite, inChat: false, tokens: entry.tokens } }))
        .filter(({ row }) => matcher(row));
      const order = libraryComparator(query.sort ?? 'edited');
      rows.sort((a, b) => order(a.row, b.row));
      return { total: rows.length, items: rows.slice(offset, offset + limit).map(({ card, revision, source, row }) => ({
        card, revision, forkCount: row.forkCount, favorite: row.favorite, tokensTotal: row.tokens, source: librarySource(row.provenance, row.document),
        sourceFormat: typeof (source?.provenance as { format?: unknown } | undefined)?.format === 'string' ? (source!.provenance as { format: string }).format : null,
      })) };
    },
    async listCardTags(workspaceId, options = {}) {
      const limit = options.limit ?? 1000;
      if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new StoreError('INVALID_INPUT', 'Tag list size must be between 1 and 5000');
      const counts = new Map<string, { tag: string; cards: Set<string> }>();
      for (const { card, revision } of await headRows(workspaceId)) {
        const tags = (revision.document as { data?: { tags?: unknown } }).data?.tags;
        if (!Array.isArray(tags)) continue;
        for (const tag of tags) {
          if (typeof tag !== 'string' || !tag.replace(/^ +| +$/g, '')) continue;
          const key = fold(tag), entry = counts.get(key) ?? { tag, cards: new Set<string>() };
          if (tag > entry.tag) entry.tag = tag;
          entry.cards.add(card.id); counts.set(key, entry);
        }
      }
      return [...counts.entries()].map(([key, { tag, cards }]) => ({ key, tag, count: cards.size }))
        .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(0, limit).map(({ tag, count }) => ({ tag, count }));
    },
    async deleteCard(workspaceId, cardId) {
      await transaction(db, ['cards', 'deletions', 'favorites'], 'readwrite', function* (tx) {
        yield* scoped<Card>(tx, 'cards', workspaceId, cardId);
        yield* request(tx.objectStore('deletions').add({ cardId, workspaceId, deletedAt: new Date().toISOString() }));
        yield* request(tx.objectStore('favorites').delete(cardId));
      });
    },
    async setFavorite(workspaceId, cardId, favorite) {
      await transaction(db, ['cards', 'deletions', 'favorites'], 'readwrite', function* (tx) {
        yield* scoped<Card>(tx, 'cards', workspaceId, cardId);
        if (favorite) yield* request(tx.objectStore('favorites').put({ cardId, workspaceId, createdAt: new Date().toISOString() }));
        else yield* request(tx.objectStore('favorites').delete(cardId));
      });
    },
    async followCreator(workspaceId, creator, follow) {
      const name = creator.replace(/^ +| +$/g, '');
      if (!name || name.length > 200) throw new StoreError('INVALID_INPUT', 'Creator name must be 1 to 200 characters');
      await transaction(db, ['workspaces', 'follows'], 'readwrite', function* (tx) {
        yield* workspace(tx, workspaceId);
        if (follow) { if (!(yield* request(tx.objectStore('follows').get([workspaceId, fold(name)])))) yield* request(tx.objectStore('follows').add({ workspaceId, key: fold(name), creator: name, createdAt: new Date().toISOString() })); }
        else yield* request(tx.objectStore('follows').delete([workspaceId, fold(name)]));
      });
    },
    async listFollowedCreators(workspaceId) {
      return (await transaction(db, ['follows'], 'readonly', function* (tx) {
        return yield* request<{ creator: string }[]>(tx.objectStore('follows').index('workspace').getAll(IDBKeyRange.bound([workspaceId], [workspaceId, []]), 5000));
      })).map((row) => row.creator);
    },
    async putRevisionMetrics(workspaceId, revisionId, metrics) {
      validate.count(metrics.total, 'total');
      await transaction(db, ['revisions', 'metrics'], 'readwrite', function* (tx) {
        yield* scoped<Revision>(tx, 'revisions', workspaceId, revisionId);
        yield* request(tx.objectStore('metrics').put({ revisionId, workspaceId, tokenizer: validate.text(metrics.tokenizer, 'tokenizer'), total: metrics.total, tokens: { ...metrics.tokens } }));
      });
    },
    async revisionsMissingMetrics(options = {}) {
      const limit = validate.limit(options.limit ?? 100);
      return transaction(db, ['cards', 'deletions', 'metrics'], 'readonly', function* (tx) {
        const cards = yield* request<Card[]>(tx.objectStore('cards').getAll());
        const missing: { workspaceId: string; revisionId: string }[] = [];
        for (const card of cards) {
          if (missing.length >= limit) break;
          if (!card.headRevisionId || (yield* get(tx, 'deletions', card.id)) || (yield* get(tx, 'metrics', card.headRevisionId))) continue;
          missing.push({ workspaceId: card.workspaceId, revisionId: card.headRevisionId });
        }
        return missing;
      });
    },
    async listRevisions(workspaceId, cardId, options = {}) {
      const range = IDBKeyRange.bound([workspaceId, cardId, validate.count(options.afterSequence ?? 0, 'afterSequence')], [workspaceId, cardId, []], true);
      const limit = validate.limit(options.limit);
      return transaction(db, ['revisions'], 'readonly', function* (tx) {
        return yield* request<Revision[]>(tx.objectStore('revisions').index('history').getAll(range, limit));
      });
    },
    async listForks(workspaceId, sourceRevisionId, options = {}) {
      const range = IDBKeyRange.bound([workspaceId, sourceRevisionId, options.afterId ?? ''], [workspaceId, sourceRevisionId, []], true);
      const limit = validate.limit(options.limit);
      return transaction(db, ['cards', 'deletions'], 'readonly', function* (tx) {
        const rows = yield* request<Card[]>(tx.objectStore('cards').index('forks').getAll(range, limit));
        const live: Card[] = [];
        for (const row of rows) if (!(yield* get(tx, 'deletions', row.id))) live.push(row);
        return live;
      });
    },
    async stageAsset(input) {
      const id = crypto.randomUUID();
      const asset: Asset = { id, workspaceId: validate.text(input.workspaceId, 'workspaceId'), hash: validate.hash(input.hash),
        byteLength: validate.count(input.byteLength, 'byteLength'), mediaType: validate.text(input.mediaType, 'mediaType'), storageKey: `assets/${id}`, state: 'staged' };
      return transaction(db, ['workspaces', 'assets'], 'readwrite', function* (tx) {
        yield* workspace(tx, asset.workspaceId);
        yield* request(tx.objectStore('assets').add(asset)); return asset;
      });
    },
    async completeAsset(input) {
      const { workspaceId, assetId } = input;
      const hash = validate.hash(input.measuredHash), byteLength = validate.count(input.measuredByteLength, 'measuredByteLength');
      return transaction(db, ['assets'], 'readwrite', function* (tx) {
        const asset = yield* scoped<Asset>(tx, 'assets', workspaceId, assetId);
        if (asset.hash !== hash || asset.byteLength !== byteLength) throw new StoreError('INTEGRITY', 'Uploaded bytes do not match the staged asset');
        asset.state = 'ready'; yield* request(tx.objectStore('assets').put(asset)); return asset;
      });
    },
  };
}
