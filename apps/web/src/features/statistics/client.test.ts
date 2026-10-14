import { describe, expect, it } from 'vitest';
import { createStatisticsClient, type StatisticsHost } from './client';

describe('native statistics client', () => {
  it('keeps statistics bound to the original actor/workspace transport and propagates cancellation', async () => {
    const requests: { path: string; signal?: AbortSignal | null }[] = [];
    const host: StatisticsHost = { workspaceId: 'workspace /?', scopeKey: 'actor:workspace',
      async call<T>(path: string, init?: RequestInit): Promise<T> { requests.push({ path, signal: init?.signal }); return { membership: { total: 3 } } as T; } };
    const client = createStatisticsClient(host);
    Object.assign(host, { workspaceId: 'other', scopeKey: 'other', call: () => { throw new Error('Retargeted'); } });
    const controller = new AbortController();
    expect((await client.read(controller.signal)).membership.total).toBe(3);
    expect(client.scopeKey).toBe('actor:workspace');
    expect(requests).toEqual([{ path: '/api/workspaces/workspace%20%2F%3F/statistics', signal: controller.signal }]);
    controller.abort();
    await expect(client.read(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toHaveLength(1);
  });
  it('does not turn a cancellation or an unavailable reader into a successful empty collection', async () => {
    const controller = new AbortController();
    const client = createStatisticsClient({ workspaceId: 'workspace', scopeKey: 'actor:workspace', async call<T>(): Promise<T> { controller.abort(); return {} as T; } });
    await expect(client.read(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const failed = createStatisticsClient({ workspaceId: 'workspace', scopeKey: 'actor:workspace', async call() { throw new Error('Statistics not configured'); } });
    await expect(failed.read()).rejects.toThrow('Statistics not configured');
  });
});
