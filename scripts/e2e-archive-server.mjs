import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';

const directory = await mkdtemp(join(tmpdir(), 'unity-archive-browser-test-')), root = join(directory, 'copy');
const execute = promisify(execFile), fixture = 'apps/archive/dist/browser-fixture-cli.js';
const report = 'runtime/e2e-archive-rehearsal.json';
await rm(report, { force: true });
// Test-only deterministic provider; no external model or credentials.
const provider = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  const text = JSON.parse(body).input[0];
  if (text === 'provider failure') { response.writeHead(503); response.end(); return; }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ embeddings: [/forest/i.test(text) ? [1, 0, 0] : [0, 1, 0]] }));
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
try {
  await execute(process.execPath, [fixture, 'seed', root], { timeout: 15000 });
  const embeddingConfig = join(directory, 'embedding.json');
  await writeFile(embeddingConfig, JSON.stringify({ provider: 'ollama', baseUrl: `http://127.0.0.1:${provider.address().port}`, space: { model: 'unity-synthetic-v1', dimensions: 3, sourceDimensions: 3, queryInstruction: '' } }));
  const child = spawn(process.execPath, ['apps/archive/dist/node.js'], { stdio: 'inherit', env: {
    ...process.env, HOST: '127.0.0.1', PORT: '19313', UNITY_ARCHIVE_MODE: 'copy', UNITY_ARCHIVE_COPY_ROOT: root,
    UNITY_ARCHIVE_READ_ORIGINS: 'http://127.0.0.1:19311', UNITY_ARCHIVE_EMBEDDING_CONFIG: embeddingConfig, UNITY_ARCHIVE_EMBEDDING_KEY: '',
  } });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { if (child.exitCode === null) child.kill(signal); });
  const [code] = await once(child, 'exit'); process.exitCode = code ?? 0;
  const checked = await execute(process.execPath, [fixture, 'check', root], { timeout: 15000 });
  await writeFile(report, JSON.stringify({ version: 'unity.browser-archive-rehearsal.v1', checkedAt: new Date().toISOString(),
    unchangedFiles: true, status: JSON.parse(checked.stdout) }) + '\n');
} finally { provider.close(); provider.closeAllConnections(); await rm(directory, { recursive: true, force: true }); }
