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
import { injectTextChunk, extractFromPNG, embedIntoPNG } from '@character-foundry/character-foundry/png';
import type { CCv3Data } from '@character-foundry/character-foundry/schemas';
import { createCardService } from '../src/index.js';
import type { AssetBinding, AssetUpload } from '../src/types.js';

const alice = { id: 'alice', uri: 'urn:unity:user:alice' }, bob = { id: 'bob', uri: 'urn:unity:user:bob' };
const image = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
const text = new TextEncoder().encode('An exact attachment.\n');
const source = new TextEncoder().encode(JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', opaque: { keep: true },
  data: { name: 'Asset fixture', description: 'Original', extensions: { vendor: [null, false] } } }));
const retained = (path: string, from = path): AssetBinding => ({ path, source: { kind: 'existing', path: from } });
const uploaded = (path: string, index: number): AssetBinding => ({ path, source: { kind: 'upload', index } });
const upload = (bytes: Uint8Array, mediaType = 'image/png'): AssetUpload => ({ bytes, mediaType });
async function receive(value: { body: ReadableStream<Uint8Array> }) { return new Uint8Array(await new Response(value.body).arrayBuffer()); }
function attach(document: CardDocument): CardDocument {
  const next = structuredClone(document);
  (next.data as CardDocument).assets = [
    { type: 'icon', name: 'main', ext: 'png', uri: 'ccdefault:', license: { exact: true } },
    { type: 'custom', name: 'notes', ext: 'txt', uri: 'embedded://notes.txt', vendor: [null, 2] },
  ];
  return next;
}

