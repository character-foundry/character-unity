import { describe, expect, it, vi } from 'vitest';
import { createRemotesClient, type RemotesHost } from './client';
import { loadPreparation, type ReturnPreparation } from './intent';

function host() {
  const requests: { path: string; init?: RequestInit }[] = [];
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    requests.push({ path, init });
    return { publications: [], nextAfter: null, connections: [], jobs: [] } as T;
  };
  const value: RemotesHost = {
    workspaceId: 'workspace /?', scopeKey: 'actor:workspace',
    connection: { actor: { id: 'actor' }, request },
    listCards: vi.fn().mockResolvedValue({ cards: [], total: 0 }),
  };
  return { value, requests };
}

describe('native configured remotes client', () => {
  it('keeps browser reads bound to the captured workspace and configured connection ID', async () => {
    const { value, requests } = host();
    const client = createRemotesClient(value);
    const controller = new AbortController();
    await client.publications('remote /?', 'cursor /?', controller.signal);
    expect(requests).toEqual([{ path: '/api/remotes/connections/remote%20%2F%3F/publications?workspaceId=workspace+%2F%3F&limit=20&afterId=cursor+%2F%3F', init: { signal: controller.signal } }]);
    expect(client.actorId).toBe('actor');
  });

  it('retains preparation before enqueue and reuses its exact operation after a lost response without sending', async () => {
    const saved = new Map<string, string>();
    const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); }, removeItem: (key: string) => { saved.delete(key); } };
    const value: ReturnPreparation = { version: 1, actorId: 'actor', workspaceId: 'workspace /?', connectionId: 'remote',
      cardId: 'card', revisionId: 'revision', requestId: 'a'.repeat(43), title: 'Name', sequence: 2 };
    const fixture = host();
    let attempt = 0;
    fixture.value.connection.request = async <T>(path: string, init?: RequestInit): Promise<T> => {
      expect(path).toBe('/api/remotes/workspaces/workspace%20%2F%3F/jobs');
      expect(loadPreparation(storage, value.actorId, value.workspaceId)).toEqual(value);
      expect(JSON.parse(String(init?.body))).toEqual({ connectionId: 'remote', cardId: 'card', revisionId: 'revision', requestId: 'a'.repeat(43) });
      if (attempt++ === 0) throw new Error('Response lost');
      return { requestId: value.requestId, cardId: value.cardId, revisionId: value.revisionId } as T;
    };
    const client = createRemotesClient(fixture.value);
    await expect(client.prepare(storage, value)).rejects.toThrow('Response lost');
    expect(loadPreparation(storage, value.actorId, value.workspaceId)).toEqual(value);
    await client.prepare(storage, value);
    expect(loadPreparation(storage, value.actorId, value.workspaceId)).toBeNull();
  });

  it('reviews and sends the queued saved revision, never the current head or a replacement operation', async () => {
    const fixture = host();
    const paths: string[] = [];
    fixture.value.connection.request = async <T>(path: string, init?: RequestInit): Promise<T> => {
      paths.push(path);
      if (path.endsWith('/send')) {
        expect(JSON.parse(String(init?.body))).toEqual({});
        return { requestId: 'saved-job', state: 'acknowledged', receipt: { cardId: 'remote-card' } } as T;
      }
      if (path.includes('/revisions/')) return { id: 'pinned-revision', cardId: 'saved-card', document: { data: { name: 'Saved name' } } } as T;
      return { requestId: 'saved-job', cardId: 'saved-card', revisionId: 'pinned-revision', state: 'uncertain' } as T;
    };
    const client = createRemotesClient(fixture.value);
    const review = await client.review('saved-job');
    expect(review.revision.id).toBe('pinned-revision');
    expect(paths).toEqual(['/api/remotes/workspaces/workspace%20%2F%3F/jobs/saved-job', '/api/workspaces/workspace%20%2F%3F/cards/saved-card/revisions/pinned-revision']);
    expect((await client.send('saved-job')).state).toBe('acknowledged');
    expect(paths.at(-1)).toBe('/api/remotes/workspaces/workspace%20%2F%3F/jobs/saved-job/send');
  });

  it('pages actual saved jobs and library summaries and pulls only the explicitly selected publication', async () => {
    const fixture = host();
    const client = createRemotesClient(fixture.value);
    await client.connections();
    await client.jobs('a'.repeat(43));
    const controller = new AbortController();
    await client.library(20, controller.signal);
    expect(fixture.value.listCards).toHaveBeenCalledWith({ offset: 20, limit: 20, sort: 'edited' }, controller.signal);
    expect(fixture.requests.map((value) => value.path)).toEqual(['/api/remotes/connections', `/api/remotes/workspaces/workspace%20%2F%3F/jobs?limit=20&afterId=${'a'.repeat(43)}`]);
    await client.pull('remote /?', 'publication');
    expect(fixture.requests.at(-1)?.path).toBe('/api/remotes/connections/remote%20%2F%3F/pulls');
    expect(JSON.parse(String(fixture.requests.at(-1)?.init?.body))).toEqual({ workspaceId: 'workspace /?', publicationId: 'publication' });
  });

  it('holds unconfirmed send outcomes instead of showing a successful transfer', async () => {
    const fixture = host();
    fixture.value.connection.request = async <T>(): Promise<T> => ({ requestId: 'saved-job', state: 'uncertain', receipt: null }) as T;
    await expect(createRemotesClient(fixture.value).send('saved-job')).rejects.toThrow('acknowledgment is not confirmed');
  });

  it('keeps account/workspace ownership immutable and refuses a preparation from another account', async () => {
    const fixture = host();
    const client = createRemotesClient(fixture.value);
    Object.assign(fixture.value, { workspaceId: 'later-workspace', scopeKey: 'later-scope' });
    Object.assign(fixture.value.connection.actor, { id: 'later-actor' });
    await client.jobs();
    expect(client.workspaceId).toBe('workspace /?');
    expect(client.actorId).toBe('actor');
    expect(client.scopeKey).toBe('actor:workspace');
    expect(fixture.requests[0].path).toContain('/workspaces/workspace%20%2F%3F/jobs?');
    const storage = { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() };
    await expect(client.prepare(storage, { version: 1, actorId: 'later-actor', workspaceId: 'workspace /?', connectionId: 'remote',
      cardId: 'card', revisionId: 'revision', requestId: 'a'.repeat(43), title: 'Name', sequence: 1 })).rejects.toThrow('another account');
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(fixture.requests).toHaveLength(1);
  });

  it('retains intent when a canceled preparation returns late instead of confirming it in another session', async () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    const intent: ReturnPreparation = { version: 1, actorId: 'actor', workspaceId: 'workspace /?', connectionId: 'remote',
      cardId: 'card', revisionId: 'revision', requestId: 'a'.repeat(43), title: 'Name', sequence: 1 };
    const fixture = host();
    const controller = new AbortController();
    fixture.value.connection.request = async <T>(): Promise<T> => {
      controller.abort();
      return { requestId: intent.requestId, cardId: intent.cardId, revisionId: intent.revisionId } as T;
    };
    await expect(createRemotesClient(fixture.value).prepare(storage, intent, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(loadPreparation(storage, intent.actorId, intent.workspaceId)).toEqual(intent);
  });

  it('refuses to review another queued operation returned for the requested ID', async () => {
    const fixture = host();
    fixture.value.connection.request = async <T>(): Promise<T> => ({ requestId: 'different-job', cardId: 'card', revisionId: 'revision' }) as T;
    await expect(createRemotesClient(fixture.value).review('selected-job')).rejects.toThrow('selected operation');
  });

  it('pages saved revision history within one fixed snapshot for an older return selection', async () => {
    const fixture = host();
    const controller = new AbortController();
    await createRemotesClient(fixture.value).history('card /?', { afterSequence: 8, throughSequence: 12, signal: controller.signal });
    expect(fixture.requests).toEqual([{ path: '/api/workspaces/workspace%20%2F%3F/cards/card%20%2F%3F/revisions?limit=20&afterSequence=8&throughSequence=12', init: { signal: controller.signal } }]);
  });
});
