import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

await access(resolve('apps/web/dist/index.html'));
// No inherited Unity/Archive settings can select a real database, credential,
// writer or path. Every process below belongs to this disposable rehearsal.
const directory = await mkdtemp(join(tmpdir(), 'unity-native-editor-e2e-'));
const runId = randomUUID(), reportPath = join(directory, 'archive-invariant.json');
const publicReport = resolve('runtime/native-archive-invariant.json');
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('UNITY_'))),
  HOST: '127.0.0.1', PORT: '19430', UNITY_PROFILE: 'local',
  UNITY_DB_PATH: join(directory, 'unity.db'), UNITY_BLOB_DIR: join(directory, 'blobs'),
  UNITY_CHAT_SCAN_SECONDS: '0', UNITY_WEB_DIR: resolve('apps/web/dist'),
  UNITY_E2E_ARCHIVE_RUN: runId, UNITY_E2E_ARCHIVE_REPORT: reportPath,
};
await mkdir(resolve('runtime'), { recursive: true });
// A killed/failed run cannot accidentally reuse a previous success report.
await writeFile(publicReport, JSON.stringify({ version: 'unity.native-archive-invariant.v1', runId, passed: false, status: 'running' }) + '\n');
const owned = [];
let stopping = false, finish;
const failures = [];
const done = new Promise(resolve => { finish = resolve; });
function signalStop() { stopping = true; finish(); }
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, signalStop);
function start(label, script, args = []) {
  const child = spawn(process.execPath, ['--import', resolve(label === 'Archive' ? 'apps/archive/node_modules/tsx/dist/loader.mjs' : 'apps/api/node_modules/tsx/dist/loader.mjs'), script, ...args],
    { env, stdio: 'inherit', detached: true });
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => {
      if (!stopping) { failures.push(new Error(`${label} exited unexpectedly (${code ?? signal})`)); finish(); }
      resolve({ code, signal });
    });
    child.once('error', error => { failures.push(error); finish(); resolve({ code: null, signal: null, error }); });
  });
  const entry = { label, child, exited }; owned.push(entry); return entry;
}
async function ready(url, entry) {
  const deadline = Date.now() + 30_000;
  while (!stopping && Date.now() < deadline) {
    if (entry.child.exitCode !== null || entry.child.signalCode !== null || failures.length) throw new Error(`${entry.label} failed before readiness`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; }
    catch { /* Only this owned fixture is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${entry.label} readiness was interrupted or timed out`);
}
async function stop(entry) {
  if (!entry) return;
  if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGTERM');
  let timer;
  try {
    const result = await Promise.race([entry.exited, new Promise((_, reject) => {
      timer = setTimeout(() => { entry.child.kill('SIGKILL'); reject(new Error(`${entry.label} failed to stop gracefully`)); }, 8000);
    })]);
    if (result.error || result.code !== 0 || result.signal !== null) throw new Error(`${entry.label} shutdown failed (${result.code ?? result.signal})`);
  } finally { clearTimeout(timer); }
}
let archive, api;
try {
  archive = start('Archive', 'apps/archive/tests/unity-browser-fixture.ts', [join(directory, 'archive')]);
  await ready('http://127.0.0.1:19431/api/health', archive);
  env.UNITY_ARCHIVE_NATIVE_ORIGIN = 'http://127.0.0.1:19431';
  env.UNITY_ARCHIVE_ADMIN_TOKEN = 'unity-browser-test-admin-token';
  env.UNITY_ARCHIVE_LIBRARY_INDEX = '1';
  api = start('Unity', 'apps/api/src/node.ts');
  await ready('http://127.0.0.1:19430/api/ready', api);
  // The shipped Node host serves the production bundle/API from one origin.
  await done;
} catch (error) { failures.push(error); }
finally {
  stopping = true;
  // Stop Unity first so its owned index deliveries settle before Archive closes.
  for (const entry of [api, archive]) {
    try { await stop(entry); } catch (error) { failures.push(error); }
  }
  await Promise.all(owned.map(entry => entry.exited));
  let proof;
  try {
    proof = JSON.parse(await readFile(reportPath, 'utf8'));
    if (proof.version !== 'unity.native-archive-invariant.v1' || proof.runId !== runId || proof.passed !== true ||
        !['logicalSql', 'acceptedOriginals', 'retainedVersions', 'originalLanceTables'].every(key => proof[key] === true)) {
      failures.push(new Error('The native Archive fixture did not complete its immutable SQL/files/versions/Lance proof'));
    }
  } catch (error) { failures.push(error); }
  if (failures.length) {
    process.exitCode = 1;
    await writeFile(publicReport, JSON.stringify({ version: 'unity.native-archive-invariant.v1', runId, passed: false,
      checkedAt: new Date().toISOString(), errors: failures.map(error => String(error)), retainedFixture: directory }) + '\n');
    console.error(new AggregateError(failures, `Native rehearsal failed; its owned fixture is retained at ${directory}`));
  } else {
    await writeFile(publicReport, JSON.stringify({ ...proof, harnessPassed: true }) + '\n');
    await rm(directory, { recursive: true, force: true });
    console.log('Native Archive fixture preserved its logical SQL, accepted originals, retained versions and original Lance tables.');
  }
  for (const signal of ['SIGTERM', 'SIGINT']) process.removeListener(signal, signalStop);
}
