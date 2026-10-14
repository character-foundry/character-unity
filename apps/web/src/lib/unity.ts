import type { CardSummary, CardSummaryList } from '@character-unity/cards';
import type { CardDocument } from '@character-unity/store';
import type { SessionConnection } from './session';
import { SessionError } from './session';

export { SessionError as UnityError } from './session';
export type { CardSummary };
export type ExportFormat = 'json' | 'png' | 'charx' | 'sillytavern-json' | 'sillytavern-png';
export interface ArchiveReference { archiveId: string; cardId: string; versionId: string }
export interface OpenedCard {
  card: { id: string; headRevisionId: string; originalHash: string | null; forkedFromRevisionId: string | null; createdAt: string };
  revision: { id: string; sequence: number; document: CardDocument; createdAt: string; assets: { path: string; assetId: string }[] };
  source: { provenance: { kind?: string; format?: string; filename?: string }; mediaType?: string; byteLength?: number; hash?: string } | null;
  favorite: boolean; reference?: ArchiveReference; archiveSource?: ArchiveReference;
}
export interface LibraryQuery {
  q?: string; tags?: readonly string[]; tagMode?: 'all' | 'any'; exclude?: readonly string[];
  tagGroups?: readonly (readonly string[])[]; excludeTagGroups?: readonly (readonly string[])[];
  has?: readonly string[]; fork?: 'only' | 'none'; favorite?: 'fav' | 'not_fav'; source?: string; minTokens?: number;
  sort?: string; offset?: number; limit?: number;
}
export interface LibraryIndexStatus {
  enabled: boolean; running: boolean; pending: number; failed: number; bounded: boolean;
  reason: string | null; lastError: string | null; semantic: boolean | null;
}
export interface SavedAssetMetadata { path: string; hash: string; byteLength: number; mediaType: string }
export interface RevisionAssets { revisionId: string; assets: SavedAssetMetadata[] }
export interface CardFamily { parent: CardSummary | null; forks: CardSummary[]; forkTotal: number }

export function assetUrl(workspace: string, cardId: string, revisionId: string, path: string) {
  return `/api/workspaces/${encodeURIComponent(workspace)}/cards/${encodeURIComponent(cardId)}/asset?${new URLSearchParams({ revisionId, path })}`;
}
export function portraitUrl(workspace: string, cardId: string, revisionId: string) { return assetUrl(workspace, cardId, revisionId, 'portrait'); }
export function originalUrl(workspace: string, cardId: string) { return `/api/workspaces/${encodeURIComponent(workspace)}/cards/${encodeURIComponent(cardId)}/original`; }

/** One immutable account/workspace owner. Later logins or workspace selections
 * cannot retarget this client's pending reads, writes or downloads. */
export function createLibraryClient(connection: SessionConnection, workspaceId: string) {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}`;
  const call = <T>(path: string, init?: RequestInit) => connection.request<T>(path, init);
  const fetchWithSession = (path: string, init?: RequestInit) => connection.fetch(path, init);
  const json = (value: unknown): RequestInit => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const cardPath = (card: string) => `${base}/cards/${encodeURIComponent(card)}`;
  async function download(path: string, filename: string) {
    const response = await fetchWithSession(path);
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      throw new SessionError(response.status, body?.error?.code ?? 'UNAVAILABLE', body?.error?.message ?? 'Download failed');
    }
    const blob = await response.blob();
    connection.signal.throwIfAborted();
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return Object.freeze({
    workspaceId, connection, scopeKey: `${connection.scopeKey}:${workspaceId}`, call, fetchWithSession,
    downloadFile: download,
    async listCards(query: LibraryQuery, signal?: AbortSignal): Promise<CardSummaryList> {
      const params = new URLSearchParams();
      if (query.q) params.set('q', query.q);
      if (query.tags?.length) params.set('tags', query.tags.join(','));
      if (query.tagMode && query.tagMode !== 'all') params.set('tagMode', query.tagMode);
      if (query.exclude?.length) params.set('exclude', query.exclude.join(','));
      if (query.tagGroups?.length) params.set('tagGroups', JSON.stringify(query.tagGroups));
      if (query.excludeTagGroups?.length) params.set('excludeTagGroups', JSON.stringify(query.excludeTagGroups));
      if (query.has?.length) params.set('has', query.has.join(','));
      if (query.fork) params.set('fork', query.fork);
      if (query.favorite) params.set('favorite', query.favorite);
      if (query.source) params.set('source', query.source);
      if (query.minTokens) params.set('minTokens', String(query.minTokens));
      if (query.sort && query.sort !== 'edited') params.set('sort', query.sort);
      if (query.offset) params.set('offset', String(query.offset));
      if (query.limit) params.set('limit', String(query.limit));
      if (params.toString().length > 8000) throw new Error('This search expands to too many tag names for one request. Select fewer meta-tags or shorten their member lists.');
      return call(`${base}/card-summaries?${params}`, { signal });
    },
    async setFavorite(cardId: string, favorite: boolean) { await call(`${cardPath(cardId)}/favorite`, { method: favorite ? 'PUT' : 'DELETE' }); },
    async deleteCard(cardId: string) { await call(cardPath(cardId), { method: 'DELETE' }); },
    async followCreator(creator: string, follow: boolean) { await call(`${base}/followed-creators`, { method: follow ? 'PUT' : 'DELETE', ...json({ creator }) }); },
    async listFollowedCreators(): Promise<string[]> { return (await call<{ creators: string[] }>(`${base}/followed-creators`)).creators; },
    async listCardTags(): Promise<{ tag: string; count: number }[]> { return (await call<{ tags: { tag: string; count: number }[] }>(`${base}/card-tags`)).tags; },
    openCard(id: string, options: { signal?: AbortSignal } = {}): Promise<OpenedCard> { return call(cardPath(id), options); },
    importFile(file: File) {
      return call<{ card: { id: string }; import: { created: boolean; match: 'file' | 'content' | 'archive' | null } }>(`${base}/imports`, {
        method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name), 'x-file-name-encoding': 'uri' }, body: file,
      });
    },
    libraryIndexStatus(signal?: AbortSignal): Promise<LibraryIndexStatus> { return call(`${base}/search-index`, { signal }); },
    retryLibraryIndex(signal?: AbortSignal): Promise<LibraryIndexStatus> { return call(`${base}/search-index/retry`, { method: 'POST', signal }); },
    listAssets(cardId: string, revisionId: string, signal?: AbortSignal) { return call<RevisionAssets>(`${cardPath(cardId)}/assets?${new URLSearchParams({ revisionId })}`, { signal }); },
    downloadOriginal(cardId: string, filename: string) { return download(originalUrl(workspaceId, cardId), filename); },
    downloadExport(cardId: string, revisionId: string, format: ExportFormat, filename: string) { return download(`${cardPath(cardId)}/export?${new URLSearchParams({ format, revisionId })}`, filename); },
    cardFamily(id: string, options: { signal?: AbortSignal } = {}) { return call<CardFamily>(`${cardPath(id)}/family`, options); },
  });
}
export type LibraryClient = ReturnType<typeof createLibraryClient>;
