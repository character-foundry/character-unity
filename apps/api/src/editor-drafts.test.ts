import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createLocalApi } from './local.js';
import { openLocalServices } from './services.js';

it('publishes native drafts, large inherited bindings and restores through authenticated bounded HTTP routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'unity-editor-http-'));
  const services = await openLocalServices({ databasePath: ':memory:', blobDirectory: directory });
  const origin = 'http://127.0.0.1:9312', app = createLocalApi(services, { origin: () => origin });
  let cookie = '';
  const request = (path: string, method = 'GET', body?: BodyInit, headers: Record<string, string> = {}) =>
    app.request(`${origin}${path}`, { method, headers: { origin, cookie, ...headers }, ...(body ? { body } : {}) });
  const form = (document: unknown, bindings: unknown[], uploads: File[] = [], expectedHead?: string) => {
    const value = new FormData();
    value.set('input', JSON.stringify({ document, bindings, ...(expectedHead ? { expectedHead } : {}) }));
    uploads.forEach((file, index) => value.set(`file:${index}`, file));
    return value;
  };
  try {
    const session = await request('/api/local-session', 'POST', undefined, { 'x-unity-session': 'local' });
    cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    const workspace = await (await request('/api/workspaces', 'POST', JSON.stringify({ name: 'Draft HTTP' }), { 'content-type': 'application/json' })).json();
    const base = `/api/workspaces/${workspace.id}`;
    const document = { spec: 'chara_card_v3', spec_version: '3.0', opaque: { keep: true }, data: { name: 'Large bindings',
      assets: Array.from({ length: 110 }, (_, index) => ({ type: 'custom', name: `notes-${index}`, ext: 'txt', uri: `embedded://notes-${index}.txt` })) } };
    const bindings = document.data.assets.map((_, index) => ({ path: `declared/${index}`, source: { kind: 'upload', index: 0 } }));
    const createdResponse = await request(`${base}/cards`, 'POST', form(document, bindings, [new File(['exact'], 'notes.txt', { type: 'text/plain' })]));
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(created.revision.sequence).toBe(1);
    expect(created.revision.assets).toHaveLength(110);
    expect(new Set(created.revision.assets.map((item: { assetId: string }) => item.assetId)).size).toBe(1);
    const cardPath = `${base}/cards/${created.cardId}`;
    expect(await (await request(`${cardPath}/asset?revisionId=${created.revisionId}&path=declared/100`)).text()).toBe('exact');
    expect((await request(`${cardPath}/asset?revisionId=${created.revisionId}&path=declared/8191`)).status).toBe(400);
    const retained = document.data.assets.map((_, index) => ({ path: `declared/${index}`, source: { kind: 'existing', path: `declared/${index}` } }));
    const forkResponse = await request(`${cardPath}/fork-assets`, 'POST', form(created.revision.document, retained, [], created.revisionId));
    expect(forkResponse.status).toBe(201);
    const fork = await forkResponse.json();
    expect(fork.revision.sequence).toBe(1);
    expect(fork.revision.assets).toEqual(created.revision.assets);
    const draft = structuredClone(created.revision.document); draft.data.description = 'Changed';
    const saved = await (await request(`${cardPath}/revisions`, 'POST', JSON.stringify({ expectedHead: created.revisionId, document: draft }), { 'content-type': 'application/json' })).json();
    const restoredResponse = await request(`${cardPath}/restores`, 'POST', JSON.stringify({ expectedHead: saved.id, revisionId: created.revisionId }), { 'content-type': 'application/json' });
    expect(restoredResponse.status).toBe(200);
    const restored = await restoredResponse.json();
    expect(restored.sequence).toBe(3); expect(restored.document.data.description).toBeUndefined();
    expect(restored.assets).toEqual(created.revision.assets);
    expect((await request(`${cardPath}/fork-assets`, 'POST', form(created.revision.document, retained, [], created.revisionId))).status).toBe(409);
    expect((await request(`${base}/cards`, 'POST', form(document, bindings), { cookie: '' })).status).toBe(401);
    expect((await (await request(`${base}/cards`)).json()).cards).toHaveLength(2);
    const name = '日本語 100%.json';
    const importedResponse = await request(`${base}/imports`, 'POST', JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Unicode' } }),
      { 'x-file-name': encodeURIComponent(name), 'x-file-name-encoding': 'uri' });
    expect(importedResponse.status).toBe(201);
    const imported = await importedResponse.json();
    expect((await services.store.getSource(workspace.id, imported.card.id))?.provenance.filename).toBe(name);
    expect((await request(`${base}/imports`, 'POST', '{}', { 'x-file-name': '%bad', 'x-file-name-encoding': 'uri' })).status).toBe(400);
  } finally { services.close(); await rm(directory, { recursive: true, force: true }); }
});
