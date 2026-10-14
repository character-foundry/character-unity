import type { ContentPolicy, ContentRecord, ContentService, ContentSummary } from '@character-unity/content';
import type { ContentKind, ContentPublicationSummary, ContentRevision } from '@character-unity/store/content';
export type { ContentKind,ContentPolicy,ContentRecord,ContentSummary,ContentRevision,ContentPublicationSummary };
export type OpenedContent = Awaited<ReturnType<ContentService['open']>>;
export type SharedContent = Awaited<ReturnType<ContentService['publication']>>;
export interface ContentHost {
  readonly workspaceId: string; readonly scopeKey: string;
  readonly connection: { readonly profile: 'local' | 'hub' | 'browser'; readonly actor: { readonly id: string } };
  call<T>(path: string,init?: RequestInit): Promise<T>;
  downloadFile(path: string,filename: string): Promise<void>;
}
const part = encodeURIComponent;
const json = (body: unknown,method = 'POST',signal?: AbortSignal): RequestInit => ({ method,headers: { 'content-type': 'application/json' },body: JSON.stringify(body),...(signal ? { signal } : {}) });
export function createContentClient(host: ContentHost) {
  const workspaceId = host.workspaceId, scopeKey = host.scopeKey, actorId = host.connection.actor.id, profile = host.connection.profile;
  const request = host.call.bind(host), download = host.downloadFile.bind(host);
  const base = `/api/content/workspaces/${part(workspaceId)}`, path = (id: string) => `${base}/documents/${part(id)}`;
  return Object.freeze({ scopeKey,sharing: profile !== 'browser',
    draftKey: (id: string) => `unity-content-draft:v1:${JSON.stringify([profile,actorId,workspaceId,id])}`,
    list(options: { kind?: ContentKind; q?: string; afterId?: string; signal?: AbortSignal } = {}) {
      const params = new URLSearchParams({ limit: '20',...(options.kind ? { kind: options.kind } : {}),...(options.q ? { q: options.q } : {}),...(options.afterId ? { afterId: options.afterId } : {}) });
      return request<{ items: ContentSummary[]; total: number; nextAfter: string | null }>(`${base}/documents?${params}`,{ signal: options.signal });
    },
    import(kind: ContentKind,file: File,signal?: AbortSignal) { return request<{ created: boolean; record: ContentRecord }>(`${base}/imports?${new URLSearchParams({ kind })}`,{
      method: 'POST',headers: { 'content-type': 'application/octet-stream','x-file-name': part(file.name),'x-file-name-encoding': 'uri' },body: file,signal,
    }); },
    open: (id: string,signal?: AbortSignal) => request<OpenedContent>(path(id),{ signal }),
    async review(id: string,revisionId: string,signal?: AbortSignal) {
      const result = await request<OpenedContent>(`${path(id)}/revisions/${part(revisionId)}`,{ signal });
      signal?.throwIfAborted();
      if (result.record.document.id !== id || result.record.revision.id !== revisionId) throw new Error('Review did not match the selected saved revision.');
      return result;
    },
    history(id: string,afterSequence = 0,signal?: AbortSignal) { return request<{ revisions: Omit<ContentRevision,'json'>[]; nextAfter: number | null }>(`${path(id)}/revisions?${new URLSearchParams({ afterSequence: String(afterSequence),limit: '20' })}`,{ signal }); },
    save(id: string,expectedHead: string,title: string,text: string,signal?: AbortSignal) { return request<ContentRevision>(path(id),json({ expectedHead,title,text },'PUT',signal)); },
    remove: (id: string,signal?: AbortSignal) => request<void>(path(id),{ method: 'DELETE',signal }),
    fork: (id: string,revisionId: string,signal?: AbortSignal) => request<ContentRecord>(`${path(id)}/forks`,json({ revisionId },'POST',signal)),
    original: (id: string,filename: string) => download(`${path(id)}/original`,filename),
    export: (id: string,revisionId: string,filename: string) => download(`${path(id)}/export?${new URLSearchParams({ revisionId })}`,filename),
    publish: (reviewed: ContentRecord,policy: ContentPolicy,signal?: AbortSignal) => request<SharedContent>(`${path(reviewed.document.id)}/publications`,json({ revisionId: reviewed.revision.id,...policy },'POST',signal)),
    publications(options: { mine?: boolean; kind?: ContentKind; afterId?: string; signal?: AbortSignal } = {}) {
      const params = new URLSearchParams({ limit: '20',...(options.mine ? { mine: 'true' } : {}),...(options.kind ? { kind: options.kind } : {}),...(options.afterId ? { afterId: options.afterId } : {}) });
      return request<{ items: ContentPublicationSummary[]; nextAfter: string | null }>(`/api/content/publications?${params}`,{ signal: options.signal });
    },
    publication: (id: string,signal?: AbortSignal) => request<SharedContent>(`/api/content/publications/${part(id)}`,{ signal }),
    policy: (id: string,expectedVersion: number,policy: ContentPolicy,signal?: AbortSignal) => request<SharedContent>(`/api/content/publications/${part(id)}`,json({ expectedVersion,...policy },'PUT',signal)),
    forkPublication: (id: string,expectedVersion: number,signal?: AbortSignal) => request<ContentRecord>(`/api/content/publications/${part(id)}/forks`,json({ workspaceId,expectedVersion },'POST',signal)),
    publicationOriginal: (id: string,filename: string) => download(`/api/content/publications/${part(id)}/original`,filename),
  });
}
export type ContentClient = ReturnType<typeof createContentClient>;
