import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

// Only creates synthetic data in a uniquely named Docker volume. Every container
// runs without a network, as uid 1000, with a read-only root. Reopen and service
// checks additionally mount the entire data volume read-only.
const image = process.argv[2];
if (!image || image.startsWith('-') || process.argv.length !== 3) throw new Error('Pass the built Archive image tag or ID');
const exec = promisify(execFile);
const docker = async (...args) => (await exec('docker', args, { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
const metadata = JSON.parse(await docker('image', 'inspect', image))[0];
assert.equal(metadata.Os, 'linux'); assert.equal(metadata.Config.User, 'node');
const name = `unity-archive-rehearsal-${randomUUID()}`, containers = new Set();
let volume;
const abort = new AbortController();
const interrupted = () => abort.abort(new Error('Archive rehearsal interrupted'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, interrupted);
async function create(command, { readonly = true, env = [] } = {}) {
  abort.signal.throwIfAborted();
  const id = await docker('create', '--label', `character-unity.rehearsal=${name}`, '--init', '--network', 'none',
    '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--mount', `type=volume,src=${volume},dst=/data${readonly ? ',readonly' : ''}`,
    ...env.flatMap((value) => ['-e', value]), metadata.Id, ...command);
  containers.add(id); await docker('start', id); return id;
}
async function remove(id, stop = false) {
  if (stop) await docker('stop', '--time', '10', id);
  const state = JSON.parse(await docker('inspect', '--format', '{{json .State}}', id));
  assert.equal(state.ExitCode, 0, await docker('logs', id)); assert.equal(state.OOMKilled, false);
  await docker('rm', id); containers.delete(id);
}
async function probe(operation, readonly) {
  const id = await create(['node', 'native-rehearsal.js', operation, '/data/rehearsal'], { readonly });
  assert.equal(await docker('wait', id), '0', await docker('logs', id));
  const result = JSON.parse(await docker('logs', id));
  await remove(id); return result;
}
async function start(mode, copyRoot = '/data/rehearsal/copy') {
  const id = await create(['node', 'node.js'], { env: [...(mode === 'off' ? [] : [`UNITY_ARCHIVE_MODE=${mode}`]), ...(mode === 'copy' ? [`UNITY_ARCHIVE_COPY_ROOT=${copyRoot}`] : [])] });
  const started = Date.now();
  while (true) {
    abort.signal.throwIfAborted();
    try {
      await docker('exec', id, 'node', '-e', "fetch('http://127.0.0.1:9313/api/health',{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))");
      return id;
    } catch {
      if (Date.now() - started > 15_000) throw new Error(`Archive did not become healthy: ${await docker('logs', id)}`);
      await new Promise((done) => setTimeout(done, 100));
    }
  }
}
const httpChecks = `
  import assert from 'node:assert/strict';
  import { createHash } from 'node:crypto';
  const base = 'http://127.0.0.1:9313/api/archive/v1';
  const request = (path, init) => fetch(base + path, { ...init, signal: AbortSignal.timeout(5000) });
  const statusResponse = await request('/status');
  if (process.env.UNITY_ARCHIVE_MODE === 'off') {
    assert.equal(statusResponse.status, 503);
  } else {
    const status = await statusResponse.json();
    assert.equal(status.mode, process.env.UNITY_ARCHIVE_MODE); assert.equal(status.cardCount, 3);
    if (status.mode === 'copy') {
      assert.equal(status.search, 'lance-fts-v1');
      assert.equal(status.browse, 'lance-filter-v1'); assert.ok(status.sorts.includes('tokens_desc'));
      const browsed = await request('/search?' + new URLSearchParams({ mode: 'browse', sort: 'tokens_desc', limit: '1' }));
      assert.equal(browsed.status, 200); const browsePage = await browsed.json();
      assert.equal(browsePage.total, 3); assert.equal(browsePage.cards[0].id, '3'); assert.deepEqual(browsePage.scores, [0]);
      const continued = await request('/search?' + new URLSearchParams({ mode: 'browse', sort: 'tokens_desc', limit: '1', snapshot: browsePage.snapshot, cursor: browsePage.nextCursor }));
      assert.equal(continued.status, 200); assert.equal((await continued.json()).cards[0].id, '1');
      assert.ok(status.filterFields.some((field) => field.name === 'tokenCount' && field.type === 'number'));
      const filtered = await request('/search?' + new URLSearchParams({ text: 'silver', filter: 'hasLorebook = true AND tokenCount >= 250' }));
      assert.equal(filtered.status, 200); assert.deepEqual((await filtered.json()).cards.map((card) => card.id), ['3']);
      const negated = await request('/search?' + new URLSearchParams({ text: 'NOT forest', filter: 'source = chub' }));
      assert.equal(negated.status, 200); assert.equal((await negated.json()).total, 0);
      const searched = await request('/search?' + new URLSearchParams({ text: 'silver AND NOT ocean', limit: '1', sort: 'id' }));
      assert.equal(searched.status, 200); assert.equal(searched.headers.get('cache-control'), 'no-store');
      const result = await searched.json(); assert.equal(result.total, 2); assert.equal(result.cards[0].id, '1'); assert.ok(result.nextCursor);
      const more = await (await request('/search?' + new URLSearchParams({ text: 'silver AND NOT ocean', limit: '1', sort: 'id', snapshot: result.snapshot, cursor: result.nextCursor }))).json();
      assert.equal(more.cards[0].id, '3'); assert.equal(more.nextCursor, null);
    } else assert.equal((await request('/search?text=forest')).status, 503);
    const response = await request('/cards?limit=1'); assert.equal(response.headers.get('cache-control'), 'no-store');
    const page = await response.json(); assert.equal(page.snapshot, status.snapshot); assert.equal(page.cards.length, 1); assert.ok(page.nextCursor);
    const next = await (await request('/cards?' + new URLSearchParams({ limit: '1', cursor: page.nextCursor, snapshot: status.snapshot }))).json();
    assert.equal(next.cards.length, 1); assert.notEqual(next.cards[0].id, page.cards[0].id);
    const card = page.cards[0];
    const original = await request('/originals/' + card.original.hash + '?snapshot=' + status.snapshot);
    assert.equal(original.status, 200); assert.equal(original.headers.get('x-archive-snapshot'), status.snapshot);
    const bytes = Buffer.from(await original.arrayBuffer());
    assert.equal(bytes.length, card.original.byteLength); assert.equal(createHash('sha256').update(bytes).digest('hex'), card.original.hash);
    assert.equal((await request('/cards?cursor=' + page.nextCursor + '&snapshot=' + '0'.repeat(64))).status, 409);
  }
  assert.equal((await request('/cards', { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await request('/sync')).status, 404);
  console.log(JSON.stringify({ mode: process.env.UNITY_ARCHIVE_MODE, status: 'passed' }));
`;
try {
  volume = await docker('volume', 'create', '--label', `character-unity.rehearsal=${name}`, name);
  const seeded = await probe('seed', false);
  const reopened = await probe('check', true);
  assert.equal(seeded.snapshot, reopened.snapshot);
  const services = [];
  for (const mode of ['off', 'fixture', 'copy', 'copy']) {
    const id = await start(mode);
    assert.equal(await docker('exec', id, 'id', '-u'), '1000');
    // The Archive runtime must not contain hub auth code or optional model SDKs.
    await docker('exec', id, 'node', '--input-type=module', '-e', `
      import { existsSync } from 'node:fs';
      import assert from 'node:assert/strict';
      for (const path of ['accounts-cli.js', 'web', 'node_modules/openai', 'node_modules/@huggingface/transformers']) assert.equal(existsSync(path), false);
    `);
    services.push(JSON.parse(await docker('exec', id, 'node', '--input-type=module', '-e', httpChecks)));
    await remove(id, true);
  }
  const afterService = await probe('check', true);
  assert.equal(afterService.snapshot, seeded.snapshot);
  const generationId = await create(['node', 'generation-cli.js', 'lexical', '--copy', '/data/rehearsal/copy', '--output', '/data/generated', '--as-of', '2026-10-12T00:00:00.000Z'], { readonly: false });
  assert.equal(await docker('wait', generationId), '0', await docker('logs', generationId));
  const generated = JSON.parse(await docker('logs', generationId)); await remove(generationId);
  assert.equal(generated.state, 'ready'); assert.equal(generated.cardCount, 3);
  const generatedServices = [];
  for (let run = 0; run < 2; run++) {
    const id = await start('copy', '/data/generated');
    generatedServices.push(JSON.parse(await docker('exec', id, 'node', '--input-type=module', '-e', httpChecks)));
    await remove(id, true);
  }
  const afterGeneration = await probe('check', true);
  assert.equal(afterGeneration.snapshot, seeded.snapshot);
  const semantic = [];
  for (const operation of ['generate', 'generation-check']) {
    const id = await create(['node', 'native-rehearsal.js', operation, '/data/rehearsal', '/data/semantic'], { readonly: operation !== 'generate' });
    assert.equal(await docker('wait', id), '0', await docker('logs', id));
    semantic.push(JSON.parse(await docker('logs', id))); await remove(id);
  }
  assert.equal(semantic[0].generated.snapshot, semantic[1].generated.snapshot);
  assert.equal(semantic[0].generated.firstCursor, semantic[1].generated.firstCursor);
  const report = { image: metadata.Id, platform: `${metadata.Os}/${metadata.Architecture}`, seeded, reopened, afterService, services, generated, generatedServices, afterGeneration, semantic,
    isolation: { user: 'node', network: 'none', rootReadonly: true, reopenedDataReadonly: true } };
  await mkdir('runtime', { recursive: true });
  await writeFile('runtime/archive-container-rehearsal.json', JSON.stringify(report, null, 2) + '\n');
  console.log('Archive container rehearsal passed: native queries, lexical/semantic generation, new-container reopen, off/fixture/copy HTTP and immutable read-only data.');
} finally {
  for (const id of containers) await docker('rm', '--force', id).catch(() => undefined);
  if (volume) await docker('volume', 'rm', volume).catch(() => undefined);
  for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, interrupted);
}
