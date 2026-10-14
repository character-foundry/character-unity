import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSavedSearches, storeSavedSearches } from './library-search';
import { createSessionRuntime, type SessionConnection } from './session';
import { createLibraryClient } from './unity';

const connections: SessionConnection[] = [];
function storage(failWrite: (key: string, value: string) => boolean = () => false): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; }, key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { if (failWrite(key, value)) throw new Error('Storage unavailable'); values.set(key, value); },
    removeItem: (key) => { values.delete(key); }, clear: () => { values.clear(); },
  };
}
async function owner(actorId: string, workspaceId: string, profile: 'local' | 'hub' = 'hub') {
  const runtime = createSessionRuntime({ fetch: async (path) => path === '/api/client'
    ? Response.json({ profile, capabilities: { browserLLM: profile === 'local' } })
    : Response.json({ actor: { id: actorId, uri: `urn:unity:user:${actorId}` }, name: actorId, expiresAt: 10_000 }) });
  const connection = await runtime.restore(); connections.push(connection);
  return createLibraryClient(connection, workspaceId);
}
const rows = [{ name: 'Private search', params: 'q=private+character&favorite=fav' }];

describe('private saved search ownership', () => {
  beforeEach(() => { vi.stubGlobal('localStorage', storage()); });
  afterEach(() => { connections.splice(0).forEach((connection) => connection.dispose()); vi.unstubAllGlobals(); });

  it('separates actor, workspace, profile, and library/Archive search namespaces', async () => {
    const alice = await owner('alice', 'desk'), bob = await owner('bob', 'desk');
    const otherWorkspace = await owner('alice', 'other'), local = await owner('alice', 'desk', 'local');
    storeSavedSearches(alice, rows, 'library');
    expect(loadSavedSearches(alice, 'library')).toEqual(rows);
    expect(loadSavedSearches(bob, 'library')).toEqual([]);
    expect(loadSavedSearches(otherWorkspace, 'library')).toEqual([]);
    expect(loadSavedSearches(local, 'library')).toEqual([]);
    expect(loadSavedSearches(alice, 'archive')).toEqual([]);
  });

  it('keeps searches across reconnects without depending on the random connection scope key', async () => {
    const first = await owner('alice', 'desk'), reconnected = await owner('alice', 'desk');
    expect(first.connection.scopeKey).not.toBe(reconnected.connection.scopeKey);
    storeSavedSearches(first, rows, 'archive');
    expect(loadSavedSearches(reconnected, 'archive')).toEqual(rows);
  });

  it('migrates both old page keys only into the first local workspace and never exposes them to an account host', async () => {
    localStorage.setItem('unity-saved-searches', JSON.stringify(rows));
    const archiveRows = [{ name: 'Old Archive search', params: 'q=forest&archiveMode=hybrid' }];
    localStorage.setItem('unity-saved-archive-searches', JSON.stringify(archiveRows));
    const hub = await owner('local-owner', 'desk'), first = await owner('local-owner', 'desk', 'local');
    const other = await owner('local-owner', 'other', 'local');
    expect(loadSavedSearches(hub)).toEqual([]);
    expect(localStorage.getItem('unity-saved-searches')).toBe(JSON.stringify(rows));
    expect(loadSavedSearches(first)).toEqual(rows);
    expect(localStorage.getItem('unity-saved-searches')).toBeNull();
    expect(loadSavedSearches(other, 'archive')).toEqual([]);
    expect(loadSavedSearches(first, 'archive')).toEqual(archiveRows);
    expect(localStorage.getItem('unity-saved-archive-searches')).toBeNull();
    expect(loadSavedSearches(hub, 'archive')).toEqual([]);
  });

  it('keeps legacy rows readable for the first local owner when storage writes fail, then removes them only after a successful save', async () => {
    let blocked = false;
    const saved = storage(() => blocked); vi.stubGlobal('localStorage', saved);
    saved.setItem('unity-saved-searches', JSON.stringify(rows)); blocked = true;
    const first = await owner('local', 'first', 'local'), second = await owner('local', 'second', 'local'), hub = await owner('local', 'first');
    expect(loadSavedSearches(first)).toEqual(rows);
    expect(loadSavedSearches(first)).toEqual(rows);
    expect(loadSavedSearches(second)).toEqual([]); expect(loadSavedSearches(hub)).toEqual([]);
    storeSavedSearches(first, rows);
    expect(saved.getItem('unity-saved-searches')).toBe(JSON.stringify(rows));
    blocked = false;
    const next = [...rows, { name: 'New search', params: 'tags=fox' }];
    storeSavedSearches(first, next);
    expect(saved.getItem('unity-saved-searches')).toBeNull();
    expect(loadSavedSearches(await owner('local', 'first', 'local'))).toEqual(next);
  });

  it('retains the durable first-workspace claim across reload when a small owner marker saves but larger search rows exceed quota', async () => {
    let quota = false;
    const saved = storage((_key, value) => quota && value.length > 40);
    saved.setItem('unity-saved-searches', JSON.stringify(rows)); quota = true;
    vi.stubGlobal('localStorage', saved);
    const first = await owner('local', 'first', 'local');
    expect(loadSavedSearches(first)).toEqual(rows);
    expect(saved.getItem('unity-saved-searches')).toBe(JSON.stringify(rows));
    // A new Storage object models a new page's JS heap over the same persisted browser keys.
    const reloaded = storage();
    for (let index = 0; index < saved.length; index++) {
      const key = saved.key(index)!; reloaded.setItem(key, saved.getItem(key)!);
    }
    vi.stubGlobal('localStorage', reloaded);
    expect(loadSavedSearches(await owner('local', 'second', 'local'))).toEqual([]);
    expect(loadSavedSearches(await owner('local', 'first', 'local'))).toEqual(rows);
    expect(reloaded.getItem('unity-saved-searches')).toBeNull();
  });

  it('does not merge namespaces when actor or workspace identifiers contain delimiter characters', async () => {
    const first = await owner('alice:bob', 'desk'), other = await owner('alice', 'bob:desk');
    storeSavedSearches(first, rows);
    expect(loadSavedSearches(other)).toEqual([]); expect(loadSavedSearches(first)).toEqual(rows);
  });
});
