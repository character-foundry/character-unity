import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer, request as httpsRequest } from 'node:https';
import { createServer as tcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const { createSyncCommandClient, createSyncReadClient, createSyncToken, encodeSyncForkSubmission, SYNC_FORK_VERSION } = createRequire(new URL('../packages/api/package.json', import.meta.url))('@character-foundry/character-foundry/sync');

const { createCardRevision, readCardLineage } = createRequire(new URL('../packages/api/package.json', import.meta.url))('@character-foundry/character-foundry/identity');

// Linux Docker Engine rehearsal. Requires only Node, Docker, OpenSSL and the built
// image and the bootstrapped public SDK. Never touches other containers/volumes or uses host application storage.
const image = process.argv[2];
if (!image || image.startsWith('-')) throw new Error('Pass the built Unity image tag or ID');
const exec = promisify(execFile);
const docker = async (...args) => (await exec('docker', args, { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
const metadata = JSON.parse(await docker('image', 'inspect', image))[0];
assert.equal(metadata.Os, 'linux');
assert.equal(metadata.Config.User, 'node');
assert.ok(metadata.Config.Env.includes('UNITY_WEB_DIR=/app/web/unity'), 'The API image must default to the native Unity UI');
const nativeWebRoot = 'apps/web/dist';
const nativeIndex = await readFile(join(nativeWebRoot, 'index.html'));
const name = `unity-rehearsal-${randomUUID()}`;
const temp = await mkdtemp(join(tmpdir(), `${name}-`));
const volumes = [], containers = new Set();
let proxy;
const label = `character-unity.rehearsal=${name}`;
async function volume(suffix) {
  const value = `${name}-${suffix}`;
  await docker('volume', 'create', '--label', label, value); volumes.push(value); return value;
}
async function run(suffix, dataVolume, args) {
  const value = `${name}-${suffix}`;
  // Create separately: cleanup only IDs whose creation succeeded, even if start fails.
  const id = await docker('create', '--name', value, '--label', label, '--init',
    '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--mount', `type=volume,src=${dataVolume},dst=/data`, ...args, metadata.Id);
  containers.add(id); await docker('start', id); return id;
}
async function stop(id) {
  await docker('stop', '--time', '10', id);
  const state = JSON.parse(await docker('inspect', '--format', '{{json .State}}', id));
  assert.equal(state.ExitCode, 0, 'Container must stop gracefully');
  assert.equal(state.OOMKilled, false);
  await docker('rm', id); containers.delete(id);
}
async function ready(id, url) {
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    const state = JSON.parse(await docker('inspect', '--format', '{{json .State}}', id));
    if (!state.Running) throw new Error(`Container exited: ${await docker('logs', id)}`);
    try {
      const response = await fetch(`${url}/api/ready`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        assert.deepEqual(await response.json(), { status: 'ready', storage: { schemaVersion: 13 } });
        return;
      }
    } catch { /* Retry only this live container's startup. */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Container readiness timed out: ${await docker('logs', id)}`);
}
async function healthy(id) {
  const started = Date.now();
  while (Date.now() - started < 40_000) {
    const value = JSON.parse(await docker('inspect', '--format', '{{json .State.Health}}', id));
    if (value.Status === 'healthy') return;
    if (value.Status === 'unhealthy') throw new Error('Image healthcheck failed');
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error('Image healthcheck did not become healthy');
}
const abort = new AbortController();
const onSignal = () => abort.abort(new Error('Container rehearsal interrupted'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, onSignal);
try {
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(temp, 'key.pem'),
    '-out', join(temp, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
  const cert = await readFile(join(temp, 'cert.pem'));
  let backend;
  proxy = createServer({ cert, key: await readFile(join(temp, 'key.pem')) }, (request, response) => {
    if (!backend) { response.writeHead(503).end(); return; }
    // Preserve Host and Origin. The app must ignore client-supplied forwarded headers.
    const upstream = httpRequest(`${backend}${request.url}`, { method: request.method, headers: request.headers,
      timeout: 30_000 }, (result) => { response.writeHead(result.statusCode, result.headers); result.pipe(response); });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    upstream.on('timeout', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const origin = `https://127.0.0.1:${proxy.address().port}`;
  const peerActor = 'https://container-peer.invalid/actors/bob', peerKeyId = `${peerActor}#one`;
  const data = await volume('hub');
  async function startHub(suffix) {
    const id = await run(suffix, data, ['-p', '127.0.0.1::9312', '-e', `UNITY_PUBLIC_ORIGIN=${origin}`, '-e', 'UNITY_SYNC_ENABLED=true', '-e', 'UNITY_SYNC_WRITES_ENABLED=true']);
    const mapping = JSON.parse(await docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', id))['9312/tcp'][0];
    assert.equal(mapping.HostIp, '127.0.0.1');
    backend = `http://127.0.0.1:${mapping.HostPort}`;
    await ready(id, backend); return id;
  }
  let hub = await startHub('hub-first');
  assert.equal(await docker('exec', hub, 'id', '-u'), '1000');
  await docker('exec', hub, 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    for (const path of ['native-rehearsal.js', 'node_modules/@lancedb/lancedb', 'node_modules/apache-arrow']) assert.equal(existsSync(path), false);
    for (const path of ['web/unity/index.html', 'web/hub/index.html', 'web/architect/index.html']) assert.equal(existsSync(path), true);
  `);
  const node = await docker('exec', hub, 'node', '--version');
  const foundryCommit = JSON.parse(await docker('exec', hub, 'cat', 'foundry-sdk.json')).commit;
  assert.equal(foundryCommit, JSON.parse(await readFile('foundry-sdk.json', 'utf8')).commit);
  assert.deepEqual(JSON.parse(await docker('exec', hub, 'node', 'peers-cli.js', 'list')), { peers: [], nextAfter: null });
  assert.deepEqual(JSON.parse(await docker('exec', hub, 'node', 'assets-cli.js', 'preview', '--database', '/data/unity.db', '--before', '2000-01-01T00:00:00.000Z')), { assets: [], nextAfter: null });
  assert.deepEqual(JSON.parse(await docker('exec', hub, 'node', 'assets-cli.js', 'sweep', '--database', '/data/unity.db', '--blob-dir', '/data/blobs')), { results: [], nextAfter: null });
  const generatedPeer = JSON.parse(await docker('exec', hub, 'node', 'peers-cli.js', 'keygen', '--private-key-file', '/tmp/peer.private.pem', '--public-key-file', '/tmp/peer.public.pem'));
  assert.match(generatedPeer.fingerprint, /^SHA256:[a-f0-9]{64}$/);
  assert.equal(await docker('exec', hub, 'stat', '-c', '%a', '/tmp/peer.private.pem'), '600');
  const accounts = {};
  for (const name of ['Alice', 'Bob']) {
    await docker('exec', hub, 'node', 'accounts-cli.js', 'create', '--name', name, '--key-file', `/tmp/${name}.json`, ...(name === 'Bob' ? ['--actor-uri', peerActor] : []));
    assert.equal(await docker('exec', hub, 'stat', '-c', '%a', `/tmp/${name}.json`), '600');
    // Credentials remain in memory and the container's ephemeral /tmp, never logs/reports.
    accounts[name] = JSON.parse(await docker('exec', hub, 'cat', `/tmp/${name}.json`));
  }
  async function request(path, { method = 'GET', body, cookie = '', headers = {}, status = 200 } = {}) {
    abort.signal.throwIfAborted();
    const encoded = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const response = await new Promise((resolve, reject) => {
      // Pin TLS SNI separately so a deliberately wrong HTTP Host reaches the
      // application's Host check instead of changing certificate verification.
      const request = httpsRequest(`${origin}${path}`, { method, ca: cert, servername: 'localhost', signal: abort.signal,
        headers: { origin, cookie, ...(encoded ? { 'content-type': 'application/json', 'content-length': String(encoded.length) } : {}), ...headers } }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk)); response.on('error', reject);
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
      });
      request.setTimeout(30_000, () => request.destroy(new Error('HTTPS request timed out')));
      request.on('error', reject); request.end(encoded);
    });
    assert.equal(response.status, status, `${method} ${path}: ${response.bytes.toString().slice(0, 300)}`);
    return { ...response, json: () => JSON.parse(response.bytes) };
  }
  const home = await request('/');
  assert.deepEqual(home.bytes, nativeIndex, 'The default image serves the exact native application entry');
  for (const path of ['/explore', '/archive', '/new', '/search', '/settings', '/sharing', '/remotes', '/chat-apps',
    '/card/container-saved-card', '/card/container-saved-card/edit', '/card/container-saved-card/fork']) {
    const page = await request(path);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.deepEqual(page.bytes, nativeIndex, `${path} must open the native React Router application`);
  }
  const asset = home.bytes.toString().match(/src="([^"]+\.js)"/); assert.ok(asset);
  const entryScript = await request(asset[1]);
  assert.match(entryScript.headers['content-type'], /javascript/);
  assert.deepEqual(entryScript.bytes, await readFile(join(nativeWebRoot, asset[1].slice(1))), 'Container serves the exact native entry bundle');
  const tokenizerPath = entryScript.bytes.toString().match(/\/assets\/tokenizer\.worker-[A-Za-z0-9_-]+\.js/)?.[0];
  assert.ok(tokenizerPath, 'Native Unity must reference its separate tokenizer worker');
  const tokenizer = await request(tokenizerPath);
  assert.match(tokenizer.headers['content-type'], /javascript/);
  assert.deepEqual(tokenizer.bytes, await readFile(join(nativeWebRoot, tokenizerPath.slice(1))), 'Container serves the exact native tokenizer worker bytes');
  assert.deepEqual((await request('/api/client')).json(), { profile: 'hub', capabilities: { browserLLM: false } });
  for (const path of ['/data/unity.db', '/accounts-cli.js', '/peers-cli.js', '/assets-cli.js', '/foundry-sdk.json', '/api/not-a-route']) {
    await request(path, { status: path.startsWith('/api/') ? 401 : 404 });
  }
  await request('/api/workspaces', { status: 401 });
  await request('/api/local-session', { method: 'POST', status: 404 });
  await request('/api/session', { method: 'POST', body: { key: accounts.Alice.key }, headers: { origin: 'https://elsewhere.invalid' }, status: 403 });
  await request('/api/session', { headers: { host: 'elsewhere.invalid', 'x-forwarded-host': new URL(origin).host, 'x-forwarded-proto': 'https' }, status: 403 });
  const clients = {};
  for (const name of ['Alice', 'Bob']) {
    const login = await request('/api/session', { method: 'POST', body: { key: accounts[name].key },
      headers: { 'x-forwarded-host': 'elsewhere.invalid', 'x-forwarded-proto': 'http' } });
    const cookie = login.headers['set-cookie'][0];
    assert.match(cookie, /^__Host-unity_hub=/);
    for (const flag of ['; Secure', '; HttpOnly', '; SameSite=Strict', '; Path=/;']) assert.ok(cookie.includes(flag));
    assert.ok(!cookie.includes('Domain='));
    assert.equal(login.json().actor.uri, accounts[name].account.uri);
    clients[name] = (path, options = {}) => request(`/api/${path}`, { cookie: cookie.split(';')[0], ...options,
      headers: { 'x-unity-actor': accounts[name].account.id, ...options.headers } });
  }
  const alice = clients.Alice, bob = clients.Bob;
  const aw = (await alice('workspaces', { method: 'POST', body: { name: 'Container source' }, status: 201 })).json();
  const bw = (await bob('workspaces', { method: 'POST', body: { name: 'Container fork' }, status: 201 })).json();
  assert.deepEqual((await alice('remotes/connections')).json(), { connections: [] });
  assert.deepEqual((await alice(`remotes/workspaces/${aw.id}/jobs`)).json(), { jobs: [], nextAfter: null });
  assert.equal((await alice('workspaces', { headers: { 'x-unity-actor': accounts.Bob.account.id }, status: 409 })).json().error.code, 'ACCOUNT_CHANGED');
  assert.equal((await alice('hub/publications', { headers: { 'x-unity-actor': accounts.Bob.account.id }, status: 409 })).json().error.code, 'ACCOUNT_CHANGED');
  assert.equal((await alice('remotes/connections', { headers: { 'x-unity-actor': accounts.Bob.account.id }, status: 409 })).json().error.code, 'ACCOUNT_CHANGED');
  const original = await readFile('e2e/fixtures/opaque-assets.png');
  const imported = (await alice(`workspaces/${aw.id}/imports`, { method: 'POST', body: original,
    headers: { 'content-type': 'image/png', 'x-file-name': 'opaque-assets.png' }, status: 201 })).json();
  const path = `workspaces/${aw.id}/cards/${imported.card.id}`;
  const blockedOriginal = await alice(`${path}/original`, { headers: { 'x-unity-actor': accounts.Bob.account.id }, status: 409 });
  assert.match(blockedOriginal.headers['content-type'], /json/);
  assert.equal(blockedOriginal.json().error.code, 'ACCOUNT_CHANGED');
  imported.revision.document.data.description = 'Saved inside the container.';
  const saved = (await alice(`${path}/revisions`, { method: 'POST', body: { expectedHead: imported.revision.id, document: imported.revision.document } })).json();
  const published = (await alice('hub/publications', { method: 'POST', body: { workspaceId: aw.id, revisionIds: [saved.id],
    policy: { visibility: 'members', allowOriginal: false, allowFork: true } }, status: 201 })).json();
  assert.equal((await bob('hub/publications')).json().publications.length, 1);
  const fork = (await bob(`hub/publications/${published.publications[0].id}/forks`, { method: 'POST', body: { workspaceId: bw.id }, status: 201 })).json();
  assert.equal(fork.revision.document.data.extensions.foundry.lineage.author, accounts.Bob.account.uri);
  const forkPath = `workspaces/${bw.id}/cards/${fork.card.id}`;
  const exportPath = `${forkPath}/export?revisionId=${fork.revision.id}&format=charx`;
  const exported = (await bob(exportPath)).bytes;
  assert.deepEqual((await alice(`${path}/original`)).bytes, original);
  assert.equal(accounts.Bob.account.uri, peerActor);
  await docker('exec', hub, 'node', 'peers-cli.js', 'grant', '--actor', peerActor, '--account', accounts.Bob.account.id,
    '--workspace', bw.id, '--scopes', 'pull,publish,fork');
  await docker('exec', hub, 'node', 'peers-cli.js', 'add-key', '--actor', peerActor, '--key-id', peerKeyId,
    '--public-key-file', '/tmp/peer.public.pem');
  const privatePem = await docker('exec', hub, 'cat', '/tmp/peer.private.pem');
  const privateKey = await crypto.subtle.importKey('pkcs8', Buffer.from(privatePem.replace(/-----[^-]+-----|\s/g, ''), 'base64'), 'Ed25519', false, ['sign']);
  // Real TLS requests, pinned only to this rehearsal's temporary certificate.
  // No browser Origin or cookie headers, and no global TLS verification override.
  const signedFetch = async (url, init) => new Promise((resolve, reject) => {
    assert.equal(new URL(url).origin, origin);
    const request = httpsRequest(url, { method: init.method, ca: cert, servername: 'localhost',
      signal: AbortSignal.any([abort.signal, init.signal]), headers: Object.fromEntries(new Headers(init.headers)) }, (response) => {
      const chunks = []; let size = 0;
      response.on('data', (chunk) => { size += chunk.length; if (size > 34 * 1024 * 1024) request.destroy(new Error('Sync rehearsal response exceeded bound')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode,
        headers: Object.entries(response.headers).flatMap(([name, value]) => value === undefined ? [] : Array.isArray(value) ? value.map((entry) => [name, entry]) : [[name, value]]) })));
    });
    request.on('error', reject); request.end(init.body);
  });
  const connection = { baseUrl: `${origin}/api/sync/v1`, actor: peerActor, keyId: peerKeyId, privateKey, fetch: signedFetch };
  const commands = createSyncCommandClient(connection), reads = createSyncReadClient(connection);
  const forkId = createSyncToken(), publishId = createSyncToken();
  const signedFork = await commands.fork(published.publications[0].id, forkId);
  assert.equal(signedFork.operation, 'publications.fork');
  assert.deepEqual(await commands.fork(published.publications[0].id, forkId), signedFork);
  const selection = { revisionIds: [signedFork.revisionId], policy: { visibility: 'members', allowFork: true } };
  const signedPublished = await commands.publish(selection, publishId);
  const signedPublication = await reads.get(signedPublished.publications[0].id);
  assert.equal(signedPublication.parentId, published.publications[0].id);
  assert.deepEqual(signedPublication.identity, fork.revision.identity);
  for (const asset of signedPublication.assets) assert.equal((await reads.asset(signedPublication, asset.path)).length, asset.byteLength);
  const remoteParent = await reads.get(published.publications[0].id);
  const remoteAssets = await Promise.all(remoteParent.assets.map((asset) => reads.asset(remoteParent, asset.path)));
  const portrait = remoteParent.assets.find((asset) => asset.binding.kind === 'portrait');
  const identityOptions = { assets: remoteParent.assets.flatMap((asset) => asset.binding.kind === 'uri' ? [{ pointer: asset.binding.pointer, hash: asset.hash }] : []),
    ...(portrait ? { portraitHash: portrait.hash } : {}) };
  const parentLineage = readCardLineage(remoteParent.document);
  const remoteFork = await createCardRevision(remoteParent.document, { ...identityOptions, originalHash: remoteParent.originalHash,
    parents: parentLineage ? [parentLineage] : [], operation: 'fork', author: peerActor, createdAt: new Date().toISOString(), nonce: 'container_remote_fork_0001' });
  const enriched = structuredClone(remoteFork.card); enriched.data.description = 'Edited by the independent HTTPS SDK client';
  const remoteEdit = await createCardRevision(enriched, { ...identityOptions, originalHash: remoteParent.originalHash, parents: [remoteFork.lineage],
    operation: 'edit', author: peerActor, createdAt: new Date().toISOString(), nonce: 'container_remote_edit_0001' });
  const remoteBytes = await encodeSyncForkSubmission({ manifest: { version: SYNC_FORK_VERSION, publicationId: remoteParent.id, baseIdentity: remoteParent.identity,
    originalHash: remoteParent.originalHash, document: remoteEdit.card, identity: remoteEdit.lineage.content, ancestry: [remoteFork.lineage], assets: remoteParent.assets }, assets: remoteAssets });
  const remoteId = createSyncToken();
  const remoteAccepted = await commands.submitFork(remoteBytes, remoteId);
  assert.equal(remoteAccepted.operation, 'forks.submit');
  const remotePublished = await commands.publish({ revisionIds: [remoteAccepted.revisionId], policy: { visibility: 'members', allowFork: true } }, createSyncToken());
  const remoteVisible = await reads.get(remotePublished.publications[0].id);
  assert.equal(remoteVisible.parentId, remoteParent.id); assert.deepEqual(remoteVisible.document, remoteEdit.card);
  for (const [index, asset] of remoteVisible.assets.entries()) assert.deepEqual(await reads.asset(remoteVisible, asset.path), remoteAssets[index]);
  assert.deepEqual((await bob(`workspaces/${bw.id}/cards/${remoteAccepted.cardId}/original`)).bytes, Buffer.from(remoteBytes));
  await healthy(hub);
  await stop(hub); hub = await startHub('hub-recreated');
  assert.deepEqual(await commands.fork(published.publications[0].id, forkId), signedFork);
  assert.deepEqual(await commands.publish(selection, publishId), signedPublished);
  assert.deepEqual(await commands.submitFork(remoteBytes, remoteId), remoteAccepted);
  assert.deepEqual((await reads.get(signedPublication.id)).identity, signedPublication.identity);
  // Same account sessions, revisions and immutable blobs must survive replacement.
  assert.equal((await alice('session')).json().actor.uri, accounts.Alice.account.uri);
  assert.equal((await alice(path)).json().revision.id, saved.id);
  assert.equal((await bob(forkPath)).json().revision.id, fork.revision.id);
  assert.deepEqual((await alice(`${path}/original`)).bytes, original);
  const returned = (await bob(`workspaces/${bw.id}/imports`, { method: 'POST', body: (await bob(exportPath)).bytes,
    headers: { 'content-type': 'application/zip', 'x-file-name': 'fork.charx' }, status: 201 })).json();
  const returnedCard = (await bob(`workspaces/${bw.id}/cards/${returned.card.id}`)).json();
  assert.deepEqual(returnedCard.revision.identity, fork.revision.identity);
  assert.deepEqual(returnedCard.revision.document.data.extensions.foundry.lineage, fork.revision.document.data.extensions.foundry.lineage);
  assert.ok(exported.length > 0);
  // CLI changes share the same database and revoke existing sessions after restart.
  await docker('exec', hub, 'node', 'accounts-cli.js', 'disable', '--id', accounts.Bob.account.id);
  await bob('workspaces', { status: 401 });
  await assert.rejects(commands.publish(selection, publishId), { code: 'UNAUTHENTICATED' });
  await assert.rejects(commands.submitFork(remoteBytes, remoteId), { code: 'UNAUTHENTICATED' });
  await stop(hub);
  await new Promise((done) => proxy.close(done)); proxy = undefined;

  const listener = tcpServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise((done) => listener.close(done));
  const architectOrigin = `http://127.0.0.1:${port}`;
  const localData = await volume('architect');
  const nativeLocal = await run('unity-local', localData, ['--network', 'host', '-e', 'UNITY_PROFILE=local', '-e', 'HOST=127.0.0.1', '-e', `PORT=${port}`]);
  await ready(nativeLocal, architectOrigin);
  for (const path of ['/', '/sharing', '/remotes', '/card/local-saved-card/edit']) {
    const response = await fetch(`${architectOrigin}${path}`); assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), nativeIndex, 'The local profile defaults to the same native application');
  }
  assert.deepEqual(await (await fetch(`${architectOrigin}/api/client`)).json(), { profile: 'local', capabilities: { browserLLM: true } });
  const nativeSession = await fetch(`${architectOrigin}/api/local-session`, { method: 'POST', headers: { origin: architectOrigin, 'x-unity-session': 'local' } });
  assert.equal(nativeSession.status, 200);
  const nativeCookie = nativeSession.headers.get('set-cookie').split(';')[0];
  const nativeWorkspace = await fetch(`${architectOrigin}/api/workspaces`, { method: 'POST', headers: { origin: architectOrigin, cookie: nativeCookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Local Unity' }) });
  assert.equal(nativeWorkspace.status, 201);
  const nativeWorkspaceId = (await nativeWorkspace.json()).id;
  await healthy(nativeLocal); await stop(nativeLocal);
  // Explicitly retained scaffold, same local origin and volume: no browser or server data migration.
  const architect = await run('architect', localData, ['--network', 'host', '-e', 'UNITY_PROFILE=local', '-e', 'HOST=127.0.0.1',
    '-e', `PORT=${port}`, '-e', 'UNITY_WEB_DIR=/app/web/architect']);
  await ready(architect, architectOrigin);
  const page = await fetch(architectOrigin); assert.equal(page.status, 200);
  const html = await page.text(); assert.match(html, /Character Unity/);
  const localAsset = html.match(/src="([^"]+\.js)"/); assert.ok(localAsset);
  const localScript = await fetch(`${architectOrigin}${localAsset[1]}`);
  assert.equal(localScript.status, 200); assert.match(localScript.headers.get('content-type'), /javascript/);
  const local = await fetch(`${architectOrigin}/api/local-session`, { method: 'POST', headers: { origin: architectOrigin, 'x-unity-session': 'local' } });
  assert.equal(local.status, 200);
  const localCookie = local.headers.get('set-cookie').split(';')[0];
  const retainedWorkspaces = await fetch(`${architectOrigin}/api/workspaces`, { headers: { origin: architectOrigin, cookie: localCookie } });
  assert.equal(retainedWorkspaces.status, 200);
  assert.ok((await retainedWorkspaces.json()).workspaces.some((workspace) => workspace.id === nativeWorkspaceId), 'Explicit legacy UI selection preserves the existing local library');
  const workspace = await fetch(`${architectOrigin}/api/workspaces`, { method: 'POST', headers: { origin: architectOrigin, cookie: localCookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Local Architect' }) });
  assert.equal(workspace.status, 201);
  await healthy(architect); await stop(architect);

  const report = { version: 'unity.container-rehearsal.v2', imageId: metadata.Id, platform: `${metadata.Os}/${metadata.Architecture}`,
    node, foundryCommit,
    schemaVersion: 13, nonRoot: true, readOnlyRoot: true, httpsProxy: true, secureCookieAttributes: true,
    nativeUiDefault: true, nativeUiDeepLinks: true, nativeEntryAndTokenizerBytes: true, actorProofJsonAndBinary: true, nativeLocalLinuxHostNetwork: true,
    twoAccountPublishFork: true, immutablePublicActorProvisioning: true, signedReadPublishFork: true, verifiedRemoteForkReturn: true, signedReceiptsSurviveContainerReplacement: true, assetBearingCharxReimport: true, unchangedOriginal: true,
    sessionAndStorageSurviveContainerReplacement: true, accountRevocation: true, architectLinuxHostNetwork: true, gracefulStop: true };
  await mkdir('runtime', { recursive: true }); await writeFile('runtime/container-rehearsal.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (proxy) { proxy.closeAllConnections(); await new Promise((done) => proxy.close(done)); }
  const failures = [];
  for (const id of containers) {
    try {
      await mkdir('runtime', { recursive: true });
      await writeFile(`runtime/container-${id.slice(0, 12)}.log`, await docker('logs', id));
    } catch (error) { failures.push(error); }
    // Log failures must not prevent removal of a container owned by this run.
    try { await docker('rm', '--force', id); } catch (error) { failures.push(error); }
  }
  for (const value of volumes.reverse()) {
    try { await docker('volume', 'rm', value); } catch (error) { failures.push(error); }
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, onSignal);
  await rm(temp, { recursive: true, force: true });
  if (failures.length) {
    console.error(new AggregateError(failures, 'Could not clean up owned rehearsal resources'));
    process.exitCode = 1;
  }
}
