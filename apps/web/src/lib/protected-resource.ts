import type { LibraryClient } from './unity';

interface Resource { users: number; controller: AbortController; promise: Promise<string>; url?: string }
const owners = new WeakMap<LibraryClient, Map<string, Resource>>();

/** No remote descriptor URLs are fetched. Authenticated files always use the
 * immutable connection; shared visible previews own one short-lived blob. */
export function acquireProtectedResource(client: LibraryClient, source: string) {
  if (!source.startsWith('/api/')) throw new Error('Only stored Unity resources can be fetched');
  let resources = owners.get(client);
  if (!resources) { resources = new Map(); owners.set(client, resources); }
  let resource = resources.get(source);
  if (!resource) {
    const controller = new AbortController();
    const entry: Resource = { users: 0, controller, promise: Promise.resolve('') };
    entry.promise = (async () => {
      const response = await client.fetchWithSession(source, { signal: controller.signal });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `Stored media is unavailable (${response.status})`);
      }
      const blob = await response.blob();
      controller.signal.throwIfAborted(); client.connection.signal.throwIfAborted();
      entry.url = URL.createObjectURL(blob);
      return entry.url;
    })().catch((failure: unknown) => {
      // A rejected read is not a cached image. Same-account recovery/retry may
      // acquire fresh bytes without remounting the editor or current view.
      if (resources.get(source) === entry) resources.delete(source);
      throw failure;
    });
    resource = entry; resources.set(source, resource);
  }
  resource.users += 1;
  const owned = resource;
  let released = false;
  return { promise: owned.promise, release() {
    if (released) return;
    released = true; owned.users -= 1;
    queueMicrotask(() => {
      if (owned.users) return;
      owned.controller.abort();
      if (owned.url) URL.revokeObjectURL(owned.url);
      if (resources.get(source) === owned) resources.delete(source);
    });
  } };
}

/** Only already-owned blobs, raster data and app-relative static files bypass
 * authenticated transport. Protocol-relative/external URLs are never loaded. */
export function publicResource(source: string): boolean {
  if (source.startsWith('blob:') || /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,/i.test(source)) return true;
  if (!source.startsWith('/') || source.startsWith('//') || source.includes('\\')) return false;
  const parsed = new URL(source, 'https://unity.invalid');
  return parsed.origin === 'https://unity.invalid' && parsed.pathname !== '/api' && !parsed.pathname.startsWith('/api/');
}
