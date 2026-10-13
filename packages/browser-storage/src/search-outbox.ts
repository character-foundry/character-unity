import type { SearchJob } from '@character-unity/store';
import * as validate from '@character-unity/store/validation';
import { request, transaction } from './transaction.js';

interface StoredSearchJob extends SearchJob { pending: boolean; queuedAt: string }
export function* enqueueSearchJob(tx: IDBTransaction, input: Pick<SearchJob, 'workspaceId' | 'cardId' | 'revisionId' | 'operation'>) {
  const previous = yield* request<StoredSearchJob | undefined>(tx.objectStore('searchJobs').get([input.workspaceId, input.cardId]));
  const eventSequence = validate.count((previous?.eventSequence ?? 0) + 1, 'eventSequence');
  yield* request(tx.objectStore('searchJobs').put({ ...input, eventSequence,
    pending: true, error: null, queuedAt: new Date().toISOString() }));
}
export function createBrowserSearchOutbox(db: IDBDatabase) {
  const key = (workspaceId: string, cardId: string, eventSequence: number) => {
    validate.count(eventSequence, 'eventSequence'); return [validate.text(workspaceId, 'workspaceId'), validate.text(cardId, 'cardId')];
  };
  return {
    async listSearchJobs(options: { limit?: number; workspaceId?: string; includeFailed?: boolean } = {}): Promise<SearchJob[]> {
      const limit = validate.limit(options.limit);
      const workspaceId = options.workspaceId === undefined ? null : validate.text(options.workspaceId, 'workspaceId');
      return transaction(db, ['searchJobs'], 'readonly', function* (tx) {
        const jobs = yield* request<StoredSearchJob[]>(workspaceId === null ? tx.objectStore('searchJobs').getAll()
          : tx.objectStore('searchJobs').index('workspace').getAll(IDBKeyRange.bound([workspaceId], [workspaceId, []])));
        return jobs.filter((job) => job.pending && (options.includeFailed !== false || job.error === null)).sort((a, b) => a.queuedAt < b.queuedAt ? -1 : a.queuedAt > b.queuedAt ? 1
          : a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : a.cardId < b.cardId ? -1 : 1)
          .slice(0, limit).map((job) => ({ workspaceId: job.workspaceId, cardId: job.cardId, revisionId: job.revisionId,
            operation: job.operation, eventSequence: job.eventSequence, error: job.error }));
      });
    },
    async ackSearchJob(workspaceId: string, cardId: string, eventSequence: number): Promise<boolean> {
      const id = key(workspaceId, cardId, eventSequence);
      return transaction(db, ['searchJobs'], 'readwrite', function* (tx) {
        const row = yield* request<StoredSearchJob | undefined>(tx.objectStore('searchJobs').get(id));
        if (!row || !row.pending || row.eventSequence !== eventSequence) return false;
        row.pending = false; row.error = null; yield* request(tx.objectStore('searchJobs').put(row)); return true;
      });
    },
    async failSearchJob(workspaceId: string, cardId: string, eventSequence: number, error: string): Promise<boolean> {
      const id = key(workspaceId, cardId, eventSequence), message = validate.text(error, 'search error', 2000);
      return transaction(db, ['searchJobs'], 'readwrite', function* (tx) {
        const row = yield* request<StoredSearchJob | undefined>(tx.objectStore('searchJobs').get(id));
        if (!row || !row.pending || row.eventSequence !== eventSequence) return false;
        row.error = message; yield* request(tx.objectStore('searchJobs').put(row)); return true;
      });
    },
  };
}
