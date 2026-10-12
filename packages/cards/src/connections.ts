import type { UnityStore } from '@character-unity/store';
import { StoreError } from '@character-unity/store';
import type { SyncOutboxStore, ReturnJob } from '@character-unity/store/sync-outbox';
import type { RemoteCardConnection, RemoteCardService } from './remote.js';
import type { createRemoteReturnService } from './remote-outbox.js';
import { CardError } from './types.js';
import type { Actor } from './types.js';

export interface ConfiguredRemote { id: string; name: string; accountId: string; connection: RemoteCardConnection }
export interface RemoteDescriptor { id: string; name: string; baseUrl: string; actor: string }
export interface ReturnJobView {
  requestId: string; connectionId: string | null; destination: string; baseUrl: string; publicationId: string;
  cardId: string; revisionId: string; title: string; sequence: number; frameHash: string; byteLength: number;
  createdAt: string; state: ReturnJob['state']; attempts: number; receivedAt: string | null; receipt: ReturnJob['receipt'];
}
type RemoteService = RemoteCardService & { returns: ReturnType<typeof createRemoteReturnService> };

/** Account-bound host configuration. Public results are explicit allowlists without credentials. */
export function createRemoteConnectionsService(store: UnityStore, outbox: SyncOutboxStore,
  configured: readonly ConfiguredRemote[], create: (connection: RemoteCardConnection) => RemoteService) {
  const connections = configured.map((value) => ({ ...value, connection: { ...value.connection } }));
  function allowed(actor: Actor) { return connections.filter((value) => value.accountId === actor.id && value.connection.actor === actor.uri); }
  function select(actor: Actor, id: string) {
    const value = allowed(actor).find((value) => value.id === id);
    if (!value) throw new CardError('FORBIDDEN', 'Remote connection is not configured for this account');
    return create(value.connection);
  }
  function matching(actor: Actor, job: ReturnJob) {
    return allowed(actor).find((value) => value.connection.actor === job.actor && value.connection.baseUrl === job.baseUrl);
  }
  async function view(actor: Actor, workspaceId: string, job: ReturnJob): Promise<ReturnJobView> {
    const revision = await store.getRevision(workspaceId, job.revisionId), data = revision.document.data;
    const connection = matching(actor, job);
    const name = data && typeof data === 'object' && !Array.isArray(data) ? data.name : revision.document.name;
    return { requestId: job.requestId, connectionId: connection?.id ?? null, destination: connection?.name ?? 'Unavailable connection',
      baseUrl: job.baseUrl, publicationId: job.publicationId, cardId: job.cardId, revisionId: job.revisionId,
      title: typeof name === 'string' && name.trim() ? name : 'Untitled character', sequence: revision.sequence,
      frameHash: job.frameHash, byteLength: job.byteLength, createdAt: job.createdAt, state: job.state,
      attempts: job.attempts, receivedAt: job.receivedAt, receipt: job.receipt };
  }
  async function getJob(actor: Actor, workspaceId: string, requestId: string) {
    const job = await outbox.get({ accountId: actor.id, workspaceId }, requestId);
    if (!job) throw new StoreError('NOT_FOUND', 'Return job not found in this workspace');
    return job;
  }
  return {
    list(actor: Actor): RemoteDescriptor[] {
      return allowed(actor).map(({ id, name, connection }) => ({ id, name, baseUrl: connection.baseUrl, actor: connection.actor }));
    },
    publications(actor: Actor, workspaceId: string, id: string, options: { after?: string; limit?: number }, signal?: AbortSignal) {
      return select(actor, id).list(actor, workspaceId, options, signal);
    },
    pull(actor: Actor, workspaceId: string, id: string, publicationId: string, signal?: AbortSignal) {
      return select(actor, id).pullFork(actor, workspaceId, publicationId, signal);
    },
    async jobs(actor: Actor, workspaceId: string, options: { afterId?: string; limit?: number }) {
      actor = { ...actor };
      const rows = await outbox.list({ accountId: actor.id, workspaceId }, options);
      return Promise.all(rows.map((job) => view(actor, workspaceId, job)));
    },
    async job(actor: Actor, workspaceId: string, requestId: string) {
      actor = { ...actor }; return view(actor, workspaceId, await getJob(actor, workspaceId, requestId));
    },
    async enqueue(actor: Actor, workspaceId: string, id: string, cardId: string, revisionId: string, requestId: string, signal?: AbortSignal) {
      actor = { ...actor };
      return view(actor, workspaceId, await select(actor, id).returns.enqueue(actor, workspaceId, cardId, revisionId, requestId, signal));
    },
    async send(actor: Actor, workspaceId: string, requestId: string, signal?: AbortSignal) {
      actor = { ...actor }; const job = await getJob(actor, workspaceId, requestId), connection = matching(actor, job);
      if (!connection) throw new CardError('FORBIDDEN', 'This return connection is unavailable; ask the operator to restore it');
      return view(actor, workspaceId, await select(actor, connection.id).returns.send(actor, workspaceId, requestId, signal));
    },
  };
}
export type RemoteConnectionsService = ReturnType<typeof createRemoteConnectionsService>;
