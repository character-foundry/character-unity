import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { Miniflare, Response as MiniflareResponse, convertV4MiniflareOptions } from 'miniflare';
import type { V4FetchHandler } from 'miniflare';
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { Revision } from '@character-unity/store';
import { createD1Driver } from '@character-unity/store/d1';
import { migrate } from '@character-unity/store/migrations';
import { createAccountStore } from '@character-unity/store/accounts';
import { createBrowserSearchFixture, fixtureInventory } from '../../archive/tests/browser-search-fixture.js';
import { openCopiedArchive } from '../../archive/src/copied.js';
import { createArchiveApp } from '../../archive/src/app.js';
import { createQueryEmbedder } from '../../archive/src/embeddings.js';
import { workerArchive } from './worker-archive.js';
import type { ArchiveImportResult } from '@character-unity/cards/archive';
import type { SearchPage } from '@character-unity/archive-client';

const origin = 'https://worker.unity.invalid';
const execute = promisify(execFile);
type CardResult = { card: { id: string }; revision: Revision };
let script: string;
beforeAll(async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL('./worker.ts', import.meta.url))],
    bundle: true, platform: 'browser', conditions: ['workerd', 'browser'], target: 'es2022', format: 'esm',
    external: ['node:*'], write: false, metafile: true });
  script = result.outputFiles[0]!.text;
  expect(Object.keys(result.metafile!.inputs).some((path) => /better-sqlite3|@lancedb|apache-arrow|apps\/archive\/src|blob-store\/src\/node|worker-local-store|accounts-cli/.test(path))).toBe(false);
});

