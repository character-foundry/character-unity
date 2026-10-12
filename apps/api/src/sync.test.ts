import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response as MiniflareResponse, convertV4MiniflareOptions } from 'miniflare';
import type { V4FetchHandler } from 'miniflare';
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createCardRevision, readCardLineage, hashBytes } from '@character-foundry/character-foundry/identity';
import type { SyncReadPublication } from '@character-foundry/character-foundry/sync';
import { encodeSyncForkSubmission, SYNC_FORK_VERSION, SYNC_FORK_MAX_BYTES, createSyncCommandClient, SYNC_COMMAND_VERSION, encodeSyncCommand, createSyncReadClient, signSyncHttp, createSyncToken } from '@character-foundry/character-foundry/sync';
import { createRemoteCardService } from '@character-unity/cards/remote';
import type { ConfiguredRemote } from '@character-unity/cards/connections';
import type { Revision } from '@character-unity/store';
import { createStore } from '@character-unity/store';
import { createAccountApi } from '@character-unity/api/sessions';
import { createSyncApi, createSyncReadApi } from '@character-unity/api/sync';
import { createD1Driver } from '@character-unity/store/d1';
import { migrate } from '@character-unity/store/migrations';
import { createAccountStore } from '@character-unity/store/accounts';
import type { AccountStore } from '@character-unity/store/accounts';
import { createSyncStore } from '@character-unity/store/sync';
import type { SyncStore } from '@character-unity/store/sync';
import { openLocalServices } from './services.js';

const origin = 'https://sync.unity.invalid', actor = 'https://peer.invalid/actors/reader', keyId = `${actor}#one`;
const baseUrl = `${origin}/api/sync/v1`;
let script: string;
beforeAll(async () => {
  script = (await build({ entryPoints: [fileURLToPath(new URL('./worker.ts', import.meta.url))], bundle: true,
    platform: 'browser', conditions: ['workerd', 'browser'], target: 'es2022', format: 'esm', external: ['node:*'], write: false })).outputFiles[0]!.text;
});

