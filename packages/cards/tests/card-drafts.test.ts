import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { openNodeStore } from '@character-unity/store/node';
import type { CardDocument, UnityStore } from '@character-unity/store';
import { createNodeBlobStore } from '@character-unity/blob-store/node';
import type { BlobStore } from '@character-unity/blob-store';
import { openBrowserStorage } from '@character-unity/browser-storage';
import { createAssetService } from '@character-unity/assets';
import { hashBytes, readCardLineage, verifyCardLineage } from '@character-foundry/character-foundry/identity';
import { writeCharX } from '@character-foundry/character-foundry/charx';
import { parseCard } from '@character-foundry/character-foundry/loader';
import { injectTextChunk } from '@character-foundry/character-foundry/png';
import type { CCv3Data } from '@character-foundry/character-foundry/schemas';
import { createCardService } from '../src/index.js';
import type { AssetBinding, AssetUpload } from '../src/types.js';

const alice = { id: 'alice', uri: 'urn:unity:user:alice' };
const image = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
const text = new TextEncoder().encode('Exact attachment bytes.\n');
const uploaded = (path: string, index: number): AssetBinding => ({ path, source: { kind: 'upload', index } });
const retained = (path: string): AssetBinding => ({ path, source: { kind: 'existing', path } });
const upload = (bytes: Uint8Array, mediaType = 'image/png'): AssetUpload => ({ bytes, mediaType });
const bindings = [uploaded('portrait', 0), uploaded('declared/0', 0), uploaded('declared/1', 1)];
const files = [upload(image), upload(text, 'text/plain')];
function document(): CardDocument {
  return { spec: 'chara_card_v3', spec_version: '3.0', opaque_root: { keep: [null, 7] },
    data: { name: 'Draft fixture', description: 'New prompt', extensions: { vendor: { preserved: true } }, assets: [
      { type: 'icon', name: 'main', ext: 'png', uri: 'ccdefault:', license: { exact: true } },
      { type: 'custom', name: 'notes', ext: 'txt', uri: 'embedded://notes.txt', vendor: [false, 2] },
    ] } };
}
async function receive(value: { body: ReadableStream<Uint8Array> }) {
  return new Uint8Array(await new Response(value.body).arrayBuffer());
}

