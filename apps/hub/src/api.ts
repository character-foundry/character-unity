import type { EditorAssetPlan, EditorAssetSnapshot } from '@character-unity/editor';
import type { Card, Revision, Workspace } from '@character-unity/store';
import type { PublicationPolicy } from '@character-unity/store/hub';
import type { HubService } from '@character-unity/cards/hub';
import type { HistoryOptions, HistoryPage } from '@character-unity/cards';
import { createArchiveHttpHost } from '@character-unity/archive-browser';
import type { RemoteDescriptor, ReturnJobView } from '@character-unity/cards/connections';
import type { SyncReadPublication } from '@character-foundry/character-foundry/sync';
export interface Session { actor: { id: string; uri: string }; name: string; expiresAt: number }
export interface OpenCard { card: Card; revision: Revision }
export type Publication = Awaited<ReturnType<HubService['get']>>;
export type LineagePage = Awaited<ReturnType<HubService['lineage']>>;
export class ApiError extends Error { constructor(public status: number, message: string, public code = '') { super(message); } }
let expectedActor: string | undefined;
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (expectedActor && (path !== 'session' || init.method === 'DELETE')) headers.set('x-unity-actor', expectedActor);
  const response = await fetch(`/api/${path}`, { ...init, headers, credentials: 'same-origin', redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(init.signal ? [init.signal] : [])]) });
  if (response.status === 204) return undefined as T;
  const value = await response.json();
  if (!response.ok) throw new ApiError(response.status, value.error?.message ?? 'The request failed', value.error?.code);
  return value as T;
}
const part = encodeURIComponent;
const json = (value: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
export const api = {
  remotes: {
    async connections(signal?: AbortSignal) { return (await request<{ connections: RemoteDescriptor[] }>('remotes/connections', { ...(signal ? { signal } : {}) })).connections; },
    publications: (id: string, workspaceId: string, afterId = '', signal?: AbortSignal) => request<{ publications: SyncReadPublication[]; nextAfter: string | null }>(
      `remotes/connections/${part(id)}/publications?${new URLSearchParams({ workspaceId, limit: '20', ...(afterId ? { afterId } : {}) })}`, { ...(signal ? { signal } : {}) }),
    pull: (id: string, workspaceId: string, publicationId: string) => request<OpenCard>(`remotes/connections/${part(id)}/pulls`, json({ workspaceId, publicationId })),
    jobs: (workspaceId: string, afterId = '', signal?: AbortSignal) => request<{ jobs: ReturnJobView[]; nextAfter: string | null }>(
      `remotes/workspaces/${part(workspaceId)}/jobs?limit=20${afterId ? `&afterId=${part(afterId)}` : ''}`, { ...(signal ? { signal } : {}) }),
    job: (workspaceId: string, requestId: string) => request<ReturnJobView>(`remotes/workspaces/${part(workspaceId)}/jobs/${part(requestId)}`),
    enqueue: (workspaceId: string, connectionId: string, cardId: string, revisionId: string, requestId: string) =>
      request<ReturnJobView>(`remotes/workspaces/${part(workspaceId)}/jobs`, json({ connectionId, cardId, revisionId, requestId })),
    send: (workspaceId: string, requestId: string) => request<ReturnJobView>(`remotes/workspaces/${part(workspaceId)}/jobs/${part(requestId)}/send`, json({})),
  },
  archive: createArchiveHttpHost(request),
  async session() { const value = await request<Session>('session'); expectedActor = value.actor.id; return value; },
  async login(key: string) { const value = await request<Session>('session', json({ key })); expectedActor = value.actor.id; return value; },
  async logout() { await request<void>('session', { method: 'DELETE' }); expectedActor = undefined; },
  async workspaces() { return (await request<{ workspaces: Workspace[] }>('workspaces')).workspaces; },
  createWorkspace: (name: string) => request<Workspace>('workspaces', json({ name })),
  async library(workspace: string, afterId = '') {
    const cards = await request<{ cards: Card[] }>(`workspaces/${part(workspace)}/cards?limit=10&afterId=${part(afterId)}`);
    return Promise.all(cards.cards.map((card) => api.open(workspace, card.id)));
  },
  open: (workspace: string, card: string) => request<OpenCard>(`workspaces/${part(workspace)}/cards/${part(card)}`),
  history: (workspace: string, card: string, options: HistoryOptions = {}, signal?: AbortSignal) =>
    request<HistoryPage>(`workspaces/${part(workspace)}/cards/${part(card)}/revisions?${new URLSearchParams(Object.entries(options).map(([key, value]) => [key, String(value)]))}`, { ...(signal ? { signal } : {}) }),
  revision: (workspace: string, card: string, revision: string, signal?: AbortSignal) =>
    request<Revision>(`workspaces/${part(workspace)}/cards/${part(card)}/revisions/${part(revision)}`, { ...(signal ? { signal } : {}) }),
  assetList: (workspace: string, card: string, revisionId: string, signal?: AbortSignal) =>
    request<EditorAssetSnapshot>(`workspaces/${part(workspace)}/cards/${part(card)}/assets?revisionId=${part(revisionId)}`, { ...(signal ? { signal } : {}) }),
  async asset(workspace: string, card: string, revisionId: string, assetPath: string, signal?: AbortSignal) {
    const headers = new Headers(); if (expectedActor) headers.set('x-unity-actor', expectedActor);
    const response = await fetch(`/api/workspaces/${part(workspace)}/cards/${part(card)}/asset?revisionId=${part(revisionId)}&path=${part(assetPath)}`, {
      headers, credentials: 'same-origin', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(35_000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) { const value = await response.json(); throw new ApiError(response.status, value.error?.message ?? 'Asset download failed', value.error?.code); }
    return response.blob();
  },
  saveAssets(workspace: string, card: string, expectedHead: string, document: Revision['document'], plan: EditorAssetPlan) {
    const form = new FormData(); form.set('input', JSON.stringify({ expectedHead, document, bindings: plan.bindings }));
    plan.files.forEach((file, index) => form.set(`file:${index}`, file, `asset-${index}`));
    return request<Revision>(`workspaces/${part(workspace)}/cards/${part(card)}/asset-revisions`, { method: 'POST', body: form });
  },
  async import(workspace: string, file: File) {
    if (file.size > 32 * 1024 * 1024) throw new Error('Choose a card smaller than 32 MiB');
    return request<OpenCard>(`workspaces/${part(workspace)}/imports`, { method: 'POST', body: file,
      headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name).slice(0, 512) } });
  },
  async export(workspace: string, card: string, revisionId: string, format: 'json' | 'png' | 'charx' | 'sillytavern-json' | 'sillytavern-png') {
    const headers = new Headers(); if (expectedActor) headers.set('x-unity-actor', expectedActor);
    const response = await fetch(`/api/workspaces/${part(workspace)}/cards/${part(card)}/export?revisionId=${part(revisionId)}&format=${format}`, {
      headers, credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(35_000),
    });
    if (!response.ok) { const value = await response.json(); throw new ApiError(response.status, value.error?.message ?? 'Export failed', value.error?.code); }
    return response.blob();
  },
  save: (workspace: string, card: string, expectedHead: string, document: Revision['document']) =>
    request<Revision>(`workspaces/${part(workspace)}/cards/${part(card)}/revisions`, json({ expectedHead, document })),
  publish: (workspaceId: string, revisionIds: string[], policy: PublicationPolicy) => request<{ publications: { id: string; policyVersion: number }[] }>('hub/publications', json({ workspaceId, revisionIds, policy })),
  async publications(afterId = '', parentId = '') {
    return (await request<{ publications: Publication[] }>(`hub/publications?limit=20&afterId=${part(afterId)}${parentId ? `&parentId=${part(parentId)}` : ''}`)).publications;
  },
  fork: (id: string, workspaceId: string) => request<OpenCard>(`hub/publications/${part(id)}/forks`, json({ workspaceId })),
  lineage: (id: string, afterId = '') => request<LineagePage>(`hub/publications/${part(id)}/lineage?limit=20&afterId=${part(afterId)}`),
  policy: (id: string, expectedVersion: number, policy: PublicationPolicy) => request(`hub/publications/${part(id)}/policy`, json({ expectedVersion,
    policy: { visibility: policy.visibility, allowOriginal: policy.allowOriginal, allowFork: policy.allowFork } }, 'PATCH')),
};
