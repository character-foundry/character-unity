import type { CardSummary, CardSummaryList } from '@character-unity/cards';
import type { CardDocument } from '@character-unity/store';

export type { CardSummary };
export type ExportFormat = 'json' | 'png' | 'charx' | 'sillytavern-json' | 'sillytavern-png';
export interface ArchiveReference { archiveId: string; cardId: string; versionId: string }
export interface OpenedCard {
  card: { id: string; headRevisionId: string; originalHash: string | null; forkedFromRevisionId: string | null; createdAt: string };
  revision: { id: string; sequence: number; document: CardDocument; createdAt: string; assets: { path: string; assetId: string }[] };
  source: { provenance: { kind?: string; format?: string; filename?: string }; mediaType?: string; byteLength?: number; hash?: string } | null;
  favorite: boolean;
  reference?: ArchiveReference;
  /** Owned fork whose exact original remains in Archive. */
  archiveSource?: ArchiveReference;
}

export class UnityError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

export async function call<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  // The local API issues a new session secret when it restarts; reconnect once and retry.
  if (response.status === 401 && !retried && path !== '/api/local-session') {
    init.signal?.throwIfAborted();
    await fetch('/api/local-session', { method: 'POST', credentials: 'same-origin', headers: { 'x-unity-session': 'local' }, signal: init.signal });
    init.signal?.throwIfAborted();
    return call<T>(path, init, true);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new UnityError(response.status, body?.error?.code ?? 'UNAVAILABLE', body?.error?.message ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function reconnectSession(signal?: AbortSignal) {
  await fetch('/api/local-session', { method: 'POST', credentials: 'same-origin', headers: { 'x-unity-session': 'local' }, signal });
}

/** Raw fetch (for binary responses) that reconnects the local session once on 401. */
export async function fetchWithSession(path: string, init: RequestInit = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  if (response.status !== 401) return response;
  init.signal?.throwIfAborted();
  await fetch('/api/local-session', { method: 'POST', credentials: 'same-origin', headers: { 'x-unity-session': 'local' }, signal: init.signal });
  init.signal?.throwIfAborted();
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

export interface LibraryQuery {
  q?: string; tags?: readonly string[]; tagMode?: 'all' | 'any'; exclude?: readonly string[];
  has?: readonly string[]; fork?: 'only' | 'none'; favorite?: 'fav' | 'not_fav'; source?: string; minTokens?: number;
  sort?: string; offset?: number; limit?: number;
}
export async function listCards(query: LibraryQuery): Promise<CardSummaryList> {
  const workspace = await libraryId();
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.tags?.length) params.set('tags', query.tags.join(','));
  if (query.tagMode && query.tagMode !== 'all') params.set('tagMode', query.tagMode);
  if (query.exclude?.length) params.set('exclude', query.exclude.join(','));
  if (query.has?.length) params.set('has', query.has.join(','));
  if (query.fork) params.set('fork', query.fork);
  if (query.favorite) params.set('favorite', query.favorite);
  if (query.source) params.set('source', query.source);
  if (query.minTokens) params.set('minTokens', String(query.minTokens));
  if (query.sort && query.sort !== 'edited') params.set('sort', query.sort);
  if (query.offset) params.set('offset', String(query.offset));
  if (query.limit) params.set('limit', String(query.limit));
  return call(`/api/workspaces/${encodeURIComponent(workspace)}/card-summaries?${params}`);
}

const json = (value: unknown): RequestInit => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
export async function setFavorite(cardId: string, favorite: boolean) {
  await call(`/api/workspaces/${encodeURIComponent(await libraryId())}/cards/${encodeURIComponent(cardId)}/favorite`, { method: favorite ? 'PUT' : 'DELETE' });
}
export async function deleteCard(cardId: string) {
  await call(`/api/workspaces/${encodeURIComponent(await libraryId())}/cards/${encodeURIComponent(cardId)}`, { method: 'DELETE' });
}
export async function followCreator(creator: string, follow: boolean) {
  await call(`/api/workspaces/${encodeURIComponent(await libraryId())}/followed-creators`, { method: follow ? 'PUT' : 'DELETE', ...json({ creator }) });
}
export async function listFollowedCreators(): Promise<string[]> {
  return (await call<{ creators: string[] }>(`/api/workspaces/${encodeURIComponent(await libraryId())}/followed-creators`)).creators;
}

export async function listCardTags(): Promise<{ tag: string; count: number }[]> {
  return (await call<{ tags: { tag: string; count: number }[] }>(`/api/workspaces/${encodeURIComponent(await libraryId())}/card-tags`)).tags;
}

export async function openCard(id: string, options: { signal?: AbortSignal } = {}): Promise<OpenedCard> {
  return call(`/api/workspaces/${encodeURIComponent(await libraryId())}/cards/${encodeURIComponent(id)}`, options);
}

export async function importFile(file: File) {
  return call<{ card: { id: string }; import: { created: boolean; match: 'file' | 'content' | 'archive' | null } }>(`/api/workspaces/${encodeURIComponent(await libraryId())}/imports`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name), 'x-file-name-encoding': 'uri' }, body: file,
  });
}

