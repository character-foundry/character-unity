import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createContentService } from '@character-unity/content';
import { openBrowserStorage } from './index.js';

describe('browser standalone content', () => {
  const handles: Awaited<ReturnType<typeof openBrowserStorage>>[] = [];
  beforeEach(() => { vi.stubGlobal('indexedDB',new IDBFactory()); vi.stubGlobal('IDBKeyRange',IDBKeyRange); });
  afterEach(() => { for (const handle of handles.splice(0)) handle.close(); vi.unstubAllGlobals(); });
  async function open() { const storage = await openBrowserStorage({ name: 'character-unity:content-test' }); handles.push(storage); return storage; }
  it('persists exact originals, concurrent dedupe, immutable CAS history and shared-source forks without resetting the card library', async () => {
    const storage = await open(), actor = { id: 'alice' }, workspaceId = (await storage.store.createWorkspace({ ownerId: actor.id,name: 'Library' })).id;
    const card = await storage.store.createCard({ workspaceId,authorId: actor.id,identity: { algorithm: 'fixture',hash: 'a'.repeat(64) },document: { data: { name: 'Existing card' } } });
    const service = createContentService(storage.store,storage.content,{ sharing: false });
    const bytes = new TextEncoder().encode('\uFEFF{ "entries": [], "foreign": {"keep":true} }\n');
    const results = await Promise.all([service.import(actor,workspaceId,'lorebook',bytes,'book.json'),service.import(actor,workspaceId,'lorebook',bytes,'same.json')]);
    expect(results.filter((value) => value.created)).toHaveLength(1);
    expect(results[0].record.document.id).toBe(results[1].record.document.id);
    const initial = results[0].record;
    const saved = await service.save(actor,workspaceId,initial.document.id,initial.revision.id,'Changed',JSON.stringify({ entries: [],foreign: { keep: true },added: 'Text' }));
    await expect(service.save(actor,workspaceId,initial.document.id,initial.revision.id,'Stale','{"entries":[]}')).rejects.toMatchObject({ code: 'HEAD_CONFLICT' });
    const fork = await service.fork(actor,workspaceId,initial.document.id,initial.revision.id);
    expect(fork.document.sourceId).toBe(initial.document.sourceId);
    expect(fork.revision.json).toEqual({ entries: [],foreign: { keep: true } });
    const reopened = await open(), again = createContentService(reopened.store,reopened.content,{ sharing: false });
    expect((await again.open(actor,workspaceId,initial.document.id)).record.revision.id).toBe(saved.id);
    expect((await again.original(actor,workspaceId,initial.document.id)).bytes).toEqual(bytes);
    expect((await again.history(actor,workspaceId,initial.document.id,{ limit: 1 })).nextAfter).toBe(1);
    expect((await reopened.store.getRevision(workspaceId,card.revision.id)).document).toEqual(card.revision.document);
    await again.remove(actor,workspaceId,initial.document.id);
    expect((await again.list(actor,workspaceId)).total).toBe(1);
    expect((await again.open(actor,workspaceId,fork.document.id)).record.revision.json).toEqual(initial.revision.json);
    await expect(again.shared(actor)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});
