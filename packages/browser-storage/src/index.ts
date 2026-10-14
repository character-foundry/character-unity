import { openDatabase } from './database.js';
import { createBrowserStore } from './store.js';
import { createBrowserBlobs } from './blobs.js';
import { createBrowserContentStore } from './content.js';
import { createBrowserStatisticsReader } from './statistics.js';
import { createBrowserMaintenance } from './maintenance.js';
export type { BrowserMaintenance, BrowserCleanupItem, BrowserCleanupPreview, BrowserRetirement } from './maintenance.js';

/** Browser-owned storage, namespaced separately from every server/Archive database. */
export async function openBrowserStorage(options: { name?: string } = {}) {
  const db = await openDatabase(options.name ?? 'character-unity:architect');
  return { store: createBrowserStore(db), blobs: createBrowserBlobs(db), content: createBrowserContentStore(db),
    statistics: createBrowserStatisticsReader(db), maintenance: createBrowserMaintenance(db), close: () => db.close() };
}
