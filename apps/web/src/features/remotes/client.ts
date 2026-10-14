import type { SyncReadPublication } from '@character-foundry/character-foundry/sync';
import type { CardSummaryList, HistoryPage } from '@character-unity/cards';
import type { RemoteDescriptor, ReturnJobView } from '@character-unity/cards/connections';
import type { Revision } from '@character-unity/store';
import type { OpenedCard } from '../../lib/unity';
import { clearPreparation, retainPreparation, type PreparationStorage, type ReturnPreparation } from './intent';

export type { RemoteDescriptor, ReturnJobView, SyncReadPublication };
export interface RemotesHost {
  readonly workspaceId: string;
  readonly scopeKey: string;
  readonly connection: {
    readonly actor: { readonly id: string };
    request<T>(path: string, init?: RequestInit): Promise<T>;
  };
  listCards(query: { offset?: number; limit?: number; sort?: string }, signal?: AbortSignal): Promise<CardSummaryList>;
}

export const remotePageSize = 20;
const part = encodeURIComponent;
const json = (value: unknown, signal?: AbortSignal): RequestInit => ({
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), ...(signal ? { signal } : {}),
});

/** Only configured connection IDs leave this browser; URLs and signing keys belong to the host. */
export function createRemotesClient(host: RemotesHost) {
  const workspaceId = host.workspaceId;
  const request = host.connection.request.bind(host.connection);
  const actorId = host.connection.actor.id;
  const listCards = host.listCards.bind(host);
  const jobsPath = `/api/remotes/workspaces/${part(workspaceId)}/jobs`;
  const job = async (id: string, signal?: AbortSignal) => {
    const current = await request<ReturnJobView>(`${jobsPath}/${part(id)}`, { signal });
    signal?.throwIfAborted();
    if (current.requestId !== id) throw new Error('Return response does not match the selected operation.');
    return current;
  };
  return {
    actorId,
    workspaceId,
    scopeKey: host.scopeKey,
    library: (offset = 0, signal?: AbortSignal) => listCards({ offset, limit: remotePageSize, sort: 'edited' }, signal),
    history(cardId: string, options: { afterSequence?: number; throughSequence?: number; signal?: AbortSignal } = {}) {
      const params = new URLSearchParams({ limit: String(remotePageSize) });
      if (options.afterSequence !== undefined) params.set('afterSequence', String(options.afterSequence));
      if (options.throughSequence !== undefined) params.set('throughSequence', String(options.throughSequence));
      return request<HistoryPage>(`/api/workspaces/${part(workspaceId)}/cards/${part(cardId)}/revisions?${params}`, { signal: options.signal });
    },
    async connections(signal?: AbortSignal) {
      return (await request<{ connections: RemoteDescriptor[] }>('/api/remotes/connections', { signal })).connections;
    },
    jobs(afterId = '', signal?: AbortSignal) {
      const params = new URLSearchParams({ limit: String(remotePageSize), ...(afterId ? { afterId } : {}) });
      return request<{ jobs: ReturnJobView[]; nextAfter: string | null }>(`${jobsPath}?${params}`, { signal });
    },
    pull(id: string, publicationId: string, signal?: AbortSignal) {
      return request<OpenedCard>(`/api/remotes/connections/${part(id)}/pulls`, json({ workspaceId, publicationId }, signal));
    },
    job,
    async review(id: string, signal?: AbortSignal) {
      const current = await job(id, signal);
      const revision = await request<Revision>(`/api/workspaces/${part(workspaceId)}/cards/${part(current.cardId)}/revisions/${part(current.revisionId)}`, { signal });
      signal?.throwIfAborted();
      if (revision.id !== current.revisionId || revision.cardId !== current.cardId) throw new Error('Return review does not match its saved revision.');
      return { job: current, revision };
    },
    async send(id: string, signal?: AbortSignal) {
      const current = await request<ReturnJobView>(`${jobsPath}/${part(id)}/send`, json({}, signal));
      if (current.requestId !== id || current.state !== 'acknowledged' || !current.receipt) {
        throw new Error('Remote acknowledgment is not confirmed. Review and retry this same saved return.');
      }
      return current;
    },
    publications(id: string, afterId = '', signal?: AbortSignal) {
      const params = new URLSearchParams({ workspaceId, limit: String(remotePageSize), ...(afterId ? { afterId } : {}) });
      return request<{ publications: SyncReadPublication[]; nextAfter: string | null }>(
        `/api/remotes/connections/${part(id)}/publications?${params}`, { signal });
    },
    async prepare(storage: PreparationStorage, input: ReturnPreparation, signal?: AbortSignal) {
      const value = { ...input };
      if (value.actorId !== actorId || value.workspaceId !== workspaceId) throw new Error('This preparation belongs to another account or workspace.');
      signal?.throwIfAborted();
      retainPreparation(storage, value);
      const job = await request<ReturnJobView>(jobsPath, json({ connectionId: value.connectionId, cardId: value.cardId,
        revisionId: value.revisionId, requestId: value.requestId }, signal));
      signal?.throwIfAborted();
      if (job.requestId !== value.requestId || job.cardId !== value.cardId || job.revisionId !== value.revisionId) {
        throw new Error('Return preparation did not match the selected saved revision. Retry the same preparation.');
      }
      clearPreparation(storage, actorId, workspaceId, value.requestId);
      return job;
    },
  };
}
export type RemotesClient = ReturnType<typeof createRemotesClient>;
