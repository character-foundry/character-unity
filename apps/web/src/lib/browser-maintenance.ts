import type { BrowserCleanupPreview } from '@character-unity/browser-storage';
import type { LibraryClient } from './unity';
import { SessionError } from './session';
export type { BrowserCleanupItem, BrowserCleanupPreview } from '@character-unity/browser-storage';

/** This client cannot address SQL/Workers cleanup or another workspace. */
export function createBrowserMaintenanceClient(library: Pick<LibraryClient, 'connection' | 'workspaceId'>) {
  const connection = library.connection;
  const base = `/api/workspaces/${encodeURIComponent(library.workspaceId)}/browser-storage`;
  const available = connection.profile === 'browser';
  const call = <T>(path: string, init: RequestInit) => available ? connection.request<T>(base + path, init)
    : Promise.reject(new SessionError(503, 'UNAVAILABLE', 'Browser cleanup is available only in the browser storage profile'));
  const post = (body: unknown, signal?: AbortSignal): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  return Object.freeze({ available,
    preview: (signal?: AbortSignal) => call<BrowserCleanupPreview>('/preview', { method: 'GET', signal }),
    observe: (assetIds: readonly string[], signal?: AbortSignal) => call<{ observed: number; eligibleAfter: string }>('/observe', post({ assetIds: [...assetIds] }, signal)),
    apply: (preview: Pick<BrowserCleanupPreview, 'before' | 'items'>, signal?: AbortSignal) => call<{ removed: number; alreadyRemoved: number; bytesRemoved: number }>('/apply', post({ before: preview.before, items: preview.items }, signal)),
  });
}
export type BrowserMaintenanceClient = ReturnType<typeof createBrowserMaintenanceClient>;
