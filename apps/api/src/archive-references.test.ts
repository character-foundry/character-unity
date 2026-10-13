import Database from 'better-sqlite3';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '@character-unity/api';
import type { CardDocument, Revision } from '@character-unity/store';
import type { AssetBinding } from '@character-unity/cards';
import { writeCharX } from '@character-foundry/character-foundry/charx';
import type { CCv3Data } from '@character-foundry/character-foundry/schemas';
import { createCardRevision, hashBytes, readCardLineage, verifyCardLineage } from '@character-foundry/character-foundry/identity';
import { openNativeArchive } from '../../archive/src/native/store.js';
import type { NativeArchive } from '../../archive/src/native/store.js';
import { createNativeArchiveApp } from '../../archive/src/native/app.js';
import { createScheduler } from '../../archive/src/native/scheduler.js';
import { openLocalServices } from './services.js';

const actor = { id: 'alice', uri: 'urn:unity:user:alice' };
const encoder = new TextEncoder();
const portrait = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
const note = encoder.encode('Original attached notes.');
const document = (description = 'Aster keeps maps.'): CardDocument => ({ spec: 'chara_card_v3', spec_version: '3.0', data: {
  name: 'Aster', description, personality: '', scenario: '', first_mes: 'Hello.', mes_example: '', creator_notes: '',
  system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: ['Fantasy'], creator: 'ash', character_version: '1', extensions: {},
} });
const encode = (value: CardDocument) => encoder.encode(JSON.stringify(value));
interface Opened { card: { id: string; headRevisionId: string }; revision: Revision; favorite: boolean;
  reference?: { archiveId: string; cardId: string; versionId: string }; source: { assetId: string; hash: string; provenance: CardDocument } | null }
interface FileImport { card: { id: string }; import: { created: boolean; match: string | null } }

