import type { Statement, StoreDriver } from './driver.js';
import * as validate from './validation.js';

export interface SearchJob {
  workspaceId: string; cardId: string; revisionId: string; operation: 'upsert' | 'delete';
  eventSequence: number; error: string | null;
}
/** Acknowledged rows retain their generation, so a delayed acknowledgment cannot erase a newer write. */
export function createSearchOutbox(driver: StoreDriver, batch: (statements: readonly Statement[]) => Promise<readonly number[]>) {
  const key = (workspaceId: string, cardId: string, eventSequence: number) => [validate.text(workspaceId, 'workspaceId'),
    validate.text(cardId, 'cardId'), validate.count(eventSequence, 'eventSequence')];
  return {
    async listSearchJobs(options: { limit?: number; workspaceId?: string; includeFailed?: boolean } = {}): Promise<SearchJob[]> {
      const workspaceId = options.workspaceId === undefined ? null : validate.text(options.workspaceId, 'workspaceId');
      return driver.query<SearchJob>({ sql: `SELECT workspace_id AS workspaceId,card_id AS cardId,revision_id AS revisionId,
        operation,event_sequence AS eventSequence,error FROM unity_search_outbox WHERE pending = 1
        ${workspaceId === null ? '' : 'AND workspace_id = ?'} ${options.includeFailed === false ? 'AND error IS NULL' : ''}
        ORDER BY queued_at,workspace_id,card_id LIMIT ?`,
        params: [...(workspaceId === null ? [] : [workspaceId]), validate.limit(options.limit)] });
    },
    async ackSearchJob(workspaceId: string, cardId: string, eventSequence: number): Promise<boolean> {
      const [changed] = await batch([{ sql: `UPDATE unity_search_outbox SET pending = 0,error = NULL
        WHERE workspace_id = ? AND card_id = ? AND event_sequence = ? AND pending = 1`, params: key(workspaceId, cardId, eventSequence) }]);
      return Boolean(changed);
    },
    async failSearchJob(workspaceId: string, cardId: string, eventSequence: number, error: string): Promise<boolean> {
      const message = validate.text(error, 'search error', 2000);
      const [changed] = await batch([{ sql: `UPDATE unity_search_outbox SET error = ?
        WHERE workspace_id = ? AND card_id = ? AND event_sequence = ? AND pending = 1`, params: [message, ...key(workspaceId, cardId, eventSequence)] }]);
      return Boolean(changed);
    },
  };
}
