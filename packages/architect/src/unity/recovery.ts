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
export function createDraftRecovery(workspaceId: string, ownerId: string, options: { legacyLocalWorkspace?: string } = {}): DraftRecovery {
  let pending = Promise.resolve();
  const prefixFor = (namespace: string, cardId: string) => `unity:${JSON.stringify([namespace, cardId])}:`;
  const prefix = (cardId: string) => prefixFor(workspaceId, cardId);
  const namespaces = [...new Set([workspaceId, ...(options.legacyLocalWorkspace ? [options.legacyLocalWorkspace] : [])])];
  const key = (cardId: string) => `${prefix(cardId)}${ownerId}`;
  const dismissedKey = (namespace: string, cardId: string) => `unity:recovery-dismissed:${JSON.stringify([namespace, cardId])}`;
  const snapshotIdentity = (draft: { snapshotId?: string; lastSaved: string }) => draft.snapshotId ?? draft.lastSaved;
  function dismissed(namespace: string, cardId: string): Record<string, string> {
    const value = localStorage.getItem(dismissedKey(namespace, cardId));
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
      // This second namespace is enabled only by the trusted local host. Read
      // exact old rows/acknowledgments in place; never rename another editor's UUID.
      const drafts = (await Promise.all(namespaces.map(async (namespace) => {
        const rows = await localDB.listDrafts(prefixFor(namespace, cardId));
        const ignored = dismissed(namespace, cardId);
        return rows.filter((draft) => ignored[draft.id] !== snapshotIdentity(draft));
      }))).flat();
      const latest = drafts
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
      const namespace = cardId ? namespaces.find((namespace) => draft.key.startsWith(prefixFor(namespace, cardId))) : undefined;
      if (!namespace) throw new Error('The recovery draft belongs to a different workspace or card');
      // Acknowledge this exact snapshot without deleting another live editor's
      // row. New writes have fresh ids even within the same clock millisecond.
      const ignored = dismissed(namespace, cardId);
      ignored[draft.key] = snapshotIdentity(draft);
      localStorage.setItem(dismissedKey(namespace, cardId), JSON.stringify(ignored));
    },
    flush() { return pending; },
  };
}
