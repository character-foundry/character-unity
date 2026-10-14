import { afterEach, describe, expect, it } from 'vitest';
import { openNodeStore } from '@character-unity/store/node';
import { createContentService } from '../src/index.js';

describe('standalone JSON content module', () => {
  const databases: Awaited<ReturnType<typeof openNodeStore>>[] = [];
  afterEach(() => { for (const database of databases.splice(0)) database.close(); });
  async function fixture(sharing = true) {
    const database = await openNodeStore(':memory:'); databases.push(database);
    const workspace = await database.store.createWorkspace({ ownerId: 'alice', name: 'Library' });
    return { database, workspaceId: workspace.id, service: createContentService(database.store, database.content, { sharing }), actor: { id: 'alice' } };
  }
  it('imports valid UTF-8 bytes losslessly, hashes all raw fields by explicit kind and rejects corruption before persistence', async () => {
    const { service, workspaceId, actor } = await fixture();
    const bytes = new TextEncoder().encode('\uFEFF{ "name":"Instructions", "temperature":0.7, "unknown":{"keep":true} }\n');
    const imported = await service.import(actor, workspaceId, 'preset', bytes, 'preset.json');
    expect(imported.created).toBe(true);
    expect(await service.original(actor, workspaceId, imported.record.document.id)).toMatchObject({ bytes, filename: 'preset.json' });
    expect((await service.import(actor, workspaceId, 'preset', bytes, 'duplicate.json')).created).toBe(false);
    const persona = await service.import(actor, workspaceId, 'persona', bytes, 'persona.json');
    expect(persona.record.revision.hash).not.toBe(imported.record.revision.hash);
    await expect(service.import(actor, workspaceId, 'preset', new Uint8Array([0xc3,0x28]), 'bad.json')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await service.list(actor, workspaceId)).total).toBe(2);
    await expect(service.list({ id: 'bob' }, workspaceId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('previews supported lorebooks without rewriting unknown fields and marks unimplemented formats raw-only', async () => {
    const { service, workspaceId, actor } = await fixture();
    const raw = { entries: { '7': { uid: 7, key: ['forest'], content: 'A forest.', futureFlag: { preserve: true } } }, unknown: 'keep' };
    const imported = await service.import(actor, workspaceId, 'lorebook', new TextEncoder().encode(JSON.stringify(raw)), 'world.json');
    const opened = await service.open(actor, workspaceId, imported.record.document.id);
    expect(opened.preview).toMatchObject({ format: 'sillytavern', entryCount: 1, rawOnly: false });
    expect(opened.record.revision.json).toEqual(raw);
    const risu = { type: 'risu', unknown: { entries: ['preserve'] } };
    const opaque = await service.import(actor, workspaceId, 'lorebook', new TextEncoder().encode(JSON.stringify(risu)), 'risu.json');
    expect((await service.open(actor, workspaceId, opaque.record.document.id)).preview).toMatchObject({ format: 'risu', entryCount: null, rawOnly: true });
  });
  it('refuses authored numeric tokens that cannot round-trip rather than silently rounding or deduplicating distinct originals', async () => {
    const { service,workspaceId,actor } = await fixture();
    for (const token of ['9007199254740993','9007199254740991.1','1.0000000000000001','1e400','1e-400']) {
      await expect(service.import(actor,workspaceId,'preset',new TextEncoder().encode(`{"number":${token}}`),'unsafe.json')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect((await service.list(actor,workspaceId)).total).toBe(0);
    const safe = await service.import(actor,workspaceId,'preset',new TextEncoder().encode('{"number":9007199254740991}'),'safe.json');
    await expect(service.import(actor,workspaceId,'preset',new TextEncoder().encode('{"number":9007199254740991.1}'),'distinct.json')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.save(actor,workspaceId,safe.record.document.id,safe.record.revision.id,'Changed','{"number":9007199254740991.1}')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await service.history(actor,workspaceId,safe.record.document.id)).revisions).toHaveLength(1);
  });
});