for (const adapter of ['native', 'indexeddb']) describe(`atomic editor drafts with ${adapter} storage`, () => {
  let directory: string | undefined;
  let database: { store: UnityStore; close(): void };
  let assets: ReturnType<typeof createAssetService>;
  let cards: ReturnType<typeof createCardService>;
  let workspace: string;
  beforeEach(async () => {
    let blobs: BlobStore;
    if (adapter === 'native') {
      directory = await mkdtemp(join(tmpdir(), 'unity-card-drafts-'));
      database = await openNodeStore(':memory:');
      blobs = await createNodeBlobStore(directory);
    } else {
      vi.stubGlobal('indexedDB', new IDBFactory());
      vi.stubGlobal('IDBKeyRange', IDBKeyRange);
      const browser = await openBrowserStorage();
      database = browser; blobs = browser.blobs;
    }
    assets = createAssetService(database.store, blobs);
    cards = createCardService(database.store, assets);
    workspace = (await cards.createWorkspace(alice, 'Drafts')).id;
  });
  afterEach(async () => {
    database?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it('creates prompt and assets together in one initial revision, preserving opaque document fields', async () => {
    const created = await cards.createDraft(alice, workspace, document(), bindings, files);
    expect(created.revision.sequence).toBe(1);
    expect(created.card.headRevisionId).toBe(created.revision.id);
    expect(created.card.originalHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await cards.list(alice, workspace))).toHaveLength(1);
    expect((await cards.history(alice, workspace, created.card.id)).revisions).toHaveLength(1);
    expect(created.revision.document.opaque_root).toEqual({ keep: [null, 7] });
    expect(created.revision.document.data).toMatchObject(document().data as CardDocument);
    expect(created.revision.assets.find((asset) => asset.path === 'portrait')!.assetId)
      .toBe(created.revision.assets.find((asset) => asset.path === 'declared/0')!.assetId);
    expect(await receive(await cards.asset(alice, workspace, created.card.id, created.revision.id, 'declared/1'))).toEqual(text);
    expect(await verifyCardLineage(created.revision.document, { portraitHash: await hashBytes(image), assets: [
      { pointer: '/assets/0/uri', hash: await hashBytes(image) }, { pointer: '/assets/1/uri', hash: await hashBytes(text) },
    ] })).toBe(true);
    const next = structuredClone(created.revision.document);
    (next.data as CardDocument).description = 'Second save';
    const saved = await cards.save(alice, workspace, created.card.id, created.revision.id, next);
    expect(saved.sequence).toBe(2);
    expect(saved.assets).toEqual(created.revision.assets);
  });

  it('rejects invalid first-save bindings before staging bytes or creating any card', async () => {
    const stage = vi.spyOn(assets, 'stage');
    await expect(cards.createDraft(alice, workspace, document(), bindings.slice(0, 2), files)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(cards.createDraft(alice, workspace, document(), [retained('portrait'), uploaded('declared/0', 0), uploaded('declared/1', 1)], files)).rejects.toBeDefined();
    await expect(cards.createDraft({ id: 'other', uri: 'urn:other' }, workspace, document(), bindings, files)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(stage).not.toHaveBeenCalled();
    expect(await cards.list(alice, workspace)).toEqual([]);
  });

  it('creates no card when uploading first-save assets fails', async () => {
    let uploads = 0;
    const failed = createCardService(database.store, { ...assets, async upload(...args) {
      if (++uploads === 2) throw new Error('Injected attachment failure');
      return assets.upload(...args);
    } });
    await expect(failed.createDraft(alice, workspace, document(), bindings, files)).rejects.toThrow('Injected attachment failure');
    expect(await cards.list(alice, workspace)).toEqual([]);
  });

  it('saves fork prompt and asset edits in its first revision, reusing retained bytes and leaving the parent intact', async () => {
    const parent = await cards.createDraft(alice, workspace, document(), bindings, files);
    const replacement = injectTextChunk(image, 'license', 'Keep metadata in the new portrait');
    const draft = structuredClone(parent.revision.document);
    (draft.data as CardDocument).description = 'Fork prompt';
    const fork = await cards.forkAssets(alice, workspace, parent.card.id, parent.revision.id, draft,
      [uploaded('portrait', 0), uploaded('declared/0', 0), retained('declared/1')], [upload(replacement)]);
    const opened = await cards.open(alice, workspace, fork.cardId);
    expect(fork.revisionId).toBe(opened.revision.id);
    expect(opened.revision.sequence).toBe(1);
    expect(opened.card.forkedFromRevisionId).toBe(parent.revision.id);
    expect(opened.card.originalHash).toBe(parent.card.originalHash);
    expect((opened.revision.document.data as CardDocument).description).toBe('Fork prompt');
    expect(opened.revision.document.opaque_root).toEqual(parent.revision.document.opaque_root);
    expect(opened.revision.assets.find((asset) => asset.path === 'declared/1')!.assetId)
      .toBe(parent.revision.assets.find((asset) => asset.path === 'declared/1')!.assetId);
    expect(await receive(await cards.asset(alice, workspace, fork.cardId, fork.revisionId, 'portrait'))).toEqual(replacement);
    expect((await cards.open(alice, workspace, parent.card.id)).revision).toEqual(parent.revision);
    expect((await cards.history(alice, workspace, fork.cardId)).revisions).toHaveLength(1);
    expect(readCardLineage(opened.revision.document)?.parents[0]?.revisionHash).toBe(readCardLineage(parent.revision.document)?.revisionHash);
  });

  it('rejects stale and racing source heads without leaving a fork card', async () => {
    const parent = await cards.createDraft(alice, workspace, document(), bindings, files);
    const next = structuredClone(parent.revision.document);
    (next.data as CardDocument).description = 'Parent changed';
    const latest = await cards.save(alice, workspace, parent.card.id, parent.revision.id, next);
    await expect(cards.forkAssets(alice, workspace, parent.card.id, parent.revision.id, parent.revision.document,
      [retained('portrait'), retained('declared/0'), retained('declared/1')], [])).rejects.toMatchObject({ code: 'HEAD_CONFLICT' });
    let raced = false;
    const racing = createCardService(database.store, { ...assets, async upload(...args) {
      const result = await assets.upload(...args);
      if (!raced) {
        raced = true;
        const winning = structuredClone(latest.document);
        (winning.data as CardDocument).description = 'Concurrent parent edit';
        await cards.save(alice, workspace, parent.card.id, latest.id, winning);
      }
      return result;
    } });
    const replacement = injectTextChunk(image, 'license', 'Replacement');
    await expect(racing.forkAssets(alice, workspace, parent.card.id, latest.id, latest.document,
      [uploaded('portrait', 0), uploaded('declared/0', 0), retained('declared/1')], [upload(replacement)])).rejects.toMatchObject({ code: 'HEAD_CONFLICT' });
    expect(await cards.list(alice, workspace)).toHaveLength(1);
    expect((await cards.family(alice, workspace, parent.card.id)).forkTotal).toBe(0);
    expect(((await cards.open(alice, workspace, parent.card.id)).revision.document.data as CardDocument).description).toBe('Concurrent parent edit');
  });

  it('retains an imported RisuAI module by reference when saving fork assets', async () => {
    const module = new Uint8Array([0x52, 0x49, 0x53, 0x55, 0, 1, 254, 255]);
    const input = document();
    (input.data as CardDocument).assets = ((input.data as CardDocument).assets as CardDocument[]).slice(0, 1);
    const original = writeCharX(input as unknown as CCv3Data, [{ type: 'icon', name: 'main', ext: 'png', data: image, isMain: true }],
      { preserveDescriptors: true, moduleRisum: module }).buffer;
    const parent = await cards.import(alice, workspace, original);
    const draft = structuredClone(parent.revision.document);
    (draft.data as CardDocument).description = 'Fork with module';
    const fork = await cards.forkAssets(alice, workspace, parent.card.id, parent.revision.id, draft, [retained('portrait'), retained('declared/0')], []);
    expect(fork.revision.assets.find((asset) => asset.path === 'module.risum')!.assetId)
      .toBe(parent.revision.assets.find((asset) => asset.path === 'module.risum')!.assetId);
    const exported = await cards.export(alice, workspace, fork.cardId, fork.revisionId, 'charx');
    expect(new Uint8Array(parseCard(exported.bytes, { extractAssets: true }).metadata!.moduleRisum!)).toEqual(module);
    expect(await receive(await cards.original(alice, workspace, parent.card.id))).toEqual(original);
  });

  it('restores a historical document and its asset references together in one new revision', async () => {
    const original = await cards.createDraft(alice, workspace, document(), bindings, files);
    const changed = structuredClone(original.revision.document);
    (changed.data as CardDocument).description = 'Different prompt and portrait';
    (changed.data as CardDocument).assets = ((changed.data as CardDocument).assets as CardDocument[]).slice(0, 1);
    const replacement = injectTextChunk(image, 'license', 'A later portrait');
    const second = await cards.saveAssets(alice, workspace, original.card.id, original.revision.id, changed,
      [uploaded('portrait', 0), uploaded('declared/0', 0)], [upload(replacement)]);

    const restored = await cards.restore(alice, workspace, original.card.id, second.id, original.revision.id);

    expect(restored.sequence).toBe(3);
    expect(restored.assets).toEqual(original.revision.assets);
    expect(restored.identity).toEqual(original.revision.identity);
    expect(restored.document.opaque_root).toEqual(original.revision.document.opaque_root);
    expect((restored.document.data as CardDocument).description).toBe('New prompt');
    expect((restored.document.data as CardDocument).assets).toEqual((original.revision.document.data as CardDocument).assets);
    expect(await receive(await cards.asset(alice, workspace, original.card.id, restored.id, 'portrait'))).toEqual(image);
    expect(await receive(await cards.asset(alice, workspace, original.card.id, restored.id, 'declared/1'))).toEqual(text);
    expect(await receive(await cards.asset(alice, workspace, original.card.id, second.id, 'portrait'))).toEqual(replacement);
    expect(readCardLineage(restored.document)?.parents[0]?.revisionHash).toBe(readCardLineage(second.document)?.revisionHash);
    expect((await cards.open(alice, workspace, original.card.id)).revision.id).toBe(restored.id);
    expect((await cards.history(alice, workspace, original.card.id)).revisions).toHaveLength(3);

    await expect(cards.restore(alice, workspace, original.card.id, second.id, original.revision.id)).rejects.toMatchObject({ code: 'HEAD_CONFLICT' });
    const other = await cards.createDraft(alice, workspace, document(), bindings, files);
    await expect(cards.restore(alice, workspace, original.card.id, restored.id, other.revision.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(cards.restore({ id: 'other', uri: 'urn:other' }, workspace, original.card.id, restored.id, original.revision.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await cards.history(alice, workspace, original.card.id)).revisions).toHaveLength(3);
  });
});
