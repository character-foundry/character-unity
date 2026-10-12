import { expect, it } from 'vitest';
import { createQueryEmbedder, createDocumentEmbedder, normalizedVector } from './embeddings.js';
const space = { model: 'pinned-model', dimensions: 2, sourceDimensions: 3, queryInstruction: 'Find cards' };
it('uses fixed Ollama/OpenAI endpoints, explicit prefix projection, bounded cache and isolated returned vectors', async () => {
  for (const provider of ['ollama', 'openai']) {
    const requests: { url: string; init?: RequestInit }[] = [];
    const embedder = createQueryEmbedder({ provider, baseUrl: 'https://provider.test', space }, provider === 'openai' ? 'synthetic-key' : '', async (url, init) => {
      requests.push({ url: String(url), ...(init ? { init } : {}) });
      return Response.json(provider === 'ollama' ? { embeddings: [[3, 4, 12]] } : { model: space.model, data: [{ index: 0, embedding: [3, 4, 12] }] });
    });
    const result = await embedder.embed('forest'); expect(result).toEqual([0.6, 0.8]); result[0] = 9;
    expect(await embedder.embed('forest')).toEqual([0.6, 0.8]); expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`https://provider.test/${provider === 'ollama' ? 'api/embed' : 'v1/embeddings'}`);
    const init = requests[0]!.init!;
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit' });
    expect(JSON.parse(String(init.body))).toEqual({ model: space.model, input: ['Instruct: Find cards\nQuery:forest'] });
    expect(new Headers(init.headers).get('authorization')).toBe(provider === 'openai' ? 'Bearer synthetic-key' : null);
    for (let i = 0; i < 64; i++) await embedder.embed(`query ${i}`);
    await embedder.embed('forest'); expect(requests).toHaveLength(66);
  }
});

it('embeds exact document batches without query instructions and restores explicit OpenAI index order', async () => {
  for (const provider of ['ollama', 'openai']) {
    let calls = 0;
    const embedder = createDocumentEmbedder({ provider, baseUrl: 'https://provider.test/v1', space }, provider === 'openai' ? 'synthetic-key' : '', async (url, init) => {
      calls++;
      expect(String(url)).toBe(`https://provider.test/v1/${provider === 'ollama' ? 'api/embed' : 'embeddings'}`);
      expect(init).toMatchObject({ redirect: 'error', credentials: 'omit' });
      expect(JSON.parse(String(init?.body))).toEqual({ model: space.model, input: [' forest\n', 'ocean'], ...(provider === 'ollama' ? { truncate: false } : {}) });
      return Response.json(provider === 'ollama' ? { embeddings: [[3, 4, 12], [0, 1, 2]] }
        : { data: [{ index: 1, embedding: [0, 1, 2] }, { index: 0, embedding: [3, 4, 12] }] });
    });
    expect(await embedder.embed([' forest\n', 'ocean'])).toEqual([[0.6, 0.8], [0, 1]]);
    await embedder.embed([' forest\n', 'ocean']); expect(calls).toBe(2); // Builds have no query cache.
  }
});

it('rejects malformed document batch results as a whole and bounds input before sending', async () => {
  const config = { provider: 'openai', baseUrl: 'https://provider.test', space };
  for (const data of [
    [{ index: 0, embedding: [1, 0, 0] }],
    [{ index: 0, embedding: [1, 0, 0] }, { index: 0, embedding: [0, 1, 0] }],
    [{ index: 0, embedding: [1, 0, 0] }, { index: 2, embedding: [0, 1, 0] }],
    [{ index: 0, embedding: [1, 0, 0] }, { index: 1, embedding: [0, 0, 1] }],
    [{ index: 0, embedding: [1, 0, 0] }, { index: '1', embedding: [0, 1, 0] }],
  ]) await expect(createDocumentEmbedder(config, '', async () => Response.json({ data })).embed(['forest', 'ocean'])).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'Document embedding failed; generation was not published' });
  let calls = 0;
  const client = createDocumentEmbedder(config, '', async () => { calls++; return Response.json({}); });
  for (const texts of [[], [''], ['\ud800'], ['x'.repeat(96001)], Array.from({ length: 129 }, () => 'x')]) await expect(client.embed(texts)).rejects.toThrow();
  const controller = new AbortController(); controller.abort(); await expect(client.embed(['x'], controller.signal)).rejects.toThrow();
  expect(calls).toBe(0);
});
it('rejects invalid configuration, dimension drift, zero/nonfinite vectors, bad models, index shape and oversized provider bodies', async () => {
  for (const baseUrl of ['http://external.test', 'https://user:password@example.test', 'https://example.test?key=secret', 'file:///tmp/model']) {
    expect(() => createQueryEmbedder({ provider: 'openai', baseUrl, space })).toThrow();
  }
  for (const vector of [[0, 0, 1], [3, 4], [NaN, 4, 2], [Infinity, 0, 0], ['3', 4, 12]]) expect(() => normalizedVector(vector, 3, 2)).toThrow();
  for (const value of normalizedVector([1e300, 1e300], 2)) expect(value).toBeCloseTo(Math.SQRT1_2, 15);
  const config = { provider: 'openai', baseUrl: 'https://provider.test/v1/', space };
  for (const response of [
    Response.json({ data: [{ index: 0, embedding: [1, 2] }] }), Response.json({ data: [{ index: 1, embedding: [1, 2, 3] }] }),
    Response.json({ model: 'changed', data: [{ index: 0, embedding: [1, 2, 3] }] }), Response.json({ data: [] }),
    Response.json({ secret: 'provider private details' }, { status: 500 }), new Response('x'.repeat(262145), { headers: { 'content-type': 'application/json' } }),
  ]) await expect(createQueryEmbedder(config, 'synthetic-key', async () => response).embed('forest')).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'Embedding query failed; check the configured provider' });
});
it('cancels before an outbound call or while receiving the provider body without caching a failed result', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const config = { provider: 'ollama', baseUrl: 'http://127.0.0.1:1', space };
  await expect(createQueryEmbedder(config, '', async () => { calls++; return Response.json({}); }).embed('forest', controller.signal)).rejects.toThrow();
  expect(calls).toBe(0);
  const pending = new AbortController(); let canceled = false;
  const client = createQueryEmbedder(config, '', async () => new Response(new ReadableStream({ start() { setTimeout(() => pending.abort(), 5); }, cancel() { canceled = true; } }), { headers: { 'content-type': 'application/json' } }));
  await expect(client.embed('forest', pending.signal)).rejects.toThrow(); expect(canceled).toBe(true);
});