for (const adapter of ['native', 'indexeddb']) describe(`asset revisions with ${adapter} storage`, () => {
  let directory: string | undefined;
  let database: { store: UnityStore; close(): void };
  let assets: ReturnType<typeof createAssetService>;
  let cards: ReturnType<typeof createCardService>;
  let workspace: string;
  beforeEach(async () => {
    let blobs: BlobStore;
    if (adapter === 'native') {
      directory = await mkdtemp(join(tmpdir(), 'unity-asset-edit-'));
      database = await openNodeStore(':memory:'); blobs = await createNodeBlobStore(directory);
    } else {
      vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange);
      const browser = await openBrowserStorage(); database = browser; blobs = browser.blobs;
    }
    assets = createAssetService(database.store, blobs); cards = createCardService(database.store, assets);
    workspace = (await cards.createWorkspace(alice, 'Assets')).id;
  });
  afterEach(async () => { database?.close(); if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('adds, replaces and removes assets with exact history, SDK lineage and container round trips', async () => {
    const initial = await cards.import(alice, workspace, source);
    const draft = attach(initial.revision.document); (draft.data as CardDocument).description = 'Prompt and assets together';
    const first = await cards.saveAssets(alice, workspace, initial.card.id, initial.revision.id, draft,
      [uploaded('portrait', 0), uploaded('declared/0', 0), uploaded('declared/1', 1)], [upload(image), upload(text, 'text/plain')]);
    expect(first.sequence).toBe(2); expect(first.document.opaque).toEqual({ keep: true });
    expect((first.document.data as CardDocument).description).toBe('Prompt and assets together');
    expect(first.assets.find((asset) => asset.path === 'portrait')!.assetId).toBe(first.assets.find((asset) => asset.path === 'declared/0')!.assetId);
    expect(await verifyCardLineage(first.document, { portraitHash: await hashBytes(image), assets: [
      { pointer: '/assets/0/uri', hash: await hashBytes(image) }, { pointer: '/assets/1/uri', hash: await hashBytes(text) },
    ] })).toBe(true);
    expect(readCardLineage(first.document)?.originalHash).toBe(await hashBytes(source));
    expect((await cards.assetList(alice, workspace, initial.card.id, initial.revision.id)).assets).toEqual([]);
    expect(await receive(await cards.asset(alice, workspace, initial.card.id, first.id, 'declared/1'))).toEqual(text);
    for (const format of ['png', 'charx'] as const) {
      const exported = await cards.export(alice, workspace, initial.card.id, first.id, format);
      const roundtrip = await cards.import(alice, workspace, exported.bytes);
      expect(roundtrip.revision.identity).toEqual(first.identity);
      expect(readCardLineage(roundtrip.revision.document)).toEqual(readCardLineage(first.document));
    }
    // Metadata in uploaded images is part of the exact accepted asset, never stripped silently.
    const replacement = injectTextChunk(image, 'license', 'Keep this metadata');
    const second = await cards.saveAssets(alice, workspace, initial.card.id, first.id, first.document,
      [uploaded('portrait', 0), uploaded('declared/0', 0), retained('declared/1')], [upload(replacement)]);
    expect(second.identity).not.toEqual(first.identity);
    expect(readCardLineage(second.document)?.parents[0]?.revisionHash).toBe(readCardLineage(first.document)?.revisionHash);
    expect(await receive(await cards.asset(alice, workspace, initial.card.id, first.id, 'portrait'))).toEqual(image);
    expect(await receive(await cards.asset(alice, workspace, initial.card.id, second.id, 'portrait'))).toEqual(replacement);
    const charx = await cards.export(alice, workspace, initial.card.id, second.id, 'charx');
    expect((await cards.import(alice, workspace, charx.bytes)).revision.identity).toEqual(second.identity);
    await expect(cards.export(alice, workspace, initial.card.id, second.id, 'png')).rejects.toMatchObject({ code: 'EXPORT_LOSS' });
    const reduced = structuredClone(second.document);
    (reduced.data as CardDocument).assets = ((reduced.data as CardDocument).assets as CardDocument[]).slice(1);
    const third = await cards.saveAssets(alice, workspace, initial.card.id, second.id, reduced, [retained('declared/0', 'declared/1')], []);
    expect(await receive(await cards.asset(alice, workspace, initial.card.id, third.id, 'declared/0'))).toEqual(text);
    await expect(cards.asset(alice, workspace, initial.card.id, third.id, 'portrait')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const empty = structuredClone(third.document); delete (empty.data as CardDocument).assets;
    const fourth = await cards.saveAssets(alice, workspace, initial.card.id, third.id, empty, [], []);
    expect(fourth.assets).toEqual([]); expect(await verifyCardLineage(fourth.document)).toBe(true);
    const json = await cards.export(alice, workspace, initial.card.id, fourth.id, 'json');
    expect((await cards.import(alice, workspace, json.bytes)).revision.identity).toEqual(fourth.identity);
    expect(await receive(await cards.original(alice, workspace, initial.card.id))).toEqual(source);
    expect((await cards.history(alice, workspace, initial.card.id)).revisions.map((revision) => revision.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it('scopes existing bindings to the expected card and rejects malformed plans before staging', async () => {
    const initial = await cards.import(alice, workspace, source);
    const other = await cards.import(alice, workspace, source);
    const draft = attach(initial.revision.document);
    const bindings = [uploaded('portrait', 0), uploaded('declared/0', 0), uploaded('declared/1', 1)];
    const files = [upload(image), upload(text, 'text/plain')];
    const stage = vi.spyOn(assets, 'stage');
    await expect(cards.saveAssets(bob, workspace, initial.card.id, initial.revision.id, draft, bindings, files)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const invalid of [bindings.slice(0, 2), [...bindings, bindings[0]!], [...bindings, uploaded('declared/2', 0)],
      [retained('portrait'), uploaded('declared/0', 0), uploaded('declared/1', 1)],
      [uploaded('portrait', 0), uploaded('declared/0', 1), uploaded('declared/1', 1)],
    ]) await expect(cards.saveAssets(alice, workspace, initial.card.id, initial.revision.id, draft, invalid, files)).rejects.toBeDefined();
    await expect(cards.saveAssets(alice, workspace, initial.card.id, initial.revision.id, draft, bindings, [...files, upload(text)])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(stage).not.toHaveBeenCalled();
    const first = await cards.saveAssets(alice, workspace, initial.card.id, initial.revision.id, draft, bindings, files);
    stage.mockClear();
    const noChange = await cards.saveAssets(alice, workspace, initial.card.id, first.id, first.document, bindings, files);
    expect(noChange.id).toBe(first.id); expect(stage).not.toHaveBeenCalled();
    await expect(cards.saveAssets(alice, workspace, initial.card.id, initial.revision.id, draft, bindings, files)).rejects.toMatchObject({ code: 'HEAD_CONFLICT' });
    await expect(cards.saveAssets(alice, workspace, other.card.id, other.revision.id, attach(other.revision.document),
      [retained('portrait'), retained('declared/0'), retained('declared/1')], [])).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE' });
    const forged = structuredClone(first.document); ((forged.data as CardDocument).extensions as CardDocument).foundry = {};
    await expect(cards.saveAssets(alice, workspace, initial.card.id, first.id, forged, bindings, files)).rejects.toMatchObject({ code: 'INVALID_LINEAGE' });
    expect(stage).not.toHaveBeenCalled();
    for (const actor of [bob]) {
      await expect(cards.assetList(actor, workspace, initial.card.id, first.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(cards.asset(actor, workspace, initial.card.id, first.id, 'portrait')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await expect(cards.assetList(alice, workspace, other.card.id, first.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(cards.asset(alice, workspace, other.card.id, first.id, 'portrait')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await receive(await cards.original(alice, workspace, initial.card.id))).toEqual(source);
  });

  it('owns caller input and keeps the head atomic across failed, cancelled and racing uploads', async () => {
    const initial = await cards.import(alice, workspace, source);
    const draft = attach(initial.revision.document);
    const bindings = [uploaded('portrait', 0), uploaded('declared/0', 0), uploaded('declared/1', 1)];
    const files = [upload(image), upload(text, 'text/plain')];
    let completed = 0;
    const failed = createCardService(database.store, { ...assets, async upload(...args) {
      if (++completed === 2) throw new Error('Injected second upload failure');
      return assets.upload(...args);
    } });
    await expect(failed.saveAssets(alice, workspace, initial.card.id, initial.revision.id, draft, bindings, files)).rejects.toThrow('Injected');
    expect((await cards.open(alice, workspace, initial.card.id)).revision).toEqual(initial.revision);
    const abort = new AbortController();
    const cancelled = createCardService(database.store, { ...assets, async upload(...args) {
      const result = await assets.upload(...args); abort.abort(); return result;
    } });
    await expect(cancelled.saveAssets(alice, workspace, initial.card.id, initial.revision.id, draft, bindings, files, abort.signal)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await cards.history(alice, workspace, initial.card.id)).revisions).toHaveLength(1);
    let concurrent = false;
    const racing = createCardService(database.store, { ...assets, async upload(...args) {
      const result = await assets.upload(...args);
      if (!concurrent) {
        concurrent = true; const next = structuredClone(initial.revision.document); (next.data as CardDocument).description = 'Concurrent winner';
        await cards.save(alice, workspace, initial.card.id, initial.revision.id, next);
      }
      return result;
    } });
    await expect(racing.saveAssets(alice, workspace, initial.card.id, initial.revision.id, draft, bindings, files)).rejects.toMatchObject({ code: 'HEAD_CONFLICT' });
    const winner = (await cards.open(alice, workspace, initial.card.id)).revision;
    expect((winner.document.data as CardDocument).description).toBe('Concurrent winner'); expect(winner.assets).toEqual([]);
    const ownedDraft = attach(winner.document), ownedBindings = structuredClone(bindings), ownedFiles = structuredClone(files), actor = { ...alice };
    const pending = cards.saveAssets(actor, workspace, initial.card.id, winner.id, ownedDraft, ownedBindings, ownedFiles);
    actor.id = bob.id; (ownedDraft.data as CardDocument).name = 'Mutated'; ownedBindings.length = 0; ownedFiles[0]!.bytes.fill(0);
    const saved = await pending;
    expect((saved.document.data as CardDocument).name).toBe('Asset fixture'); expect(saved.authorId).toBe(alice.id);
    expect(await receive(await cards.asset(alice, workspace, initial.card.id, saved.id, 'portrait'))).toEqual(image);
    expect(await receive(await cards.original(alice, workspace, initial.card.id))).toEqual(source);
    expect((await cards.history(alice, workspace, initial.card.id)).revisions).toHaveLength(3);
  });

  it('exports marked SillyTavern PNG portraits and aliases while rejecting separate attachments', async () => {
    for (const version of ['2', '3']) {
      const raw = JSON.parse(new TextDecoder().decode(source)); raw.spec = `chara_card_v${version}`; raw.spec_version = `${version}.0`;
      const original = new TextEncoder().encode(JSON.stringify(raw));
      const initial = await cards.import(alice, workspace, original);
      await expect(cards.export(alice, workspace, initial.card.id, initial.revision.id, 'sillytavern-png')).rejects.toMatchObject({ code: 'EXPORT_LOSS' });
      const draft = structuredClone(initial.revision.document);
      if (version === '3') (draft.data as CardDocument).assets = [{ type: 'icon', name: 'Authored.Main', ext: 'PNG', uri: 'embedded://main.png', license: { keep: true } }];
      const bindings = [uploaded('portrait', 0), ...(version === '3' ? [uploaded('declared/0', 0)] : [])];
      const saved = await cards.saveAssets(alice, workspace, initial.card.id, initial.revision.id, draft, bindings, [upload(image)]);
      const exported = await cards.export(alice, workspace, initial.card.id, saved.id, 'sillytavern-png');
      expect(exported.filename).toBe('character.png'); expect(exported.mediaType).toBe('image/png');
      const returned = extractFromPNG(exported.bytes).data as unknown as CardDocument;
      expect(returned).toHaveProperty('data.extensions.foundry.local.sillyTavernTransport');
      if (version === '3') expect((returned.data as CardDocument).assets).toEqual([{ type: 'icon', name: 'Authored.Main', ext: 'PNG', uri: 'ccdefault:', license: { keep: true } }]);
      const direct = await cards.import(alice, workspace, exported.bytes); expect(direct.revision.identity).toEqual(saved.identity);
      // Observed transport additions; the real application is checked by the separate harness.
      const data = returned.data as CardDocument;
      returned.name = data.name!; returned.description = data.description!; returned.fav = false; returned.create_date = '2026-10-11T00:00:00.000Z';
      (data.extensions as CardDocument).fav = false; returned.spec = 'chara_card_v3'; returned.spec_version = '3.0';
      const returnedBytes = embedIntoPNG(image, returned as unknown as CCv3Data, { key: 'ccv3' });
      const restored = await cards.import(alice, workspace, returnedBytes);
      expect(restored.revision.identity).toEqual(saved.identity); expect(readCardLineage(restored.revision.document)).toEqual(readCardLineage(saved.document));
      expect(await receive(await cards.original(alice, workspace, restored.card.id))).toEqual(returnedBytes);
      expect(await receive(await cards.asset(alice, workspace, restored.card.id, restored.revision.id, 'portrait'))).toEqual(image);
      data.description = returned.description = 'A changed external prompt';
      await expect(cards.import(alice, workspace, embedIntoPNG(image, returned as unknown as CCv3Data, { key: 'ccv3' }))).rejects.toBeDefined();
      const withAttachment = structuredClone(saved.document); const descriptors = ((withAttachment.data as CardDocument).assets ?? []) as CardDocument[];
      const index = descriptors.length; descriptors.push({ type: 'custom', name: 'notes', ext: 'txt', uri: 'embedded://notes.txt' }); (withAttachment.data as CardDocument).assets = descriptors;
      const next = await cards.saveAssets(alice, workspace, initial.card.id, saved.id, withAttachment,
        [...saved.assets.map((asset) => retained(asset.path)), uploaded(`declared/${index}`, 0)], [upload(text, 'text/plain')]);
      await expect(cards.export(alice, workspace, initial.card.id, next.id, 'sillytavern-png')).rejects.toMatchObject({ code: 'EXPORT_LOSS' });
      expect((await cards.revision(alice, workspace, initial.card.id, saved.id)).document).toEqual(saved.document);
      expect(await receive(await cards.original(alice, workspace, initial.card.id))).toEqual(original);
    }
  });

  it('adds an implicit CCv2 portrait without changing the document format', async () => {
    const input = JSON.parse(new TextDecoder().decode(source)); input.spec = 'chara_card_v2'; input.spec_version = '2.0';
    const initial = await cards.import(alice, workspace, new TextEncoder().encode(JSON.stringify(input)));
    const saved = await cards.saveAssets(alice, workspace, initial.card.id, initial.revision.id, initial.revision.document, [uploaded('portrait', 0)], [upload(image)]);
    expect(saved.document.spec).toBe('chara_card_v2'); expect(saved.document.data).not.toHaveProperty('assets');
    const png = await cards.export(alice, workspace, initial.card.id, saved.id, 'png');
    expect((await cards.import(alice, workspace, png.bytes)).revision.identity).toEqual(saved.identity);
  });
});
