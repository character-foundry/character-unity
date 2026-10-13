/** One native card store; templates and snippets remain browser preferences. */
import { ServerPersistenceAdapter } from './server-adapter';
import type { PersistenceAdapter } from './types';
import { useEditorSession } from '../../unity/context';
export type { PersistenceAdapter, CardListItem, AssetSaveOptions, AssetUpdateOptions, Version, ImageType, PersistenceResult } from './types';
export { ServerPersistenceAdapter } from './server-adapter';
export function createPersistenceAdapter(...dependencies: ConstructorParameters<typeof ServerPersistenceAdapter>): PersistenceAdapter {
  return new ServerPersistenceAdapter(...dependencies);
}
export function usePersistence(): PersistenceAdapter { return useEditorSession().persistence; }
