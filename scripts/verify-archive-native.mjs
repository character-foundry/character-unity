import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

// Independent processes reopen persisted native files, never a live Archive path.
const exec = promisify(execFile);
const temp = await mkdtemp(join(tmpdir(), 'unity-archive-native-'));
try {
  const results = [];
  for (const operation of ['seed', 'check']) {
    const { stdout } = await exec(process.execPath, [resolve('apps/archive/dist/native-rehearsal.js'), operation, join(temp, 'fixture')], { timeout: 30_000 });
    results.push(JSON.parse(stdout));
  }
  assert.equal(results[0].snapshot, results[1].snapshot);
  const generated = JSON.parse((await exec(process.execPath, [resolve('apps/archive/dist/generation-cli.js'), 'lexical', '--copy', join(temp, 'fixture', 'copy'), '--output', join(temp, 'generated'), '--as-of', '2026-10-12T00:00:00.000Z'], { timeout: 30_000 })).stdout);
  assert.equal(generated.state, 'ready'); assert.equal(generated.cardCount, 3);
  // Generation must leave every input byte and queue sentinel unchanged.
  const afterGeneration = JSON.parse((await exec(process.execPath, [resolve('apps/archive/dist/native-rehearsal.js'), 'check', join(temp, 'fixture')], { timeout: 30_000 })).stdout);
  assert.equal(afterGeneration.snapshot, results[0].snapshot);
  const semantic = [];
  for (const operation of ['generate', 'generation-check']) semantic.push(JSON.parse((await exec(process.execPath, [resolve('apps/archive/dist/native-rehearsal.js'), operation, join(temp, 'fixture'), join(temp, 'semantic')], { timeout: 30000 })).stdout));
  assert.equal(semantic[0].generated.snapshot, semantic[1].generated.snapshot);
  assert.equal(semantic[0].generated.firstCursor, semantic[1].generated.firstCursor);
  // Existing paths must be refused, including the probe's own previous fixture.
  await assert.rejects(exec(process.execPath, [resolve('apps/archive/dist/native-rehearsal.js'), 'seed', join(temp, 'fixture')]), /EEXIST/);
  await mkdir('runtime', { recursive: true });
  await writeFile('runtime/archive-native-rehearsal.json', JSON.stringify({ results, generated, afterGeneration, semantic }, null, 2) + '\n');
  console.log('Archive native install/reopen and lexical/semantic generation rehearsal passed (SQLite, LanceDB FTS and exact vectors).');
} finally { await rm(temp, { recursive: true, force: true }); }
