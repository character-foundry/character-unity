import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

await access(resolve('apps/web/dist/index.html'));
// No existing library or Archive path can enter this harness, even through inherited env.
const directory = await mkdtemp(join(tmpdir(), 'unity-native-editor-e2e-'));
const env = { ...process.env, HOST: '127.0.0.1', PORT: '19431', UNITY_PROFILE: 'local',
  UNITY_DB_PATH: join(directory, 'unity.db'), UNITY_BLOB_DIR: join(directory, 'blobs'),
  UNITY_CHAT_SCAN_SECONDS: '0', UNITY_API_ORIGIN: 'http://127.0.0.1:19431',
  UNITY_WEB_HOST: '127.0.0.1', UNITY_WEB_PORT: '19430' };
for (const key of ['UNITY_WEB_DIR', 'UNITY_ARCHIVE_ORIGIN', 'UNITY_ARCHIVE_NATIVE_ORIGIN',
  'UNITY_ARCHIVE_ADMIN_TOKEN', 'UNITY_REMOTE_CONNECTIONS_FILE', 'UNITY_PUBLIC_ORIGIN']) delete env[key];
const children = [];
let stopping = false;
function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stop(signal));
try {
  const api = spawn(process.execPath, ['--import', resolve('apps/api/node_modules/tsx/dist/loader.mjs'), 'apps/api/src/node.ts'], { env, stdio: 'inherit' });
  children.push(api);
  const deadline = Date.now() + 30_000;
  while (true) {
    if (api.exitCode !== null || api.signalCode !== null) throw new Error('Unity test API exited before becoming ready');
    try { if ((await fetch('http://127.0.0.1:19431/api/ready')).ok) break; } catch { /* The isolated API is still starting. */ }
    if (Date.now() >= deadline) throw new Error('Unity test API did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Preview serves the production bundle and inherits the API proxy configured by UNITY_API_ORIGIN.
  const web = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '19430', '--strictPort'], { cwd: resolve('apps/web'), env, stdio: 'inherit' });
  children.push(web);
  const exits = children.map(async (child) => {
    const [code] = await once(child, 'exit');
    if (!stopping) { process.exitCode = code || 1; stop(); }
  });
  await Promise.all(exits);
} finally {
  stop();
  await rm(directory, { recursive: true, force: true });
}