describe('account Worker in workerd with D1 and R2', () => {
  let root: string;
  let mf: Miniflare;
  async function start(publicOrigin = origin, loginLimit = 60, statePath = root, databaseId = 'worker-test', archiveOrigin?: string, outbound?: V4FetchHandler) {
    mf = new Miniflare(convertV4MiniflareOptions({ port: 0, modules: true, script,
      compatibilityDate: '2026-10-11', compatibilityFlags: ['nodejs_compat'],
      bindings: { UNITY_PUBLIC_ORIGIN: publicOrigin, ...(archiveOrigin === undefined ? {} : { UNITY_ARCHIVE_ORIGIN: archiveOrigin }) }, d1Databases: { UNITY_DB: databaseId },
      r2Buckets: { UNITY_BLOBS: 'worker-test' }, resourcePersistencePath: statePath,
      ratelimits: { UNITY_LOGIN_LIMITER: { namespace_id: '1001', simple: { limit: loginLimit, period: 60 } } },
      ...(outbound ? { outboundService: outbound } : {}),
    }));
    await mf.ready;
  }
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'unity-worker-')); await start(); });
  afterEach(async () => { await mf?.dispose(); if (root) await rm(root, { recursive: true, force: true }); });
  const request = (path: string, cookie = '', method = 'GET', body?: unknown) => mf.dispatchFetch(`${origin}/api/${path}`, {
    method, headers: { cookie, origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function setup() {
    const driver = createD1Driver(await mf.getD1Database('UNITY_DB'));
    await migrate(driver);
    const accounts = createAccountStore(driver);
    const alice = await accounts.create('Alice'), bob = await accounts.create('Bob');
    async function login(key: string) {
      const response = await request('session', '', 'POST', { key });
      expect(response.status).toBe(200);
      const cookie = response.headers.get('set-cookie')!;
      expect(cookie).toContain('__Host-unity_hub='); expect(cookie).toContain('Secure'); expect(cookie).toContain('HttpOnly');
      return cookie.split(';')[0]!;
    }
    return { driver, accounts, alice, bob, a: await login(alice.key), b: await login(bob.key) };
  }

  async function archiveFixture() {
    const directory = join(root, 'archive-copy'); await createBrowserSearchFixture(directory);
    const before = await fixtureInventory(directory);
    const embedder = createQueryEmbedder({ provider: 'ollama', baseUrl: 'http://127.0.0.1:1', space: { model: 'unity-synthetic-v1', dimensions: 3, sourceDimensions: 3, queryInstruction: '' } }, '', async () => Response.json({ embeddings: [[0, 1, 0]] }));
    const source = await openCopiedArchive(directory, embedder), app = createArchiveApp(source);
    const reads: string[] = [];
    let transform: (response: Response, url: URL) => Promise<Response> = async (response) => response;
    const outbound: V4FetchHandler = async (request) => {
      const url = new URL(request.url);
      expect(url.origin).toBe('https://archive.unity.invalid'); expect(request.method).toBe('GET');
      expect(request.headers.has('cookie')).toBe(false); expect(request.headers.has('authorization')).toBe(false); expect(request.headers.has('x-unity-actor')).toBe(false);
      reads.push(url.pathname);
      const response = await transform(await app.fetch(new Request(request.url)), url);
      return new MiniflareResponse(await response.arrayBuffer(), { status: response.status, headers: Object.fromEntries(response.headers) });
    };
    async function restart(config = 'https://archive.unity.invalid') { await mf.dispose(); await start(origin, 60, root, 'worker-test', config, outbound); }
    return { directory, before, source, reads, restart, transform(next: typeof transform) { transform = next; } };
  }

  it('uses the configured Archive through workerd for filtered, semantic and paged reads and exact D1/R2 imports', async () => {
    const { a, b } = await setup();
    const workspace = await (await request('workspaces', a, 'POST', { name: 'Archive import' })).json() as { id: string };
    const base = `workspaces/${workspace.id}/archive`, fixture = await archiveFixture();
    expect((await request(`${base}/status`, a)).status).toBe(503); // Default remains disabled.
    await fixture.restart();
    for (const cookie of ['', b]) expect((await request(`${base}/status`, cookie)).status).toBe(cookie ? 403 : 401);
    expect((await request(`${base}/search?text=forest&url=https://other.invalid`, a)).status).toBe(400);
    expect(fixture.reads).toEqual([]);
    const status = await (await request(`${base}/status`, a)).json();
    expect(status).toMatchObject({ search: 'lance-fts-v1', semantic: { dimensions: 3 } });
    const query = 'text=forest%20AND%20NOT%20ocean&provider=synthetic&filter=tokenCount%20%3E%3D%20100&sort=tokens_desc&limit=1';
    const page = await (await request(`${base}/search?${query}`, a)).json() as SearchPage;
    expect(page.total).toBe(12); expect(page.cards[0]!.id).toBe('zlex-12');
    const next = await (await request(`${base}/search?${query}&snapshot=${page.snapshot}&cursor=${page.nextCursor}`, a)).json() as SearchPage;
    expect(next.cards[0]!.id).toBe('zlex-11');
    const semantic = await (await request(`${base}/search?mode=semantic&text=sea`, a)).json() as SearchPage;
    expect(semantic.cards[0]!.id).toBe('zlex-13'); expect(semantic.matches?.[0]?.text).toContain('ocean');
    const hybrid = await (await request(`${base}/search?mode=hybrid&text=Lexical%2001`, a)).json() as SearchPage;
    expect(hybrid.cards[0]!.id).toBe('zlex-01');
    const browse = await (await request(`${base}/search?mode=browse&sort=tokens_desc`, a)).json() as SearchPage;
    expect(browse.cards[0]!.id).toBe('zlex-13');
    const selected = { snapshot: status, ids: ['zlex-01', 'zlex-13'] };
    expect((await request(`${base}/selection`, a, 'POST', selected)).status).toBe(200);
    const imported = await (await request(`${base}/imports`, a, 'POST', selected)).json() as ArchiveImportResult;
    expect(imported.failures).toEqual([]); expect(imported.imported.map((item) => item.archiveCardId)).toEqual(selected.ids);
    await fixture.restart();
    for (const item of imported.imported) {
      const accepted = await request(`workspaces/${workspace.id}/cards/${item.card.id}/original`, a);
      expect(new Uint8Array(await accepted.arrayBuffer())).toEqual(new Uint8Array(await readFile(join(fixture.directory, 'files', `${item.archiveCardId}.json`))));
    }
    expect(await fixtureInventory(fixture.directory)).toEqual(fixture.before);
    await fixture.restart('https://archive.unity.invalid/not-an-origin');
    expect((await request('ready')).status).toBe(503); expect((await request('health')).status).toBe(200);
  }, 30000);

  it('rejects oversized and tampered Archive imports in workerd before committing cards', async () => {
    const { a } = await setup(), fixture = await archiveFixture(); await fixture.restart();
    const workspace = await (await request('workspaces', a, 'POST', { name: 'Rejected imports' })).json() as { id: string };
    const base = `workspaces/${workspace.id}`;
    fixture.transform(async (response, url) => {
      if (!url.pathname.endsWith('/manifest')) return response;
      const manifest = await response.json(); manifest.cards[0].original.byteLength = 8 * 1024 * 1024 + 1;
      return Response.json(manifest);
    });
    const selected = { snapshot: fixture.source.status(), ids: ['zlex-01'] };
    const large = await request(`${base}/archive/imports`, a, 'POST', selected);
    expect(large.status).toBe(413); expect(fixture.reads.some((path) => path.includes('/originals/'))).toBe(false);
    fixture.transform(async (response, url) => {
      if (!url.pathname.includes('/originals/')) return response;
      const bytes = new Uint8Array(await response.arrayBuffer()); bytes[0] = bytes[0]! ^ 1;
      return new Response(bytes, { headers: response.headers });
    });
    const bad = await request(`${base}/archive/imports`, a, 'POST', selected);
    expect(bad.status).toBe(503); expect(await bad.json()).toMatchObject({ error: { code: 'INTEGRITY' } });
    expect(await (await request(`${base}/cards`, a)).json()).toEqual({ cards: [] });
    expect((await (await mf.getR2Bucket('UNITY_BLOBS')).list()).objects).toEqual([]);
    const count = fixture.reads.length;
    fixture.transform(async () => new Response(null, { status: 302, headers: { location: 'https://unexpected.invalid/redirected' } }));
    const redirect = await request(`${base}/archive/status`, a);
    expect(redirect.status).toBe(503); expect(await redirect.json()).toMatchObject({ error: { code: 'PROTOCOL' } });
    expect(fixture.reads).toHaveLength(count + 1);
    expect(await fixtureInventory(fixture.directory)).toEqual(fixture.before);
  }, 30000);

  it('rechecks D1 session authority after Archive reads and before importing bytes', async () => {
    const { alice } = await setup(), fixture = await archiveFixture(); await fixture.restart();
    const accounts = createAccountStore(createD1Driver(await mf.getD1Database('UNITY_DB')));
    let revoke = false;
    fixture.transform(async (response) => { if (revoke) { revoke = false; await accounts.setEnabled(alice.account.id, false); } return response; });
    for (const suffix of ['status', 'cards', 'search?text=forest', 'search?mode=semantic&text=sea', 'selection', 'imports']) {
      await accounts.setEnabled(alice.account.id, true);
      const login = await request('session', '', 'POST', { key: alice.key }), cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const workspace = await (await request('workspaces', cookie, 'POST', { name: suffix })).json() as { id: string };
      revoke = true;
      const post = suffix === 'selection' || suffix === 'imports';
      const response = await request(`workspaces/${workspace.id}/archive/${suffix}`, cookie, post ? 'POST' : 'GET', post ? { snapshot: fixture.source.status(), ids: ['zlex-01'] } : undefined);
      if (suffix === 'imports') {
        // Selection may be read before revocation; the domain commit still refuses.
        expect(response.status).toBe(200); const result = await response.json() as ArchiveImportResult;
        expect(result.imported).toEqual([]); expect(result.interrupted).toBe(true);
      } else expect(response.status).toBe(401);
    }
    expect(await fixtureInventory(fixture.directory)).toEqual(fixture.before);
    expect((await (await mf.getR2Bucket('UNITY_BLOBS')).list()).objects).toEqual([]);
  }, 30000);

  it('fails closed before operator migration and for mismatched schema/configuration without repairing either', async () => {
    expect((await request('health')).status).toBe(200);
    expect((await request('ready')).status).toBe(503);
    expect((await request('session', '', 'POST', { key: 'invalid' })).status).toBe(503);
    const db = await mf.getD1Database('UNITY_DB');
    expect((await db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'unity_%'").all()).results).toEqual([]);
    const { driver, a } = await setup();
    expect((await request('sync/v1/capabilities', a)).status).toBe(404);
    expect(await (await request('ready')).json()).toEqual({ status: 'ready', storage: { schemaVersion: 13 } });
    await driver.batch([{ sql: "UPDATE unity_migrations SET checksum = 'changed' WHERE version = 5" }]);
    expect((await request('workspaces', a, 'POST', { name: 'Must not write' })).status).toBe(503);
    expect(await driver.query({ sql: 'SELECT id FROM unity_workspaces' })).toEqual([]);
    await mf.dispose(); await start('https://worker.unity.invalid/path');
    expect((await request('health')).status).toBe(200); expect((await request('ready')).status).toBe(503);
  });

  it('retains exact originals/assets across edit, selected publication, second-account fork, restart and revocation', async () => {
    const { bob, a, b } = await setup();
    const aw = await (await request('workspaces', a, 'POST', { name: 'Alice workspace' })).json() as { id: string };
    const bw = await (await request('workspaces', b, 'POST', { name: 'Bob workspace' })).json() as { id: string };
    const original = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Worker Aster', description: 'Accepted', extensions: { opaque: ['retain', 0] } } };
    const accepted = await request(`workspaces/${aw.id}/imports`, a, 'POST', original);
    expect(accepted.status).toBe(201);
    const imported = await accepted.json() as CardResult;
    await request(`workspaces/${aw.id}/imports`, a, 'POST', { ...original, data: { ...original.data, name: 'Not selected' } });
    const path = `workspaces/${aw.id}/cards/${imported.card.id}`;
    const document = { ...original, data: { ...original.data, description: 'Explicit edit in workerd',
      assets: [{ type: 'custom', name: 'Notes', ext: 'txt', uri: 'embedded://notes.txt', opaque: { retained: true } }] } };
    const bytes = 'Worker attachment bytes\n';
    const body = new FormData(); body.set('input', JSON.stringify({ expectedHead: imported.revision.id, document,
      bindings: [{ path: 'declared/0', source: { kind: 'upload', index: 0 } }] }));
    body.set('file:0', new Blob([bytes], { type: 'text/plain' }), 'notes.txt');
    const multipart = new Request(`${origin}/api/${path}/asset-revisions`, { method: 'POST', body });
    const response = await mf.dispatchFetch(multipart.url, { method: 'POST', headers: { origin, cookie: a, 'content-type': multipart.headers.get('content-type')! }, body: await multipart.arrayBuffer() });
    expect(response.status, await response.clone().text()).toBe(200);
    const saved = await response.json() as Revision; expect(saved.sequence).toBe(2);
    expect((await request(`${path}/revisions`, a, 'POST', { expectedHead: imported.revision.id, document })).status).toBe(409);
    const published = await request('hub/publications', a, 'POST', { workspaceId: aw.id, revisionIds: [saved.id],
      policy: { visibility: 'public', allowOriginal: false, allowFork: true } });
    expect(published.status).toBe(201);
    const id = (await published.json() as { publications: { id: string }[] }).publications[0]!.id;
    expect((await (await request('hub/publications', b)).json() as { publications: unknown[] }).publications).toHaveLength(1);
    expect((await request(path, b)).status).toBe(403);
    expect((await request(`hub/publications/${id}/original`, b)).status).toBe(404);
    const asset = await request(`hub/publications/${id}/asset?path=declared%2F0`, b);
    expect(await asset.text()).toBe(bytes); expect(asset.headers.get('cache-control')).toBe('no-store');
    const forkResponse = await request(`hub/publications/${id}/forks`, b, 'POST', { workspaceId: bw.id });
    expect(forkResponse.status).toBe(201);
    const fork = await forkResponse.json() as CardResult;
    expect(fork.revision.authorId).toBe(bob.account.id);
    expect(fork.revision.document).toHaveProperty('data.extensions.foundry.lineage.author', bob.account.uri);
    expect(fork.revision.identity).toEqual(saved.identity);
    const forkPath = `workspaces/${bw.id}/cards/${fork.card.id}`;
    const exported = await request(`${forkPath}/export?format=charx&revisionId=${fork.revision.id}`, b);
    expect(exported.status).toBe(200);
    const container = await exported.arrayBuffer();
    const reimport = await mf.dispatchFetch(`${origin}/api/workspaces/${bw.id}/imports`, { method: 'POST', headers: {
      origin, cookie: b, 'content-type': 'application/octet-stream' }, body: container });
    expect(reimport.status).toBe(201); expect((await reimport.json() as CardResult).revision.identity).toEqual(fork.revision.identity);
    expect(await (await request(`${path}/original`, a)).text()).toBe(JSON.stringify(original));
    expect((await (await mf.getR2Bucket('UNITY_BLOBS')).list({ prefix: 'pending/' })).objects).toEqual([]);
    await mf.dispose(); await start();
    expect((await request('session', b)).status).toBe(200);
    expect((await (await request(forkPath, b)).json() as CardResult).revision.id).toBe(fork.revision.id);
    expect(await (await request(`${forkPath}/asset?revisionId=${fork.revision.id}&path=declared%2F0`, b)).text()).toBe(bytes);
    expect(await (await request(`${path}/original`, a)).text()).toBe(JSON.stringify(original));
    const currentAccounts = createAccountStore(createD1Driver(await mf.getD1Database('UNITY_DB')));
    await currentAccounts.setEnabled(bob.account.id, false);
    expect((await request('session', b)).status).toBe(401);
    expect((await request(`workspaces/${bw.id}/imports`, b, 'POST', original)).status).toBe(401);
    expect((await request('session', a)).status).toBe(200);
  }, 30_000);

  it('checks canonical origins and account identity, has no local shortcut and limits login across separate requests', async () => {
    const { a, bob } = await setup();
    expect((await request('workspaces')).status).toBe(401);
    expect((await request('local-session', a, 'POST', {})).status).toBe(404);
    expect((await mf.dispatchFetch(`${origin}/api/workspaces`, { headers: { cookie: a, 'x-unity-actor': bob.account.id } })).status).toBe(409);
    expect((await mf.dispatchFetch('https://other.invalid/api/workspaces', { headers: { cookie: a } })).status).toBe(403);
    expect((await mf.dispatchFetch('http://worker.unity.invalid/api/workspaces', { headers: { cookie: a, origin } })).status).toBe(403);
    expect((await mf.dispatchFetch(`${origin}/api/workspaces`, { method: 'POST', headers: { cookie: a, origin: 'https://other.invalid' }, body: '{}' })).status).toBe(403);
    await mf.dispose(); await start(origin, 4);
    expect((await request('ready')).status, 'schema must survive restarting workerd').toBe(200);
    for (let i = 0; i < 2; i++) expect((await request('session', '', 'POST', { key: 'invalid' })).status).toBe(401);
    const limited = await request('session', '', 'POST', { key: 'invalid' });
    expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('60');
  });

  it('operator CLI uses the same persisted local D1, protects key files and never requires a public bootstrap route', async () => {
    const state = join(root, 'operator-state'), keyPath = join(root, 'operator-key.json');
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const run = (...args: string[]) => execute('pnpm', ['exec', 'tsx', 'src/accounts-cli.ts', ...args, '--worker-state', state], { cwd, timeout: 30_000 });
    await run('migrate');
    const output = await run('create', '--name', 'Worker operator', '--actor-uri', 'https://worker.example/actors/operator', '--key-file', keyPath);
    const secret = JSON.parse(await readFile(keyPath, 'utf8'));
    expect(secret.account.uri).toBe('https://worker.example/actors/operator');
    expect(output.stdout).not.toContain(secret.key); expect(output.stderr).not.toContain(secret.key);
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
    expect((await run('list')).stdout).toContain(secret.account.id);
    await expect(run('rotate', '--id', secret.account.id, '--key-file', keyPath)).rejects.toThrow();
    await mf.dispose(); await start(origin, 60, join(state, 'v3'), '00000000-0000-0000-0000-000000000000');
    const login = await request('session', '', 'POST', { key: secret.key });
    expect(login.status, await login.clone().text()).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    await mf.dispose();
    await run('disable', '--id', secret.account.id);
    expect((await run('list')).stdout).toContain('"enabled":false');
    await start(origin, 60, join(state, 'v3'), '00000000-0000-0000-0000-000000000000');
    expect((await request('session', cookie)).status).toBe(401);
  }, 120_000);
});

it('accepts only explicit HTTPS Archive configuration or a paired local loopback profile', () => {
  expect(workerArchive(undefined, origin)).toBeUndefined(); expect(workerArchive('', origin)).toBeUndefined();
  expect(workerArchive('https://archive.example', origin)).toBeDefined();
  expect(workerArchive('http://127.0.0.1:9313', 'http://127.0.0.1:9312')).toBeDefined();
  for (const value of ['http://127.0.0.1:9313', 'http://archive.example', 'https://archive.example/', 'https://archive.example/path', 'https://user:password@archive.example', 'https://archive.example?x=1', 'https://archive.example#fragment', 'file:///tmp/archive', ' https://archive.example']) expect(() => workerArchive(value, origin)).toThrow();
});
