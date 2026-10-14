import { useEffect, useState } from 'react';
import type { MetaTag, MetaTagCatalog, MetaTagWrite } from '@character-unity/store/meta-tags';
import { metaTagCatalogByteLimit, validateMetaTagCatalog, validateMetaTagWrite } from '@character-unity/store/meta-tags';
import { useLibraryClient } from './library-client';
import type { LibraryClient } from './unity';
import { libraryChanged } from './library-events';

export type { MetaTag, MetaTagCatalog, MetaTagWrite };
type MetaTagHost = Pick<LibraryClient, 'workspaceId' | 'scopeKey' | 'call'>;
interface OwnerCache { catalog: MetaTagCatalog | null; listeners: Set<() => void> }
const caches = new WeakMap<MetaTagHost, OwnerCache>();
function cacheFor(host: MetaTagHost) {
  let cache = caches.get(host);
  if (!cache) { cache = { catalog: null, listeners: new Set() }; caches.set(host, cache); }
  return cache;
}

function catalogResponse(value: unknown): MetaTagCatalog {
  try { return validateMetaTagCatalog(value); }
  catch { throw new Error('The host returned an invalid Meta-tag catalog. Reload to retry.'); }
}

/** Captures one authenticated workspace transport; it never consults a current/global client. */
export function createMetaTagClient(host: MetaTagHost) {
  const path = `/api/workspaces/${encodeURIComponent(host.workspaceId)}/meta-tags`;
  const request = host.call.bind(host), cache = cacheFor(host);
  return Object.freeze({
    scopeKey: host.scopeKey,
    async read(signal?: AbortSignal) {
      const catalog = catalogResponse(await request<MetaTagCatalog>(path, { signal }));
      signal?.throwIfAborted();
      if (!cache.catalog || catalog.version >= cache.catalog.version) cache.catalog = structuredClone(catalog);
      return catalog;
    },
    async write(input: MetaTagWrite, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const owned = validateMetaTagWrite(input), body = JSON.stringify(owned);
      if (new TextEncoder().encode(body).byteLength > metaTagCatalogByteLimit) throw new Error('Meta-tag catalogs are limited to 1 MiB of JSON. Your draft has not been saved.');
      const catalog = catalogResponse(await request<MetaTagCatalog>(path, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body, signal,
      }));
      signal?.throwIfAborted();
      cache.catalog = structuredClone(catalog);
      for (const listener of cache.listeners) listener();
      libraryChanged();
      return catalog;
    },
  });
}

export function readMetaTags(host: MetaTagHost, signal?: AbortSignal) { return createMetaTagClient(host).read(signal); }

/** Owner-local cached display with explicit refresh errors; a failed read is never an empty catalog. */
export function useMetaTags() {
  const host = useLibraryClient(), cache = cacheFor(host);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ owner: MetaTagHost; catalog: MetaTagCatalog | null; loading: boolean; error: string | null }>(
    () => ({ owner: host, catalog: cache.catalog, loading: true, error: null }),
  );
  useEffect(() => {
    const refresh = () => setAttempt((value) => value + 1);
    cache.listeners.add(refresh);
    return () => { cache.listeners.delete(refresh); };
  }, [cache]);
  useEffect(() => {
    const controller = new AbortController();
    setState({ owner: host, catalog: cache.catalog, loading: true, error: null });
    void readMetaTags(host, controller.signal).then((catalog) => {
      if (!controller.signal.aborted) setState({ owner: host, catalog, loading: false, error: null });
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setState({ owner: host, catalog: cache.catalog, loading: false,
        error: failure instanceof Error ? failure.message : 'Meta-tags could not be read.' });
    });
    return () => controller.abort();
  }, [host, cache, attempt]);
  return { catalog: state.owner === host ? state.catalog : null, loading: state.owner !== host || state.loading,
    error: state.owner === host ? state.error : null, reload: () => setAttempt((value) => value + 1) };
}
