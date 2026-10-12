import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { verifyAssetFlow } from './sillytavern-assets-flow.mjs';
import { withSillyTavern } from './sillytavern-host.mjs';

const checkout = process.argv[2];
if (!checkout) throw new Error('Pass an explicit clean SillyTavern checkout with installed dependencies');
await promisify(execFile)(process.execPath, ['scripts/assert-foundry.mjs']);
const foundryPin = JSON.parse(await readFile('foundry-sdk.json', 'utf8'));
const temp = await mkdtemp(join(tmpdir(), 'unity-interoperability-'));
const children = [];
async function port() {
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const value = listener.address().port; await new Promise((done) => listener.close(done)); return value;
}
async function start(name, file, env, ready) {
  let log = ''; const child = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'exit'); const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
  children.push({ child, exit, stop, name, log: () => log });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
  child.stdout.on('data', (chunk) => { log += chunk; }); child.stderr.on('data', (chunk) => { log += chunk; });
  const started = Date.now();
  while (true) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${name} exited before readiness`);
    try { const response = await fetch(ready, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; }
    catch { /* startup retries stay tied to this live child */ }
    if (Date.now() - started > 30_000) throw new Error(`${name} readiness timed out`);
    await new Promise((done) => setTimeout(done, 100));
  }
}
try {
  const archivePort = await port(), apiPort = await port();
  const archiveOrigin = `http://127.0.0.1:${archivePort}`, apiOrigin = `http://127.0.0.1:${apiPort}`;
  const database = join(temp, 'unity.db');
  const accounts = {};
  for (const name of ['Alice', 'Bob']) {
    const keyPath = join(temp, `${name}.json`);
    await promisify(execFile)(process.execPath, ['apps/api/dist/accounts-cli.js', 'create', '--name', name, '--database', database, '--key-file', keyPath]);
    accounts[name] = JSON.parse(await readFile(keyPath, 'utf8'));
  }
  await start('archive', 'apps/archive/dist/node.js', { HOST: '127.0.0.1', PORT: String(archivePort), UNITY_ARCHIVE_MODE: 'fixture' }, `${archiveOrigin}/api/health`);
  await start('api', 'apps/api/dist/node.js', { HOST: '127.0.0.1', PORT: String(apiPort), UNITY_PROFILE: 'hub', UNITY_PUBLIC_ORIGIN: apiOrigin,
    UNITY_DB_PATH: database, UNITY_BLOB_DIR: join(temp, 'blobs'), UNITY_ARCHIVE_ORIGIN: archiveOrigin }, `${apiOrigin}/api/ready`);
  async function login(name) {
    let cookie = '';
    async function request(path, method = 'GET', body, expectedStatus = 200) {
      const multipart = body instanceof FormData; const binary = body instanceof Uint8Array;
      const response = await fetch(`${apiOrigin}/api/${path}`, { method, headers: { origin: apiOrigin, cookie,
        ...(body === undefined || multipart ? {} : { 'content-type': binary ? 'application/octet-stream' : 'application/json' }) }, ...(body === undefined ? {} : { body: typeof body === 'string' || multipart || binary ? body : JSON.stringify(body) }),
        redirect: 'error', signal: AbortSignal.timeout(35_000) });
      assert.equal(response.status, expectedStatus, `${method} ${path}: ${response.status} (${expectedStatus} expected)`);
      return response;
    }
    const response = await request('session', 'POST', { key: accounts[name].key });
    cookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal((await response.json()).actor.uri, accounts[name].account.uri);
    return request;
  }
  const alice = await login('Alice'), bob = await login('Bob');
  const aliceWorkspace = await (await alice('workspaces', 'POST', { name: 'Archive desk' }, 201)).json();
  const bobWorkspace = await (await bob('workspaces', 'POST', { name: 'Fork desk' }, 201)).json();
  const sourceStatus = await (await fetch(`${archiveOrigin}/api/archive/v1/status`)).json();
  const archiveOriginals = new Map();
  for (const id of ['aster', 'birch', 'cinder']) {
    const sourceCard = await (await fetch(`${archiveOrigin}/api/archive/v1/cards/${id}?snapshot=${sourceStatus.snapshot}`)).json();
    const url = `${archiveOrigin}/api/archive/v1/originals/${sourceCard.card.original.hash}?snapshot=${sourceStatus.snapshot}`;
    archiveOriginals.set(id, { url, bytes: new Uint8Array(await (await fetch(url)).arrayBuffer()) });
  }
  const archivePage = await (await alice(`workspaces/${aliceWorkspace.id}/archive/cards`)).json();
  const snapshot = { version: archivePage.version, archiveId: archivePage.archiveId, snapshot: archivePage.snapshot };
  const imports = await (await alice(`workspaces/${aliceWorkspace.id}/archive/imports`, 'POST', { snapshot, ids: ['aster', 'cinder'] })).json();
  assert.equal(imports.imported.length, 2); assert.equal(imports.failures.length, 0);
  // Resolve by preserved source provenance rather than relying on result ordering.
  const opened = await Promise.all(imports.imported.map(async (entry) => (await alice(`workspaces/${aliceWorkspace.id}/cards/${entry.card.id}`)).json()));
  const aster = opened.find((entry) => entry.source.provenance.cardId === 'aster'); assert.ok(aster);
  aster.revision.document.data.description = 'Edited from Archive before publication.';
  const saved = await (await alice(`workspaces/${aliceWorkspace.id}/cards/${aster.card.id}/revisions`, 'POST', { expectedHead: aster.revision.id, document: aster.revision.document })).json();
  const receipt = await (await alice('hub/publications', 'POST', { workspaceId: aliceWorkspace.id, revisionIds: [saved.id],
    policy: { visibility: 'members', allowOriginal: false, allowFork: true } }, 201)).json();
  assert.equal((await (await bob('hub/publications')).json()).publications.length, 1);
  const fork = await (await bob(`hub/publications/${receipt.publications[0].id}/forks`, 'POST', { workspaceId: bobWorkspace.id }, 201)).json();
  assert.equal(fork.revision.document.data.extensions.foundry.lineage.author, accounts.Bob.account.uri);
  const forkSource = new Uint8Array(await (await bob(`workspaces/${bobWorkspace.id}/cards/${fork.card.id}/original`)).arrayBuffer());
  const exported = new Uint8Array(await (await bob(`workspaces/${bobWorkspace.id}/cards/${fork.card.id}/export?revisionId=${fork.revision.id}&format=sillytavern-json`)).arrayBuffer());
  await withSillyTavern(checkout, async ({ request: st, commit }) => {
    const form = new FormData(); form.set('avatar', new Blob([exported], { type: 'application/json' }), 'fork.json'); form.set('file_type', 'json');
    const imported = await (await st('/api/characters/import', { method: 'POST', body: form })).json();
    assert.ok(imported.file_name);
    const avatar = `${imported.file_name}.png`;
    async function stJson(path, value) { return st(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }); }
    const returned = await (await stJson('/api/characters/export', { avatar_url: avatar, format: 'json' })).text();
    const reimported = await (await bob(`workspaces/${bobWorkspace.id}/imports`, 'POST', returned, 201)).json();
    assert.deepEqual(reimported.revision.identity, fork.revision.identity);
    assert.deepEqual(reimported.revision.document.data.extensions.foundry.lineage, fork.revision.document.data.extensions.foundry.lineage);
    assert.equal(reimported.card.originalHash, aster.card.originalHash);
    assert.equal(await (await bob(`workspaces/${bobWorkspace.id}/cards/${reimported.card.id}/original`)).text(), returned);
    assert.deepEqual(new Uint8Array(await (await bob(`workspaces/${bobWorkspace.id}/cards/${fork.card.id}/original`)).arrayBuffer()), forkSource);
    for (const entry of opened) assert.deepEqual(new Uint8Array(await (await alice(`workspaces/${aliceWorkspace.id}/cards/${entry.card.id}/original`)).arrayBuffer()), archiveOriginals.get(entry.source.provenance.cardId).bytes);
    for (const original of archiveOriginals.values()) assert.deepEqual(new Uint8Array(await (await fetch(original.url)).arrayBuffer()), original.bytes);
    assert.deepEqual(await (await fetch(`${archiveOrigin}/api/archive/v1/status`)).json(), sourceStatus);
    await stJson('/api/characters/edit-attribute', { avatar_url: avatar, ch_name: 'aster', field: 'description', value: 'A real external prompt edit.' });
    const changed = await (await stJson('/api/characters/export', { avatar_url: avatar, format: 'json' })).text();
    const rejected = await (await bob(`workspaces/${bobWorkspace.id}/imports`, 'POST', changed, 400)).json();
    assert.ok(rejected.error);
    assert.equal((await (await bob(`workspaces/${bobWorkspace.id}/cards`)).json()).cards.length, 2);
    const assets = await verifyAssetFlow({ checkout, alice, bob, aliceWorkspace, bobWorkspace, aster, saved, st });
    for (const original of archiveOriginals.values()) assert.deepEqual(new Uint8Array(await (await fetch(original.url)).arrayBuffer()), original.bytes);
    assert.deepEqual(await (await fetch(`${archiveOrigin}/api/archive/v1/status`)).json(), sourceStatus);
    const result = { version: 'unity.sillytavern-flow.v2', sillyTavernCommit: commit, foundryCommit: foundryPin.commit, archive: 'synthetic read fixture', profile: 'sillytavern-json', assets,
      realAccountSessions: 2, exactPublicationSelection: true, forkAuthor: accounts.Bob.account.uri,
      originalHash: reimported.card.originalHash, content: reimported.revision.identity,
      revisionHash: reimported.revision.document.data.extensions.foundry.lineage.revisionHash,
      unchangedOriginals: true, externalEditRejected: true, externalEditError: rejected.error.code };
    await mkdir('runtime', { recursive: true }); await writeFile('runtime/sillytavern-flow.json', JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  });
} finally {
  for (const entry of children.reverse()) {
    entry.stop(); const force = setTimeout(() => { if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL'); }, 5000);
    await entry.exit; clearTimeout(force);
    for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, entry.stop);
    await mkdir('runtime', { recursive: true }); await writeFile(`runtime/sillytavern-${entry.name}.log`, entry.log());
  }
  await rm(temp, { recursive: true, force: true });
}
