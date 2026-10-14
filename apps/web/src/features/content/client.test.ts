import { describe, expect, it } from 'vitest';
import { createContentClient, type ContentHost } from './client';

describe('native standalone content client', () => {
  it('captures its actor/workspace and publishes the explicitly reviewed revision instead of a refreshed head', async () => {
    const requests: { path: string; init?: RequestInit }[] = [];
    const host: ContentHost = { workspaceId: 'workspace /?',scopeKey: 'account:workspace',connection: { profile: 'local',actor: { id: 'alice' } },
      async call<T>(path: string,init?: RequestInit): Promise<T> { requests.push({ path,init });
        if (path.includes('/revisions/')) return { record: { document: { id: 'doc' },revision: { id: 'saved-1',json: { future: true } } } } as T;
        return { id: 'publication' } as T;
      },async downloadFile() {},
    };
    const client = createContentClient(host);
    Object.assign(host,{ workspaceId: 'later',call: () => { throw new Error('Retargeted'); } });
    const reviewed = await client.review('doc','saved-1');
    await client.publish(reviewed.record,{ visibility: 'private',allowFork: false,allowOriginal: false });
    expect(requests[0].path).toBe('/api/content/workspaces/workspace%20%2F%3F/documents/doc/revisions/saved-1');
    expect(JSON.parse(String(requests[1].init?.body))).toEqual({ revisionId: 'saved-1',visibility: 'private',allowFork: false,allowOriginal: false });
    expect(client.draftKey('doc')).toContain('alice');
    expect(client.draftKey('doc')).toContain('workspace');
  });
  it('refuses a review that does not match the exact selected saved revision', async () => {
    const host: ContentHost = { workspaceId: 'workspace',scopeKey: 'scope',connection: { profile: 'local',actor: { id: 'alice' } },
      async call<T>(): Promise<T> { return { record: { document: { id: 'doc' },revision: { id: 'new-head' } } } as T; },async downloadFile() {},
    };
    await expect(createContentClient(host).review('doc','saved-1')).rejects.toThrow('selected saved revision');
  });
});
