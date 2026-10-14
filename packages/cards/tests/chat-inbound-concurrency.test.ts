import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStore } from '@character-unity/store';
import { openNodeStore } from '@character-unity/store/node';
import { createD1Driver } from '@character-unity/store/d1';
import { migrate } from '@character-unity/store/migrations';
import { createChatStore } from '@character-unity/store/chat';
import { createNodeBlobStore } from '@character-unity/blob-store/node';
import { createAssetService } from '@character-unity/assets';
import type { ChatApp } from '@character-unity/chat-apps';
import { createCardService } from '../src/index.js';
import { createChatService } from '../src/chat.js';

const actor = { id: 'alice', uri: 'urn:alice' };
const document = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Aster', description: 'Original.', extensions: {} } };
describe.each(['sqlite', 'd1'])('inbound edit atomic acceptance / %s', (adapter) => {
  it('returns one durable fork to simultaneous acceptances and never treats authored receipt JSON as authority', async () => {
    const database = adapter === 'sqlite' ? await openNodeStore(':memory:') : null;
    const mf = adapter === 'd1' ? new Miniflare(convertV4MiniflareOptions({ port: 0, workers: [{ name: 'inbound-test', modules: true,
      script: 'export default { fetch() { return new Response("test"); } };', compatibilityDate: '2026-10-11', d1Databases: ['DB'] }] })) : null;
    const directory = await mkdtemp(join(tmpdir(), 'unity-inbound-'));
    try {
      const driver = mf ? createD1Driver(await mf.getD1Database('DB')) : null;
      if (driver) await migrate(driver);
      const store = database?.store ?? createStore(driver!), placements = database?.chat ?? createChatStore(driver!), assets = createAssetService(store, await createNodeBlobStore(directory));
      const cards = createCardService(store, assets), workspace = await cards.createWorkspace(actor, 'Library');
      const imported = await cards.import(actor, workspace.id, new TextEncoder().encode(JSON.stringify(document)));
      const remote = { ...document, data: { ...document.data, description: 'Remote edit.' } };
      const client: ChatApp = { kind: 'sillytavern', check: async () => ({ characters: 1 }), list: async () => [], read: async () => remote,
        readForImport: async () => ({ bytes: new TextEncoder().encode(JSON.stringify(remote)), fields: remote.data, envelope: remote }),
        upload: async () => ({ remoteId: 'remote' }) };
      const first = createChatService(store, placements, assets, () => client), second = createChatService(store, placements, assets, () => client);
      const target = await first.addTarget(actor, workspace.id, { kind: 'sillytavern', baseUrl: 'http://chat.test', credentials: {} });
      await placements.recordPlacements(workspace.id, target.id, [{ cardId: imported.card.id, revisionId: imported.revision.id,
        remoteId: 'remote', remoteName: 'Aster', edited: true }], { complete: false });
      const review = await first.reviewEdit(actor, workspace.id, target.id, 'remote');
      const [one, two] = await Promise.all([first.acceptEdit(actor, workspace.id, target.id, review), second.acceptEdit(actor, workspace.id, target.id, review)]);
      expect(one.cardId).toBe(two.cardId);
      expect([one.duplicate, two.duplicate].sort()).toEqual([false, true]);
      expect(await cards.list(actor, workspace.id)).toHaveLength(2);
      expect(await second.acceptEdit(actor, workspace.id, target.id, review)).toMatchObject({ cardId: one.cardId, duplicate: true });
      const fork = await cards.open(actor, workspace.id, one.cardId);
      const receipt = (fork.revision.document.data as { extensions: { foundry: { local: { unityChatImport: { receiptHash: string } } } } }).extensions.foundry.local.unityChatImport;
      expect(await placements.importedEdit(workspace.id, 'other', receipt.receiptHash, review.expectedHead)).toBeNull();

      // An unrelated document can never masquerade as an actual fork receipt.
      const otherWorkspace = await cards.createWorkspace(actor, 'Other');
      await store.createCard({ workspaceId: otherWorkspace.id, authorId: actor.id, originalHash: 'b'.repeat(64),
        document: fork.revision.document, identity: fork.revision.identity });
      expect(await placements.importedEdit(otherWorkspace.id, actor.id, receipt.receiptHash, review.expectedHead)).toBeNull();
      await store.forkCard({ workspaceId: otherWorkspace.id, sourceWorkspaceId: workspace.id, sourceRevisionId: imported.revision.id,
        authorId: actor.id, document: fork.revision.document, identity: fork.revision.identity });
      expect(await placements.importedEdit(otherWorkspace.id, actor.id, receipt.receiptHash, review.expectedHead)).toBeNull();
      expect(await store.listCards(otherWorkspace.id)).toHaveLength(2);
    } finally { database?.close(); await mf?.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
});