export interface LibraryIndexStatus {
  enabled: boolean; running: boolean; pending: number; failed: number; bounded: boolean;
  reason: string | null; lastError: string | null; semantic: boolean | null;
}
export async function libraryIndexStatus(signal?: AbortSignal): Promise<LibraryIndexStatus> {
  return call(`/api/workspaces/${encodeURIComponent(await libraryId())}/search-index`, signal ? { signal } : {});
}
export async function retryLibraryIndex(signal?: AbortSignal): Promise<LibraryIndexStatus> {
  return call(`/api/workspaces/${encodeURIComponent(await libraryId())}/search-index/retry`, { method: 'POST', ...(signal ? { signal } : {}) });
}

export function assetUrl(workspace: string, cardId: string, revisionId: string, path: string) {
  return `/api/workspaces/${encodeURIComponent(workspace)}/cards/${encodeURIComponent(cardId)}/asset?${new URLSearchParams({ revisionId, path })}`;
}
export function portraitUrl(workspace: string, cardId: string, revisionId: string) {
  return assetUrl(workspace, cardId, revisionId, 'portrait');
}
export function originalUrl(workspace: string, cardId: string) {
  return `/api/workspaces/${encodeURIComponent(workspace)}/cards/${encodeURIComponent(cardId)}/original`;
}
export interface SavedAssetMetadata { path: string; hash: string; byteLength: number; mediaType: string }
export interface RevisionAssets { revisionId: string; assets: SavedAssetMetadata[] }
export async function listAssets(cardId: string, revisionId: string, signal?: AbortSignal) {
  return call<RevisionAssets>(`${await cardPath(cardId)}/assets?${new URLSearchParams({ revisionId })}`, signalInit(signal));
}
async function download(path: string, filename: string, action: string) {
  const response = await fetchWithSession(path);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `${action} failed (${response.status})`);
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function downloadOriginal(cardId: string, filename: string) {
  return download(originalUrl(await libraryId(), cardId), filename, 'Original download');
}

export async function downloadExport(cardId: string, revisionId: string, format: ExportFormat, filename: string) {
  return download(`${await cardPath(cardId)}/export?${new URLSearchParams({ format, revisionId })}`, filename, 'Export');
}

// Editor host ports (same endpoints as the current Architect host).
const cardPath = async (card: string) => `/api/workspaces/${encodeURIComponent(await libraryId())}/cards/${encodeURIComponent(card)}`;
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

export interface CardFamily { parent: CardSummary | null; forks: CardSummary[]; forkTotal: number }
export async function cardFamily(id: string, options: { signal?: AbortSignal } = {}) {
  return call<CardFamily>(`${await cardPath(id)}/family`, options);
}
