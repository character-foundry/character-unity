import type { CardSummary, CardSummaryList, HistoryPage } from '@character-unity/cards';
import type { HubService } from '@character-unity/cards/hub';
import type { CardDocument } from '@character-unity/store';
import type { PublicationPolicy } from '@character-unity/store/hub';

export type Publication = Awaited<ReturnType<HubService['get']>>;
export type PublishedLineage = Awaited<ReturnType<HubService['lineage']>>;
export type { PublicationPolicy };
export interface SelectedRevision { cardId: string; revisionId: string; name: string; sequence: number }
export interface ReviewedRevision extends SelectedRevision { document: CardDocument; createdAt: string }
export interface SharingHost {
  readonly workspaceId: string;
  readonly scopeKey: string;
  readonly connection: {
    readonly actor: { readonly id: string };
    request<T>(path: string, init?: RequestInit): Promise<T>;
    fetch(path: string, init?: RequestInit): Promise<Response>;
  };
  listCards(query: { offset?: number; limit?: number; sort?: string }, signal?: AbortSignal): Promise<CardSummaryList>;
}

export const defaultPolicy: Readonly<PublicationPolicy> = Object.freeze({ visibility: 'members', allowFork: true, allowOriginal: false });
export const publicationPageSize = 20;
const part = encodeURIComponent;
const json = (value: unknown, method = 'POST', signal?: AbortSignal): RequestInit => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), ...(signal ? { signal } : {}),
});

/** Selection snapshots exact saved heads; refreshed library data never silently repins them. */
export function selectRevision(selected: readonly SelectedRevision[], card: CardSummary, checked: boolean): SelectedRevision[] {
  if (!checked) return selected.filter((value) => value.cardId !== card.id);
  if (card.reference) throw new Error('Archive references are read-only links. Save an edited fork before publishing.');
  if (selected.some((value) => value.cardId === card.id)) return [...selected];
  if (selected.length >= 20) throw new Error('Select at most 20 saved revisions for one publication.');
  return [...selected, { cardId: card.id, revisionId: card.headRevisionId, name: card.name, sequence: card.revisionCount }];
}

export function publicationTitle(document: CardDocument): string {
  const data = document.data;
  return data && typeof data === 'object' && !Array.isArray(data) && typeof data.name === 'string' && data.name.trim()
    ? data.name : 'Untitled character';
}
export function publicationText(document: CardDocument, field: string): string {
  const data = document.data;
  return data && typeof data === 'object' && !Array.isArray(data) && typeof data[field] === 'string' ? data[field] as string : '';
}

/** Native sharing uses one immutable authenticated library client, including binary reads. */
export function createSharingClient(host: SharingHost) {
  const workspacePath = `/api/workspaces/${part(host.workspaceId)}`;
  const publicationPath = (id: string) => `/api/hub/publications/${part(id)}`;
  return {
    actorId: host.connection.actor.id,
    scopeKey: host.scopeKey,
    library: (offset = 0, signal?: AbortSignal) => host.listCards({ offset, limit: publicationPageSize, sort: 'edited' }, signal),
    history(cardId: string, options: { afterSequence?: number; throughSequence?: number; signal?: AbortSignal } = {}) {
      const params = new URLSearchParams({ limit: String(publicationPageSize) });
      if (options.afterSequence !== undefined) params.set('afterSequence', String(options.afterSequence));
      if (options.throughSequence !== undefined) params.set('throughSequence', String(options.throughSequence));
      return host.connection.request<HistoryPage>(`${workspacePath}/cards/${part(cardId)}/revisions?${params}`, { signal: options.signal });
    },
    async review(selected: readonly SelectedRevision[], signal: AbortSignal): Promise<ReviewedRevision[]> {
      // Snapshot before awaiting: callers can continue selecting without changing this review.
      const selection = selected.map((value) => ({ ...value }));
      if (!selection.length || selection.length > 20 || new Set(selection.map((value) => value.revisionId)).size !== selection.length) {
        throw new Error('Select 1–20 distinct saved revisions.');
      }
      return Promise.all(selection.map(async (value) => {
        const revision = await host.connection.request<{ id: string; sequence: number; document: CardDocument; createdAt: string }>(
          `${workspacePath}/cards/${part(value.cardId)}/revisions/${part(value.revisionId)}`, { signal });
        signal.throwIfAborted();
        if (revision.id !== value.revisionId) throw new Error('The saved revision changed unexpectedly. Review the selection again.');
        return { ...value, name: publicationTitle(revision.document), sequence: revision.sequence, document: revision.document, createdAt: revision.createdAt };
      }));
    },
    async list(options: { afterId?: string; parentId?: string; signal?: AbortSignal } = {}) {
      const params = new URLSearchParams({ limit: String(publicationPageSize) });
      if (options.afterId) params.set('afterId', options.afterId);
      if (options.parentId) params.set('parentId', options.parentId);
      const value = await host.connection.request<{ publications: Publication[] }>(`/api/hub/publications?${params}`, { signal: options.signal });
      return value.publications;
    },
    detail: (id: string, signal?: AbortSignal) => host.connection.request<Publication>(publicationPath(id), { signal }),
    publish(selected: readonly SelectedRevision[], policy: PublicationPolicy, signal?: AbortSignal) {
      const revisionIds = selected.map((value) => value.revisionId);
      if (!revisionIds.length || revisionIds.length > 20 || new Set(revisionIds).size !== revisionIds.length) throw new Error('Select 1–20 distinct saved revisions.');
      return host.connection.request<{ publications: { id: string; policyVersion: number }[] }>('/api/hub/publications',
        json({ workspaceId: host.workspaceId, revisionIds,
          policy: { visibility: policy.visibility, allowFork: policy.allowFork, allowOriginal: policy.allowOriginal } }, 'POST', signal));
    },
    policy(id: string, expectedVersion: number, policy: PublicationPolicy, signal?: AbortSignal) {
      return host.connection.request<PublicationPolicy & { policyVersion: number }>(`${publicationPath(id)}/policy`,
        json({ expectedVersion, policy: { visibility: policy.visibility, allowFork: policy.allowFork, allowOriginal: policy.allowOriginal } }, 'PATCH', signal));
    },
    fork: (id: string, signal?: AbortSignal) => host.connection.request<{ card: { id: string } }>(`${publicationPath(id)}/forks`,
      json({ workspaceId: host.workspaceId }, 'POST', signal)),
    lineage(id: string, options: { afterId?: string; signal?: AbortSignal } = {}) {
      const params = new URLSearchParams({ limit: String(publicationPageSize), ...(options.afterId ? { afterId: options.afterId } : {}) });
      return host.connection.request<PublishedLineage>(`${publicationPath(id)}/lineage?${params}`, { signal: options.signal });
    },
    async original(id: string, signal?: AbortSignal) {
      const response = await host.connection.fetch(`${publicationPath(id)}/original`, { signal });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `Original download failed (${response.status})`);
      }
      return response.blob();
    },
  };
}
export type SharingClient = ReturnType<typeof createSharingClient>;
