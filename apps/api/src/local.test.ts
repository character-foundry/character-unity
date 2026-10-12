import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openLocalServices } from './services.js';
import { createLocalApi } from './local.js';

it('serves an authenticated import/edit/reopen/original workflow and rejects forged browser origins', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'unity-api-'));
  const services = await openLocalServices({ databasePath: ':memory:', blobDirectory: directory });
  const origin = 'http://127.0.0.1:9312';
  const app = createLocalApi(services, { origin: () => origin });
  let cookie = '';
  async function request(path: string, method = 'GET', body?: string, extra: Record<string, string> = {}) {
    return app.request(`${origin}${path}`, { method, headers: { origin, cookie, ...(body ? { 'content-type': 'application/json' } : {}), ...extra }, ...(body ? { body } : {}) });
  }
  try {
    expect((await request('/api/workspaces')).status).toBe(401);
    for (const headers of [{ origin: 'https://attacker.test' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
      expect((await request('/api/local-session', 'POST', undefined, { 'x-unity-session': 'local', ...headers })).status).toBe(403);
    }
    expect((await app.request('http://attacker.test/api/local-session', { method: 'POST', headers: { origin, 'x-unity-session': 'local' } })).status).toBe(403);
    const session = await request('/api/local-session', 'POST', undefined, { 'x-unity-session': 'local' });
    expect(session.status).toBe(200);
    expect(session.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
    cookie = session.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect((await request('/api/workspaces', 'GET', undefined, { cookie: `unity_session=${'é'.repeat(43)}` })).status).toBe(401);
    expect((await request('/api/workspaces', 'POST', JSON.stringify({ name: 'Desk', ownerId: 'bob' }))).status).toBe(400);
    const workspaceResponse = await request('/api/workspaces', 'POST', JSON.stringify({ name: 'Desk' }));
    expect(workspaceResponse.status).toBe(201);
    const workspace = await workspaceResponse.json();
    expect(workspace.ownerId).toBe('local');
    const base = `/api/workspaces/${workspace.id}`;
    const bytes = '{ "spec":"chara_card_v3", "spec_version":"3.0", "data":{"name":"Aster","unknown":42} }\n';
    const importedResponse = await request(`${base}/imports`, 'POST', bytes, { 'x-file-name': 'fixture.json' });
    expect(importedResponse.status).toBe(201);
    const imported = await importedResponse.json();
    const cardPath = `${base}/cards/${imported.card.id}`;
    const draft = structuredClone(imported.revision.document); draft.data.description = 'Edited through HTTP.';
    const saveResponse = await request(`${cardPath}/revisions`, 'POST', JSON.stringify({ expectedHead: imported.revision.id, document: draft }));
    expect(saveResponse.status).toBe(200);
    const saved = await saveResponse.json();
    const history = await request(`${cardPath}/revisions?limit=1`);
    expect(history.status).toBe(200); expect(history.headers.get('cache-control')).toBe('no-store');
    expect(await history.json()).toMatchObject({ throughSequence: 2, nextAfter: 1, revisions: [{ id: imported.revision.id }] });
    expect(await (await request(`${cardPath}/revisions/${imported.revision.id}`)).json()).toEqual(imported.revision);
    for (const query of ['limit=21', 'limit=1&limit=2', 'throughSequence=3', 'afterSequence=-1', 'limit=01', 'unknown=1']) {
      expect((await request(`${cardPath}/revisions?${query}`)).status).toBe(400);
    }
    expect((await request(`${cardPath}/revisions/${saved.id}?url=elsewhere`)).status).toBe(400);
    for (const path of [`${cardPath}/revisions`, `${cardPath}/revisions/${saved.id}`]) {
      expect((await request(path, 'GET', undefined, { cookie: '' })).status).toBe(401);
    }
    expect(saved.authorId).toBe('local');
    expect(saved.document.data.unknown).toBe(42);
    expect(saved.document.data.extensions.foundry.lineage.author).toBe('urn:unity:user:local');
    expect((await request(`${cardPath}/revisions`, 'POST', JSON.stringify({ expectedHead: imported.revision.id, document: draft }))).status).toBe(409);
    expect((await (await request(cardPath)).json()).revision.id).toBe(saved.id);
    expect(await (await request(`${cardPath}/original`)).text()).toBe(bytes);
    const exported = await request(`${cardPath}/export?revisionId=${saved.id}&format=json`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get('x-unity-revision')).toBe(saved.id);
    expect(exported.headers.get('cache-control')).toBe('no-store');
    expect(exported.headers.get('content-disposition')).toBe('attachment; filename="character.json"');
    expect(exported.headers.get('content-security-policy')).toContain('sandbox');
    expect(await exported.json()).toEqual(saved.document);
    const oldExport = await request(`${cardPath}/export?revisionId=${imported.revision.id}&format=json`);
    expect(await oldExport.json()).toEqual({ ...imported.revision.document, data: { ...imported.revision.document.data, extensions: {} } });
    for (const query of ['format=json', `revisionId=${saved.id}&format=json&format=png`, `revisionId=${saved.id}&format=voxta`, `revisionId=${saved.id}&format=json&url=https://example.test`]) {
      expect((await request(`${cardPath}/export?${query}`)).status).toBe(400);
    }
    expect((await request(`${cardPath}/export?revisionId=${saved.id}&format=json`, 'GET', undefined, { cookie: '' })).status).toBe(401);
    expect((await (await request(`${cardPath}/export?revisionId=${saved.id}&format=png`)).json()).error.code).toBe('EXPORT_LOSS');

    expect((await request(`${cardPath}/original`, 'GET', undefined, { origin: 'https://attacker.test' })).status).toBe(401);
    expect((await request(`${cardPath}/revisions`, 'POST', JSON.stringify({ expectedHead: saved.id, document: draft }), { origin: 'https://attacker.test' })).status).toBe(401);
    const malformed = await request(`${base}/imports`, 'POST', 'not a card');
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toContain(directory);
    const abort = new AbortController();
    abort.abort();
    const cancelled = await app.request(`${origin}${base}/imports`, { method: 'POST', headers: { origin, cookie }, body: bytes, signal: abort.signal });
    expect(cancelled.status).toBe(400);
    expect((await (await request(`${base}/cards`)).json()).cards).toHaveLength(1);
  } finally { services.close(); await rm(directory, { recursive: true, force: true }); }
});
