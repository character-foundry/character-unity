import { access, mkdtemp, rm, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';

// Two disposable real Node hosts. The HTTPS proxy can lose one successful return
// response via a test-owned file; no application test routes or login bypasses exist.
const webDirectory = resolve(process.argv[2] ?? 'apps/web/dist');
await access(join(webDirectory, 'index.html'));
const hostArgs = process.argv[2]
  ? ['--import', resolve('apps/api/node_modules/tsx/dist/loader.mjs'), 'apps/api/src/node.ts']
  : ['apps/api/dist/node.js'];
const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('UNITY_')));
const directory = await mkdtemp(join(tmpdir(), 'unity-remote-browser-'));
const fixturePath = resolve('runtime/e2e-remote.json');
const senderOrigin = 'http://127.0.0.1:19314', receiverOrigin = 'https://127.0.0.1:19315';
const actor = 'https://sender.example/actors/editor', keyId = `${actor}#browser`;
const lostResponseFile = join(directory, 'lose-next-return');
const exec = promisify(execFile), children = new Set();
let proxy, stopping = false, finish;
const done = new Promise((resolve) => { finish = resolve; });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { stopping = true; finish(); });
function start(env) {
  const child = spawn(process.execPath, hostArgs, { env: { ...inheritedEnv, UNITY_REMOTE_CONNECTIONS_FILE: undefined,
    UNITY_SYNC_ENABLED: 'false', UNITY_SYNC_WRITES_ENABLED: 'false', UNITY_ARCHIVE_ORIGIN: undefined,
    UNITY_PROFILE: 'hub', HOST: '127.0.0.1', UNITY_WEB_DIR: webDirectory, ...env }, stdio: 'inherit' });
  const exited = new Promise((resolve) => {
    child.once('exit', (code) => { if (!stopping) { process.exitCode = code || 1; finish(); } resolve(); });
    child.once('error', () => { process.exitCode = 1; finish(); resolve(); });
  });
  const owned = { child, exited }; children.add(owned); return owned;
}
async function ready(url, child) {
  const until = Date.now() + 15_000;
  while (Date.now() < until && !stopping) {
    if (child.exitCode !== null) throw new Error('Remote browser fixture host exited during startup');
    try { const response = await fetch(`${url}/api/ready`, { signal: AbortSignal.timeout(500) }); if (response.ok) return; } catch { /* This owned host is still starting. */ }
    await wait(100);
  }
  throw new Error('Remote browser fixture readiness timed out');
}
async function createAccount(database, name, publicActor) {
  const file = join(directory, `${name}.json`);
  await exec(process.execPath, ['apps/api/dist/accounts-cli.js', 'create', '--database', database, '--name', name, '--key-file', file,
    ...(publicActor ? ['--actor-uri', publicActor] : [])]);
  return JSON.parse(await readFile(file, 'utf8'));
}
try {
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'tls.key'), '-out', join(directory, 'tls.pem'),
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
  const cert = await readFile(join(directory, 'tls.pem'));
  proxy = createServer({ cert, key: await readFile(join(directory, 'tls.key')) }, async (request, response) => {
    let lose = false;
    if (request.method === 'POST' && request.url?.startsWith('/api/sync/v1/commands/submit-fork/')) {
      try { await readFile(lostResponseFile); await unlink(lostResponseFile); lose = true; } catch { /* No requested fault. */ }
    }
    const upstream = httpRequest(`http://127.0.0.1:19316${request.url}`, { method: request.method, headers: request.headers, timeout: 30_000 }, (result) => {
      if (lose && result.statusCode === 200) { result.resume(); result.once('end', () => response.destroy()); }
      else { response.writeHead(result.statusCode, result.headers); result.pipe(response); }
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  proxy.listen(19315, '127.0.0.1'); await once(proxy, 'listening');
  const receiverDb = join(directory, 'receiver.db'), senderDb = join(directory, 'sender.db');
  const publisher = await createAccount(receiverDb, 'Publisher'), receiver = await createAccount(receiverDb, 'Receiver');
  const editor = await createAccount(senderDb, 'Editor', actor), outsider = await createAccount(senderDb, 'Outsider');
  const receiverProcess = start({ PORT: '19316', UNITY_PUBLIC_ORIGIN: receiverOrigin, UNITY_SYNC_ENABLED: 'true', UNITY_SYNC_WRITES_ENABLED: 'true',
    UNITY_DB_PATH: receiverDb, UNITY_BLOB_DIR: join(directory, 'receiver-blobs') });
  await ready('http://127.0.0.1:19316', receiverProcess.child);
  const request = (path, body, cookie = '') => new Promise((resolve, reject) => {
    const req = httpsRequest(`${receiverOrigin}/api/${path}`, { ca: cert, method: 'POST', headers: { origin: receiverOrigin, cookie, 'content-type': 'application/json' } }, (response) => {
      const chunks = []; response.on('data', (chunk) => chunks.push(chunk)); response.on('error', reject); response.on('end', () => {
        if (![200, 201].includes(response.statusCode)) { reject(new Error(`Fixture setup failed (${response.statusCode})`)); return; }
        resolve({ body: JSON.parse(Buffer.concat(chunks).toString()), cookie: response.headers['set-cookie']?.[0]?.split(';')[0] });
      });
    }); req.on('error', reject); req.end(JSON.stringify(body));
  });
  const session = await request('session', { key: receiver.key });
  const workspace = (await request('workspaces', { name: 'Remote returns' }, session.cookie)).body;
  const privatePath = join(directory, 'signing.key'), publicPath = join(directory, 'signing.pub');
  await exec(process.execPath, ['apps/api/dist/peers-cli.js', 'keygen', '--private-key-file', privatePath, '--public-key-file', publicPath]);
  await exec(process.execPath, ['apps/api/dist/peers-cli.js', 'grant', '--database', receiverDb, '--actor', actor, '--account', receiver.account.id,
    '--workspace', workspace.id, '--scopes', 'pull,fork,publish']);
  await exec(process.execPath, ['apps/api/dist/peers-cli.js', 'add-key', '--database', receiverDb, '--actor', actor, '--key-id', keyId, '--public-key-file', publicPath]);
  const config = join(directory, 'connections.json');
  await writeFile(config, JSON.stringify({ version: 'unity.remote-connections.v1', connections: [{ id: 'friends', name: 'Friends hub',
    accountId: editor.account.id, actor, baseUrl: `${receiverOrigin}/api/sync/v1`, keyId, privateKeyPem: await readFile(privatePath, 'utf8') }] }), { mode: 0o600 });
  await writeFile(fixturePath, JSON.stringify({ publisher, receiver, editor, outsider, workspaceId: workspace.id, lostResponseFile }), { mode: 0o600 });
  const senderProcess = start({ PORT: '19314', UNITY_PUBLIC_ORIGIN: senderOrigin, UNITY_DB_PATH: senderDb,
    UNITY_BLOB_DIR: join(directory, 'sender-blobs'), UNITY_REMOTE_CONNECTIONS_FILE: config, NODE_EXTRA_CA_CERTS: join(directory, 'tls.pem') });
  await ready(senderOrigin, senderProcess.child);
  await done;
} finally {
  stopping = true;
  for (const { child } of children) if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.all([...children].map(({ exited }) => exited));
  if (proxy) { proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); }
  await rm(directory, { recursive: true, force: true }); await rm(fixturePath, { force: true });
}
