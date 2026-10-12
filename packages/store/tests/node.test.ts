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
    expect(await reopened.store.readiness()).toEqual({ schemaVersion: 11 });
    expect(await reopened.store.listRevisions(workspaceId, base.card.id)).toHaveLength(2);
  } finally {
    for (const handle of handles) handle.close();
    await rm(directory, { recursive: true, force: true });
  }
});
