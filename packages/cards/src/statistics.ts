import type { UnityStore } from '@character-unity/store';
import type { StatisticsReader } from '@character-unity/store/statistics';
import { CardError, type Actor } from './types.js';

/** Authorization belongs to the application boundary, never a URL-supplied owner. */
export function createStatisticsService(store: Pick<UnityStore, 'getWorkspace'>, reader: StatisticsReader) {
  async function authorize(actorId: string, workspaceId: string) {
    if ((await store.getWorkspace(workspaceId)).ownerId !== actorId) throw new CardError('FORBIDDEN', 'Workspace belongs to another account');
  }
  return {
    async read(actor: Actor, workspaceId: string) {
      const actorId = actor.id;
      await authorize(actorId, workspaceId);
      const statistics = await reader.read(workspaceId);
      await authorize(actorId, workspaceId);
      return statistics;
    },
  };
}
export type StatisticsService = ReturnType<typeof createStatisticsService>;
