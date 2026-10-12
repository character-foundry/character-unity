import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '@character-unity/api';
import type { CardDocument } from '@character-unity/store';
import { openLocalServices } from './services.js';
import { createLocalApi } from './local.js';

const alice = { id: 'alice', uri: 'urn:unity:user:alice' };
const bob = { id: 'bob', uri: 'urn:unity:user:bob' };
const policy = { visibility: 'public', allowOriginal: false, allowFork: true };
const original = new TextEncoder().encode(JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: {
  name: 'Aster', description: 'Original', extensions: { foundry: { local: { password: 'synthetic-private' } } },
} }));
describe('hub HTTP boundary', () => {
  let directory: string;
  let services: Awaited<ReturnType<typeof openLocalServices>>;
  let workspaceId: string;
  let target: string;
  let revisionId: string;
  let cardId: string;
  let app: ReturnType<typeof createApi>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'unity-hub-http-'));
    services = await openLocalServices({ databasePath: ':memory:', blobDirectory: directory });
    workspaceId = (await services.cards.createWorkspace(alice, 'Publisher')).id;
    target = (await services.cards.createWorkspace(bob, 'Reader')).id;
    const source = await services.cards.import(alice, workspaceId, original);
    revisionId = source.revision.id; cardId = source.card.id;
    // Test-only identity injection; production uses host sessions, never these headers.
    app = createApi({ store: services.store, cards: services.cards, hub: services.hub, authenticate(request) {
      const token = request.headers.get('authorization');
      return token === 'Bearer alice' ? alice : token === 'Bearer bob' ? bob : null;
    } });
  });
  afterEach(async () => { services?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
  function request(path: string, actor = 'alice', method = 'GET', body?: unknown) {
    return app.request(`/api/hub${path}`, { method, headers: { authorization: `Bearer ${actor}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function publish() {
    const response = await request('/publications', 'alice', 'POST', { workspaceId, revisionIds: [revisionId], policy });
    expect(response.status).toBe(201);
    const body = await response.json() as { publications: { id: string; policyVersion: number }[] };
    return body.publications[0]!.id;
  }

  it('accepts explicit selection and a second authenticated actor fork without exposing workspace versions', async () => {
    const id = await publish();
    const response = await request(`/publications/${id}`, 'bob');
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const published = await response.json() as { document: CardDocument };
    expect(published).not.toHaveProperty('workspaceId'); expect(published).not.toHaveProperty('revisionId');
    expect(JSON.stringify(published)).not.toContain('synthetic-private');
    const graphResponse = await request(`/publications/${id}/lineage?limit=1`, 'bob');
    expect(graphResponse.status).toBe(200); expect(graphResponse.headers.get('cache-control')).toBe('no-store');
    const graph = await graphResponse.json() as { nodes: { publicationId: string }[]; nextAfter: string | null };
    expect(graph.nodes.map((node) => node.publicationId)).toEqual([id]); expect(graph.nextAfter).toBeNull();
    expect(JSON.stringify(graph)).not.toContain('synthetic-private');
    expect(published.document).not.toHaveProperty('data.extensions.foundry.lineage');
    expect((await request(`/publications/${id}/original`, 'bob')).status).toBe(404);
    const own = await request(`/publications/${id}/original`);
    expect(new Uint8Array(await own.arrayBuffer())).toEqual(original);
    const fork = await request(`/publications/${id}/forks`, 'bob', 'POST', { workspaceId: target });
    expect(fork.status).toBe(201);
    const body = await fork.json() as { revision: { document: CardDocument; authorId: string } };
    expect(body.revision.authorId).toBe(bob.id);
    expect(body.revision.document).toHaveProperty('data.extensions.foundry.lineage.author', bob.uri);
    const privateCard = await app.request(`/api/workspaces/${workspaceId}/cards/${cardId}`, { headers: { authorization: 'Bearer bob' } });
    expect(privateCard.status).toBe(403);
    const allowed = await request(`/publications/${id}/policy`, 'alice', 'PATCH', { expectedVersion: 1, policy: { ...policy, allowOriginal: true } });
    expect(allowed.status).toBe(200);
    const download = await request(`/publications/${id}/original`, 'bob');
    expect(download.status).toBe(200); expect(download.headers.get('content-disposition')).toBe('attachment');
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(original);
    expect((await request(`/publications/${id}/policy`, 'alice', 'PATCH', { expectedVersion: 1, policy })).status).toBe(409);
  });

  it('rejects forged actors, private source access, malformed policies, duplicate query parameters and oversized bodies', async () => {
    const id = await publish();
    expect((await request('/publications', 'missing')).status).toBe(401);
    expect((await request(`/publications/${id}/forks`, 'bob', 'POST', { workspaceId: target, actor: alice })).status).toBe(400);
    expect((await request(`/publications/${id}/forks`, 'bob', 'POST', { workspaceId })).status).toBe(403);
    expect((await request('/publications', 'bob', 'POST', { workspaceId, revisionIds: [revisionId], policy })).status).toBe(403);
    expect((await request(`/publications/${id}/policy`, 'bob', 'PATCH', { expectedVersion: 1, policy })).status).toBe(409);
    expect((await request(`/publications/${id}/policy`, 'alice', 'PATCH', { expectedVersion: 1, policy: { ...policy, allowOriginal: 'yes' } })).status).toBe(400);
    expect((await request('/publications?limit=1&limit=2')).status).toBe(400);
    expect((await request('/publications?limit=21')).status).toBe(400);
    for (const query of ['limit=21', 'limit=1&limit=2', 'originalHash=forged']) expect((await request(`/publications/${id}/lineage?${query}`)).status).toBe(400);
    expect((await request('/publications', 'alice', 'POST', { workspaceId: 'x'.repeat(9000), revisionIds: [revisionId], policy })).status).toBe(413);
    expect((await request(`/publications/${id}/policy`, 'alice', 'PATCH', { expectedVersion: 1, policy: { ...policy, visibility: 'private' } })).status).toBe(200);
    expect((await request(`/publications/${id}`, 'bob')).status).toBe(404);
    expect((await request(`/publications/${id}/lineage`, 'bob')).status).toBe(404);
    expect((await request(`/publications/${id}/original`, 'bob')).status).toBe(404);
    expect((await request('/publications', 'bob')).status).toBe(200);
    expect(await (await request('/publications', 'bob')).json()).toEqual({ publications: [] });
  });

  it('keeps the local hub behind the existing session and browser-origin boundary', async () => {
    const local = createLocalApi(services, { origin: () => 'http://127.0.0.1:9312' });
    expect((await local.request('http://127.0.0.1:9312/api/hub/publications')).status).toBe(401);
    const session = await local.request('http://127.0.0.1:9312/api/local-session', { method: 'POST', headers: { origin: 'http://127.0.0.1:9311', 'x-unity-session': 'local' } });
    expect(session.status).toBe(200);
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    expect((await local.request('http://127.0.0.1:9312/api/hub/publications', { headers: { cookie } })).status).toBe(200);
    expect((await local.request('http://127.0.0.1:9312/api/hub/publications', { headers: { cookie, origin: 'https://foreign.invalid' } })).status).toBe(401);
    expect((await local.request('http://127.0.0.1:9312/api/hub/publications', { method: 'POST', headers: { cookie, origin: 'https://foreign.invalid', 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  });
});
