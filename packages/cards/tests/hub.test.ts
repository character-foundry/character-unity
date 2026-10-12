import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openNodeStore } from '@character-unity/store/node';
import type { CardDocument } from '@character-unity/store';
import type { PublicationPolicy } from '@character-unity/store/hub';
import { createNodeBlobStore } from '@character-unity/blob-store/node';
import { createAssetService } from '@character-unity/assets';
import type { AssetService } from '@character-unity/assets';
import { hashBytes, readCardLineage, verifyCardLineage } from '@character-foundry/character-foundry/identity';
import { createSyncToken, signSyncHttp, verifySyncHttp } from '@character-foundry/character-foundry/sync';
import type { SyncWriteContext } from '@character-unity/store/sync';
import { createCardService } from '../src/index.js';
import { createHubService } from '../src/hub.js';

const alice = { id: 'alice', uri: 'urn:unity:user:alice' };
const bob = { id: 'bob', uri: 'urn:unity:user:bob' };
const policy: PublicationPolicy = { visibility: 'public', allowFork: true, allowOriginal: false };
const encoder = new TextEncoder();
function document(): CardDocument {
  return { spec: 'chara_card_v3', spec_version: '3.0', opaque_envelope: 'preserved', data: {
    name: 'Aster', description: 'A map keeper.', personality: '', scenario: '', first_mes: 'Hello.', mes_example: '',
    tags: [], creator: '', character_version: '', group_only_greetings: [],
    extensions: { foreign: { note: 'public' }, charx_media: { private: 'local path' }, foundry: { local: { token: 'synthetic secret' } } },
  } };
}
async function receive(value: { body: ReadableStream<Uint8Array> }) { return new Uint8Array(await new Response(value.body).arrayBuffer()); }

