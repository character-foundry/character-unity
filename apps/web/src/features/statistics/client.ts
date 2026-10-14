import type { WorkspaceStatistics } from '@character-unity/store/statistics';

export interface StatisticsHost {
  readonly workspaceId: string;
  readonly scopeKey: string;
  call<T>(path: string, init?: RequestInit): Promise<T>;
}

/** The supplied library transport already owns its immutable account/session. */
export function createStatisticsClient(host: StatisticsHost) {
  const path = `/api/workspaces/${encodeURIComponent(host.workspaceId)}/statistics`;
  const scopeKey = host.scopeKey, request = host.call.bind(host);
  return Object.freeze({ scopeKey, async read(signal?: AbortSignal): Promise<WorkspaceStatistics> {
    signal?.throwIfAborted();
    const result = await request<WorkspaceStatistics>(path, { signal });
    signal?.throwIfAborted();
    return result;
  } });
}
export type StatisticsClient = ReturnType<typeof createStatisticsClient>;
