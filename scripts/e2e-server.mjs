import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const directory = await mkdtemp(join(tmpdir(), 'unity-browser-test-'));
const child = spawn(process.execPath, ['apps/api/dist/node.js'], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: '19310', UNITY_PROFILE: 'local', UNITY_DB_PATH: join(directory, 'unity.db'),
    UNITY_BLOB_DIR: join(directory, 'blobs'), UNITY_ARCHIVE_ORIGIN: 'http://127.0.0.1:19313', UNITY_WEB_DIR: resolve('apps/architect/dist') },
  stdio: 'inherit',
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { if (child.exitCode === null) child.kill(signal); });
try {
  const [code] = await once(child, 'exit');
  process.exitCode = code ?? 0;
} finally { await rm(directory, { recursive: true, force: true }); }
