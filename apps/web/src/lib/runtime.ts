import { createSessionRuntime, type SessionRuntime } from './session';

/** Build-time selection only: a missing server never silently opens a different
 * library. The browser host is lazy so normal local/hub bundles need not load it. */
export async function createWebSessionRuntime(): Promise<SessionRuntime> {
  if (import.meta.env.VITE_UNITY_STORAGE !== 'browser') return createSessionRuntime();
  const { createBrowserRuntime } = await import('../browser/runtime');
  const archiveOrigin = import.meta.env.VITE_UNITY_ARCHIVE_ORIGIN as string | undefined;
  return createBrowserRuntime(archiveOrigin ? { archive: { origin: archiveOrigin } } : {}).runtime;
}
