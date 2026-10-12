import type { ArchiveStatus, CardPage, ListRequest, SearchRequest, SearchPage, SelectionManifest, Snapshot } from '@character-unity/archive-client';
import type { ArchiveImportResult } from '@character-unity/cards/archive';

export interface ArchiveHost {
  status(workspace: string, signal?: AbortSignal): Promise<ArchiveStatus>;
  search(workspace: string, query: SearchRequest, signal?: AbortSignal): Promise<SearchPage>;
  list(workspace: string, query: ListRequest, signal?: AbortSignal): Promise<CardPage>;
  select(workspace: string, snapshot: Snapshot, ids: string[], signal?: AbortSignal): Promise<SelectionManifest>;
  import(workspace: string, snapshot: Snapshot, ids: string[], signal?: AbortSignal): Promise<ArchiveImportResult>;
}
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
function selectionBody(snapshot: Snapshot, ids: string[], signal?: AbortSignal): RequestInit {
  // A caller may hold an entire page or manifest. Send only the snapshot token.
  return { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ snapshot: { version: snapshot.version, archiveId: snapshot.archiveId, snapshot: snapshot.snapshot }, ids }),
    ...(signal ? { signal } : {}) };
}
/** Authenticated same-origin transport belongs to the host, not the selection UI. */
export function createArchiveHttpHost(request: Request): ArchiveHost {
  const path = (workspace: string) => `workspaces/${encodeURIComponent(workspace)}/archive`;
  return {
    status: (workspace, signal) => request<ArchiveStatus>(`${path(workspace)}/status`, signal ? { signal } : {}),
    search(workspace, query, signal) {
      const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
      return request<SearchPage>(`${path(workspace)}/search?${params}`, signal ? { signal } : {});
    },
    list(workspace, query, signal) {
      const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
      return request<CardPage>(`${path(workspace)}/cards?${params}`, signal ? { signal } : {});
    },
    select: (workspace, snapshot, ids, signal) => request<SelectionManifest>(`${path(workspace)}/selection`, selectionBody(snapshot, ids, signal)),
    import: (workspace, snapshot, ids, signal) => request<ArchiveImportResult>(`${path(workspace)}/imports`, selectionBody(snapshot, ids, signal)),
  };
}
