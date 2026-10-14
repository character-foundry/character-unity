import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '@character-unity/api';
import { createChatService } from '@character-unity/cards/chat';
import type { ChatEditReview } from '@character-unity/cards/chat';
import { createCardService } from '@character-unity/cards';
import { openNodeStore } from '@character-unity/store/node';
import { createNodeBlobStore } from '@character-unity/blob-store/node';
import { createAssetService } from '@character-unity/assets';

async function openFixture(directory: string) {
  const database = await openNodeStore(':memory:');
  const assets = createAssetService(database.store, await createNodeBlobStore(directory));
  return { ...database, assets, cards: createCardService(database.store, assets) };
}

const actor = { id: 'alice', uri: 'urn:alice' };
describe('inbound chat HTTP review', () => {
  let directory: string, workspaceId: string, targetId: string;
  let services: Awaited<ReturnType<typeof openFixture>>;
  let api: ReturnType<typeof createApi>;
  let remote: { spec: string; spec_version: string; data: Record<string, unknown> };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'unity-inbound-http-'));
    services = await openFixture(directory);
    workspaceId = (await services.cards.createWorkspace(actor, 'Library')).id;
    const original = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Aster', description: 'Original.', extensions: {} } };
    const source = await services.cards.import(actor, workspaceId, new TextEncoder().encode(JSON.stringify(original)));
    remote = { ...original, data: { ...original.data, description: 'Remote edit.' } };
    const chat = createChatService(services.store, services.chat, services.assets, () => ({ kind: 'sillytavern',
      check: async () => ({ characters: 1 }), list: async () => [], read: async () => remote,
      readForImport: async () => ({ bytes: new TextEncoder().encode(JSON.stringify(remote)), fields: remote.data, envelope: remote }),
      upload: async () => ({ remoteId: 'copy/one?' }) }));
    targetId = (await chat.addTarget(actor, workspaceId, { kind: 'sillytavern', baseUrl: 'http://chat.test', credentials: {} })).id;
    await services.chat.recordPlacements(workspaceId, targetId, [{ cardId: source.card.id, revisionId: source.revision.id,
      remoteId: 'copy/one?', remoteName: 'Aster', edited: true }], { complete: false });
    api = createApi({ cards: services.cards, chat, authenticate(request) {
      return request.headers.get('authorization') === 'alice' ? actor : request.headers.get('authorization') === 'bob' ? { id: 'bob', uri: 'urn:bob' } : null;
    } });
  });
  afterEach(async () => { services?.close(); await rm(directory, { recursive: true, force: true }); });
  const path = (workspace: string, target: string) => `/api/workspaces/${workspace}/chat/targets/${target}/edits`;
  function post(suffix: string, body: unknown, authorization = 'alice') {
    return api.request(path(workspaceId, targetId) + suffix, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  it('requires the owner to review before accepting a private fork and rejects client-supplied content', async () => {
    expect((await post('/review', { remoteId: 'copy/one?' }, '')).status).toBe(401);
    expect((await post('/review', { remoteId: 'copy/one?' }, 'bob')).status).toBe(403);
    const response = await post('/review', { remoteId: 'copy/one?' });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const { changes, preserved, ...pin } = await response.json() as ChatEditReview;
    expect(changes).toHaveLength(1); expect(preserved).toHaveLength(3);
    expect(await services.cards.list(actor, workspaceId)).toHaveLength(1);
    expect((await post('', { ...pin, document: { forged: true } })).status).toBe(400);
    expect((await post('', { ...pin, remoteHash: 'not-a-hash' })).status).toBe(400);
    const accepted = await post('', pin);
    expect(accepted.status).toBe(201); expect(accepted.headers.get('cache-control')).toBe('no-store');
    const fork = await accepted.json() as { cardId: string };
    expect(await services.cards.list(actor, workspaceId)).toHaveLength(2);
    expect(await (await post('', pin)).json()).toMatchObject({ cardId: fork.cardId, duplicate: true });
    expect((await post('', pin, 'bob')).status).toBe(403);
  });
  it('returns explicit conflict instead of importing a changed snapshot', async () => {
    const { changes: _changes, preserved: _preserved, ...pin } = await (await post('/review', { remoteId: 'copy/one?' })).json() as ChatEditReview;
    void _changes; void _preserved;
    remote.data.description = 'Changed again.';
    const conflict = await post('', pin);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'ACCESS_CHANGED' } });
    expect(await services.cards.list(actor, workspaceId)).toHaveLength(1);
  });
  it('returns a clear conflict for a removed prior import and never silently recreates it', async () => {
    const { changes: _changes, preserved: _preserved, ...pin } = await (await post('/review', { remoteId: 'copy/one?' })).json() as ChatEditReview;
    void _changes; void _preserved;
    const fork = await (await post('', pin)).json() as { cardId: string };
    await services.cards.delete(actor, workspaceId, fork.cardId);
    const { changes: _freshChanges, preserved: _freshPreserved, ...freshPin } = await (await post('/review', { remoteId: 'copy/one?' })).json() as ChatEditReview;
    void _freshChanges; void _freshPreserved;
    expect(freshPin).toEqual(pin);
    for (const snapshot of [pin, freshPin]) {
      const response = await post('', snapshot);
      expect(response.status).toBe(409); expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ error: { code: 'ACCESS_CHANGED',
        message: 'A previous import of this snapshot was removed; it will not be silently recreated.' } });
    }
    expect(await services.cards.list(actor, workspaceId)).toHaveLength(1);
    await expect(services.cards.open(actor, workspaceId, fork.cardId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
