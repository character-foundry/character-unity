import type { CardSummary, CardSummaryList } from '@character-unity/cards';
import type { CardDocument } from '@character-unity/store';

export type { CardSummary };
export type ExportFormat = 'json' | 'png' | 'charx' | 'sillytavern-json' | 'sillytavern-png';
export interface OpenedCard {
  card: { id: string; headRevisionId: string; originalHash: string | null; forkedFromRevisionId: string | null; createdAt: string };
  revision: { id: string; sequence: number; document: CardDocument; createdAt: string; assets: { path: string; assetId: string }[] };
  source: { provenance: { format?: string; filename?: string } } | null;
}

export class UnityError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

export async function call<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  // The local API issues a new session secret when it restarts; reconnect once and retry.
  if (response.status === 401 && !retried && path !== '/api/local-session') {
    await fetch('/api/local-session', { method: 'POST', credentials: 'same-origin', headers: { 'x-unity-session': 'local' } });
    return call<T>(path, init, true);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new UnityError(response.status, body?.error?.code ?? 'UNAVAILABLE', body?.error?.message ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function reconnectSession() {
  await fetch('/api/local-session', { method: 'POST', credentials: 'same-origin', headers: { 'x-unity-session': 'local' } });
}

/** Raw fetch (for binary responses) that reconnects the local session once on 401. */
export async function fetchWithSession(path: string, init: RequestInit = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  if (response.status !== 401) return response;
  await fetch('/api/local-session', { method: 'POST', credentials: 'same-origin', headers: { 'x-unity-session': 'local' } });
  return fetch(path, { credentials: 'same-origin', ...init });
}

let library: Promise<string> | null = null;
/** The internal profile uses one default library workspace; it is created on first use. */
export function libraryId(): Promise<string> {
  library ??= (async () => {
    await call('/api/local-session', { method: 'POST', headers: { 'x-unity-session': 'local' } });
    const { workspaces } = await call<{ workspaces: { id: string; name: string }[] }>('/api/workspaces');
    const existing = workspaces.find((workspace) => workspace.name === 'Library') ?? workspaces[0];
    if (existing) return existing.id;
    const created = await call<{ id: string }>('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Library' }) });
    return created.id;
  })();
  library.catch(() => { library = null; });
  return library;
}

export async function listCards(query: { q?: string; tag?: string; offset?: number; limit?: number }): Promise<CardSummaryList> {
  const workspace = await libraryId();
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.tag) params.set('tag', query.tag);
  if (query.offset) params.set('offset', String(query.offset));
  if (query.limit) params.set('limit', String(query.limit));
  return call(`/api/workspaces/${workspace}/card-summaries?${params}`);
}

export async function openCard(id: string): Promise<OpenedCard> {
  return call(`/api/workspaces/${await libraryId()}/cards/${encodeURIComponent(id)}`);
}

export async function importFile(file: File) {
  return call<{ card: { id: string } }>(`/api/workspaces/${await libraryId()}/imports`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': file.name.slice(0, 500) }, body: file,
  });
}

export function portraitUrl(workspace: string, cardId: string, revisionId: string) {
  return `/api/workspaces/${workspace}/cards/${cardId}/asset?${new URLSearchParams({ revisionId, path: 'portrait' })}`;
}

export async function downloadExport(cardId: string, revisionId: string, format: ExportFormat, filename: string) {
  const response = await fetchWithSession(`/api/workspaces/${await libraryId()}/cards/${cardId}/export?${new URLSearchParams({ format, revisionId })}`);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `Export failed (${response.status})`);
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Editor host ports (same endpoints as the current Architect host).
const cardPath = async (card: string) => `/api/workspaces/${await libraryId()}/cards/${encodeURIComponent(card)}`;
const signalInit = (signal?: AbortSignal): RequestInit => (signal ? { signal } : {});
export interface SavedRevision { id: string; sequence: number; document: CardDocument; createdAt: string }
export const editorApi = {
  async save(card: string, expectedHead: string, document: CardDocument) {
    return call<SavedRevision>(`${await cardPath(card)}/revisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedHead, document }) });
  },
  async saveAssets(card: string, expectedHead: string, document: CardDocument, plan: { bindings: unknown; files: readonly File[] }) {
    const form = new FormData(); form.set('input', JSON.stringify({ expectedHead, document, bindings: plan.bindings }));
    plan.files.forEach((file, index) => form.set(`file:${index}`, file, `asset-${index}`));
    return call<SavedRevision>(`${await cardPath(card)}/asset-revisions`, { method: 'POST', body: form });
  },
  async history(card: string, options: Record<string, number> = {}, signal?: AbortSignal) {
    return call(`${await cardPath(card)}/revisions?${new URLSearchParams(Object.entries(options).map(([key, value]) => [key, String(value)]))}`, signalInit(signal));
  },
  async revision(card: string, revision: string, signal?: AbortSignal) {
    return call<SavedRevision>(`${await cardPath(card)}/revisions/${encodeURIComponent(revision)}`, signalInit(signal));
  },
  async assetList(card: string, revisionId: string, signal?: AbortSignal) {
    return call(`${await cardPath(card)}/assets?revisionId=${encodeURIComponent(revisionId)}`, signalInit(signal));
  },
  async asset(card: string, revisionId: string, path: string, signal?: AbortSignal) {
    const response = await fetchWithSession(`${await cardPath(card)}/asset?${new URLSearchParams({ revisionId, path })}`, signalInit(signal));
    if (!response.ok) throw new UnityError(response.status, 'ASSET', 'Asset download failed');
    return response.blob();
  },
};

export async function forkCard(id: string) {
  return call<{ card: { id: string } }>(`${await cardPath(id)}/forks`, { method: 'POST' });
}
export interface CardFamily { parent: CardSummary | null; forks: CardSummary[]; forkTotal: number }
export async function cardFamily(id: string) {
  return call<CardFamily>(`${await cardPath(id)}/family`);
}
