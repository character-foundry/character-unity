import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { openNodeStore } from '../src/node.js';

it('persists through reopen and rejects stale writers across separate SQLite connections', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'unity-store-'));
  const filename = join(directory, 'unity.db');
  const handles: Awaited<ReturnType<typeof openNodeStore>>[] = [];
  try {
    const opened = await Promise.allSettled([filename, filename].map(async (path) => {
      const handle = await openNodeStore(path);
      handles.push(handle);
      return handle;
    }));
    for (const result of opened) if (result.status === 'rejected') throw result.reason;
    const [first, second] = handles;
    if (!first || !second) throw new Error('Expected two independent SQLite connections');
    const workspaceId = (await first.store.createWorkspace({ ownerId: 'local', name: 'Desk' })).id;
    const input = { workspaceId, authorId: 'local', document: { name: 'Aster' }, identity: { algorithm: 'test-v1', hash: 'a'.repeat(64) } };
    const base = await first.store.createCard(input);
    expect(await second.store.getRevision(workspaceId, base.revision.id)).toEqual(base.revision);
    const command = { ...input, cardId: base.card.id, expectedHead: base.revision.id };
    const outcomes = await Promise.allSettled([first.store.saveRevision(command), second.store.saveRevision(command)]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = outcomes.find((result) => result.status === 'rejected');
    expect(failed?.status === 'rejected' && failed.reason).toMatchObject({ code: 'HEAD_CONFLICT' });
    for (const handle of handles.splice(0)) handle.close();
    const reopened = await openNodeStore(filename);
    handles.push(reopened);
    expect(await reopened.store.readiness()).toEqual({ schemaVersion: 13 });
    expect(await reopened.store.listRevisions(workspaceId, base.card.id)).toHaveLength(2);
  } finally {
    for (const handle of handles) handle.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('persists shared import claims and acknowledged search generations across connections and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'unity-store-claims-')), filename = join(directory, 'unity.db');
  const handles: Awaited<ReturnType<typeof openNodeStore>>[] = [];
  try {
    const first = await openNodeStore(filename), second = await openNodeStore(filename); handles.push(first, second);
    const workspaceId = (await first.store.createWorkspace({ ownerId: 'local', name: 'Claims' })).id;
    const assetInput = { workspaceId, hash: 'b'.repeat(64), byteLength: 4, mediaType: 'image/png' };
    const [a, b] = await Promise.all([first.store.stageSharedAsset(assetInput), second.store.stageSharedAsset(assetInput)]);
    expect(a).toEqual(b);
    const input = { workspaceId, authorId: 'local', document: { name: 'Aster' }, identity: { algorithm: 'test-v1', hash: 'a'.repeat(64) }, fileHash: 'c'.repeat(64) };
    const imported = await Promise.all([first.store.createImportedCard(input), second.store.createImportedCard(input)]);
    expect(imported.filter((result) => result.created)).toHaveLength(1);
    const winner = imported.find((result) => result.created)!; if (!winner.created) throw new Error('Expected import winner');
    await first.store.ackSearchJob(workspaceId, winner.card.id, 1);
    for (const handle of handles.splice(0)) handle.close();
    const reopened = await openNodeStore(filename); handles.push(reopened);
    expect((await reopened.store.stageSharedAsset(assetInput)).id).toBe(a.id);
    expect(await reopened.store.listSearchJobs()).toEqual([]);
    await reopened.store.saveRevision({ ...input, cardId: winner.card.id, expectedHead: winner.revision.id });
    expect(await reopened.store.ackSearchJob(workspaceId, winner.card.id, 1)).toBe(false);
    expect(await reopened.store.listSearchJobs()).toMatchObject([{ eventSequence: 2, cardId: winner.card.id }]);
  } finally {
    for (const handle of handles) handle.close();
    await rm(directory, { recursive: true, force: true });
  }
});