for (const adapter of ['sqlite', 'worker']) describe(`signed publication sync / ${adapter}`, () => {
  let root: string, close: () => void | Promise<void>, dispatch: (request: Request) => Promise<Response>;
  let accounts: AccountStore, sync: SyncStore, key: CryptoKeyPair;
  let alice: string, bob: string, bobId: string, workspaceId: string, peerWorkspaceId: string;
  let client: ReturnType<typeof createSyncReadClient>;
  let enabled: boolean, writes: boolean, admitted: boolean;
  let commands: ReturnType<typeof createSyncCommandClient>;
  let afterRead: (() => Promise<void>) | undefined, beforeWrite: (() => Promise<void>) | undefined;
  const browser = (path: string, cookie = '', method = 'GET', body?: unknown) => dispatch(new Request(`${origin}/api/${path}`, {
    method, headers: { cookie, origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  async function json<T>(response: Response, status = 200): Promise<T> {
    expect(response.status, await response.clone().text()).toBe(status); return response.json() as Promise<T>;
  }
  async function signed(path: string) {
    const message = await signSyncHttp({ actor, keyId, privateKey: key.privateKey, requestId: createSyncToken(),
      method: 'GET', url: `${baseUrl}${path}`, contentType: 'application/json', body: new Uint8Array() });
    return new Request(message.url, { method: 'GET', headers: message.headers });
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'unity-sync-read-')); enabled = true; writes = true; admitted = true; afterRead = undefined; beforeWrite = undefined;
    if (adapter === 'sqlite') {
      const services = await openLocalServices({ databasePath: join(root, 'db.sqlite'), blobDirectory: join(root, 'blobs') });
      close = () => { services.close(); }; accounts = services.accounts; sync = services.sync;
      const readApi = createSyncApi({ origin, sync, writes: true, admit: async () => admitted, hub: { ...services.hub,
        async submitFork(...args) { await beforeWrite?.(); return services.hub.submitFork(...args); },
        async fork(...args) { await beforeWrite?.(); return services.hub.fork(...args); },
        async publish(...args) { await beforeWrite?.(); return services.hub.publish(...args); },
        async get(...args) { const value = await services.hub.get(...args); await afterRead?.(); return value; },
      } });
      const app = createAccountApi({ origin, ...services, sync: readApi });
      const disabled = createAccountApi({ origin, accounts, store: services.store, forSession: services.forSession });
      const readOnly = createAccountApi({ origin, ...services, sync: createSyncReadApi({ origin, sync, hub: services.hub }) });
      dispatch = async (request) => (enabled ? writes ? app : readOnly : disabled).fetch(request);
    } else {
      const mf = new Miniflare(convertV4MiniflareOptions({ port: 0, modules: true, script,
        compatibilityDate: '2026-10-11', compatibilityFlags: ['nodejs_compat'],
        bindings: { UNITY_PUBLIC_ORIGIN: origin, UNITY_SYNC_ENABLED: 'true', UNITY_SYNC_WRITES_ENABLED: 'true' }, d1Databases: { UNITY_DB: 'sync-read' },
        r2Buckets: { UNITY_BLOBS: 'sync-read' }, resourcePersistencePath: root,
        ratelimits: { UNITY_LOGIN_LIMITER: { namespace_id: '1001', simple: { limit: 60, period: 60 } },
          UNITY_SYNC_LIMITER: { namespace_id: '1002', simple: { limit: 120, period: 60 } } },
      }));
      close = () => mf.dispose();
      const driver = createD1Driver(await mf.getD1Database('UNITY_DB')); await migrate(driver);
      accounts = createAccountStore(driver); sync = createSyncStore(driver);
      dispatch = async (request) => {
        const result = await mf.dispatchFetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers),
          ...(request.body ? { body: await request.arrayBuffer() } : {}) });
        return new Response(await result.arrayBuffer(), { status: result.status, headers: Object.fromEntries(result.headers) });
      };
    }
    const a = await accounts.create('Publisher'), b = await accounts.create('Reader'); bobId = b.account.id;
    async function login(secret: string) {
      const response = await browser('session', '', 'POST', { key: secret }); expect(response.status).toBe(200);
      return response.headers.get('set-cookie')!.split(';')[0]!;
    }
    alice = await login(a.key); bob = await login(b.key);
    workspaceId = (await json<{ id: string }>(await browser('workspaces', alice, 'POST', { name: 'Publisher desk' }), 201)).id;
    peerWorkspaceId = (await json<{ id: string }>(await browser('workspaces', bob, 'POST', { name: 'Reader desk' }), 201)).id;
    await sync.grant({ actor, accountId: bobId, workspaceId: peerWorkspaceId, scopes: ['pull'] });
    key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']); await sync.addKey(actor, keyId, key.publicKey);
    commands = createSyncCommandClient({ baseUrl, actor, keyId, privateKey: key.privateKey,
      fetch: async (input, init) => dispatch(new Request(input, init)) });
    client = createSyncReadClient({ baseUrl, actor, keyId, privateKey: key.privateKey,
      fetch: async (input, init) => dispatch(new Request(input, init)) });
  });
  afterEach(async () => { await close?.(); if (root) await rm(root, { recursive: true, force: true }); });

  async function publish(visibility: 'public' | 'private' | 'members' = 'public', attachment = false) {
    const document = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Signed Aster', description: 'Verified', extensions: { opaque: [0, false] } } };
    const imported = await json<{ card: { id: string }; revision: { id: string } }>(await browser(`workspaces/${workspaceId}/imports`, alice, 'POST', document), 201);
    let revisionId = imported.revision.id;
    const bytes = 'Signed publication attachment\n';
    if (attachment) {
      const data = { ...document.data, assets: [{ type: 'custom', name: 'Notes', ext: 'txt', uri: 'embedded://notes.txt' }] };
      const form = new FormData(); form.set('input', JSON.stringify({ expectedHead: revisionId, document: { ...document, data },
        bindings: [{ path: 'declared/0', source: { kind: 'upload', index: 0 } }] }));
      form.set('file:0', new Blob([bytes], { type: 'text/plain' }), 'notes.txt');
      const saved = await json<{ id: string }>(await dispatch(new Request(`${origin}/api/workspaces/${workspaceId}/cards/${imported.card.id}/asset-revisions`, {
        method: 'POST', headers: { origin, cookie: alice }, body: form,
      })));
      revisionId = saved.id;
    }
    const published = await json<{ publications: { id: string }[] }>(await browser('hub/publications', alice, 'POST', {
      workspaceId, revisionIds: [revisionId], policy: { visibility, allowOriginal: false, allowFork: true },
    }), 201);
    return { id: published.publications[0]!.id, cardId: imported.card.id, revisionId, document, bytes };
  }

  it('verifies portable identity and exact asset bytes while listing only visible selected publications', async () => {
    const first = await publish('public', true), second = await publish('members'), hidden = await publish('private');
    expect((await client.capabilities()).operations).toEqual(['publications.list', 'publications.get', 'assets.get']);
    const page = await client.list({ limit: 1 }); expect(page.publications).toHaveLength(1);
    const next = await client.list({ limit: 1, after: page.nextAfter! });
    expect([page.publications[0]!.id, next.publications[0]!.id].sort()).toEqual([first.id, second.id].sort());
    expect((await client.list({ after: next.nextAfter! })).publications).toEqual([]);
    const value = await client.get(first.id);
    expect(value.document).toHaveProperty('data.extensions.opaque', [0, false]);
    for (const privateField of ['ownerId', 'workspaceId', 'revisionId', 'sourceId', 'allowOriginal']) expect(value).not.toHaveProperty(privateField);
    expect(value.assets).toMatchObject([{ path: 'declared/0', binding: { kind: 'uri', pointer: '/assets/0/uri' } }]);
    expect(new TextDecoder().decode(await client.asset(value, 'declared/0'))).toBe(first.bytes);
    await expect(client.get(hidden.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(client.list({ parent: hidden.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await client.list({ parent: first.id })).publications).toEqual([]);
    expect(await (await browser(`workspaces/${workspaceId}/cards/${first.cardId}/original`, alice)).text()).toBe(JSON.stringify(first.document));
    const updated = await browser(`hub/publications/${first.id}/policy`, alice, 'PATCH', { expectedVersion: 1,
      policy: { visibility: 'public', allowOriginal: false, allowFork: false } });
    expect(updated.status, await updated.clone().text()).toBe(200);
    await expect(client.asset(value, 'declared/0')).rejects.toMatchObject({ code: 'CHANGED' });
  }, 30_000);

  it('rejects unsigned, replayed, tampered, ambient and revoked credentials without session fallback', async () => {
    expect((await dispatch(new Request(`${baseUrl}/capabilities`))).status).toBe(401);
    const request = await signed('/capabilities'); expect((await dispatch(request.clone())).status).toBe(200);
    expect((await dispatch(request)).status).toBe(401);
    const altered = await signed('/capabilities');
    expect((await dispatch(new Request(`${baseUrl}/publications`, altered))).status).toBe(401);
    for (const [name, value] of [['cookie', bob], ['authorization', 'Bearer ignored'], ['origin', origin]]) {
      const ambient = await signed('/capabilities'); ambient.headers.set(name!, value!);
      expect((await dispatch(ambient)).status).toBe(403);
    }
    await sync.setScopes(actor, ['publish']); await expect(client.capabilities()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await sync.setScopes(actor, ['pull']); await sync.setEnabled(actor, false);
    await expect(client.capabilities()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await sync.setEnabled(actor, true); await accounts.setEnabled(bobId, false);
    await expect(client.capabilities()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await accounts.setEnabled(bobId, true); await sync.revokeKey(actor, keyId);
    await expect(client.capabilities()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    // Account suspension revokes existing browser sessions, even after re-enabling.
    expect((await browser('session', bob)).status).toBe(401);
    expect((await browser('session', alice)).status).toBe(200);
    if (adapter === 'sqlite') { enabled = false; expect((await dispatch(await signed('/capabilities'))).status).toBe(404); }
  }, 30_000);

  async function remoteBundle(parent: SyncReadPublication, content: Uint8Array, author = actor) {
    const options = { assets: parent.assets.flatMap((asset) => asset.binding.kind === 'uri' ? [{ pointer: asset.binding.pointer, hash: asset.hash }] : []) };
    const previous = readCardLineage(parent.document);
    const fork = await createCardRevision(parent.document, { ...options, originalHash: parent.originalHash, parents: previous ? [previous] : [],
      operation: 'fork', author, createdAt: new Date().toISOString(), nonce: 'remote_fork_record_0001' });
    const edited = structuredClone(fork.card); edited.data.description = 'Enriched on a remote instance';
    const hash = await hashBytes(content);
    const final = await createCardRevision(edited, { assets: [{ pointer: '/assets/0/uri', hash }], originalHash: parent.originalHash,
      parents: [fork.lineage], operation: 'edit', author, createdAt: new Date().toISOString(), nonce: 'remote_edit_record_0001' });
    const manifest = { version: SYNC_FORK_VERSION, publicationId: parent.id, baseIdentity: parent.identity, originalHash: parent.originalHash,
      document: final.card, identity: final.lineage.content, ancestry: [fork.lineage], assets: [{ ...parent.assets[0]!, hash, byteLength: content.length }] };
    return { manifest, assets: [content] };
  }

  it('persists a separate Unity pull/edit/outbox and recovers a lost return acknowledgment after restart', async () => {
    const original = await publish('public', true), parent = await client.get(original.id);
    await sync.setScopes(actor, ['pull', 'fork', 'publish']);
    const directory = join(root, 'independent-sender');
    const open = () => openLocalServices({ databasePath: join(directory, 'unity.db'), blobDirectory: join(directory, 'blobs') });
    let sender = await open();
    let offline = false, loseResponse = false, networkCalls = 0;
    const sentFrames: Uint8Array[] = [];
    const connection = { baseUrl, actor, keyId, privateKey: key.privateKey, fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      networkCalls++; if (offline) throw new Error('Remote connection unavailable');
      const message = new Request(input, init);
      if (message.method === 'POST') sentFrames.push(new Uint8Array(await message.clone().arrayBuffer()));
      const response = await dispatch(message);
      if (loseResponse && message.method === 'POST') { loseResponse = false; expect(response.status).toBe(200); await response.body?.cancel(); throw new Error('Receipt lost after remote commit'); }
      return response;
    } };
    const remoteOrigin = new URL(actor).origin;
    let app = createAccountApi({ origin: remoteOrigin, accounts: sender.accounts, store: sender.store, forSession: sender.forSession });
    const request = (path: string, cookie = '', method = 'GET', body?: unknown) => app.request(`${remoteOrigin}/api/${path}`, {
      method, headers: { cookie, origin: remoteOrigin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    try {
      const account = await sender.accounts.create('Remote editor', { actorUri: actor });
      const login = await request('session', '', 'POST', { key: account.key }); expect(login.status).toBe(200);
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const session = (await sender.accounts.authenticate(cookie.slice(cookie.indexOf('=') + 1)))!;
      const localActor = { id: account.account.id, uri: account.account.uri };
      const workspace = await json<{ id: string }>(await request('workspaces', cookie, 'POST', { name: 'Independent editor' }), 201);
      const scope = () => sender.forSession(session.proof);
      const remote = () => scope().remote(connection);
      const denied = { ...localActor, uri: 'urn:local-only' };
      await expect(remote().pullFork(denied, workspace.id, original.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(networkCalls).toBe(0);
      const pulled = await remote().pullFork(localActor, workspace.id, original.id);
      expect(pulled.card.originalHash).toBe(parent.originalHash);
      expect(pulled.revision.document).toHaveProperty('data.extensions.foundry.lineage.operation', 'fork');
      expect(pulled.revision.document).toHaveProperty('data.extensions.foundry.lineage.author', actor);
      const path = `workspaces/${workspace.id}/cards/${pulled.card.id}`;
      const originalSnapshot = new Uint8Array(await (await request(`${path}/original`, cookie)).arrayBuffer());
      expect(JSON.parse(new TextDecoder().decode(originalSnapshot))).toEqual(parent);
      const opened = await json<{ revision: Revision }>(await request(path, cookie));
      const document = structuredClone(opened.revision.document);
      if (!document.data || typeof document.data !== 'object' || Array.isArray(document.data)) throw new Error('Expected CCv3 data');
      document.data.description = 'Edited in a second persisted Unity account';
      const saved = await json<Revision>(await request(`${path}/revisions`, cookie, 'POST', { expectedHead: opened.revision.id, document }));
      expect(saved.document).toHaveProperty('data.extensions.foundry.lineage.author', actor);
      const prepared = await remote().prepareReturn(localActor, workspace.id, pulled.card.id, saved.id);
      const operationId = createSyncToken(), beforeQueue = networkCalls;
      const queued = await remote().returns.enqueue(localActor, workspace.id, pulled.card.id, saved.id, operationId);
      expect(queued).toMatchObject({ requestId: operationId, revisionId: saved.id, frameHash: prepared.hash, byteLength: prepared.bytes.length, state: 'prepared', attempts: 0 });
      expect(await remote().returns.enqueue(localActor, workspace.id, pulled.card.id, saved.id, operationId)).toEqual(queued);
      expect(networkCalls).toBe(beforeQueue);
      // Preparing an older selected revision must not silently switch to a newer head.
      const newer = structuredClone(saved.document);
      if (!newer.data || typeof newer.data !== 'object' || Array.isArray(newer.data)) throw new Error('Expected CCv3 data');
      newer.data.description = 'A later local edit, not selected for return';
      const head = await json<Revision>(await request(`${path}/revisions`, cookie, 'POST', { expectedHead: saved.id, document: newer }));
      await expect(remote().returns.enqueue(localActor, workspace.id, pulled.card.id, head.id, operationId)).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
      const calls = networkCalls; offline = true;
      sender.close(); sender = await open();
      app = createAccountApi({ origin: remoteOrigin, accounts: sender.accounts, store: sender.store, forSession: sender.forSession });
      expect((await request('session', cookie)).status).toBe(200);
      expect((await json<{ revision: Revision }>(await request(path, cookie))).revision.id).toBe(head.id);
      const repeated = await remote().prepareReturn(localActor, workspace.id, pulled.card.id, saved.id);
      expect(repeated).toEqual(prepared); expect(networkCalls).toBe(calls);
      expect(await remote().returns.get(localActor, workspace.id, operationId)).toEqual(queued);
      expect(await remote().returns.list(localActor, workspace.id)).toEqual([queued]);
      expect(new Uint8Array(await (await request(`${path}/original`, cookie)).arrayBuffer())).toEqual(originalSnapshot);
      // Retargeting a persisted draft is forbidden, even if its local actor/key are the same.
      const other = createRemoteCardService(scope().store, scope().assets, { ...connection, baseUrl: 'https://elsewhere.invalid/api/sync/v1' });
      await expect(other.prepareReturn(localActor, workspace.id, pulled.card.id, saved.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const retargeted = scope().remote({ ...connection, baseUrl: 'https://elsewhere.invalid/api/sync/v1' });
      await expect(retargeted.returns.send(localActor, workspace.id, operationId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(remote().returns.send(denied, workspace.id, operationId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const cancelled = new AbortController(); cancelled.abort();
      await expect(remote().returns.send(localActor, workspace.id, operationId, cancelled.signal)).rejects.toThrow();
      const frameAsset = await scope().store.getAsset(workspace.id, queued.assetId);
      const framePath = join(directory, 'blobs', frameAsset.storageKey), corrupt = new Uint8Array(prepared.bytes);
      corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
      await writeFile(framePath, corrupt);
      await expect(remote().returns.send(localActor, workspace.id, operationId)).rejects.toMatchObject({ code: 'INTEGRITY' });
      await writeFile(framePath, prepared.bytes);
      expect(networkCalls).toBe(calls);
      expect((await remote().returns.get(localActor, workspace.id, operationId))?.attempts).toBe(0);
      offline = false; loseResponse = true;
      await expect(remote().returns.send(localActor, workspace.id, operationId)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      expect(await remote().returns.get(localActor, workspace.id, operationId)).toMatchObject({ state: 'uncertain', attempts: 1, receipt: null });
      sender.close(); sender = await open();
      expect(await remote().returns.get(localActor, workspace.id, operationId)).toMatchObject({ state: 'uncertain', attempts: 1 });
      const replacement = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
      connection.keyId = `${actor}#replacement`; connection.privateKey = replacement.privateKey;
      await sync.rotateKey(actor, keyId, connection.keyId, replacement.publicKey);
      const acknowledged = await remote().returns.send(localActor, workspace.id, operationId);
      expect(acknowledged).toMatchObject({ state: 'acknowledged', attempts: 2, frameHash: prepared.hash });
      expect(sentFrames).toEqual([prepared.bytes, prepared.bytes]);
      const returned = acknowledged.receipt!;
      commands = createSyncCommandClient({ ...connection, fetch: async (input, init) => dispatch(new Request(input, init)) });
      client = createSyncReadClient({ ...connection, fetch: async (input, init) => dispatch(new Request(input, init)) });
      expect(await commands.submitFork(repeated.bytes, operationId)).toEqual(returned);
      const afterAck = networkCalls; offline = true;
      sender.close(); sender = await open();
      expect(await remote().returns.send(localActor, workspace.id, operationId)).toEqual(acknowledged);
      expect(networkCalls).toBe(afterAck);
      if (returned.operation !== 'forks.submit') throw new Error('Expected returned fork');
      const selected = await commands.publish({ revisionIds: [returned.revisionId], policy: { visibility: 'public', allowFork: true } }, createSyncToken());
      if (selected.operation !== 'publications.publish') throw new Error('Expected publication');
      const visible = await client.get(selected.publications[0]!.id);
      expect(visible.parentId).toBe(parent.id); expect(visible.document).toEqual(saved.document);
      expect(new TextDecoder().decode(await client.asset(visible, 'declared/0'))).toBe(original.bytes);
      expect(await (await browser(`workspaces/${workspaceId}/cards/${original.cardId}/original`, alice)).text()).toBe(JSON.stringify(original.document));
      await sender.accounts.setEnabled(account.account.id, false);
      await expect(remote().prepareReturn(localActor, workspace.id, pulled.card.id, saved.id)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      await expect(remote().returns.get(localActor, workspace.id, operationId)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      await expect(remote().returns.send(localActor, workspace.id, operationId)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    } finally { sender.close(); }
  }, 30_000);

  it('exposes configured remote browser routes only to their account and keeps keys and peer errors outside local sessions', async () => {
    const original = await publish('public', true), senderOrigin = 'https://sender.unity.invalid';
    let connections: ConfiguredRemote[] = [], outbound = 0;
    const open = () => openLocalServices({ databasePath: join(root, 'configured.db'), blobDirectory: join(root, 'configured-blobs'), remoteConnections: connections });
    let sender = await open();
    try {
      const owner = await sender.accounts.create('Configured owner', { actorUri: actor }), stranger = await sender.accounts.create('Other user');
      const first = (await sender.accounts.login(owner.key))!, second = (await sender.accounts.login(stranger.key))!;
      const workspace = await sender.store.createWorkspace({ ownerId: owner.account.id, name: 'Returns' });
      const otherWorkspace = await sender.store.createWorkspace({ ownerId: stranger.account.id, name: 'Private' });
      const connection = { baseUrl, actor, keyId, privateKey: key.privateKey, fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        outbound++; const request = new Request(input, init); expect(request.headers.has('cookie')).toBe(false); expect(request.headers.has('authorization')).toBe(false);
        return dispatch(request);
      } };
      connections = [{ id: 'friends', name: 'Friends', accountId: owner.account.id, connection }];
      sender.close(); sender = await open();
      let app = createAccountApi({ origin: senderOrigin, accounts: sender.accounts, store: sender.store, forSession: sender.forSession });
      const request = (path: string, method = 'GET', body?: unknown, token = first.token, headerActor = owner.account.id, requestOrigin = senderOrigin) =>
        app.request(`${senderOrigin}/api/${path}`, { method, headers: { origin: requestOrigin, cookie: `__Host-unity_hub=${token}`, 'x-unity-actor': headerActor, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const descriptors = await json<{ connections: unknown[] }>(await request('remotes/connections'));
      expect(descriptors.connections).toEqual([{ id: 'friends', name: 'Friends', baseUrl, actor }]);
      expect(JSON.stringify(descriptors)).not.toMatch(/privateKey|keyId|accountId|BEGIN PRIVATE/);
      expect(await json(await request('remotes/connections', 'GET', undefined, second.token, stranger.account.id))).toEqual({ connections: [] });
      expect((await request('remotes/connections', 'GET', undefined, '')).status).toBe(401);
      expect((await request('remotes/connections', 'GET', undefined, second.token)).status).toBe(409);
      expect((await request('remotes/connections', 'GET', undefined, first.token, owner.account.id, 'https://evil.example')).status).toBe(403);
      const listing = `remotes/connections/friends/publications?workspaceId=${workspace.id}`;
      expect((await request(listing, 'GET', undefined, second.token, stranger.account.id)).status).toBe(403);
      expect((await request(`remotes/connections/friends/publications?workspaceId=${otherWorkspace.id}`)).status).toBe(403);
      expect((await request(`${listing}&baseUrl=https://evil.example`)).status).toBe(400);
      expect((await request('remotes/connections/friends/pulls', 'POST', { workspaceId: workspace.id, publicationId: original.id, privateKey: 'untrusted' })).status).toBe(400);
      expect(outbound).toBe(0);
      const listed = await json<{ publications: { id: string }[] }>(await request(listing)); expect(listed.publications.map((value) => value.id)).toContain(original.id);
      const pulled = await json<{ card: { id: string }; revision: Revision }>(await request('remotes/connections/friends/pulls', 'POST', { workspaceId: workspace.id, publicationId: original.id }), 201);
      const jobsPath = `remotes/workspaces/${workspace.id}/jobs`, requestId = createSyncToken();
      const enqueue = { connectionId: 'friends', cardId: pulled.card.id, revisionId: pulled.revision.id, requestId };
      const beforeQueue = outbound;
      const queued = await json<Record<string, unknown>>(await request(jobsPath, 'POST', enqueue), 201);
      expect(queued).toMatchObject({ title: 'Signed Aster', sequence: 1, state: 'prepared', connectionId: 'friends', requestId });
      expect(queued).not.toHaveProperty('assetId'); expect(queued).not.toHaveProperty('accountId'); expect(outbound).toBe(beforeQueue);
      expect(await json(await request(jobsPath, 'POST', enqueue), 201)).toEqual(queued);
      expect((await request(`${jobsPath}/${requestId}/send`, 'POST', { baseUrl: 'https://evil.example' })).status).toBe(400);
      expect((await request(jobsPath, 'GET', undefined, second.token, stranger.account.id)).status).toBe(401);
      const denied = await request(`${jobsPath}/${requestId}/send`, 'POST', {});
      expect(denied.status).toBe(502); expect(await denied.json()).toMatchObject({ error: { code: 'REMOTE_UNAUTHENTICATED' } });
      expect((await request('session')).status).toBe(200);
      expect(await json(await request(`${jobsPath}/${requestId}`))).toMatchObject({ state: 'uncertain', attempts: 1 });
      await sync.setScopes(actor, ['pull', 'fork']);
      expect(await json(await request(`${jobsPath}/${requestId}/send`, 'POST', {}))).toMatchObject({ state: 'acknowledged', attempts: 2, receipt: { operation: 'forks.submit', requestId } });
      connections = []; sender.close(); sender = await open();
      app = createAccountApi({ origin: senderOrigin, accounts: sender.accounts, store: sender.store, forSession: sender.forSession });
      expect(await json(await request(`${jobsPath}/${requestId}`))).toMatchObject({ connectionId: null, state: 'acknowledged' });
      const beforeDenied = outbound; expect((await request(`${jobsPath}/${requestId}/send`, 'POST', {})).status).toBe(403); expect(outbound).toBe(beforeDenied);
      await sender.accounts.setEnabled(owner.account.id, false); expect((await request(jobsPath)).status).toBe(401);
    } finally { sender.close(); }
  }, 30_000);

  it('runs configured pull, edit and durable return dispatch inside workerd and recovers after sender D1/R2 restart', async () => {
    const original = await publish('public', true), senderOrigin = 'https://worker-sender.unity.invalid';
    await sync.setScopes(actor, ['pull', 'fork']);
    let secret: string | undefined, lost = true, sends = 0;
    const outbound: V4FetchHandler = async (request) => {
      expect(request.url.startsWith(`${baseUrl}/`)).toBe(true); expect(request.headers.has('signature')).toBe(true);
      expect(request.headers.has('cookie')).toBe(false);
      const response = await dispatch(new Request(request.url, { method: request.method, headers: Object.fromEntries(request.headers),
        ...(request.method === 'GET' ? {} : { body: await request.arrayBuffer() }) }));
      if (request.method === 'POST') {
        sends++;
        if (lost) { lost = false; expect(response.status).toBe(200); await response.body?.cancel(); return new MiniflareResponse('Lost acknowledgment', { status: 503 }); }
      }
      return new MiniflareResponse(await response.arrayBuffer(), { status: response.status, headers: Object.fromEntries(response.headers) });
    };
    const options = () => convertV4MiniflareOptions({ port: 0, modules: true, script, compatibilityDate: '2026-10-11', compatibilityFlags: ['nodejs_compat'],
      bindings: { UNITY_PUBLIC_ORIGIN: senderOrigin, ...(secret === undefined ? {} : { UNITY_REMOTE_CONNECTIONS_JSON: secret }) },
      d1Databases: { UNITY_DB: 'remote-sender' }, r2Buckets: { UNITY_BLOBS: 'remote-sender' }, resourcePersistencePath: join(root, 'worker-sender'),
      ratelimits: { UNITY_LOGIN_LIMITER: { namespace_id: '1001', simple: { limit: 60, period: 60 } } }, outboundService: outbound });
    let sender = new Miniflare(options());
    try {
      const driver = createD1Driver(await sender.getD1Database('UNITY_DB')); await migrate(driver);
      const account = await createAccountStore(driver).create('Worker sender', { actorUri: actor });
      const workspace = await createStore(driver).createWorkspace({ ownerId: account.account.id, name: 'Worker remote forks' });
      const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', key.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----\n`;
      secret = JSON.stringify({ version: 'unity.remote-connections.v1', connections: [{ id: 'friends', name: 'Worker connection', accountId: account.account.id,
        actor, baseUrl, keyId, privateKeyPem: pem }] });
      await sender.setOptions(options());
      let cookie = '';
      const request = async (path: string, method = 'GET', body?: unknown) => {
        const response = await sender.dispatchFetch(`${senderOrigin}/api/${path}`, { method, headers: { origin: senderOrigin, cookie, 'content-type': 'application/json', 'x-unity-actor': account.account.id },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return new Response(await response.arrayBuffer(), { status: response.status, headers: Object.fromEntries(response.headers) });
      };
      const login = await request('session', 'POST', { key: account.key }); expect(login.status).toBe(200); cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      expect(await json(await request('remotes/connections'))).toEqual({ connections: [{ id: 'friends', name: 'Worker connection', baseUrl, actor }] });
      const pulled = await json<{ card: { id: string }; revision: Revision }>(await request('remotes/connections/friends/pulls', 'POST', { workspaceId: workspace.id, publicationId: original.id }), 201);
      const document = structuredClone(pulled.revision.document);
      if (!document.data || typeof document.data !== 'object' || Array.isArray(document.data)) throw new Error('Expected card data');
      document.data.description = 'Edited and returned by the Worker sender';
      const saved = await json<Revision>(await request(`workspaces/${workspace.id}/cards/${pulled.card.id}/revisions`, 'POST', { expectedHead: pulled.revision.id, document }));
      const requestId = createSyncToken(), jobsPath = `remotes/workspaces/${workspace.id}/jobs`;
      const job = await json<{ frameHash: string }>(await request(jobsPath, 'POST', { connectionId: 'friends', cardId: pulled.card.id, revisionId: saved.id, requestId }), 201);
      expect(await json(await request(`${jobsPath}/${requestId}/send`, 'POST', {}), 502)).toMatchObject({ error: { code: 'REMOTE_UNAVAILABLE' } });
      expect(await json(await request(`${jobsPath}/${requestId}`))).toMatchObject({ state: 'uncertain', attempts: 1 });
      await sender.dispose(); sender = new Miniflare(options());
      const recovered = await json<{ receipt: { cardId: string; revisionId: string } }>(await request(`${jobsPath}/${requestId}/send`, 'POST', {}));
      expect(recovered).toMatchObject({ state: 'acknowledged', attempts: 2, frameHash: job.frameHash }); expect(sends).toBe(2);
      const returned = await json<{ revision: Revision }>(await browser(`workspaces/${peerWorkspaceId}/cards/${recovered.receipt.cardId}`, bob));
      expect(returned.revision.document).toEqual(saved.document);
      expect(await json(await request(`${jobsPath}/${requestId}/send`, 'POST', {}))).toEqual(recovered); expect(sends).toBe(2);
    } finally { await sender.dispose(); }
  }, 30_000);

  it('does not stage a remote fork after corrupt bytes, a mid-pull policy change or session revocation', async () => {
    const original = await publish('public', true);
    const sender = await openLocalServices({ databasePath: join(root, 'pull-failures.db'), blobDirectory: join(root, 'pull-failure-blobs') });
    try {
      const created = await sender.accounts.create('Remote editor', { actorUri: actor });
      const session = (await sender.accounts.login(created.key))!, localActor = { id: created.account.id, uri: actor };
      const scoped = sender.forSession(session.proof);
      const workspace = await scoped.cards.createWorkspace(localActor, 'Remote fork failures');
      let stages = 0, mode: 'corrupt' | 'changed' | 'revoked' = 'corrupt';
      const service = createRemoteCardService(scoped.store, { ...scoped.assets, async stage(input) { stages++; return scoped.assets.stage(input); } }, {
        baseUrl, actor, keyId, privateKey: key.privateKey, fetch: async (input, init) => {
          const response = await dispatch(new Request(input, init));
          if (String(input).includes('/asset?')) {
            if (mode === 'corrupt') { await response.body?.cancel(); return new Response('corrupted attachment', { headers: { 'content-type': 'text/plain' } }); }
            if (mode === 'changed') await browser(`hub/publications/${original.id}/policy`, alice, 'PATCH', {
              expectedVersion: 1, policy: { visibility: 'public', allowFork: true, allowOriginal: false },
            });
            if (mode === 'revoked') await sender.accounts.setEnabled(localActor.id, false);
          }
          return response;
        },
      });
      await expect(service.pullFork(localActor, workspace.id, original.id)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
      mode = 'changed';
      await expect(service.pullFork(localActor, workspace.id, original.id)).rejects.toMatchObject({ code: 'ACCESS_CHANGED' });
      mode = 'revoked';
      await expect(service.pullFork(localActor, workspace.id, original.id)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(stages).toBe(0); expect(await sender.store.listCards(workspace.id)).toEqual([]);
    } finally { sender.close(); }
  }, 30_000);

  it('accepts an enriched remote fork with exact assets and ancestry, preserves its signed source and publishes only on selection', async () => {
    const original = await publish('public', true), parent = await client.get(original.id);
    const asset = new TextEncoder().encode('Enriched attachment bytes from remote peer');
    const bundle = await remoteBundle(parent, asset), bytes = await encodeSyncForkSubmission(bundle);
    await sync.setScopes(actor, ['pull', 'fork', 'publish']);
    const id = createSyncToken();
    const [accepted, duplicate] = await Promise.all([commands.submitFork(bytes, id), commands.submitFork(bytes, id)]);
    expect(accepted).toEqual(duplicate);
    if (accepted.operation !== 'forks.submit') throw new Error('Expected remote fork receipt');
    expect((await client.list({ parent: parent.id })).publications).toEqual([]);
    const path = `workspaces/${peerWorkspaceId}/cards/${accepted.cardId}`;
    const stored = await json<{ revision: { id: string; authorId: string; document: unknown; identity: unknown } }>(await browser(path, bob));
    expect(stored.revision.authorId).toBe(bobId);
    expect(stored.revision.document).toEqual(bundle.manifest.document);
    expect(stored.revision.identity).toEqual(bundle.manifest.identity);
    expect(new Uint8Array(await (await browser(`${path}/original`, bob)).arrayBuffer())).toEqual(bytes);
    expect(new Uint8Array(await (await browser(`${path}/asset?revisionId=${accepted.revisionId}&path=declared%2F0`, bob)).arrayBuffer())).toEqual(asset);
    const selected = await commands.publish({ revisionIds: [accepted.revisionId], policy: { visibility: 'members', allowFork: true } }, createSyncToken());
    if (selected.operation !== 'publications.publish') throw new Error('Expected publication receipt');
    const published = await client.get(selected.publications[0]!.id);
    expect(published.parentId).toBe(parent.id); expect(published.originalHash).toBe(parent.originalHash);
    expect(published.document).toEqual(bundle.manifest.document); expect(await client.asset(published, 'declared/0')).toEqual(asset);
    expect(await (await browser(`workspaces/${workspaceId}/cards/${original.cardId}/original`, alice)).text()).toBe(JSON.stringify(original.document));
    const changed = await encodeSyncForkSubmission(await remoteBundle(parent, new TextEncoder().encode('Changed bytes')));
    await expect(commands.submitFork(changed, id)).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    await browser(`hub/publications/${parent.id}/policy`, alice, 'PATCH', { expectedVersion: 1, policy: { visibility: 'private', allowFork: false, allowOriginal: false } });
    await expect(commands.submitFork(bytes, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 30_000);

  it('rejects correctly signed but unproven lineage or corrupt asset bundles before creating drafts', async () => {
    const original = await publish('public', true), parent = await client.get(original.id);
    await sync.setScopes(actor, ['pull', 'fork']);
    const asset = new TextEncoder().encode('Remote attachment');
    const bundle = await remoteBundle(parent, asset);
    const good = await encodeSyncForkSubmission(bundle), corrupt = new Uint8Array(good); corrupt[corrupt.length - 1] = 0;
    const cases = [corrupt,
      await encodeSyncForkSubmission(await remoteBundle(parent, asset, 'https://untrusted.example/actor')),
      await encodeSyncForkSubmission({ ...bundle, manifest: { ...bundle.manifest, ancestry: [] } }),
      await encodeSyncForkSubmission({ ...bundle, manifest: { ...bundle.manifest, publicationId: 'substituted' } }),
    ];
    for (const body of cases) {
      const message = await signSyncHttp({ actor, keyId, privateKey: key.privateKey, requestId: createSyncToken(), method: 'POST',
        url: `${baseUrl}/commands/submit-fork/${parent.id}`, contentType: 'application/octet-stream', body });
      const response = await dispatch(new Request(message.url, { method: 'POST', headers: message.headers, body: new Uint8Array(message.body) }));
      expect(response.status, await response.clone().text()).toBe(400);
    }
    if (adapter === 'sqlite') {
      beforeWrite = () => sync.setEnabled(actor, false);
      await expect(commands.submitFork(good, createSyncToken())).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
    expect(await json(await browser(`workspaces/${peerWorkspaceId}/cards`, bob))).toEqual({ cards: [] });
  }, 30_000);

  it('handles a near-limit binary bundle on the actual backend without dropping or changing asset bytes', async () => {
    const original = await publish('public', true), parent = await client.get(original.id);
    await sync.setScopes(actor, ['pull', 'fork']);
    const asset = new Uint8Array(SYNC_FORK_MAX_BYTES - 16384); asset.fill(37);
    const bundle = await encodeSyncForkSubmission(await remoteBundle(parent, asset));
    expect(bundle.length).toBeLessThanOrEqual(SYNC_FORK_MAX_BYTES);
    const accepted = await commands.submitFork(bundle, createSyncToken());
    if (accepted.operation !== 'forks.submit') throw new Error('Expected remote fork receipt');
    const response = await browser(`workspaces/${peerWorkspaceId}/cards/${accepted.cardId}/asset?revisionId=${accepted.revisionId}&path=declared%2F0`, bob);
    expect(response.status).toBe(200); expect(await hashBytes(new Uint8Array(await response.arrayBuffer()))).toBe(await hashBytes(asset));
  }, 30_000);

  it('forks and publishes an exact selection with stable receipts after lost responses, races and key rotation', async () => {
    const original = await publish('public', true);
    expect(await json(await dispatch(await signed('/command-capabilities')))).toMatchObject({ version: SYNC_COMMAND_VERSION });
    await sync.setScopes(actor, ['pull', 'fork', 'publish']);
    const operationId = createSyncToken(); let drop = true;
    const unreliable = createSyncCommandClient({ baseUrl, actor, keyId, privateKey: key.privateKey, fetch: async (input, init) => {
      const response = await dispatch(new Request(input, init));
      expect(response.status, await response.clone().text()).toBe(200);
      if (drop) { drop = false; throw new Error('Lost acknowledgement after server commit'); } return response;
    } });
    await expect(unreliable.fork(original.id, operationId)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    const recovered = await unreliable.fork(original.id, operationId);
    const [first, second] = await Promise.all([commands.fork(original.id, operationId), commands.fork(original.id, operationId)]);
    expect(first).toEqual(recovered); expect(second).toEqual(recovered);
    if (recovered.operation !== 'publications.fork') throw new Error('Expected fork receipt');
    const fork = await json<{ card: { id: string }; revision: { id: string; document: Record<string, unknown>; identity: unknown } }>(
      await browser(`workspaces/${peerWorkspaceId}/cards/${recovered.cardId}`, bob));
    expect(fork.revision.id).toBe(recovered.revisionId);
    expect(fork.revision.document).toHaveProperty('data.extensions.foundry.lineage.operation', 'fork');
    expect(fork.revision.document).toHaveProperty('data.extensions.foundry.lineage.author', (await accounts.list()).find((item) => item.id === bobId)!.uri);
    const selection = { revisionIds: [recovered.revisionId], policy: { visibility: 'public' as const, allowFork: true } };
    const publishId = createSyncToken();
    const results = await Promise.all([commands.publish(selection, publishId), commands.publish(selection, publishId)]);
    expect(results[0]).toEqual(results[1]); const result = results[0]!;
    if (result.operation !== 'publications.publish') throw new Error('Expected publish receipt');
    const publication = await client.get(result.publications[0]!.id);
    expect(publication.parentId).toBe(original.id); expect(publication.identity).toEqual(fork.revision.identity);
    expect(new TextDecoder().decode(await client.asset(publication, 'declared/0'))).toBe(original.bytes);
    expect((await client.list({ parent: original.id })).publications.map((item) => item.id)).toEqual([publication.id]);
    expect((await browser(`hub/publications/${publication.id}/original`, alice)).status).toBe(404);
    const different = { ...selection, policy: { ...selection.policy, allowFork: false } };
    await expect(commands.publish(different, publishId)).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    await expect(commands.fork(original.id, publishId)).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    const replacement = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    await sync.rotateKey(actor, keyId, `${actor}#two`, replacement.publicKey);
    const rotated = createSyncCommandClient({ baseUrl, actor, keyId: `${actor}#two`, privateKey: replacement.privateKey,
      fetch: async (input, init) => dispatch(new Request(input, init)) });
    expect(await rotated.publish(selection, publishId)).toEqual(result);
    await expect(commands.publish(selection, publishId)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await (await browser(`workspaces/${workspaceId}/cards/${original.cardId}/original`, alice)).text()).toBe(JSON.stringify(original.document));
  }, 30_000);

  it('enforces command scope, exact signed bytes, granted workspace and current fork policy', async () => {
    const publication = await publish();
    await expect(commands.fork(publication.id, createSyncToken())).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await sync.setScopes(actor, ['fork', 'publish']);
    // A peer may execute its configured scope without pull/capability access.
    await expect(client.capabilities()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(commands.publish({ revisionIds: [publication.revisionId], policy: { visibility: 'public', allowFork: true } }, createSyncToken()))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    for (const invalid of ['not json', JSON.stringify({ version: SYNC_COMMAND_VERSION, operation: 'publications.fork', publicationId: publication.id, workspaceId }),
      JSON.stringify({ version: SYNC_COMMAND_VERSION, operation: 'publications.publish', revisionIds: ['one'], policy: { visibility: 'public', allowFork: true } })]) {
      const message = await signSyncHttp({ actor, keyId, privateKey: key.privateKey, requestId: createSyncToken(), method: 'POST',
        url: `${baseUrl}/commands/fork`, contentType: 'application/json', body: new TextEncoder().encode(invalid) });
      expect((await dispatch(new Request(message.url, { method: 'POST', headers: message.headers, body: new Uint8Array(message.body) }))).status).toBe(400);
    }
    const bytes = encodeSyncCommand({ version: SYNC_COMMAND_VERSION, operation: 'publications.fork', publicationId: publication.id });
    const forkId = createSyncToken();
    const message = await signSyncHttp({ actor, keyId, privateKey: key.privateKey, requestId: forkId, method: 'POST',
      url: `${baseUrl}/commands/fork`, contentType: 'application/json', body: bytes });
    const send = (body = bytes, headers = message.headers) => dispatch(new Request(message.url, { method: 'POST', headers, body: new Uint8Array(body) }));
    const changed = new TextEncoder().encode(new TextDecoder().decode(bytes).replace(publication.id, 'substituted'));
    expect((await send(changed)).status).toBe(401);
    const ambient = new Headers(message.headers); ambient.set('cookie', bob); expect((await send(bytes, ambient)).status).toBe(403);
    expect((await send()).status).toBe(200); expect((await send()).status).toBe(401);
    await browser(`hub/publications/${publication.id}/policy`, alice, 'PATCH', { expectedVersion: 1,
      policy: { visibility: 'private', allowFork: false, allowOriginal: false } });
    await expect(commands.fork(publication.id, forkId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await sync.setEnabled(actor, false);
    await expect(commands.fork(publication.id, createSyncToken())).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    if (adapter === 'sqlite') { writes = false; expect((await send()).status).toBe(404); }
  }, 30_000);

  if (adapter === 'sqlite') it('rechecks grant revocation after reading and fails closed before verification when admission is denied', async () => {
    const published = await publish();
    await sync.setScopes(actor, ['pull', 'fork']);
    beforeWrite = () => sync.setEnabled(actor, false);
    await expect(commands.fork(published.id, createSyncToken())).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await sync.setEnabled(actor, true);
    afterRead = () => sync.setEnabled(actor, false);
    await expect(client.get(published.id)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    admitted = false;
    const limited = await dispatch(new Request(`${baseUrl}/capabilities`));
    expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('60');
  });

  it('rejects unsupported routes, query shapes and methods after signed admission', async () => {
    for (const path of ['/capabilities?extra=1', '/publications?limit=21', '/publications?limit=1&limit=2', '/publications?parent=bad%2Fid']) {
      expect((await dispatch(await signed(path))).status).toBe(400);
    }
    expect((await dispatch(await signed('/originals'))).status).toBe(404);
    const method = await signed('/capabilities'); expect((await dispatch(new Request(method, { method: 'POST' }))).status).toBe(400);
  }, 30_000);
});
