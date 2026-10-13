/** One native card store; templates and snippets remain browser preferences. */
import { ServerPersistenceAdapter } from './server-adapter';
import type { PersistenceAdapter } from './types';
export type { PersistenceAdapter, CardListItem, AssetSaveOptions, AssetUpdateOptions, Version, ImageType, PersistenceResult } from './types';
export { ServerPersistenceAdapter } from './server-adapter';
export function createPersistenceAdapter(): PersistenceAdapter { return new ServerPersistenceAdapter(); }
export const persistence = createPersistenceAdapter();
export function usePersistence(): PersistenceAdapter { return persistence; }
