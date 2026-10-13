import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card } from '../lib/types';
import { createDraftRecovery } from './recovery';

const { database } = vi.hoisted(() => ({ database: {
  saveDraft: vi.fn(), deleteDraft: vi.fn(), listDrafts: vi.fn(),
} }));
vi.mock('../lib/db', () => ({ localDB: database }));

interface Row { id: string; card: Card; lastSaved: string; snapshotId?: string; baseRevisionId?: string }
const rows = new Map<string, Row>();
afterEach(() => vi.unstubAllGlobals());
let sequence = 0;
function card(description = 'Draft'): Card {
  return { meta: { id: 'same-card', name: 'Character', spec: 'v3', tags: [], createdAt: '', updatedAt: '' },
    data: { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Character', description } } as Card['data'] };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks(); rows.clear(); sequence = 0;
  const preferences = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => preferences.get(key) ?? null,
    setItem: (key: string, value: string) => { preferences.set(key, value); } });
  database.saveDraft.mockImplementation(async (id: string, value: Card, baseRevisionId?: string) => {
    rows.set(id, { id, card: structuredClone(value), snapshotId: `snapshot-${sequence}`,
      lastSaved: `2026-10-13T12:00:${String(sequence++).padStart(2, '0')}.000Z`, baseRevisionId });
  });
  database.deleteDraft.mockImplementation(async (id: string) => { rows.delete(id); });
  database.listDrafts.mockImplementation(async (prefix: string) => [...rows.values()].filter((row) => row.id.startsWith(prefix)));
});