describe('Archive references through the composed native HTTP API', () => {
  let directory: string, archive: NativeArchive, services: Awaited<ReturnType<typeof openLocalServices>>, database: Database.Database;
  let api: ReturnType<typeof createApi>, scheduler: ReturnType<typeof createScheduler>, workspace: string;
  let offline: boolean, wrongArchiveId: boolean;
  let beforeObject: ((signal?: AbortSignal) => Promise<void>) | undefined;
  let archiveRequests: { path: string; headers: Headers }[];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'unity-reference-api-'));
    archive = await openNativeArchive(join(directory, 'archive'));
    scheduler = createScheduler(archive, []);
    const archiveApp = createNativeArchiveApp(archive, scheduler, []);
    offline = false; wrongArchiveId = false; beforeObject = undefined; archiveRequests = [];
    const databasePath = join(directory, 'unity.sqlite');
    services = await openLocalServices({ databasePath, blobDirectory: join(directory, 'blobs'), nativeArchive: {
      origin: 'http://archive.test', async fetch(url, init) {
        if (offline) throw new TypeError('Archive offline');
        archiveRequests.push({ path: new URL(url).pathname, headers: new Headers(init?.headers) });
        if (new URL(url).pathname.startsWith('/api/archive/v2/objects/')) await beforeObject?.(init?.signal ?? undefined);
        const response = await archiveApp.fetch(new Request(url, init));
        if (wrongArchiveId && response.headers.get('content-type')?.startsWith('application/json')) {
          return Response.json({ ...await response.json() as Record<string, unknown>, archiveId: 'different-archive' }, { status: response.status });
        }
        return response;
      },
    } });
    workspace = (await services.cards.createWorkspace(actor, 'Library')).id;
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    api = createApi({ cards: services.cards, ...(services.nativeArchive ? { nativeArchive: services.nativeArchive } : {}), authenticate: () => actor });
  });
  afterEach(async () => { database?.close(); services?.close(); await scheduler?.stop(); archive?.close(); await rm(directory, { recursive: true, force: true }); });
  const call = (path: string, init?: RequestInit) => api.request(`/api/workspaces/${workspace}${path}`, init);
  const postJson = (path: string, value: unknown, method = 'POST') => call(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  async function json<T>(response: Response, status = 200): Promise<T> {
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body as T;
  }
  const owned = () => database.prepare(`SELECT (SELECT count(*) FROM unity_cards) AS cards,
    (SELECT count(*) FROM unity_revisions) AS revisions,(SELECT count(*) FROM unity_assets) AS assets`).get();
  const referenceCount = () => (database.prepare('SELECT count(*) AS n FROM unity_archive_references').get() as { n: number }).n;
  async function blobFiles() {
    return (await readdir(join(directory, 'blobs'), { recursive: true, withFileTypes: true })).filter((item) => item.isFile())
      .map((item) => join(item.parentPath, item.name)).sort();
  }
  async function put(recordId: string, value = document(), options: { portrait?: boolean; note?: Uint8Array; bytes?: Uint8Array; mediaType?: string } = {}) {
    await archive.put({ provider: 'chub', recordId, creator: 'ash', url: `https://chub.ai/characters/ash/${recordId}`, objects: [
      { role: 'card', name: options.mediaType === 'application/zip' ? 'card.charx' : 'card.json', bytes: options.bytes ?? encode(value), mediaType: options.mediaType ?? 'application/json' },
      ...(options.portrait ? [{ role: 'portrait' as const, bytes: portrait, mediaType: 'image/png' }] : []),
      ...(options.note ? [{ role: 'asset' as const, name: 'embedded://notes.txt', bytes: options.note, mediaType: 'text/plain' }] : []),
    ] });
    return archive.card(`chub:${recordId}`);
  }
  async function add(id: string, versionId?: string, favorite = true) {
    return json<{ cardId: string; created: boolean }>(await postJson(`/archive/v2/cards/${encodeURIComponent(id)}/${favorite ? 'favorite' : 'import'}`,
      versionId ? { versionId } : {}, favorite ? 'PUT' : 'POST'), 201);
  }
  const open = async (id: string) => json<Opened>(await call(`/cards/${id}`));
  const upload = async (bytes: Uint8Array) => json<FileImport>(await call('/imports', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'card.charx' }, body: new Uint8Array(bytes) }), 201);
  function form(current: Opened, value: CardDocument, bindings: AssetBinding[], files: { bytes: Uint8Array; mediaType: string }[] = []) {
    const input = new FormData();
    input.set('input', JSON.stringify({ expectedHead: current.revision.id, document: value, bindings }));
    files.forEach((file, index) => input.set(`file:${index}`, new File([new Uint8Array(file.bytes)], `asset-${index}`, { type: file.mediaType })));
    return input;
  }

  it('favorites/imports are metadata only; opens, exports and originals retain the exact older pin', async () => {
    const firstDocument = document('The first archived version.'), first = await put('one', firstDocument);
    const added = await add(first.id, first.versionId);
    expect(added.created).toBe(true);
    expect(await add(first.id, first.versionId, false)).toEqual({ cardId: added.cardId, created: false });
    expect(owned()).toEqual({ cards: 0, revisions: 0, assets: 0 });
    expect(await blobFiles()).toEqual([]);
    expect(referenceCount()).toBe(1);
    expect((await open(added.cardId))).toMatchObject({ favorite: true, reference: { cardId: first.id, versionId: first.versionId }, revision: { document: firstDocument } });
    const page = await json<{ cards: { id: string; libraryCardId: string; libraryFavorite: boolean }[] }>(await call('/archive/v2/cards?sort=name'));
    expect(page.cards).toMatchObject([{ id: first.id, libraryCardId: added.cardId, libraryFavorite: true }]);
    const browseHeaders = archiveRequests.find((request) => request.path === '/api/archive/v2/cards')!.headers;
    expect(browseHeaders.has('x-unity-library-workspace')).toBe(false); expect(browseHeaders.has('authorization')).toBe(false);
    await put('one', document('The second archived version.'));
    const reopened = await open(added.cardId);
    expect(reopened.revision.id).toBe(first.versionId);
    expect(reopened.revision.document).toEqual(firstDocument);
    const original = await call(`/cards/${added.cardId}/original`);
    expect(original.status).toBe(200);
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(encode(firstDocument));
    expect(await json(await call(`/cards/${added.cardId}/export?revisionId=${first.versionId}&format=json`))).toEqual(firstDocument);
    expect(owned()).toEqual({ cards: 0, revisions: 0, assets: 0 });
    expect(await blobFiles()).toEqual([]);
  });

  it('uploads versions A then B from one source create distinct exact references, while repeated bytes dedupe', async () => {
    const firstDocument = document('Version A.'), first = await put('versions', firstDocument);
    const a = await upload(encode(firstDocument));
    const secondDocument = document('Version B.'), second = await put('versions', secondDocument);
    const b = await upload(encode(secondDocument));
    expect(a.import.created).toBe(false); expect(b.import.created).toBe(false);
    expect(a.card.id).not.toBe(b.card.id);
    expect((await open(a.card.id)).reference?.versionId).toBe(first.versionId);
    expect((await open(b.card.id)).reference?.versionId).toBe(second.versionId);
    expect((await upload(encode(firstDocument))).card.id).toBe(a.card.id);
    expect(referenceCount()).toBe(2);
    expect(owned()).toEqual({ cards: 0, revisions: 0, assets: 0 });
    expect(await blobFiles()).toEqual([]);
  });

  it('retains upstream identity for same-content sources and recognizes exact files before requiring missing sidecars', async () => {
    const attached = document();
    (attached.data as CardDocument).assets = [{ type: 'custom', name: 'notes', ext: 'txt', uri: 'embedded://notes.txt' }];
    const first = await put('same-a', attached, { note }), second = await put('same-b', attached, { note });
    const a = await add(first.id, first.versionId), b = await add(second.id, second.versionId);
    expect(a.cardId).not.toBe(b.cardId);
    // The uploaded JSON alone cannot be losslessly parsed: its declared bytes
    // are available only from Archive, where the exact file already exists.
    expect((await upload(encode(attached))).card.id).toBe(a.cardId);
    expect((await open(a.cardId)).reference?.cardId).toBe(first.id);
    expect((await open(b.cardId)).reference?.cardId).toBe(second.id);
    expect(owned()).toEqual({ cards: 0, revisions: 0, assets: 0 });
    expect(await blobFiles()).toEqual([]);
  });

  it('commits only a changed fork and uploaded bytes, inherits Archive locators, and survives unlinking the reference', async () => {
    const attached = document();
    (attached.data as CardDocument).assets = [{ type: 'custom', name: 'notes', ext: 'txt', uri: 'embedded://notes.txt' }];
    const original = encode(attached), source = await put('fork', attached, { portrait: true, note });
    const membership = await add(source.id, source.versionId), current = await open(membership.cardId);
    const retained: AssetBinding[] = [{ path: 'portrait', source: { kind: 'existing', path: 'portrait' } }, { path: 'declared/0', source: { kind: 'existing', path: 'declared/0' } }];
    const noChange = await json<{ cardId: string; revisionId: string }>(await call(`/cards/${membership.cardId}/fork-assets`, { method: 'POST', body: form(current, current.revision.document, retained) }), 201);
    expect(noChange).toMatchObject({ cardId: membership.cardId, revisionId: source.versionId });
    expect(owned()).toEqual({ cards: 0, revisions: 0, assets: 0 });
    const relocated = structuredClone(current.revision.document);
    (((relocated.data as CardDocument).assets as CardDocument[])[0]!).uri = 'embedded://same-bytes-relocated.txt';
    const relocatedResult = await json<{ cardId: string; revisionId: string }>(await call(`/cards/${membership.cardId}/fork-assets`, { method: 'POST', body: form(current, relocated, retained) }), 201);
    expect(relocatedResult).toMatchObject({ cardId: membership.cardId, revisionId: source.versionId });
    expect(owned()).toEqual({ cards: 0, revisions: 0, assets: 0 });
    const invalid = await call(`/cards/${membership.cardId}/fork-assets`, { method: 'POST', body: form(current, current.revision.document, [{ path: 'portrait', source: { kind: 'existing', path: 'missing' } }]) });
    expect(invalid.status).toBe(400); expect(owned()).toEqual({ cards: 0, revisions: 0, assets: 0 });

    const changed = structuredClone(current.revision.document), uploaded = encoder.encode('New fork-only attachment.');
    (changed.data as CardDocument).description = 'Changed in Unity.';
    ((changed.data as CardDocument).assets as CardDocument[]).push({ type: 'custom', name: 'new', ext: 'txt', uri: 'embedded://new.txt' });
    const result = await json<{ cardId: string; revisionId: string; revision: Revision }>(await call(`/cards/${membership.cardId}/fork-assets`, { method: 'POST',
      body: form(current, changed, [...retained, { path: 'declared/1', source: { kind: 'upload', index: 0 } }], [{ bytes: uploaded, mediaType: 'text/plain' }]) }), 201);
    expect(result.cardId).not.toBe(membership.cardId);
    expect(readCardLineage(result.revision.document)?.operation).toBe('fork');
    expect(readCardLineage(result.revision.document)?.originalHash).toBe(await hashBytes(original));
    expect(await verifyCardLineage(result.revision.document, { portraitHash: await hashBytes(portrait), assets: [
      { pointer: '/assets/0/uri', hash: await hashBytes(note) }, { pointer: '/assets/1/uri', hash: await hashBytes(uploaded) },
    ] })).toBe(true);
    const saved = await open(result.cardId);
    expect((saved.revision.document.data as CardDocument).description).toBe('Changed in Unity.');
    expect(saved.source?.provenance).toMatchObject({ kind: 'archive', cardId: source.id, versionId: source.versionId });
    const locators = database.prepare('SELECT archive_card_id AS cardId,archive_version_id AS versionId,path FROM unity_archive_assets ORDER BY path').all();
    expect(locators).toEqual(expect.arrayContaining([{ cardId: source.id, versionId: source.versionId, path: 'portrait' }, { cardId: source.id, versionId: source.versionId, path: 'declared/0' }]));
    const files = await blobFiles();
    expect(files).toHaveLength(1); expect(new Uint8Array(await readFile(files[0]!))).toEqual(uploaded);
    const family = await json<{ forks: { id: string }[]; forkTotal: number }>(await call(`/cards/${membership.cardId}/family`));
    expect(family.forks.map((item) => item.id)).toEqual([result.cardId]); expect(family.forkTotal).toBe(1);
    expect((await call(`/cards/${membership.cardId}`, { method: 'DELETE' })).status).toBe(204);
    expect(referenceCount()).toBe(0);
    expect(new Uint8Array(await (await call(`/cards/${result.cardId}/original`)).arrayBuffer())).toEqual(original);
    expect(new Uint8Array(await (await call(`/cards/${result.cardId}/asset?revisionId=${result.revisionId}&path=portrait`)).arrayBuffer())).toEqual(portrait);
    expect(new Uint8Array(await (await call(`/cards/${result.cardId}/asset?revisionId=${result.revisionId}&path=declared/0`)).arrayBuffer())).toEqual(note);
    expect((await open(result.cardId)).source?.provenance).toMatchObject({ kind: 'archive', versionId: source.versionId });
    wrongArchiveId = true;
    expect((await call(`/cards/${result.cardId}/asset?revisionId=${result.revisionId}&path=portrait`)).status).toBe(404);
    expect(await blobFiles()).toEqual(files);
  });

  it('concurrent local file imports produce one owned card, one revision and one shared original blob', async () => {
    const bytes = encode(document('Not in Archive.'));
    const results = await Promise.all(Array.from({ length: 4 }, () => upload(bytes)));
    expect(new Set(results.map((item) => item.card.id)).size).toBe(1);
    expect(results.filter((item) => item.import.created)).toHaveLength(1);
    expect(owned()).toEqual({ cards: 1, revisions: 1, assets: 1 });
    const files = await blobFiles(); expect(files).toHaveLength(1);
    expect(new Uint8Array(await readFile(files[0]!))).toEqual(bytes);
  });

  it('content dedupe verifies asset bytes, opaque modules and lineage rather than only prompt content', async () => {
    const attached = document();
    (attached.data as CardDocument).assets = [{ type: 'custom', name: 'notes', ext: 'txt', uri: 'embedded://notes.txt' }];
    await put('assets', attached, { note });
    const changedAsset = writeCharX(attached as unknown as CCv3Data, [{ type: 'custom', name: 'notes', ext: 'txt', data: encoder.encode('Different asset bytes.') }], { preserveDescriptors: true }).buffer;
    expect((await upload(changedAsset)).import.created).toBe(true);
    const sameAsset = writeCharX(attached as unknown as CCv3Data, [{ type: 'custom', name: 'notes', ext: 'txt', data: note }], { preserveDescriptors: true }).buffer;
    const matched = await upload(sameAsset);
    expect(matched.import.created).toBe(false); expect((await open(matched.card.id)).reference?.cardId).toBe('chub:assets');

    const plain = document('Opaque module fixture.'), moduleA = encoder.encode('module A'), moduleB = encoder.encode('module B');
    const firstModule = writeCharX(plain as unknown as CCv3Data, [], { moduleRisum: moduleA }).buffer;
    await put('module', plain, { bytes: firstModule, mediaType: 'application/zip' });
    const secondModule = writeCharX(plain as unknown as CCv3Data, [], { moduleRisum: moduleB }).buffer;
    expect((await upload(secondModule)).import.created).toBe(true);
    const withLineage = await createCardRevision(plain, { originalHash: await hashBytes(encode(plain)), parents: [], operation: 'edit', author: actor.uri,
      createdAt: '2026-10-13T00:00:00.000Z', nonce: 'separate-authored-history' });
    const thirdModule = writeCharX(withLineage.card as unknown as CCv3Data, [], { moduleRisum: moduleB }).buffer;
    const distinct = await upload(thirdModule);
    expect(distinct.import.created).toBe(true);
    expect((await open(distinct.card.id)).reference).toBeUndefined();
    expect(owned()).toMatchObject({ cards: 3, revisions: 3 });
  });

  it('offline or wrong-Archive-ID reads fail without retargeting the stored membership', async () => {
    const source = await put('pinned'), membership = await add(source.id, source.versionId);
    const before = database.prepare('SELECT archive_id,archive_card_id,archive_version_id FROM unity_archive_references').all();
    offline = true;
    expect((await call(`/cards/${membership.cardId}`)).status).toBe(503);
    offline = false; wrongArchiveId = true;
    const failed = await call(`/cards/${membership.cardId}`);
    expect(failed.status).toBe(404); expect(await failed.json()).toMatchObject({ error: { code: 'SOURCE_UNAVAILABLE' } });
    expect(database.prepare('SELECT archive_id,archive_card_id,archive_version_id FROM unity_archive_references').all()).toEqual(before);
    expect(owned()).toEqual({ cards: 0, revisions: 0, assets: 0 }); expect(await blobFiles()).toEqual([]);
  });

  it('an incomplete identity miss refuses a potentially duplicate import and writes no library state', async () => {
    const missing = document('An unresolved archived asset.');
    (missing.data as CardDocument).assets = [{ type: 'custom', name: 'missing', ext: 'txt', uri: 'embedded://missing.txt' }];
    await put('incomplete', missing);
    const response = await call('/imports', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(encode(document('Different unresolved candidate.'))) });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: 'ARCHIVE_IDENTITY_INCOMPLETE' } });
    expect(referenceCount()).toBe(0); expect(owned()).toEqual({ cards: 0, revisions: 0, assets: 0 }); expect(await blobFiles()).toEqual([]);
  });

  it('downloads exact pinned original bytes even when a missing sidecar prevents opening the editor', async () => {
    const missing = document('The accepted original has an unavailable attachment.');
    (missing.data as CardDocument).assets = [{ type: 'custom', name: 'missing', ext: 'txt', uri: 'embedded://missing.txt' }];
    const bytes = encode(missing), source = await put('raw-original', missing), membership = await add(source.id, source.versionId);
    const failedOpen = await call(`/cards/${membership.cardId}`);
    expect(failedOpen.status).toBe(400);
    expect(await failedOpen.json()).toMatchObject({ error: { code: 'ASSET_UNAVAILABLE' } });
    await put('raw-original', document('The upstream now has a different, healthy version.'));
    const original = await call(`/cards/${membership.cardId}/original`);
    expect(original.status).toBe(200); expect(original.headers.get('etag')).toBe(`"${await hashBytes(bytes)}"`);
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(bytes);
    expect(owned()).toEqual({ cards: 0, revisions: 0, assets: 0 }); expect(referenceCount()).toBe(1); expect(await blobFiles()).toEqual([]);
  });

  it('reads only a requested JSON sidecar object, without fetching the container or unrelated attachments', async () => {
    const attached = document();
    (attached.data as CardDocument).assets = [{ type: 'custom', name: 'notes', ext: 'txt', uri: 'embedded://notes.txt' }];
    const source = await put('sidecar', attached, { portrait: true, note }), membership = await add(source.id, source.versionId);
    archiveRequests = [];
    const image = await call(`/cards/${membership.cardId}/asset?revisionId=${source.versionId}&path=portrait`);
    expect(image.status).toBe(200); expect(new Uint8Array(await image.arrayBuffer())).toEqual(portrait);
    expect(archiveRequests.filter((item) => item.path.includes('/objects/')).map((item) => item.path)).toEqual([`/api/archive/v2/objects/${await hashBytes(portrait)}`]);
    archiveRequests = [];
    const attachment = await call(`/cards/${membership.cardId}/asset?revisionId=${source.versionId}&path=declared/0`);
    expect(attachment.status).toBe(200); expect(new Uint8Array(await attachment.arrayBuffer())).toEqual(note);
    expect(archiveRequests.filter((item) => item.path.includes('/objects/')).map((item) => item.path)).toEqual([`/api/archive/v2/objects/${await hashBytes(note)}`]);
    expect(owned()).toEqual({ cards: 0, revisions: 0, assets: 0 }); expect(await blobFiles()).toEqual([]);
  });

  it.each(['open', 'revision', 'assets', 'asset', 'original'] as const)('cancels the upstream %s read when its HTTP request is aborted without writing index work', async (route) => {
    const source = await put('cancel-read', document(), { portrait: true }), membership = await add(source.id, source.versionId);
    const suffix = { open: '', revision: `/revisions/${source.versionId}`, assets: `/assets?revisionId=${source.versionId}`,
      asset: `/asset?revisionId=${source.versionId}&path=portrait`, original: '/original' }[route];
    let entered!: () => void, observed: AbortSignal | undefined;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    beforeObject = async (signal) => {
      observed = signal; entered();
      await new Promise<void>((_resolve, reject) => {
        if (!signal) { reject(new Error('Upstream read has no cancellation signal')); return; }
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
      });
    };
    const cancellation = new AbortController(), reading = call(`/cards/${membership.cardId}${suffix}`, { signal: cancellation.signal });
    await reached; cancellation.abort();
    expect((await reading).ok).toBe(false); expect(observed?.aborted).toBe(true);
    expect(owned()).toEqual({ cards: 0, revisions: 0, assets: 0 }); expect(await blobFiles()).toEqual([]);
    expect(database.prepare('SELECT * FROM unity_search_outbox').all()).toEqual([]);
  });

  it.each(['asset', 'original', 'export'] as const)('cancels an owned Archive fork %s read through the external-asset composition', async (route) => {
    const source = await put('cancel-fork', document(), { portrait: true }), membership = await add(source.id, source.versionId), current = await open(membership.cardId);
    const changed = structuredClone(current.revision.document); (changed.data as CardDocument).description = 'Owned fork, inherited bytes.';
    const fork = await services.cards.fork(actor, workspace, membership.cardId, { expectedHead: current.revision.id, document: changed });
    const before = database.prepare('SELECT * FROM unity_search_outbox').all();
    const suffix = { asset: `/asset?revisionId=${fork.revision.id}&path=portrait`, original: '/original', export: `/export?revisionId=${fork.revision.id}&format=png` }[route];
    let entered!: () => void, observed: AbortSignal | undefined;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    beforeObject = async (signal) => {
      observed = signal; entered();
      await new Promise<void>((_resolve, reject) => {
        if (!signal) { reject(new Error('External read has no cancellation signal')); return; }
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
      });
    };
    const cancellation = new AbortController(), reading = call(`/cards/${fork.card.id}${suffix}`, { signal: cancellation.signal });
    await reached; cancellation.abort();
    expect((await reading).ok).toBe(false); expect(observed?.aborted).toBe(true);
    expect(database.prepare('SELECT * FROM unity_search_outbox').all()).toEqual(before); expect(await blobFiles()).toEqual([]);
  });

  it('saves an explicit format conversion as a fork even when Foundry content identity is unchanged', async () => {
    const v2 = { ...document(), spec: 'chara_card_v2', spec_version: '2.0' }, source = await put('convert', v2);
    const membership = await add(source.id, source.versionId), current = await open(membership.cardId);
    const converted = { ...current.revision.document, spec: 'chara_card_v3', spec_version: '3.0' };
    const saved = await json<{ cardId: string; revision: Revision }>(await call(`/cards/${membership.cardId}/fork-assets`, { method: 'POST', body: form(current, converted, []) }), 201);
    expect(saved.cardId).not.toBe(membership.cardId);
    expect(saved.revision.document).toMatchObject({ spec: 'chara_card_v3', spec_version: '3.0' });
    expect(saved.revision.identity).toEqual(current.revision.identity);
    expect((await open(membership.cardId)).revision.document.spec).toBe('chara_card_v2');
  });

  it('keeps an authored opaque-field change in a new fork instead of discarding it as an unchanged reference', async () => {
    const source = await put('opaque'), membership = await add(source.id, source.versionId), current = await open(membership.cardId);
    const changed = { ...current.revision.document, vendor_metadata: { nested: ['exact', null, { retain: true }] } };
    const saved = await json<{ cardId: string; revision: Revision }>(await call(`/cards/${membership.cardId}/fork-assets`, { method: 'POST', body: form(current, changed, []) }), 201);
    expect(saved.cardId).not.toBe(membership.cardId);
    expect(saved.revision.document.vendor_metadata).toEqual(changed.vendor_metadata);
    expect((await open(membership.cardId)).revision.document.vendor_metadata).toBeUndefined();
    expect(await blobFiles()).toEqual([]);
  });

  it('references and their exact asset routes stay workspace-scoped and require ownership', async () => {
    const source = await put('scoped', document(), { portrait: true }), membership = await add(source.id, source.versionId);
    const another = await services.cards.createWorkspace(actor, 'Another library');
    const foreign = await services.cards.createWorkspace({ id: 'bob', uri: 'urn:unity:user:bob' }, 'Bob library');
    for (const suffix of ['', '/original', `/asset?revisionId=${source.versionId}&path=portrait`, `/export?revisionId=${source.versionId}&format=png`]) {
      expect((await api.request(`/api/workspaces/${another.id}/cards/${membership.cardId}${suffix}`)).status).toBe(404);
      expect((await api.request(`/api/workspaces/${foreign.id}/cards/${membership.cardId}${suffix}`)).status).toBe(403);
    }
    const denied = createApi({ cards: services.cards, authenticate: () => null });
    expect((await denied.request(`/api/workspaces/${workspace}/cards/${membership.cardId}`)).status).toBe(401);
    expect(owned()).toEqual({ cards: 0, revisions: 0, assets: 0 }); expect(referenceCount()).toBe(1); expect(await blobFiles()).toEqual([]);
  });

  it.each(['logout', 'disable'] as const)('rejects an owned Archive fork original when %s revokes its session during the external read', async (revocation) => {
    const created = await services.accounts.create('Owner'), session = await services.accounts.login(created.key);
    expect(session).not.toBeNull();
    if (!session) throw new Error('Fixture login failed');
    const owner = { id: created.account.id, uri: created.account.uri }, scoped = services.forSession(session.proof);
    const library = await scoped.cards.createWorkspace(owner, 'Account library'), source = await put('session-original');
    const reference = await scoped.cards.addArchiveReference(owner, library.id, source.id, source.versionId);
    const current = await scoped.cards.open(owner, library.id, reference.id), changed = structuredClone(current.revision.document);
    (changed.data as CardDocument).description = 'Saved account fork.';
    const fork = await scoped.cards.fork(owner, library.id, reference.id, { expectedHead: current.revision.id, document: changed });
    const accountApi = createApi({ cards: scoped.cards, authenticate: () => owner });
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
    beforeObject = async () => { entered(); await held; };
    const reading = accountApi.request(`/api/workspaces/${library.id}/cards/${fork.card.id}/original`);
    await reached;
    try {
      if (revocation === 'logout') await services.accounts.logout(session.token);
      else await services.accounts.setEnabled(owner.id, false);
    } finally { release(); }
    const response = await reading;
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect(await blobFiles()).toEqual([]);
  });
});