describe('hub service with Foundry', () => {
  let directory: string;
  let database: Awaited<ReturnType<typeof openNodeStore>>;
  let assets: AssetService;
  let cards: ReturnType<typeof createCardService>;
  let hub: ReturnType<typeof createHubService>;
  let workspaceId: string;
  let target: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'unity-hub-'));
    database = await openNodeStore(':memory:');
    assets = createAssetService(database.store, await createNodeBlobStore(directory));
    cards = createCardService(database.store, assets);
    hub = createHubService(database.store, database.hub, assets);
    workspaceId = (await cards.createWorkspace(alice, 'Desk')).id;
    target = (await cards.createWorkspace(bob, 'Second account')).id;
  });
  afterEach(async () => { database?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
  async function imported(withAsset = false) {
    const card = document();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    if (withAsset) (card.data as CardDocument).assets = [{ type: 'background', name: 'scene', ext: 'png', uri: 'https://example.invalid/never-fetched.png' }];
    const original = encoder.encode(JSON.stringify(card, null, 2));
    const result = await cards.import(alice, workspaceId, original, { kind: 'archive', privatePath: 'must not publish' }, withAsset
      ? [{ binding: { kind: 'uri', uri: 'https://example.invalid/never-fetched.png' }, bytes, mediaType: 'image/png' }] : []);
    return { ...result, original, resource: bytes };
  }
  async function published(withAsset = false) {
    const source = await imported(withAsset);
    const draft = structuredClone(source.revision.document); (draft.data as CardDocument).description = 'Explicit edit';
    const saved = await cards.save(alice, workspaceId, source.card.id, source.revision.id, draft);
    const [receipt] = await hub.publish(alice, workspaceId, [saved.id], policy);
    return { ...source, saved, id: receipt!.id };
  }

  async function syncRecipient() {
    const account = (await database.accounts.create('Remote recipient')).account;
    const recipient = { id: account.id, uri: account.uri };
    const desk = (await cards.createWorkspace(recipient, 'Sync workspace')).id;
    const remote = 'https://sender.example/actors/recipient'; const keyId = `${remote}#one`;
    const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    await database.sync.grant({ actor: remote, accountId: account.id, workspaceId: desk, scopes: ['publish', 'fork'] });
    await database.sync.addKey(remote, keyId, key.publicKey);
    return { recipient, desk, async context(scope: 'publish' | 'fork', requestId = createSyncToken()): Promise<SyncWriteContext> {
      const signed = await signSyncHttp({ method: 'POST', url: `https://receiver.example/sync/${scope}`, actor: remote,
        keyId, privateKey: key.privateKey, requestId, body: encoder.encode('{}'), contentType: 'application/json' });
      const claim = await verifySyncHttp(signed, { resolveKey: (actor, keyId) => database.sync.resolveKey(actor, keyId, scope),
        consumeNonce: (claim) => database.sync.consumeNonce(claim, scope) });
      return { claim };
    } };
  }

  it('retries signed fork and publication operations with stable lineage and no repeated blob staging', async () => {
    const source = await published(true); const remote = await syncRecipient();
    const first = await remote.context('fork');
    const fork = await hub.fork(remote.recipient, source.id, remote.desk, first);
    const original = await receive(await cards.original(remote.recipient, remote.desk, fork.card.id));
    const noNewBlobs = createHubService(database.store, database.hub, { ...assets,
      async stage() { throw new Error('A committed retry must not stage another blob'); },
    });
    const retry = await noNewBlobs.fork(remote.recipient, source.id, remote.desk, await remote.context('fork', first.claim.requestId));
    expect(retry).toEqual(fork);
    expect(readCardLineage(retry.revision.document)).toEqual(readCardLineage(fork.revision.document));
    expect(await receive(await cards.original(remote.recipient, remote.desk, retry.card.id))).toEqual(original);
    expect(await receive(await assets.download(remote.desk, retry.revision.assets[0]!.assetId))).toEqual(source.resource);
    const publishContext = await remote.context('publish');
    const receipt = await hub.publish(remote.recipient, remote.desk, [fork.revision.id], policy, publishContext);
    expect(await hub.publish(remote.recipient, remote.desk, [fork.revision.id], policy, await remote.context('publish', publishContext.claim.requestId))).toEqual(receipt);
    await hub.updatePolicy(remote.recipient, receipt[0]!.id, 1, { ...policy, visibility: 'members' });
    expect(await hub.publish(remote.recipient, remote.desk, [fork.revision.id], policy, await remote.context('publish', publishContext.claim.requestId))).toEqual(receipt);
    expect((await hub.get(remote.recipient, receipt[0]!.id)).policyVersion).toBe(2);
    expect(await cards.list(remote.recipient, remote.desk)).toHaveLength(1);
    expect(await hub.list(remote.recipient, { parentId: source.id })).toHaveLength(1);
    expect(await receive(await cards.original(alice, workspaceId, source.card.id))).toEqual(source.original);
  });

  it('retries an interrupted pre-commit blob copy without publishing incomplete data or deleting accepted bytes', async () => {
    const source = await published(true); const remote = await syncRecipient(); const first = await remote.context('fork');
    const staged: string[] = [];
    const interrupted = createHubService(database.store, database.hub, { ...assets,
      async stage(input) { const asset = await assets.stage(input); staged.push(asset.id); return asset; },
      async upload(...args) { await assets.upload(...args); throw new Error('interrupted after durable upload'); },
    });
    await expect(interrupted.fork(remote.recipient, source.id, remote.desk, first)).rejects.toThrow('interrupted after durable upload');
    expect(await cards.list(remote.recipient, remote.desk)).toEqual([]);
    expect(await database.store.findSyncFork(remote.recipient.id, remote.desk, first)).toBeNull();
    const completed = await hub.fork(remote.recipient, source.id, remote.desk, await remote.context('fork', first.claim.requestId));
    expect(await cards.list(remote.recipient, remote.desk)).toHaveLength(1);
    expect(completed.revision.assets[0]!.assetId).not.toBe(staged[0]);
    // Unlinked uploads are retained for future operator cleanup, never erased speculatively.
    expect(await receive(await assets.download(remote.desk, staged[0]!))).toEqual(source.resource);
    expect(await receive(await assets.download(remote.desk, completed.revision.assets[0]!.assetId))).toEqual(source.resource);
    expect(await receive(await cards.original(alice, workspaceId, source.card.id))).toEqual(source.original);
  });

  it('publishes exactly selected immutable revisions without adding lineage or leaking local/source metadata', async () => {
    const a = await imported(); await imported(); const c = await imported();
    const result = await hub.publish(alice, workspaceId, [a.revision.id, c.revision.id], policy);
    expect(result).toHaveLength(2);
    const page = await hub.list(null);
    expect(page).toHaveLength(2);
    for (const item of page) {
      expect(readCardLineage(item.document)).toBeNull();
      expect(item.identity).toEqual(a.revision.identity);
      expect(item.document.opaque_envelope).toBe('preserved');
      expect((item.document.data as CardDocument).extensions).toEqual({ foreign: { note: 'public' } });
      for (const key of ['workspaceId', 'revisionId', 'source', 'provenance', 'storageKey']) expect(item).not.toHaveProperty(key);
    }
    expect(await receive(await cards.original(alice, workspaceId, a.card.id))).toEqual(a.original);
    const draft = structuredClone(a.revision.document); (draft.data as CardDocument).description = 'Unpublished';
    await cards.save(alice, workspaceId, a.card.id, a.revision.id, draft);
    expect(((await hub.get(null, result[0]!.id)).document.data as CardDocument).description).toBe('A map keeper.');
  });

  it('forks a verified publication for a second actor, copies assets and preserves parent/root lineage', async () => {
    const source = await published(true);
    await expect(hub.original(bob, source.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await receive(await hub.asset(bob, source.id, 'declared/0'))).toEqual(source.resource);
    const fork = await hub.fork(bob, source.id, target);
    const lineage = readCardLineage(fork.revision.document)!;
    expect(lineage.operation).toBe('fork'); expect(lineage.author).toBe(bob.uri);
    expect(lineage.originalHash).toBe(await hashBytes(source.original));
    expect(lineage.parents[0]?.revisionHash).toBe(readCardLineage(source.saved.document)!.revisionHash);
    expect(await verifyCardLineage(fork.revision.document, { assets: [{ pointer: '/assets/0/uri', hash: await hashBytes(source.resource) }] })).toBe(true);
    expect(fork.revision.identity).toEqual(source.saved.identity);
    const original = JSON.parse(new TextDecoder().decode(await receive(await cards.original(bob, target, fork.card.id))));
    expect(original).toEqual((await hub.get(bob, source.id)).document);
    expect(JSON.stringify(original)).not.toContain('synthetic secret');
    const originalAsset = source.saved.assets[0]!; const targetAsset = fork.revision.assets[0]!;
    expect(targetAsset.assetId).not.toBe(originalAsset.assetId);
    expect(await receive(await assets.download(target, targetAsset.assetId))).toEqual(source.resource);
    const [child] = await hub.publish(bob, target, [fork.revision.id], policy);
    expect((await hub.list(null, { parentId: source.id })).map((item) => item.id)).toEqual([child!.id]);
    const otherFork = await hub.fork(bob, source.id, target);
    expect(readCardLineage(otherFork.revision.document)!.revisionHash).not.toBe(lineage.revisionHash);
    expect(await receive(await cards.original(alice, workspaceId, source.card.id))).toEqual(source.original);
  });

  it('preflights selection ownership and rejects unauthorized target workspaces before copying bytes', async () => {
    const source = await imported();
    await expect(hub.publish(bob, workspaceId, [source.revision.id], policy)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(hub.publish(alice, workspaceId, [source.revision.id, 'missing'], policy)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(hub.publish(alice, workspaceId, [source.revision.id, source.revision.id], policy)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await hub.list(null)).toEqual([]);
    const [receipt] = await hub.publish(alice, workspaceId, [source.revision.id], policy);
    await expect(hub.fork(bob, receipt!.id, workspaceId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await cards.list(bob, target)).toEqual([]);
  });

  it('rolls back a fork if permissions change during byte copying', async () => {
    const source = await published(true);
    let revoked = false;
    const interrupted = createHubService(database.store, database.hub, { ...assets, async upload(...args) {
      const result = await assets.upload(...args);
      if (!revoked) { revoked = true; await hub.updatePolicy(alice, source.id, 1, { ...policy, allowFork: false }); }
      return result;
    } });
    await expect(interrupted.fork(bob, source.id, target)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
    expect(await cards.list(bob, target)).toEqual([]);
    expect((await cards.open(alice, workspaceId, source.card.id)).revision).toEqual(source.saved);
  });

  it('does not commit a fork when stored asset bytes fail digest verification', async () => {
    const source = await published(true);
    const corrupt = createHubService(database.store, database.hub, { ...assets, async download(...args) {
      const result = await assets.download(...args); await result.body.cancel();
      return { ...result, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(result.byteLength)); controller.close(); } }) };
    } });
    await expect(corrupt.fork(bob, source.id, target)).rejects.toThrow();
    expect(await cards.list(bob, target)).toEqual([]);
  });

  it('hides descendants, assets and downloads when an ancestor is made private', async () => {
    const source = await published(true);
    const fork = await hub.fork(bob, source.id, target);
    const [child] = await hub.publish(bob, target, [fork.revision.id], { ...policy, allowOriginal: true });
    await hub.updatePolicy(alice, source.id, 1, { ...policy, visibility: 'private' });
    for (const operation of [() => hub.get(null, child!.id), () => hub.asset(bob, child!.id, 'declared/0'),
      () => hub.original(bob, child!.id), () => hub.fork(bob, child!.id, target)]) await expect(operation()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await hub.list(bob)).toEqual([]);
    expect((await cards.open(bob, target, fork.card.id)).revision.id).toBe(fork.revision.id);
    expect(await receive(await cards.original(alice, workspaceId, source.card.id))).toEqual(source.original);
  });

  it('returns published lineage across revisions and forks without enriching private parent references', async () => {
    const source = await imported();
    const [untouched] = await hub.publish(alice, workspaceId, [source.revision.id], policy);
    const draft = structuredClone(source.revision.document); (draft.data as CardDocument).name = 'Public parent';
    const edit = await cards.save(alice, workspaceId, source.card.id, source.revision.id, draft);
    const [parent] = await hub.publish(alice, workspaceId, [edit.id], policy);
    const fork = await hub.fork(bob, parent!.id, target);
    const [forkPublication] = await hub.publish(bob, target, [fork.revision.id], policy);
    const hiddenDraft = structuredClone(fork.revision.document); (hiddenDraft.data as CardDocument).name = 'PRIVATE_ONLY_DO_NOT_SHOW';
    const hidden = await cards.save(bob, target, fork.card.id, fork.revision.id, hiddenDraft);
    const nextDraft = structuredClone(hidden.document); (nextDraft.data as CardDocument).name = 'Public descendant';
    const latest = await cards.save(bob, target, fork.card.id, hidden.id, nextDraft);
    const [child] = await hub.publish(bob, target, [latest.id], policy);
    const nodes = []; let afterId: string | undefined;
    do {
      const page = await hub.lineage(bob, child!.id, { limit: 2, ...(afterId ? { afterId } : {}) });
      expect(page.originalHash).toBe(source.card.originalHash);
      expect(JSON.stringify(page)).not.toContain('PRIVATE_ONLY_DO_NOT_SHOW');
      nodes.push(...page.nodes); afterId = page.nextAfter ?? undefined;
    } while (afterId && nodes.length < 20);
    expect(nodes.map((node) => node.publicationId).sort()).toEqual([untouched!.id, parent!.id, forkPublication!.id, child!.id].sort());
    expect(nodes.find((node) => node.publicationId === untouched!.id)).toMatchObject({ operation: 'original', revisionHash: null, parents: [] });
    expect(nodes.find((node) => node.publicationId === child!.id)).toMatchObject({ operation: 'edit', forkedFromPublicationId: parent!.id,
      parents: [{ revisionHash: readCardLineage(hidden.document)!.revisionHash }] });
    expect(nodes.some((node) => node.revisionHash === readCardLineage(hidden.document)!.revisionHash)).toBe(false);
    for (const node of nodes) for (const key of ['document', 'workspaceId', 'revisionId', 'source', 'provenance', 'assets']) expect(node).not.toHaveProperty(key);
    await hub.updatePolicy(alice, parent!.id, 1, { ...policy, visibility: 'private' });
    await expect(hub.lineage(bob, child!.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const visible = await hub.lineage(bob, untouched!.id);
    expect(visible.nodes.map((node) => node.publicationId)).toEqual([untouched!.id]); expect(visible.nextAfter).toBeNull();
  });

  it('rechecks access to graph nodes after assembling a page', async () => {
    const source = await published();
    const interrupted = createHubService(database.store, { ...database.hub, async rootPage(...args) {
      const page = await database.hub.rootPage(...args);
      await hub.updatePolicy(alice, source.id, 1, { ...policy, visibility: 'private' });
      return page;
    } }, assets);
    await expect(interrupted.lineage(bob, source.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
