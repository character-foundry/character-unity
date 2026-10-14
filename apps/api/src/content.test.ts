import { afterEach, describe, expect, it } from 'vitest';
import { openNodeStore } from '@character-unity/store/node';
import { createContentService } from '@character-unity/content';
import { createApi } from '@character-unity/api';

describe('native standalone content HTTP contract', () => {
  const databases: Awaited<ReturnType<typeof openNodeStore>>[] = [];
  afterEach(() => { for (const database of databases.splice(0)) database.close(); });
  async function fixture() {
    const database = await openNodeStore(':memory:'); databases.push(database);
    const workspace = await database.store.createWorkspace({ ownerId: 'alice', name: 'Private' });
    const content = createContentService(database.store,database.content);
    const app = createApi({ content,authenticate: (request) => { const id = request.headers.get('x-test-actor'); return id ? { id,uri: `urn:${id}` } : null; } });
    return { app,base: `/api/content/workspaces/${workspace.id}` };
  }
  it('imports typed original bytes privately, saves unknown JSON losslessly and publishes only a selected exact revision', async () => {
    const { app,base } = await fixture(), source = '\uFEFF{ "name":"Preset", "temperature":0.7, "future":{"keep":true} }\n';
    expect((await app.request(`${base}/documents`)).status).toBe(401);
    expect((await app.request(`${base}/documents`,{ headers: { 'x-test-actor': 'bob' } })).status).toBe(403);
    const imported = await app.request(`${base}/imports?kind=preset`,{ method: 'POST',headers: { 'x-test-actor': 'alice','x-file-name': 'preset.json' },body: source });
    expect(imported.status).toBe(201);
    const result = await imported.json() as { record: { document: { id: string }; revision: { id: string } } };
    const path = `${base}/documents/${result.record.document.id}`, headers = { 'x-test-actor': 'alice' };
    expect(new Uint8Array(await (await app.request(`${path}/original`,{ headers })).arrayBuffer())).toEqual(new TextEncoder().encode(source));
    const published = await app.request(`${path}/publications`,{ method: 'POST',headers: { ...headers,'content-type': 'application/json' },body: JSON.stringify({
      revisionId: result.record.revision.id,visibility: 'public',allowFork: true,allowOriginal: false,
    }) });
    expect(published.status).toBe(201);
    const publication = await published.json() as { id: string };
    const shared = await app.request(`/api/content/publications/${publication.id}`);
    expect(shared.status).toBe(200);
    expect(shared.headers.get('cache-control')).toBe('no-store');
    const payload = await shared.json();
    expect(payload).toMatchObject({ json: { future: { keep: true },temperature: 0.7 } });
    expect(payload).not.toHaveProperty('workspaceId'); expect(payload).not.toHaveProperty('revisionId');
    expect((await app.request(`/api/content/publications/${publication.id}/original`)).status).toBe(409);
    expect((await app.request(`${base}/documents?actor=bob`,{ headers })).status).toBe(400);
  });
  it('rejects imprecise raw import and editor Save numbers before a document or revision is written', async () => {
    const { app,base } = await fixture(), headers = { 'x-test-actor': 'alice' };
    const invalid = await app.request(`${base}/imports?kind=preset`,{ method: 'POST',headers,body: '{"number":9007199254740991.1}' });
    expect(invalid.status).toBe(400);
    const imported = await app.request(`${base}/imports?kind=preset`,{ method: 'POST',headers,body: '{"number":1}' });
    const initial = await imported.json() as { record: { document: { id: string }; revision: { id: string } } };
    const path = `${base}/documents/${initial.record.document.id}`;
    const saved = await app.request(path,{ method: 'PUT',headers: { ...headers,'content-type': 'application/json' },body: JSON.stringify({ expectedHead: initial.record.revision.id,title: 'Unsafe edit',text: '{"number":9007199254740991.1}' }) });
    expect(saved.status).toBe(400);
    const current = await app.request(`${path}/revisions`,{ headers });
    expect(await current.json()).toMatchObject({ revisions: [{ id: initial.record.revision.id }] });
    expect((await (await app.request(`${base}/documents`,{ headers })).json() as { total: number }).total).toBe(1);
  });
});
