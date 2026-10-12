import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { openNodeStore } from '@character-unity/store/node';
import { createNodeBlobStore } from '@character-unity/blob-store/node';
import { createAssetService } from '@character-unity/assets';
import { createCardService } from '../src/index.js';
import { openBrowserStorage } from '@character-unity/browser-storage';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { BlobStore } from '@character-unity/blob-store';
import type { CardDocument, UnityStore } from '@character-unity/store';
import { hashBytes, readCardLineage, verifyCardLineage } from '@character-foundry/character-foundry/identity';
import { embedIntoPNG, injectTextChunk } from '@character-foundry/character-foundry/png';
import { writeCharX } from '@character-foundry/character-foundry/charx';
import type { CCv3Data } from '@character-foundry/character-foundry/schemas';

const alice = { id: 'alice', uri: 'urn:unity:user:alice' };
const bob = { id: 'bob', uri: 'urn:unity:user:bob' };
const encoder = new TextEncoder();
function document(): CardDocument {
  return { spec: 'chara_card_v3', spec_version: '3.0', opaque_envelope: { value: 7 }, data: {
    name: 'Aster', description: 'A map keeper.', personality: '', scenario: '', first_mes: 'Hello.', mes_example: '',
    tags: ['forest'], creator: 'Fixture', character_version: '1', group_only_greetings: [],
    unknown_inner: [null, true], extensions: { foreign: { note: 'keep' } },
  } };
}
const encoded = () => encoder.encode(JSON.stringify(document(), null, 2) + '\n');
async function receive(value: { body: ReadableStream<Uint8Array> }) { return new Uint8Array(await new Response(value.body).arrayBuffer()); }

