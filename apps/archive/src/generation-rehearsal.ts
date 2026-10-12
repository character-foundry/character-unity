import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQueryEmbedder } from './embeddings.js';
import { openCopiedArchive } from './copied.js';

/** Only called after native-rehearsal verifies its explicit synthetic fixture.
 * This provider is a deterministic protocol probe, never a real model. */
export async function rehearseSemanticGeneration(copy: string, output: string, generate: boolean) {
  const temporary = await mkdtemp(join(tmpdir(), 'unity-embedding-probe-'));
  let documentBatches = 0, queryRequests = 0;
  const space = { model: 'unity-generation-synthetic', dimensions: 4, sourceDimensions: 4, queryInstruction: 'Find a character' };
  const server = createServer(async (request, response) => {
    assert.equal(request.url, '/api/embed'); assert.equal(request.method, 'POST');
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as { model: string; input: string[]; truncate?: boolean };
    assert.equal(payload.model, space.model);
    if (payload.input[0]!.startsWith('Instruct:')) queryRequests++; else { documentBatches++; assert.equal(payload.truncate, false); }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ embeddings: payload.input.map((text) => /ocean|sea voyage/.test(text) ? [0, 1, 0, 0] : text.includes('Cinder') ? [0, 0, 1, 0] : [1, 0, 0, 0]) }));
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing synthetic provider address');
    const config = { provider: 'ollama', baseUrl: `http://127.0.0.1:${address.port}`, space }, configFile = join(temporary, 'embedding.json');
    await writeFile(configFile, JSON.stringify(config));
    if (generate) {
      const result = await promisify(execFile)(process.execPath, [join(import.meta.dirname, 'generation-cli.js'), 'semantic', '--copy', copy, '--output', output,
        '--as-of', '2026-10-12T00:00:00.000Z', '--embedding-config', configFile, '--batch-size', '2'], { timeout: 30000, env: { ...process.env, UNITY_ARCHIVE_EMBEDDING_KEY: '' } });
      const report = JSON.parse(result.stdout);
      assert.equal(report.kind, 'semantic'); assert.equal(report.state, 'ready'); assert.equal(report.embeddings.indexedRows, 3);
    }
    const source = await openCopiedArchive(output, createQueryEmbedder(config));
    const status = source.status(); assert.equal(status.cardCount, 3); assert.equal(status.semantic?.indexedCards, 3);
    const first = await source.search({ mode: 'semantic', text: 'sea voyage', limit: 1 });
    assert.equal(first.cards[0]?.id, '2'); assert.equal(first.matches?.[0]?.score, 1); assert.match(first.matches?.[0]?.text ?? '', /ocean/);
    const next = await source.search({ mode: 'semantic', text: 'sea voyage', limit: 1, snapshot: first.snapshot, cursor: first.nextCursor! });
    assert.equal(next.cards[0]?.id, '1');
    assert.equal((await source.search({ mode: 'hybrid', text: 'Cinder' })).cards[0]?.id, '3');
    assert.deepEqual((await source.search({ text: 'silver AND NOT ocean', sort: 'id' })).cards.map((card) => card.id), ['1', '3']);
    const original = await openCopiedArchive(copy);
    for (const card of source.list().cards) assert.deepEqual((await source.object('originals', status.snapshot, card.original.hash)).bytes,
      (await original.object('originals', original.status().snapshot, card.original.hash)).bytes);
    assert.equal(documentBatches, generate ? 2 : 0); assert.equal(queryRequests, 2);
    return { snapshot: status.snapshot, firstCursor: first.nextCursor, cardCount: status.cardCount, documentBatches, queryRequests, exactOriginals: true };
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await closed;
    await rm(temporary, { recursive: true, force: true });
  }
}
