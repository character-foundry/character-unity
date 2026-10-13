import type { Card } from '../lib/types';
import { localDB } from '../lib/db';

export interface RecoveryDraft { key: string; card: Card; lastSaved: string; snapshotId?: string; baseRevisionId?: string }
export interface DraftRecovery {
  load(cardId: string): Promise<RecoveryDraft | null>;
  save(cardId: string, card: Card, baseRevisionId?: string): Promise<void>;
  remove(cardId: string): Promise<void>;
  dismiss?(draft: RecoveryDraft): Promise<void>;
  flush(): Promise<void>;
}

/** Recovery belongs to a workspace and an individual draft owner. Concurrent
 * editors never overwrite or delete each other's rows; restoring is explicit. */
export function createDraftRecovery(workspaceId: string, ownerId: string): DraftRecovery {
  let pending = Promise.resolve();
  const prefix = (cardId: string) => `unity:${JSON.stringify([workspaceId, cardId])}:`;
  const key = (cardId: string) => `${prefix(cardId)}${ownerId}`;
  const dismissedKey = (cardId: string) => `unity:recovery-dismissed:${JSON.stringify([workspaceId, cardId])}`;
  const snapshotIdentity = (draft: { snapshotId?: string; lastSaved: string }) => draft.snapshotId ?? draft.lastSaved;
  function dismissed(cardId: string): Record<string, string> {
    const value = localStorage.getItem(dismissedKey(cardId));
    if (value === null) return {};
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !Object.values(parsed).every((timestamp) => typeof timestamp === 'string')) throw new Error('Recovery dismissal metadata is invalid');
    return parsed as Record<string, string>;
  }
  function enqueue(action: () => Promise<void>) {
    const next = pending.catch(() => undefined).then(action);
    pending = next;
    return next;
  }
  return {
    async load(cardId) {
      await pending.catch(() => undefined);
      const drafts = await localDB.listDrafts(prefix(cardId));
      const ignored = dismissed(cardId);
      const latest = drafts.filter((draft) => ignored[draft.id] !== snapshotIdentity(draft))
        .sort((a, b) => b.lastSaved.localeCompare(a.lastSaved))[0];
      return latest ? { key: latest.id, card: latest.card, lastSaved: latest.lastSaved, snapshotId: latest.snapshotId, baseRevisionId: latest.baseRevisionId } : null;
    },
    save(cardId, card, baseRevisionId) {
      const snapshot = structuredClone(card);
      return enqueue(() => localDB.saveDraft(key(cardId), snapshot, baseRevisionId));
    },
    remove(cardId) { return enqueue(() => localDB.deleteDraft(key(cardId))); },
    async dismiss(draft) {
      const cardId = draft.card.meta.id;
      if (!cardId || !draft.key.startsWith(prefix(cardId))) throw new Error('The recovery draft belongs to a different workspace or card');
      // Acknowledge this exact snapshot without deleting another live editor's
      // row. New writes have fresh ids even within the same clock millisecond.
      const ignored = dismissed(cardId);
      ignored[draft.key] = snapshotIdentity(draft);
      localStorage.setItem(dismissedKey(cardId), JSON.stringify(ignored));
    },
    flush() { return pending; },
  };
}
