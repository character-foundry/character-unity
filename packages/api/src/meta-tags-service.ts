import type { UnityStore } from '@character-unity/store';
import { StoreError } from '@character-unity/store';
import { validateMetaTagWrite, type MetaTagWrite } from '@character-unity/store/meta-tags';
import { text } from '@character-unity/store/validation';
import type { Actor } from '@character-unity/cards/contract';

/** Authorization wraps the same metadata interface in every host profile. */
export function createMetaTagService(store: Pick<UnityStore, 'getWorkspace' | 'readMetaTags' | 'writeMetaTags'>) {
  async function authorize(actorId: string, workspaceId: string) {
    if ((await store.getWorkspace(workspaceId)).ownerId !== actorId) throw new StoreError('FORBIDDEN', 'Workspace belongs to another account');
  }
  return {
    async read(actor: Actor, workspaceId: string) {
      const actorId = text(actor.id, 'actorId'); workspaceId = text(workspaceId, 'workspaceId');
      await authorize(actorId, workspaceId);
      const catalog = await store.readMetaTags(workspaceId);
      await authorize(actorId, workspaceId);
      return catalog;
    },
    async write(actor: Actor, workspaceId: string, input: MetaTagWrite) {
      const actorId = text(actor.id, 'actorId'); workspaceId = text(workspaceId, 'workspaceId');
      const snapshot = validateMetaTagWrite(input);
      await authorize(actorId, workspaceId);
      const catalog = await store.writeMetaTags(workspaceId, snapshot);
      await authorize(actorId, workspaceId);
      return catalog;
    },
  };
}
export type MetaTagService = ReturnType<typeof createMetaTagService>;
