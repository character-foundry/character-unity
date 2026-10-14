import { useSyncExternalStore } from 'react';

let version = 0;
const listeners = new Set<() => void>();

/** Invalidate native library/search views after an explicit local mutation. */
export function libraryChanged() { version++; for (const listener of listeners) listener(); }
export function useLibraryVersion() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => version);
}
