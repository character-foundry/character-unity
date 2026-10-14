import { StoreError } from '@character-unity/store';
import { validateMetaTagCatalog, validateMetaTagWrite, type MetaTagCatalog, type MetaTagStore } from '@character-unity/store/meta-tags';
import { text } from '@character-unity/store/validation';
import { request, transaction } from './transaction.js';

const key = (workspaceId: string) => `meta-tags:catalog:${JSON.stringify(workspaceId)}`;
function* workspace(tx: IDBTransaction, workspaceId: string) {
  if (!(yield* request(tx.objectStore('workspaces').get(workspaceId)))) throw new StoreError('NOT_FOUND', 'Workspace not found');
}
function* read(tx: IDBTransaction, workspaceId: string): Generator<IDBRequest, MetaTagCatalog, unknown> {
  yield* workspace(tx, workspaceId);
  const row = yield* request<{ catalog: MetaTagCatalog } | undefined>(tx.objectStore('meta').get(key(workspaceId)));
  if (!row) return { version: 0, groups: [] };
  try { return validateMetaTagCatalog(row.catalog); }
  catch (cause) { throw new StoreError('INTEGRITY', 'Stored meta-tag catalog is invalid', { cause }); }
}
/** Existing schema4 meta storage; native transactions fence all competing tabs. */
export function createBrowserMetaTags(db: IDBDatabase): MetaTagStore {
  return {
    async readMetaTags(workspaceId) {
      workspaceId = text(workspaceId, 'workspaceId');
      return transaction(db, ['workspaces', 'meta'], 'readonly', (tx) => read(tx, workspaceId));
    },
    async writeMetaTags(workspaceId, input) {
      workspaceId = text(workspaceId, 'workspaceId');
      const snapshot = validateMetaTagWrite(input);
      return transaction(db, ['workspaces', 'meta'], 'readwrite', function* (tx) {
        const current = yield* read(tx, workspaceId);
        if (current.version !== snapshot.expectedVersion) throw new StoreError('HEAD_CONFLICT', 'The meta-tag catalog changed; reload before saving');
        const catalog = { version: current.version + 1, groups: snapshot.groups };
        yield* request(tx.objectStore('meta').put({ key: key(workspaceId), catalog }));
        return catalog;
      });
    },
  };
}
