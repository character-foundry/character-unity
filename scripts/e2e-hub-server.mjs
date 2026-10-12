import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';

const directory = await mkdtemp(join(tmpdir(), 'unity-hub-browser-test-'));
const credentialsPath = resolve('runtime/e2e-hub-accounts.json');
let child;
try {
  const accounts = {};
  for (const name of ['Alice', 'Bob']) {
    const keyPath = join(directory, `${name}.json`);
    await promisify(execFile)(process.execPath, ['apps/api/dist/accounts-cli.js', 'create', '--name', name,
      '--database', join(directory, 'unity.db'), '--key-file', keyPath]);
    accounts[name] = JSON.parse(await readFile(keyPath, 'utf8'));
  }
  // Synthetic test accounts only. Never expose a login shortcut in the server.
  await writeFile(credentialsPath, JSON.stringify(accounts), { mode: 0o600 });
  child = spawn(process.execPath, ['apps/api/dist/node.js'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '19312', UNITY_PROFILE: 'hub', UNITY_PUBLIC_ORIGIN: 'http://127.0.0.1:19312',
      UNITY_DB_PATH: join(directory, 'unity.db'), UNITY_BLOB_DIR: join(directory, 'blobs'), UNITY_ARCHIVE_ORIGIN: 'http://127.0.0.1:19313', UNITY_WEB_DIR: resolve('apps/hub/dist') },
    stdio: 'inherit',
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { if (child.exitCode === null) child.kill(signal); });
  const [code] = await once(child, 'exit'); process.exitCode = code ?? 0;
} finally {
  await rm(directory, { recursive: true, force: true }); await rm(credentialsPath, { force: true });
}
