import { openDatabase } from './database.js';
import { createBrowserStore } from './store.js';
import { createBrowserBlobs } from './blobs.js';

/** Browser-owned storage, namespaced separately from every server/Archive database. */
export async function openBrowserStorage(options: { name?: string } = {}) {
  const db = await openDatabase(options.name ?? 'character-unity:architect');
  return { store: createBrowserStore(db), blobs: createBrowserBlobs(db), close: () => db.close() };
}
