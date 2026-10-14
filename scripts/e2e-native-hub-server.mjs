import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

await access(resolve('apps/web/dist/index.html'));
const directory = await mkdtemp(join(tmpdir(), 'unity-native-hub-e2e-'));
const credentialsPath = join(directory, 'accounts.json');
const fixturePath = resolve('runtime/e2e-native-hub.json');
await mkdir(resolve('runtime'), { recursive: true });
const env = { ...process.env };
// Test-owned storage and peers only. No inherited corpus, account, signing or writer config.
for (const key of Object.keys(env)) if (key.startsWith('UNITY_')) delete env[key];
Object.assign(env, { HOST: '127.0.0.1', PORT: '19432', UNITY_PROFILE: 'hub', UNITY_PUBLIC_ORIGIN: 'http://127.0.0.1:19432',
  UNITY_DB_PATH: join(directory, 'unity.db'), UNITY_BLOB_DIR: join(directory, 'blobs'), UNITY_CHAT_SCAN_SECONDS: '0', UNITY_WEB_DIR: resolve('apps/web/dist') });
const children = new Set();
let stopping = false;
let fixtureWritten = false;
function start(args) {
  const child = spawn(process.execPath, args, { env, stdio: 'inherit' });
  const exited = new Promise((resolve) => { child.once('exit', resolve); child.once('error', resolve); });
  children.add({ child, exited });
  return child;
}
function stop(signal = 'SIGTERM') {
  stopping = true;
  for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stop(signal));
async function ready(origin, child, path = '/api/ready') {
  const deadline = Date.now() + 30_000;
  while (!stopping && Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Owned native hub fixture exited during startup');
    try { if ((await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* Still starting this owned host. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Owned native hub fixture readiness timed out');
}
try {
  const seed = start(['--import', resolve('apps/api/node_modules/tsx/dist/loader.mjs'), 'apps/api/tests/native-hub-browser-fixture.ts', directory, credentialsPath]);
  const [seedCode] = await once(seed, 'exit');
  if (seedCode !== 0) throw new Error('Operator fixture bootstrap failed');
  const { readFile, writeFile } = await import('node:fs/promises');
  await writeFile(fixturePath, await readFile(credentialsPath), { mode: 0o600, flag: 'wx' });
  fixtureWritten = true;
  const archive = start(['--import', resolve('apps/archive/node_modules/tsx/dist/loader.mjs'), 'apps/archive/tests/unity-browser-fixture.ts', join(directory, 'archive'), '19433']);
  await ready('http://127.0.0.1:19433', archive, '/api/health');
  env.UNITY_ARCHIVE_NATIVE_ORIGIN = 'http://127.0.0.1:19433';
  env.UNITY_ARCHIVE_ADMIN_TOKEN = 'unity-browser-test-admin-token';
  const api = start(['--import', resolve('apps/api/node_modules/tsx/dist/loader.mjs'), 'apps/api/src/node.ts']);
  await ready('http://127.0.0.1:19432', api);
  await Promise.race([archive, api].map((child) => once(child, 'exit').then(([code]) => { if (!stopping) process.exitCode = code || 1; })));
} finally {
  stop(); await Promise.all([...children].map(({ exited }) => exited));
  await rm(directory, { recursive: true, force: true });
  if (fixtureWritten) await rm(fixturePath, { force: true });
}