for (const adapter of ['native', 'indexeddb']) describe(`card service with Foundry and ${adapter} storage`, () => {
  let directory: string | undefined;
  let database: { store: UnityStore; close(): void }; 
  let service: ReturnType<typeof createCardService>;
  let workspaceId: string;
  let assetService: ReturnType<typeof createAssetService>;
  beforeEach(async () => {
    let blobs: BlobStore;
    if (adapter === 'native') {
      directory = await mkdtemp(join(tmpdir(), 'unity-cards-'));
      database = await openNodeStore(':memory:');
      blobs = await createNodeBlobStore(directory);
    } else {
      vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange);
      const browser = await openBrowserStorage();
      database = browser; blobs = browser.blobs;
    }
    assetService = createAssetService(database.store, blobs);
    service = createCardService(database.store, assetService);
    workspaceId = (await service.createWorkspace(alice, 'Desk')).id;
  });
  afterEach(async () => { database?.close(); if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; vi.unstubAllGlobals(); });

  it('reads scoped immutable history with a stable pagination boundary while new revisions are saved', async () => {
    const bytes = encoded();
    const original = await service.import(alice, workspaceId, bytes);
    const changed = structuredClone(original.revision.document); (changed.data as CardDocument).description = 'Second revision';
    const second = await service.save(alice, workspaceId, original.card.id, original.revision.id, changed);
    const first = await service.history(alice, workspaceId, original.card.id, { limit: 1 });
    expect(first).toEqual({ headRevisionId: second.id, throughSequence: 2, nextAfter: 1, revisions: [{
      id: original.revision.id, sequence: 1, authorId: alice.id, createdAt: original.revision.createdAt,
    }] });
    const nextDocument = structuredClone(second.document); (nextDocument.data as CardDocument).description = 'Third revision';
    const third = await service.save(alice, workspaceId, original.card.id, second.id, nextDocument);
    const last = await service.history(alice, workspaceId, original.card.id, { limit: 1, afterSequence: first.nextAfter!, throughSequence: first.throughSequence });
    expect(last.revisions.map((revision) => revision.id)).toEqual([second.id]);
    expect(last.nextAfter).toBeNull(); expect(last.headRevisionId).toBe(third.id);
    expect((await service.history(alice, workspaceId, original.card.id)).revisions.map((revision) => revision.sequence)).toEqual([1, 2, 3]);
    const read = await service.revision(alice, workspaceId, original.card.id, original.revision.id);
    expect(read).toEqual(original.revision);
    (read.document.data as CardDocument).description = 'Caller changed its copy';
    expect(await service.revision(alice, workspaceId, original.card.id, original.revision.id)).toEqual(original.revision);
    const other = await service.import(alice, workspaceId, bytes);
    await expect(service.revision(alice, workspaceId, other.card.id, second.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.history(bob, workspaceId, original.card.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.revision(bob, workspaceId, original.card.id, second.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const options of [{ limit: 21 }, { limit: 0 }, { afterSequence: -1 }, { throughSequence: 4 }, { afterSequence: 3, throughSequence: 2 }, { afterSequence: NaN }]) {
      await expect(service.history(alice, workspaceId, original.card.id, options)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect((await service.open(alice, workspaceId, original.card.id)).revision).toEqual(third);
    expect(await receive(await service.original(alice, workspaceId, original.card.id))).toEqual(bytes);
  });

  it('imports exact original bytes and opaque fields without inventing lineage', async () => {
    const input = encoded();
    const expected = new Uint8Array(input);
    const provenance = { kind: 'archive', archiveId: 'fixture', snapshot: 'a'.repeat(64), cardId: 'aster' };
    const pending = service.import(alice, workspaceId, input, provenance);
    input.fill(0); provenance.cardId = 'changed';
    const result = await pending;
    expect(result.revision.identity.algorithm).toBe('foundry-card-v1-sha256');
    expect(result.revision.document).toEqual(document());
    expect(readCardLineage(result.revision.document)).toBeNull();
    expect(result.card.originalHash).toBe(await hashBytes(expected));
    expect(await receive(await service.original(alice, workspaceId, result.card.id))).toEqual(expected);
    expect((await service.open(alice, workspaceId, result.card.id)).source?.provenance.cardId).toBe('aster');
    const noChange = await service.save(alice, workspaceId, result.card.id, result.revision.id, result.revision.document);
    expect(noChange.id).toBe(result.revision.id);
    expect(await database.store.listRevisions(workspaceId, result.card.id)).toHaveLength(1);
  });

  it('saves a real edit with SDK lineage while retaining unknown fields and immutable original bytes', async () => {
    const bytes = encoded();
    const imported = await service.import(alice, workspaceId, bytes);
    const draft = structuredClone(imported.revision.document);
    (draft.data as CardDocument).description = 'A new story.';
    const saved = await service.save(alice, workspaceId, imported.card.id, imported.revision.id, draft);
    expect(saved.sequence).toBe(2);
    expect(saved.parentRevisionId).toBe(imported.revision.id);
    expect(saved.identity).not.toEqual(imported.revision.identity);
    expect(await verifyCardLineage(saved.document)).toBe(true);
    expect(readCardLineage(saved.document)?.originalHash).toBe(await hashBytes(bytes));
    expect((saved.document.data as CardDocument).unknown_inner).toEqual([null, true]);
    expect(saved.document.opaque_envelope).toEqual({ value: 7 });
    expect(await receive(await service.original(alice, workspaceId, imported.card.id))).toEqual(bytes);
    const second = structuredClone(saved.document); (second.data as CardDocument).scenario = 'A forest';
    const next = await service.save(alice, workspaceId, imported.card.id, saved.id, second);
    expect(readCardLineage(next.document)?.parents[0]?.revisionHash).toBe(readCardLineage(saved.document)?.revisionHash);
    await expect(service.save(alice, workspaceId, imported.card.id, imported.revision.id, draft)).rejects.toMatchObject({ code: 'HEAD_CONFLICT' });
  });

  it('rejects concurrent stale saves without partial revisions', async () => {
    const imported = await service.import(alice, workspaceId, encoded());
    const drafts = ['First', 'Second'].map((name) => { const value = structuredClone(imported.revision.document); (value.data as CardDocument).name = name; return value; });
    const results = await Promise.allSettled(drafts.map((draft) => service.save(alice, workspaceId, imported.card.id, imported.revision.id, draft)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({ code: 'HEAD_CONFLICT' });
    expect(await database.store.listRevisions(workspaceId, imported.card.id)).toHaveLength(2);
  });

  it('authorizes every workspace operation before accessing original bytes or mutating cards', async () => {
    const imported = await service.import(alice, workspaceId, encoded());
    for (const operation of [
      () => service.export(bob, workspaceId, imported.card.id, imported.revision.id, 'json'),
      () => service.list(bob, workspaceId), () => service.open(bob, workspaceId, imported.card.id),
      () => service.import(bob, workspaceId, encoded()), () => service.original(bob, workspaceId, imported.card.id),
      () => service.save(bob, workspaceId, imported.card.id, imported.revision.id, imported.revision.document),
    ]) await expect(operation()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await service.list(alice, workspaceId)).toHaveLength(1);
  });

  it('imports actual PNG/CharX containers with digest-bound assets and preserves them through saves', async () => {
    const image = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
    const input = document();
    (input.data as CardDocument).assets = [{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' }];
    const card = input as unknown as CCv3Data;
    const png = embedIntoPNG(image, card, { key: 'ccv3' });
    const charx = writeCharX(card, [{ type: 'icon', name: 'main', ext: 'png', data: image }]).buffer;
    const identities = [];
    for (const bytes of [png, charx]) {
      const imported = await service.import(alice, workspaceId, bytes);
      identities.push(imported.revision.identity);
      expect(imported.revision.assets.map((asset) => asset.path)).toEqual(['declared/0', 'portrait']);
      expect(await receive(await service.original(alice, workspaceId, imported.card.id))).toEqual(bytes);
      const draft = structuredClone(imported.revision.document); (draft.data as CardDocument).description = 'Edited';
      const saved = await service.save(alice, workspaceId, imported.card.id, imported.revision.id, draft);
      expect(saved.assets).toEqual(imported.revision.assets);
      expect(await verifyCardLineage(saved.document, { assets: [{ pointer: '/assets/0/uri', hash: await hashBytes(image) }], portraitHash: await hashBytes(image) })).toBe(true);
    }
    expect(identities[0]).toEqual(identities[1]);
  });

  it('exports a pinned saved revision, omits local metadata and never changes history or originals', async () => {
    const input = document();
    ((input.data as CardDocument).extensions as CardDocument).foundry = { local: { secret: 'private' } };
    const original = encoder.encode(JSON.stringify(input));
    const imported = await service.import(alice, workspaceId, original);
    const draft = structuredClone(imported.revision.document); (draft.data as CardDocument).description = 'Export this edit';
    const saved = await service.save(alice, workspaceId, imported.card.id, imported.revision.id, draft);
    const old = await service.export(alice, workspaceId, imported.card.id, imported.revision.id, 'json');
    const oldCard = JSON.parse(new TextDecoder().decode(old.bytes));
    expect(readCardLineage(oldCard)).toBeNull();
    expect(oldCard.data.description).toBe('A map keeper.');
    expect(oldCard.data.extensions.foundry?.local).toBeUndefined();
    const output = await service.export(alice, workspaceId, imported.card.id, saved.id, 'json');
    const importedAgain = await service.import(alice, workspaceId, output.bytes);
    expect(importedAgain.revision.identity).toEqual(saved.identity);
    expect(readCardLineage(importedAgain.revision.document)).toEqual(readCardLineage(saved.document));
    expect(importedAgain.card.originalHash).toEqual(imported.card.originalHash);
    await expect(service.export(alice, workspaceId, importedAgain.card.id, saved.id, 'json')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.export(alice, workspaceId, imported.card.id, saved.id, 'png')).rejects.toMatchObject({ code: 'EXPORT_LOSS' });
    const abort = new AbortController(); abort.abort();
    await expect(service.export(alice, workspaceId, imported.card.id, saved.id, 'json', abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await database.store.listRevisions(workspaceId, imported.card.id)).toHaveLength(2);
    expect(await receive(await service.original(alice, workspaceId, imported.card.id))).toEqual(original);
  });

  it('exports verified PNG and CharX assets with opaque descriptors, rejecting missing JSON bytes', async () => {
    const image = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
    for (const opaque of [false, true]) {
      const input = document();
      (input.data as CardDocument).assets = [{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png', ...(opaque ? { custom: { license: 'keep me' } } : {}) }];
      const original = embedIntoPNG(image, input as unknown as CCv3Data, { key: 'ccv3' });
      const imported = await service.import(alice, workspaceId, original);
      const draft = structuredClone(imported.revision.document); (draft.data as CardDocument).description = 'Container edit';
      const saved = await service.save(alice, workspaceId, imported.card.id, imported.revision.id, draft);
      await expect(service.export(alice, workspaceId, imported.card.id, saved.id, 'json')).rejects.toMatchObject({ code: 'EXPORT_LOSS' });
      for (const format of ['png', 'charx'] as const) {
        const exported = await service.export(alice, workspaceId, imported.card.id, saved.id, format);
        const reopened = await service.import(alice, workspaceId, exported.bytes);
        expect(reopened.revision.identity).toEqual(saved.identity);
        expect(readCardLineage(reopened.revision.document)).toEqual(readCardLineage(saved.document));
        expect(reopened.revision.assets.map((asset) => asset.path)).toEqual(['declared/0', 'portrait']);
        if (opaque) expect((reopened.revision.document.data as CardDocument).assets).toMatchObject([{ custom: { license: 'keep me' } }]);
      }
      expect(await database.store.listRevisions(workspaceId, imported.card.id)).toHaveLength(2);
      expect(await receive(await service.original(alice, workspaceId, imported.card.id))).toEqual(original);
    }
  });

  it('keeps distinct asset bytes and authored metadata when CharX filenames collide after sanitization', async () => {
    const image = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
    const input = document();
    (input.data as CardDocument).assets = [
      { type: 'icon', name: 'Main.Art', ext: 'PNG', uri: 'ccdefault:', license: { preserve: true } },
      { type: 'custom', name: 'data.file', ext: 'txt', uri: 'pngchunk:1', vendor: [1, null] },
      { type: 'custom', name: 'data_file', ext: 'txt', uri: 'pngchunk:2', vendor: [2, false] },
    ];
    let source = embedIntoPNG(image, input as unknown as CCv3Data, { key: 'ccv3' });
    source = injectTextChunk(source, 'chara-ext-asset_:1', Buffer.from('first distinct asset').toString('base64'));
    source = injectTextChunk(source, 'chara-ext-asset_:2', Buffer.from('second distinct asset').toString('base64'));
    const imported = await service.import(alice, workspaceId, source);
    const draft = structuredClone(imported.revision.document); (draft.data as CardDocument).description = 'Before CharX transport';
    const saved = await service.save(alice, workspaceId, imported.card.id, imported.revision.id, draft);
    const exported = await service.export(alice, workspaceId, imported.card.id, saved.id, 'charx');
    const restored = await service.import(alice, workspaceId, exported.bytes);
    expect(restored.revision.identity).toEqual(saved.identity);
    expect(readCardLineage(restored.revision.document)).toEqual(readCardLineage(saved.document));
    const descriptors = (restored.revision.document.data as CardDocument).assets as CardDocument[];
    expect(descriptors).toMatchObject([{ name: 'Main.Art', ext: 'PNG', license: { preserve: true } }, { name: 'data.file', vendor: [1, null] }, { name: 'data_file', vendor: [2, false] }]);
    expect(new Set(descriptors.map((entry) => entry.uri)).size).toBe(3);
    for (const [index, text] of [[1, 'first distinct asset'], [2, 'second distinct asset']] as const) {
      const asset = restored.revision.assets.find((entry) => entry.path === `declared/${index}`)!;
      expect(new TextDecoder().decode(await receive(await assetService.download(workspaceId, asset.assetId)))).toBe(text);
    }
    expect(await receive(await service.original(alice, workspaceId, imported.card.id))).toEqual(source);
  });

  it('restores marked SillyTavern transport without adding lineage and rejects external edits before writes', async () => {
    const imported = await service.import(alice, workspaceId, encoded());
    const draft = structuredClone(imported.revision.document); (draft.data as CardDocument).description = 'Before external transport';
    const saved = await service.save(alice, workspaceId, imported.card.id, imported.revision.id, draft);
    const exported = await service.export(alice, workspaceId, imported.card.id, saved.id, 'sillytavern-json');
    expect(exported.filename).toBe('character.json');
    const returned = JSON.parse(new TextDecoder().decode(exported.bytes));
    returned.name = returned.data.name; returned.description = returned.data.description;
    returned.fav = false; returned.data.extensions.fav = false; returned.create_date = '2026-10-11T01:02:03.000Z';
    const bytes = encoder.encode(JSON.stringify(returned));
    const restored = await service.import(alice, workspaceId, bytes);
    expect(restored.revision.identity).toEqual(saved.identity);
    expect(readCardLineage(restored.revision.document)).toEqual(readCardLineage(saved.document));
    expect(restored.revision.document.name).toBeUndefined();
    expect((restored.revision.document.data as CardDocument).extensions).not.toHaveProperty('foundry.local');
    expect(await receive(await service.original(alice, workspaceId, restored.card.id))).toEqual(bytes);
    returned.description = returned.data.description = 'External edit';
    await expect(service.import(alice, workspaceId, encoder.encode(JSON.stringify(returned)))).rejects.toMatchObject({ code: 'LOSSY_FORMAT' });
    expect(await service.list(alice, workspaceId)).toHaveLength(2);
    expect(await database.store.listRevisions(workspaceId, imported.card.id)).toHaveLength(2);
  });

  it('rejects corrupted asset bytes before returning an export', async () => {
    const image = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
    const imported = await service.import(alice, workspaceId, embedIntoPNG(image, document() as unknown as CCv3Data));
    const damaged = createCardService(database.store, { ...assetService, async download(workspace, id) {
      const object = await assetService.download(workspace, id);
      const bytes = await receive(object); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      return { ...object, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
    } });
    await expect(damaged.export(alice, workspaceId, imported.card.id, imported.revision.id, 'png')).rejects.toMatchObject({ code: 'INTEGRITY' });
    expect(await database.store.listRevisions(workspaceId, imported.card.id)).toHaveLength(1);
  });

  it('rejects missing remote assets and lineage replacement without creating cards or extra revisions', async () => {
    const unresolved = document();
    (unresolved.data as CardDocument).assets = [{ type: 'icon', uri: 'https://example.test/not-fetched.png', name: 'main', ext: 'png' }];
    await expect(service.import(alice, workspaceId, encoder.encode(JSON.stringify(unresolved)))).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE' });
    expect(await service.list(alice, workspaceId)).toEqual([]);
    const imported = await service.import(alice, workspaceId, encoded());
    const changed = structuredClone(imported.revision.document); (changed.data as CardDocument).description = 'Edit';
    const saved = await service.save(alice, workspaceId, imported.card.id, imported.revision.id, changed);
    const forged = structuredClone(saved.document);
    ((forged.data as CardDocument).extensions as CardDocument).foundry = {};
    await expect(service.save(alice, workspaceId, imported.card.id, saved.id, forged)).rejects.toMatchObject({ code: 'INVALID_LINEAGE' });
    expect(await database.store.listRevisions(workspaceId, imported.card.id)).toHaveLength(2);
  });
});
