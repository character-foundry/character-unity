import { createSyncToken } from '@character-foundry/character-foundry/sync';
import type { CardSummary } from '@character-unity/cards';

export interface ReturnPreparation {
  version: 1;
  actorId: string;
  workspaceId: string;
  connectionId: string;
  cardId: string;
  revisionId: string;
  requestId: string;
  title: string;
  sequence: number;
}
export type PreparationStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function createPreparation(owner: { actorId: string; workspaceId: string }, connectionId: string,
  card: Pick<CardSummary, 'id' | 'headRevisionId' | 'name' | 'revisionCount' | 'reference'>): ReturnPreparation {
  if (card.reference) throw new Error('Archive references are read-only. Save an owned fork before preparing a return.');
  return { version: 1, actorId: owner.actorId, workspaceId: owner.workspaceId, connectionId,
    cardId: card.id, revisionId: card.headRevisionId, requestId: createSyncToken(),
    title: (card.name || 'Untitled character').slice(0, 1024), sequence: card.revisionCount };
}

export function preparationKey(actorId: string, workspaceId: string): string {
  return `unity:return-preparation:v2:${encodeURIComponent(actorId)}:${encodeURIComponent(workspaceId)}`;
}

export function loadPreparation(storage: PreparationStorage, actorId: string, workspaceId: string): ReturnPreparation | null {
  const raw = storage.getItem(preparationKey(actorId, workspaceId));
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid preparation');
    const item = value as Record<string, unknown>;
    const ids = ['actorId', 'workspaceId', 'connectionId', 'cardId', 'revisionId'];
    if (Object.keys(item).length !== 9 || item.version !== 1 || item.actorId !== actorId || item.workspaceId !== workspaceId
      || ids.some((key) => typeof item[key] !== 'string' || !(item[key] as string).length || (item[key] as string).length > 200)
      || typeof item.requestId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(item.requestId)
      || typeof item.title !== 'string' || !item.title.length || item.title.length > 1024
      || !Number.isSafeInteger(item.sequence) || Number(item.sequence) < 1) throw new Error('Invalid preparation');
    return item as unknown as ReturnPreparation;
  } catch {
    throw new Error('Saved return preparation is unreadable. Dismiss it explicitly before preparing another return. Existing server returns are not deleted.');
  }
}

/** Persist before enqueueing. A lost response must not silently mint another operation ID. */
export function retainPreparation(storage: PreparationStorage, value: ReturnPreparation): void {
  const existing = loadPreparation(storage, value.actorId, value.workspaceId);
  if (existing && (Object.keys(existing) as (keyof ReturnPreparation)[]).some((key) => existing[key] !== value[key])) {
    throw new Error('Recover or dismiss the existing preparation before preparing another return.');
  }
  storage.setItem(preparationKey(value.actorId, value.workspaceId), JSON.stringify(value));
}

/** No expected ID means the user explicitly dismissed an unreadable preparation. */
export function clearPreparation(storage: PreparationStorage, actorId: string, workspaceId: string, expectedRequestId?: string): void {
  if (expectedRequestId && loadPreparation(storage, actorId, workspaceId)?.requestId !== expectedRequestId) return;
  storage.removeItem(preparationKey(actorId, workspaceId));
}
