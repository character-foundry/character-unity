import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const build = resolve('runtime/native-browser-archive-web');
await access(join(build, 'index.html'));
const directory = await mkdtemp(join(tmpdir(), 'unity-browser-archive-e2e-'));
const runId = randomUUID(), reportPath = join(directory, 'archive-invariant.json');
const publicReport = resolve('runtime/native-browser-archive-invariant.json');
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('UNITY_'))),
  UNITY_ARCHIVE_READ_ORIGINS: 'http://127.0.0.1:19435', UNITY_E2E_ARCHIVE_RUN: runId, UNITY_E2E_ARCHIVE_REPORT: reportPath };
await mkdir(resolve('runtime'), { recursive: true });
await writeFile(publicReport, JSON.stringify({ version: 'unity.native-archive-invariant.v1', runId, passed: false, status: 'running' }) + '\n');
const owned = [], failures = [];
let stopping = false, finish;
const done = new Promise(resolve => { finish = resolve; });
function signalStop() { stopping = true; finish(); }
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, signalStop);
function start(label, args) {
  const child = spawn(process.execPath, args, { env, stdio: 'inherit', detached: true });
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
let archive, browser;
try {
  archive = start('Archive', ['--import', resolve('apps/archive/node_modules/tsx/dist/loader.mjs'),
    'apps/archive/tests/unity-browser-fixture.ts', join(directory, 'archive'), '19436']);
  await ready('http://127.0.0.1:19436/api/health', archive);
  browser = start('Browser assets', ['scripts/e2e-native-browser-server.mjs', build, '19435']);
  await ready('http://127.0.0.1:19435', browser);
  // Static assets only: API operations remain in-process over browser IndexedDB.
  await done;
} catch (error) { failures.push(error); }
finally {
  stopping = true;
  for (const entry of [browser, archive]) { try { await stop(entry); } catch (error) { failures.push(error); } }
  await Promise.all(owned.map(entry => entry.exited));
  let proof;
  try {
    proof = JSON.parse(await readFile(reportPath, 'utf8'));
    if (proof.version !== 'unity.native-archive-invariant.v1' || proof.runId !== runId || proof.passed !== true ||
        !['logicalSql', 'acceptedOriginals', 'retainedVersions', 'originalLanceTables'].every(key => proof[key] === true)) {
      failures.push(new Error('The browser Archive rehearsal did not complete its immutable SQL/files/versions/Lance proof'));
    }
  } catch (error) { failures.push(error); }
  if (failures.length) {
    process.exitCode = 1;
    await writeFile(publicReport, JSON.stringify({ version: 'unity.native-archive-invariant.v1', runId, passed: false,
      checkedAt: new Date().toISOString(), errors: failures.map(error => String(error)), retainedFixture: directory }) + '\n');
    console.error(new AggregateError(failures, `Browser Archive rehearsal failed; its owned fixture is retained at ${directory}`));
  } else {
    await writeFile(publicReport, JSON.stringify({ ...proof, harnessPassed: true }) + '\n');
    await rm(directory, { recursive: true, force: true });
    console.log('Browser Archive reads/forks preserved original SQL, accepted files, retained versions and Lance tables.');
  }
  for (const signal of ['SIGTERM', 'SIGINT']) process.removeListener(signal, signalStop);
}
