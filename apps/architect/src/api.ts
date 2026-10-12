import type { EditorAssetPlan, EditorAssetSnapshot } from '@character-unity/editor';
import type { Card, CardSource, Revision, Workspace } from '@character-unity/store';
import { createArchiveHttpHost } from '@character-unity/archive-browser';
import type { ArchiveHost } from '@character-unity/archive-browser';
import type { HistoryOptions, HistoryPage } from '@character-unity/cards';
export type { ArchiveHost } from '@character-unity/archive-browser';
export interface OpenCard { card: Card; revision: Revision; source: CardSource | null }

class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, { ...init, credentials: 'same-origin', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(35_000), ...(init.signal ? [init.signal] : [])]) });
  } catch { throw new Error('Cannot reach the local API. Check that it is running, then try again.'); }
  const result = await response.json();
  if (!response.ok) throw new ApiError(response.status, result.error?.message ?? 'The request could not be completed.');
  return result as T;
}
const part = encodeURIComponent;
const path = (workspace: string, card: string) => `workspaces/${part(workspace)}/cards/${part(card)}`;
function json(value: unknown): RequestInit { return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }; }
export const api = {
  kind: 'local' as const,
  archive: createArchiveHttpHost(request),
  async session() { await request('local-session', { method: 'POST', headers: { 'x-unity-session': 'local' } }); },
  async workspaces() {
    try { return (await request<{ workspaces: Workspace[] }>('workspaces')).workspaces; }
    catch (error) { if (error instanceof ApiError && error.status === 401) return null; throw error; }
  },
  createWorkspace: (name: string) => request<Workspace>('workspaces', json({ name })),
  async list(workspace: string, afterId?: string) {
    return (await request<{ cards: Card[] }>(`workspaces/${part(workspace)}/cards?limit=10${afterId ? `&afterId=${part(afterId)}` : ''}`)).cards;
  },
  open: (workspace: string, card: string) => request<OpenCard>(path(workspace, card)),
  history: (workspace: string, card: string, options: HistoryOptions = {}, signal?: AbortSignal) =>
    request<HistoryPage>(`${path(workspace, card)}/revisions?${new URLSearchParams(Object.entries(options).map(([key, value]) => [key, String(value)]))}`, { ...(signal ? { signal } : {}) }),
  revision: (workspace: string, card: string, revision: string, signal?: AbortSignal) =>
    request<Revision>(`${path(workspace, card)}/revisions/${part(revision)}`, { ...(signal ? { signal } : {}) }),
  assetList: (workspace: string, card: string, revisionId: string, signal?: AbortSignal) =>
    request<EditorAssetSnapshot>(`${path(workspace, card)}/assets?revisionId=${part(revisionId)}`, { ...(signal ? { signal } : {}) }),
  async asset(workspace: string, card: string, revisionId: string, assetPath: string, signal?: AbortSignal) {
    const headers = new Headers(); 
    const response = await fetch(`/api/${path(workspace, card)}/asset?revisionId=${part(revisionId)}&path=${part(assetPath)}`, {
      headers, credentials: 'same-origin', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(35_000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) { const value = await response.json(); throw new ApiError(response.status, value.error?.message ?? 'Asset download failed'); }
    return response.blob();
  },
  saveAssets(workspace: string, card: string, expectedHead: string, document: Revision['document'], plan: EditorAssetPlan) {
    const form = new FormData(); form.set('input', JSON.stringify({ expectedHead, document, bindings: plan.bindings }));
    plan.files.forEach((file, index) => form.set(`file:${index}`, file, `asset-${index}`));
    return request<Revision>(`${path(workspace, card)}/asset-revisions`, { method: 'POST', body: form });
  },
  async import(workspace: string, file: File) {
    if (file.size > 32 * 1024 * 1024) throw new Error('Choose a card smaller than 32 MiB.');
    // HTTP header values are Latin-1. Unicode filenames are represented safely without changing bytes.
    return request<{ card: Card; revision: Revision }>(`workspaces/${part(workspace)}/imports`, {
      method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name).slice(0, 512) },
    });
  },
  save: (workspace: string, card: string, expectedHead: string, document: Revision['document']) =>
    request<Revision>(`${path(workspace, card)}/revisions`, json({ expectedHead, document })),
  async export(workspace: string, card: string, revisionId: string, format: 'json' | 'png' | 'charx' | 'sillytavern-json' | 'sillytavern-png') {
    const response = await fetch(`/api/${path(workspace, card)}/export?revisionId=${part(revisionId)}&format=${format}`, {
      credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(35_000),
    });
    if (!response.ok) { const value = await response.json(); throw new ApiError(response.status, value.error?.message ?? 'Export failed'); }
    return response.blob();
  },
  async downloadOriginal(workspace: string, card: string) {
    const response = await fetch(`/api/${path(workspace, card)}/original`, { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(35_000) });
    if (!response.ok) throw new Error('Original download failed. Reconnect your session and try again.');
    return response.blob();
  },
};
export type ArchitectHost = Omit<typeof api, 'kind' | 'archive'> & { kind: 'local' | 'browser'; archive?: ArchiveHost };
