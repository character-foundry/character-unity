import { ArchiveError, integer, record, string } from '@character-unity/archive-client/contract';
import { toUSVString } from 'node:util';

export interface EmbeddingSpace { model: string; dimensions: number; sourceDimensions: number; queryInstruction: string }
export interface QueryEmbedder { space: EmbeddingSpace; embed(text: string, signal?: AbortSignal): Promise<number[]> }
export interface DocumentEmbedder { space: EmbeddingSpace; embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> }
function invalid(message: string): never { throw new ArchiveError('INVALID_INPUT', message); }
export function embeddingSpace(raw: unknown): EmbeddingSpace {
  const value = record(raw);
  if (Object.keys(value).some((key) => !['model', 'dimensions', 'sourceDimensions', 'queryInstruction'].includes(key))) invalid('Unknown embedding space field');
  const model = string(value.model, 256), dimensions = integer(value.dimensions, 4096), sourceDimensions = integer(value.sourceDimensions, 4096);
  if (!model.trim() || !dimensions || sourceDimensions < dimensions) invalid('Embedding space needs a model and 1–4096 dimensions');
  return { model, dimensions, sourceDimensions, queryInstruction: string(value.queryInstruction, 2048) };
}
export function normalizedVector(value: unknown, size: number, outputSize = size): number[] {
  if (!Array.isArray(value) || value.length !== size || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) invalid('Embedding vector has invalid values or dimensions');
  const projected: number[] = value.slice(0, outputSize);
  // Scaling first avoids overflow/underflow in the norm of a finite input.
  const scale = Math.max(...projected.map(Math.abs));
  if (!scale) invalid('Embedding vector must have nonzero magnitude');
  const scaled = projected.map((item) => item / scale), norm = Math.hypot(...scaled);
  return scaled.map((item) => item / norm);
}

/** Shared fixed-endpoint transport for query reads and explicit document builds. */
function embeddingTransport(raw: unknown, apiKey: string, fetcher: typeof fetch) {
  const value = record(raw);
  if (Object.keys(value).some((key) => !['provider', 'baseUrl', 'space'].includes(key))) invalid('Unknown embedding configuration field');
  if (value.provider !== 'ollama' && value.provider !== 'openai') invalid('Embedding provider must be ollama or openai');
  const space = embeddingSpace(value.space), provider = value.provider;
  const base = new URL(string(value.baseUrl, 2048));
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
    || (base.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname))) invalid('Embedding URL must use HTTPS or loopback HTTP without credentials');
  if (apiKey && (provider !== 'openai' || /[\r\n]/.test(apiKey) || apiKey.length > 8192)) invalid('Invalid embedding API key');
  const path = base.pathname.replace(/\/+$/, '');
  base.pathname = provider === 'ollama' ? `${path}/api/embed` : `${path.endsWith('/v1') ? path : `${path}/v1`}/embeddings`;
  return { space, async request(texts: readonly string[], signal: AbortSignal | undefined, options: { timeoutMs: number; maxBytes: number; failure: string; document?: boolean }) {
    const deadline = AbortSignal.any([AbortSignal.timeout(options.timeoutMs), ...(signal ? [signal] : [])]);
    try {
      deadline.throwIfAborted();
      const response = await fetcher(base, { method: 'POST', redirect: 'error', credentials: 'omit', signal: deadline,
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model: space.model, input: texts, ...(provider === 'ollama' && options.document ? { truncate: false } : {}) }),
      });
      if (!response.ok || !response.body || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        await response.body?.cancel(); throw new Error('Embedding response unavailable');
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      const abort = () => { void reader.cancel().catch(() => undefined); }; deadline.addEventListener('abort', abort, { once: true });
      try {
        while (true) {
          deadline.throwIfAborted(); const next = await reader.read(); deadline.throwIfAborted(); if (next.done) break;
          size += next.value.byteLength; if (size > options.maxBytes) throw new Error('Embedding response exceeds limit'); chunks.push(next.value);
        }
      } finally { deadline.removeEventListener('abort', abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const data = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      if (data.model !== undefined && data.model !== space.model) throw new Error('Embedding response model mismatch');
      let vectors: unknown[];
      if (provider === 'ollama') {
        if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) throw new Error('Invalid embedding response');
        vectors = data.embeddings;
      } else {
        if (!Array.isArray(data.data) || data.data.length !== texts.length) throw new Error('Invalid embedding response');
        const ordered = new Map<number, unknown>();
        for (const raw of data.data) {
          const item = record(raw), index = item.index;
          if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= texts.length || ordered.has(index)) throw new Error('Invalid embedding response index');
          ordered.set(index, item.embedding);
        }
        vectors = texts.map((_, index) => ordered.get(index));
      }
      const result = vectors.map((vector) => normalizedVector(vector, space.sourceDimensions, space.dimensions));
      deadline.throwIfAborted(); return result;
    } catch {
      signal?.throwIfAborted();
      throw new ArchiveError('UNAVAILABLE', options.failure);
    }
  } };
}

/** Operator configuration only. Prefix projection is explicit in the space. */
export function createQueryEmbedder(raw: unknown, apiKey = '', fetcher: typeof fetch = fetch): QueryEmbedder {
  const transport = embeddingTransport(raw, apiKey, fetcher), space = transport.space;
  const cache = new Map<string, { at: number; vector: number[] }>();
  return { space: { ...space }, async embed(text, signal) {
    signal?.throwIfAborted();
    if (!text.trim() || text.length > 2048) invalid('Embedding query must contain 1–2048 characters');
    const cached = cache.get(text);
    if (cached && Date.now() - cached.at < 300_000) return [...cached.vector];
    const [result] = await transport.request([space.queryInstruction ? `Instruct: ${space.queryInstruction}\nQuery:${text.trim()}` : text.trim()], signal,
      { timeoutMs: 15000, maxBytes: 256 * 1024, failure: 'Embedding query failed; check the configured provider' });
    cache.delete(text); while (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(text, { at: Date.now(), vector: result! }); return [...result!];
  } };
}

/** Explicit build batches only: no query instruction, trimming, retries, cache,
 * discovery or model downloads. Every response index must occur exactly once. */
export function createDocumentEmbedder(raw: unknown, apiKey = '', fetcher: typeof fetch = fetch): DocumentEmbedder {
  const transport = embeddingTransport(raw, apiKey, fetcher);
  return { space: { ...transport.space }, async embed(texts, signal) {
    signal?.throwIfAborted();
    if (!Array.isArray(texts) || !texts.length || texts.length > 128 || texts.some((text) => typeof text !== 'string' || text.length > 96000 || !text.trim() || toUSVString(text) !== text)
      || texts.reduce((total, text) => total + text.length, 0) > 96000) invalid('Document batch requires 1–128 nonempty, well-formed texts totaling at most 96,000 characters');
    const captured = [...texts];
    return transport.request(captured, signal, { timeoutMs: 120000, maxBytes: 16 * 1024 * 1024, document: true, failure: 'Document embedding failed; generation was not published' });
  } };
}