describe('workspace and owner scoped recovery', () => {
  it('stores separate snapshots for identical card ids and removes only its own row', async () => {
    const first = createDraftRecovery('workspace-a', 'owner-a');
    const second = createDraftRecovery('workspace-a', 'owner-b');
    const otherWorkspace = createDraftRecovery('workspace-b', 'owner-a');
    await first.save('same-card', card('First owner'), 'first-head');
    await second.save('same-card', card('Second owner'), 'second-head');
    await otherWorkspace.save('same-card', card('Other workspace'), 'other-head');
    expect(rows.size).toBe(3);
    await first.remove('same-card');
    expect(rows.size).toBe(2);
    expect((await first.load('same-card'))?.baseRevisionId).toBe('second-head');
    expect((await otherWorkspace.load('same-card'))?.baseRevisionId).toBe('other-head');
    expect(database.deleteDraft).toHaveBeenCalledWith('unity:["workspace-a","same-card"]:owner-a');
  });

  it('snapshots at enqueue time and serializes save/remove/save so old writes cannot resurrect', async () => {
    const recovery = createDraftRecovery('workspace', 'owner');
    const held = deferred();
    const write = database.saveDraft.getMockImplementation()!;
    database.saveDraft.mockImplementationOnce(async (...args: unknown[]) => { await held.promise; await write(...args); });
    const initial = card('Enqueued original');
    const first = recovery.save('same-card', initial, 'head-1');
    const remove = recovery.remove('same-card');
    const latest = recovery.save('same-card', card('Newest draft'), 'head-2');
    (initial.data as { data: { description: string } }).data.description = 'Mutated after enqueue';
    await vi.waitFor(() => expect(database.saveDraft).toHaveBeenCalledTimes(1));
    expect(database.deleteDraft).not.toHaveBeenCalled();
    expect((database.saveDraft.mock.calls[0]![1] as Card).data).toMatchObject({ data: { description: 'Enqueued original' } });
    held.resolve(); await Promise.all([first, remove, latest, recovery.flush()]);
    expect([...rows.values()][0]).toMatchObject({ baseRevisionId: 'head-2', card: { data: { data: { description: 'Newest draft' } } } });
    expect(database.saveDraft.mock.invocationCallOrder[0]).toBeLessThan(database.deleteDraft.mock.invocationCallOrder[0]!);
    expect(database.deleteDraft.mock.invocationCallOrder[0]).toBeLessThan(database.saveDraft.mock.invocationCallOrder[1]!);
  });

  it('continues the write queue after a failed recovery write', async () => {
    const recovery = createDraftRecovery('workspace', 'owner');
    database.saveDraft.mockRejectedValueOnce(new Error('Disk quota exceeded'));
    const failed = expect(recovery.save('same-card', card())).rejects.toThrow('Disk quota exceeded');
    await recovery.remove('same-card'); await failed;
    await expect(recovery.flush()).resolves.toBeUndefined();
    expect(database.deleteDraft).toHaveBeenCalledTimes(1);
  });

  it('persists exact-snapshot dismissal without deleting another owner’s live row', async () => {
    const source = createDraftRecovery('workspace', 'live-owner');
    await source.save('same-card', card('Previously offered'), 'head-1');
    const firstReader = createDraftRecovery('workspace', 'reader-one');
    const offered = (await firstReader.load('same-card'))!;
    await firstReader.dismiss!(offered);
    expect(rows.size).toBe(1);
    expect(database.deleteDraft).not.toHaveBeenCalled();
    const recreated = createDraftRecovery('workspace', 'reader-after-reload');
    expect(await recreated.load('same-card')).toBeNull();
    await source.save('same-card', card('New live-owner edit'), 'head-2');
    expect((await recreated.load('same-card'))?.baseRevisionId).toBe('head-2');
  });

  it('keeps a claimed recovery until Save while acknowledging the original snapshot', async () => {
    const previous = createDraftRecovery('workspace', 'previous-owner');
    await previous.save('same-card', card('Recovered text'), 'base-head');
    const current = createDraftRecovery('workspace', 'current-owner');
    const offered = (await current.load('same-card'))!;
    await current.save('same-card', offered.card, offered.baseRevisionId);
    await current.dismiss!(offered);
    expect((await createDraftRecovery('workspace', 'after-crash').load('same-card'))?.key).toContain('current-owner');
    await current.remove('same-card');
    expect(await createDraftRecovery('workspace', 'after-save').load('same-card')).toBeNull();
    expect(rows.size).toBe(1);
  });

  it('offers a new snapshot from the same owner even when its timestamp is unchanged', async () => {
    const source = createDraftRecovery('workspace', 'live-owner');
    await source.save('same-card', card('Dismissed snapshot'), 'head-1');
    const reader = createDraftRecovery('workspace', 'reader');
    const offered = (await reader.load('same-card'))!;
    expect(offered.snapshotId).toBe('snapshot-0');
    await reader.dismiss!(offered);
    await source.save('same-card', card('New within the same millisecond'), 'head-2');
    const current = rows.get(offered.key)!;
    current.lastSaved = offered.lastSaved;
    const next = await createDraftRecovery('workspace', 'reader-after-reload').load('same-card');
    expect(next?.lastSaved).toBe(offered.lastSaved);
    expect(next?.snapshotId).toBe('snapshot-1');
    expect(next?.baseRevisionId).toBe('head-2');
  });

  it('still acknowledges older scoped rows that have no snapshot id', async () => {
    const recovery = createDraftRecovery('workspace', 'old-owner');
    await recovery.save('same-card', card('Older scoped format'));
    delete [...rows.values()][0]!.snapshotId;
    const offered = (await recovery.load('same-card'))!;
    expect(offered.snapshotId).toBeUndefined();
    await recovery.dismiss!(offered);
    expect(await createDraftRecovery('workspace', 'new-reader').load('same-card')).toBeNull();
  });

  it('surfaces dismissal storage failures and rejects cross-workspace acknowledgments', async () => {
    const source = createDraftRecovery('workspace', 'owner');
    await source.save('same-card', card());
    const offered = (await source.load('same-card'))!;
    await expect(createDraftRecovery('another-workspace', 'reader').dismiss!(offered)).rejects.toThrow('different workspace');
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('Preferences quota exceeded'); } });
    await expect(source.dismiss!(offered)).rejects.toThrow('Preferences quota exceeded');
  });
});
