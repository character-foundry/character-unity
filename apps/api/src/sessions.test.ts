import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccountApi } from '@character-unity/api/sessions';
import { createCardService } from '@character-unity/cards';
import { openLocalServices } from './services.js';

const execute = promisify(execFile);
const origin = 'http://127.0.0.1:19312';
describe('real account session HTTP profile', () => {
  let directory: string;
  let services: Awaited<ReturnType<typeof openLocalServices>>;
  let app: ReturnType<typeof createAccountApi>;
  let alice: Awaited<ReturnType<typeof services.accounts.create>>;
  let bob: typeof alice;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'unity-sessions-'));
    services = await openLocalServices({ databasePath: join(directory, 'unity.db'), blobDirectory: join(directory, 'blobs') });
    alice = await services.accounts.create('Alice'); bob = await services.accounts.create('Bob');
    app = createAccountApi({ origin, accounts: services.accounts, store: services.store, forSession: services.forSession });
  });
  afterEach(async () => { services?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
  function request(path: string, cookie = '', method = 'GET', body?: unknown) {
    return app.request(`${origin}/api/${path}`, { method, headers: { cookie, origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function login(key: string, priorCookie = '') {
    const response = await request('session', priorCookie, 'POST', { key });
    expect(response.status).toBe(200);
    const header = response.headers.get('set-cookie')!;
    expect(header).toContain('HttpOnly'); expect(header).toContain('SameSite=Strict'); expect(header).toContain('Max-Age=28800');
    return { cookie: header.split(';')[0]!, body: await response.json() };
  }

  it('saves multipart asset revisions and scopes immutable asset reads to their owner and card', async () => {
    const a = await login(alice.key), b = await login(bob.key);
    const workspace = await (await request('workspaces', a.cookie, 'POST', { name: 'Asset edits' })).json();
    const original = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Private assets', extensions: {} } };
    const imported = await (await request(`workspaces/${workspace.id}/imports`, a.cookie, 'POST', original)).json();
    const other = await (await request(`workspaces/${workspace.id}/imports`, a.cookie, 'POST', { ...original, data: { ...original.data, name: 'Other private card' } })).json();
    const base = `workspaces/${workspace.id}/cards/${imported.card.id}`;
    const document = structuredClone(imported.revision.document);
    document.data.assets = [{ type: 'custom', name: 'notes', ext: 'txt', uri: 'embedded://notes.txt', custom: { keep: true } }];
    const bindings = [{ path: 'declared/0', source: { kind: 'upload', index: 0 } }];
    const body = () => {
      const form = new FormData();
      form.set('input', JSON.stringify({ expectedHead: imported.revision.id, document, bindings }));
      form.set('file:0', new Blob(['Private asset bytes\n'], { type: 'text/plain' }), 'notes.txt');
      return form;
    };
    const post = (form: FormData, cookie = a.cookie) => app.request(`${origin}/api/${base}/asset-revisions`, { method: 'POST', headers: { origin, cookie }, body: form });
    expect((await post(body(), b.cookie)).status).toBe(403);
    expect((await post(body(), '')).status).toBe(401);
    for (const variant of ['duplicate', 'sparse', 'extra', 'metadata'] as const) {
      const form = body();
      if (variant === 'duplicate') form.append('input', '{}');
      if (variant === 'sparse') { form.set('file:2', form.get('file:0')!); form.delete('file:0'); }
      if (variant === 'extra') form.set('file:1', new Blob(['unused']));
      if (variant === 'metadata') form.set('input', JSON.stringify({ expectedHead: imported.revision.id, document, bindings, actor: bob.account.id }));
      expect((await post(form)).status).toBe(400);
    }
    expect((await request(`${base}/asset-revisions`, a.cookie, 'POST', {})).status).toBe(400);
    const response = await post(body()); expect(response.status).toBe(200);
    const saved = await response.json(); expect(saved.sequence).toBe(2);
    expect(saved.document.data.assets[0].custom).toEqual({ keep: true });
    const listPath = `${base}/assets?revisionId=${saved.id}`;
    const assetPath = `${base}/asset?revisionId=${saved.id}&path=declared%2F0`;
    const listing = await (await request(listPath, a.cookie)).json();
    expect(listing).toMatchObject({ revisionId: saved.id, assets: [{ path: 'declared/0', mediaType: 'text/plain', byteLength: 20 }] });
    expect(Object.keys(listing.assets[0]).sort()).toEqual(['byteLength', 'hash', 'mediaType', 'path']);
    const bytes = await request(assetPath, a.cookie);
    expect(bytes.headers.get('content-disposition')).toContain('attachment'); expect(bytes.headers.get('content-security-policy')).toContain('sandbox');
    expect(bytes.headers.get('x-content-type-options')).toBe('nosniff'); expect(await bytes.text()).toBe('Private asset bytes\n');
    for (const path of [listPath, assetPath]) {
      expect((await request(path, b.cookie)).status).toBe(403);
      expect((await request(path.replace(imported.card.id, other.card.id), a.cookie)).status).toBe(404);
      expect((await request(`${path}&revisionId=${saved.id}`, a.cookie)).status).toBe(400);
      expect((await request(`${path}&extra=1`, a.cookie)).status).toBe(400);
    }
    expect((await request(`${base}/assets`, a.cookie)).status).toBe(400);
    expect((await request(`${base}/asset?revisionId=${saved.id}&path=../original`, a.cookie)).status).toBe(400);
    expect((await request(`${base}/asset?revisionId=${imported.revision.id}&path=declared%2F0`, a.cookie)).status).toBe(404);
    expect((await post(body())).status).toBe(409);
    expect(await (await request(`${base}/original`, a.cookie)).json()).toEqual(original);
    await services.accounts.setEnabled(alice.account.id, false);
    expect((await request(listPath, a.cookie)).status).toBe(401);
    expect((await request(assetPath, a.cookie)).status).toBe(401);
    expect((await post(body())).status).toBe(401);
  });

  it('rejects an asset revision revoked after upload without advancing the existing card', async () => {
    const session = await login(alice.key);
    const workspace = await (await request('workspaces', session.cookie, 'POST', { name: 'Asset revocation' })).json();
    const original = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Unchanged', extensions: {} } };
    const imported = await (await request(`workspaces/${workspace.id}/imports`, session.cookie, 'POST', original)).json();
    const interrupted = createAccountApi({ origin, accounts: services.accounts, store: services.store, forSession(proof) {
      const scoped = services.forSession(proof);
      const cards = createCardService(scoped.store, { ...scoped.assets, async upload(...args) {
        const result = await scoped.assets.upload(...args);
        await services.accounts.setEnabled(alice.account.id, false); return result;
      } });
      return { ...scoped, cards };
    } });
    const document = structuredClone(imported.revision.document);
    document.data.assets = [{ type: 'custom', name: 'notes', ext: 'txt', uri: 'embedded://notes.txt' }];
    const form = new FormData();
    form.set('input', JSON.stringify({ expectedHead: imported.revision.id, document, bindings: [{ path: 'declared/0', source: { kind: 'upload', index: 0 } }] }));
    form.set('file:0', new Blob(['Uploaded before revocation'], { type: 'text/plain' }));
    const response = await interrupted.request(`${origin}/api/workspaces/${workspace.id}/cards/${imported.card.id}/asset-revisions`, {
      method: 'POST', headers: { origin, cookie: session.cookie }, body: form,
    });
    expect(response.status).toBe(401);
    expect((await services.store.getCard(workspace.id, imported.card.id)).headRevisionId).toBe(imported.revision.id);
    expect(await services.store.listRevisions(workspace.id, imported.card.id)).toHaveLength(1);
    expect((await services.store.getRevision(workspace.id, imported.revision.id)).assets).toEqual([]);
  });

  it('keeps private revision history scoped to the owning account and revokes reads with the session', async () => {
    const a = await login(alice.key), b = await login(bob.key);
    const workspace = await (await request('workspaces', a.cookie, 'POST', { name: 'Private history' })).json();
    const imported = await (await request(`workspaces/${workspace.id}/imports`, a.cookie, 'POST', {
      spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Private', extensions: { privateNote: 'Owner only' } },
    })).json();
    const path = `workspaces/${workspace.id}/cards/${imported.card.id}/revisions`;
    expect((await request(path, a.cookie)).status).toBe(200);
    expect((await request(`${path}/${imported.revision.id}`, a.cookie)).status).toBe(200);
    for (const route of [path, `${path}/${imported.revision.id}`]) {
      expect((await request(route, b.cookie)).status).toBe(403);
      expect((await request(route)).status).toBe(401);
    }
    await services.accounts.setEnabled(alice.account.id, false);
    expect((await request(path, a.cookie)).status).toBe(401);
    expect((await request(`${path}/${imported.revision.id}`, a.cookie)).status).toBe(401);
  });

  it('uses independent real sessions for workspace isolation, publication and a second-user fork', async () => {
    const a = await login(alice.key); const b = await login(bob.key);
    expect(a.cookie).not.toBe(b.cookie); expect(JSON.stringify(a.body)).not.toContain('cuk_'); expect(JSON.stringify(a.body)).not.toContain('cus_');
    const workspace = await (await request('workspaces', a.cookie, 'POST', { name: 'Alice' })).json() as { id: string };
    const target = await (await request('workspaces', b.cookie, 'POST', { name: 'Bob' })).json() as { id: string };
    const original = JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Aster', description: 'Original', extensions: {} } });
    const imported = await app.request(`${origin}/api/workspaces/${workspace.id}/imports`, { method: 'POST', headers: { origin, cookie: a.cookie }, body: original });
    expect(imported.status).toBe(201);
    const value = await imported.json() as { card: { id: string }; revision: { id: string } };
    expect((await request(`workspaces/${workspace.id}/cards`, b.cookie)).status).toBe(403);
    const published = await request('hub/publications', a.cookie, 'POST', { workspaceId: workspace.id, revisionIds: [value.revision.id], policy: { visibility: 'members', allowFork: true, allowOriginal: false } });
    expect(published.status).toBe(201);
    const { publications } = await published.json() as { publications: { id: string }[] };
    const fork = await request(`hub/publications/${publications[0]!.id}/forks`, b.cookie, 'POST', { workspaceId: target.id });
    expect(fork.status).toBe(201);
    expect(await fork.json()).toHaveProperty('revision.document.data.extensions.foundry.lineage.author', bob.account.uri);
    expect((await request(`hub/publications/${publications[0]!.id}/original`, b.cookie)).status).toBe(404);
    expect(await (await request(`workspaces/${workspace.id}/cards/${value.card.id}/original`, a.cookie)).text()).toBe(original);
  });

  it('revokes replaced/logout/rotated/disabled sessions and offers no account-profile local bypass', async () => {
    const first = await login(alice.key);
    const replacement = await login(alice.key, first.cookie);
    expect((await request('workspaces', first.cookie)).status).toBe(401);
    expect((await request('local-session', replacement.cookie, 'POST', {})).status).toBe(404);
    expect((await request('session', replacement.cookie, 'DELETE')).status).toBe(204);
    expect((await request('workspaces', replacement.cookie)).status).toBe(401);
    const beforeRotation = await login(alice.key);
    const next = await services.accounts.rotateKey(alice.account.id);
    expect((await request('workspaces', beforeRotation.cookie)).status).toBe(401);
    expect((await request('session', '', 'POST', { key: alice.key })).status).toBe(401);
    const current = await login(next.key);
    await services.accounts.setEnabled(alice.account.id, false);
    expect((await request('session', current.cookie)).status).toBe(401);
    expect((await request('workspaces', current.cookie, 'POST', { name: 'Denied' })).status).toBe(401);
  });

  it('rejects cross-origin/host requests, duplicate cookies, oversized login bodies and uncontrolled login bursts', async () => {
    const current = await login(alice.key);
    for (const headers of [{ origin: 'https://foreign.invalid' }, { 'sec-fetch-site': 'cross-site' }]) {
      expect((await app.request(`${origin}/api/session`, { method: 'POST', headers: { origin, cookie: current.cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ key: alice.key }) })).status).toBe(403);
    }
    expect((await app.request('http://wrong.invalid/api/session', { headers: { cookie: current.cookie, 'x-forwarded-host': '127.0.0.1:19312' } })).status).toBe(403);
    expect((await request('workspaces', `${current.cookie}; ${current.cookie}`)).status).toBe(401);
    expect((await request('session', '', 'POST', { key: 'x'.repeat(2000) })).status).toBe(413);
    let rateLimited = false;
    for (let i = 0; i < 65; i++) {
      const response = await request('session', '', 'POST', { key: 'invalid' });
      if (response.status === 429) { expect(response.headers.get('retry-after')).toBe('60'); rateLimited = true; break; }
    }
    expect(rateLimited).toBe(true);
  });

  it('uses host-bound Secure cookies for configured HTTPS origins and refuses insecure remote origins', async () => {
    for (const value of ['http://hub.example', 'https://hub.example/', 'https://user:pass@hub.example', 'https://hub.example/path']) {
      expect(() => createAccountApi({ origin: value, accounts: services.accounts, store: services.store, forSession: services.forSession })).toThrow();
    }
    const tls = createAccountApi({ origin: 'https://hub.example', accounts: services.accounts, store: services.store, forSession: services.forSession });
    const response = await tls.request('http://hub.example/api/session', { method: 'POST', headers: { origin: 'https://hub.example', 'content-type': 'application/json' }, body: JSON.stringify({ key: alice.key }) });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^__Host-unity_hub=/); expect(cookie).toContain('Path=/;'); expect(cookie).toContain('; Secure'); expect(cookie).not.toContain('Domain=');
  });

  it('operator CLI creates protected key files, lists without credentials, rotates and disables accounts', async () => {
    const script = new URL('./accounts-cli.ts', import.meta.url).pathname;
    const keyFile = join(directory, 'key.json');
    const args = ['--import', 'tsx', script];
    const cli = (...rest: string[]) => execute(process.execPath, [...args, ...rest, '--database', join(directory, 'unity.db')], { cwd: new URL('..', import.meta.url).pathname });
    const created = await cli('create', '--name', 'CLI account', '--actor-uri', 'https://cli.example/actors/alice', '--key-file', keyFile);
    expect(created.stdout).not.toContain('cuk_');
    const key = JSON.parse(await readFile(keyFile, 'utf8')) as { account: { id: string; uri: string }; key: string };
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    expect(key.account.uri).toBe('https://cli.example/actors/alice');
    await expect(cli('rotate', '--id', key.account.id, '--key-file', keyFile)).rejects.toThrow();
    expect(await services.accounts.login(key.key)).not.toBeNull();
    const listing = await cli('list'); expect(listing.stdout).not.toContain('key_hash'); expect(listing.stdout).not.toContain(key.key);
    const rotatedPath = join(directory, 'rotated.json');
    await cli('rotate', '--id', key.account.id, '--key-file', rotatedPath);
    const rotated = JSON.parse(await readFile(rotatedPath, 'utf8')) as { key: string };
    expect(await services.accounts.login(key.key)).toBeNull(); expect(await services.accounts.login(rotated.key)).not.toBeNull();
    await cli('disable', '--id', key.account.id); expect(await services.accounts.login(rotated.key)).toBeNull();
  });

  it('rejects an in-flight import after account revocation without committing the card', async () => {
    const session = await login(alice.key);
    const workspace = await (await request('workspaces', session.cookie, 'POST', { name: 'Revocation race' })).json() as { id: string };
    const interrupted = createAccountApi({ origin, accounts: services.accounts, store: services.store, forSession(proof) {
      const scoped = services.forSession(proof);
      const cards = createCardService(scoped.store, { ...scoped.assets, async upload(...args) {
        const result = await scoped.assets.upload(...args);
        await services.accounts.setEnabled(alice.account.id, false);
        return result;
      } });
      return { ...scoped, cards };
    } });
    const response = await interrupted.request(`${origin}/api/workspaces/${workspace.id}/imports`, {
      method: 'POST', headers: { origin, cookie: session.cookie },
      body: JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Interrupted', extensions: {} } }),
    });
    expect(response.status).toBe(401); expect(await services.store.listCards(workspace.id)).toEqual([]);
  });

  it('rejects stale-tab actor assertions instead of writing or logging out the newly signed-in account', async () => {
    const a = await login(alice.key);
    const b = await login(bob.key, a.cookie);
    for (const [path, method, body] of [['workspaces', 'POST', '{"name":"Wrong actor"}'], ['session', 'DELETE', undefined]] as const) {
      const response = await app.request(`${origin}/api/${path}`, { method, headers: { origin, cookie: b.cookie, 'x-unity-actor': alice.account.id, 'content-type': 'application/json' }, ...(body ? { body } : {}) });
      expect(response.status).toBe(409); expect(await response.json()).toHaveProperty('error.code', 'ACCOUNT_CHANGED');
    }
    expect((await request('session', b.cookie)).status).toBe(200);
    expect(await services.store.listWorkspaces(bob.account.id)).toEqual([]);
  });
});
