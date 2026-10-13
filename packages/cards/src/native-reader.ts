import { hashBytes } from '@character-foundry/character-foundry/identity';
import type { ArchivePin } from '@character-unity/store';
import { documentByteLimit } from '@character-unity/store/validation';
import { prepareArchiveImport, type ArchiveImportObject } from './import.js';
import { CardError, importByteLimit } from './types.js';

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export interface NativeArchiveOptions { origin: string; adminToken?: string; fetch?: Fetch; libraryIndex?: boolean }
export class NativeArchiveUnavailable extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = 'NativeArchiveUnavailable'; }
}
export interface NativeArchiveVersion { id: string; sequence?: number; createdAt?: string; fetchedAt?: string; objects: ArchiveImportObject[] }
export interface NativeArchiveCard {
  archiveId?: string; id: string; provider: string; recordId: string; url: string; versionId: string;
  name?: string; creator?: string; description?: string; tags?: string[]; changedAt?: string;
  tokensTotal?: number | null; portrait?: string | null; flags?: Record<string, boolean>; versions?: number;
  document?: unknown;
  versionList: NativeArchiveVersion[];
}
export interface ArchiveIdentityMatch { cardId: string; versionId: string; fileHash: string; contentHash: string | null; provider: string; recordId: string; url: string }
export interface ArchiveIdentityResult { archiveId: string; matches: ArchiveIdentityMatch[]; complete: boolean; unresolved?: number }

/** Immutable, bounded reads of a configured Archive. No byte cache, repair,
 * index population, migration or ingestion is triggered by these operations. */
export function createNativeArchiveReader(options: NativeArchiveOptions) {
  const configured = new URL(options.origin);
  if (!['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password || configured.pathname !== '/' || configured.search || configured.hash) {
    throw new CardError('INVALID_INPUT', 'Archive configuration must be an HTTP(S) origin without credentials');
  }
  const origin = configured.origin, fetcher = options.fetch ?? fetch;
  const requestSignals = new WeakMap<Response, AbortSignal>();
  async function call(path: string, init: RequestInit = {}, admin = false) {
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(init.signal ? [init.signal] : [])]);
    signal.throwIfAborted();
    let response: Response;
    try {
      const request: RequestInit & { credentials: 'omit' } = { ...init, redirect: 'manual', credentials: 'omit', signal,
        headers: { ...init.headers as Record<string, string>, ...(admin && options.adminToken ? { authorization: `Bearer ${options.adminToken}` } : {}) } };
      response = await fetcher(`${origin}${path}`, request);
    } catch {
      signal.throwIfAborted();
      throw new NativeArchiveUnavailable(503, 'UNAVAILABLE', 'The configured Archive did not answer');
    }
    if (signal.aborted) { await response.body?.cancel(); signal.throwIfAborted(); }
    requestSignals.set(response, signal);
    if (!response.ok) {
      const bytes = await read(response, 16_384);
      let body: { error?: { code?: string; message?: string } } = {};
      try { body = JSON.parse(new TextDecoder().decode(bytes)) as typeof body; } catch { /* bounded non-JSON upstream error */ }
      throw new NativeArchiveUnavailable(response.status, body.error?.code ?? 'UNAVAILABLE', body.error?.message ?? `The Archive answered HTTP ${response.status}`);
    }
    return response;
  }
  async function read(response: Response, max: number): Promise<Uint8Array> {
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    const signal = requestSignals.get(response);
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      signal?.throwIfAborted();
      for (;;) {
        const next = await reader.read(); signal?.throwIfAborted(); if (next.done) break;
        size += next.value.byteLength;
        if (size > max) throw new CardError('TOO_LARGE', 'Archive response exceeds its read limit');
        chunks.push(new Uint8Array(next.value));
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return bytes;
    } finally { signal?.removeEventListener('abort', cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  async function json<T>(path: string, init?: RequestInit, admin = false): Promise<T> {
    const response = await call(path, init, admin);
    if (response.headers.get('content-type')?.split(';')[0] !== 'application/json') { await response.body?.cancel(); throw new NativeArchiveUnavailable(503, 'PROTOCOL', 'Archive metadata was not JSON'); }
    // A maximum-sized valid card still needs room for its metadata/version envelope.
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await read(response, documentByteLimit + 4 * 1024 * 1024))) as T; }
    catch (error) {
      if (error instanceof CardError || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) throw error;
      throw new NativeArchiveUnavailable(503, 'PROTOCOL', 'Archive metadata was invalid');
    }
  }
  async function status(signal?: AbortSignal) { return json<{ archiveId: string; [key: string]: unknown }>('/api/archive/v2/status', signal ? { signal } : undefined); }
  async function card(id: string, versionId?: string, signal?: AbortSignal) {
    const query = versionId ? `?${new URLSearchParams({ version: versionId })}` : '';
    return json<NativeArchiveCard>(`/api/archive/v2/cards/${encodeURIComponent(id)}${query}`, signal ? { signal } : undefined);
  }
  async function pinned(pin: ArchivePin, signal?: AbortSignal) {
    const detail = await card(pin.cardId, pin.versionId, signal);
    const archiveId = detail.archiveId ?? (await status(signal)).archiveId;
    const version = detail.versionList?.find((row) => row.id === pin.versionId);
    if (archiveId !== pin.archiveId || detail.id !== pin.cardId || detail.versionId !== pin.versionId || !version) {
      throw new NativeArchiveUnavailable(404, 'SOURCE_UNAVAILABLE', 'The exact referenced Archive version is unavailable');
    }
    return { detail, version };
  }
  async function object(ref: ArchiveImportObject, signal?: AbortSignal) {
    if (!/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0 || ref.byteLength > importByteLimit) throw new CardError('TOO_LARGE', 'Archive file exceeds the read limit');
    const bytes = await read(await call(`/api/archive/v2/objects/${ref.sha256}`, signal ? { signal } : {}), ref.byteLength);
    if (bytes.length !== ref.byteLength || await hashBytes(bytes) !== ref.sha256) throw new CardError('INVALID_INPUT', 'An Archive file did not match its digest');
    return bytes;
  }
  async function prepareVersion({ detail, version }: Awaited<ReturnType<typeof pinned>>, signal?: AbortSignal) {
    let total = 0;
    const prepared = await prepareArchiveImport(version.objects, async (ref) => {
      total += ref.byteLength;
      if (total > importByteLimit) throw new CardError('TOO_LARGE', 'Archive version exceeds the read limit');
      return object(ref, signal);
    });
    signal?.throwIfAborted();
    return { detail, version, prepared };
  }
  async function load(pin: ArchivePin, signal?: AbortSignal) { return prepareVersion(await pinned(pin, signal), signal); }
  return { call, json, status, card, pinned, object, load,
    async identity(query: { fileHash: string; contentHash?: string; name?: string }, signal?: AbortSignal) {
      return json<ArchiveIdentityResult>(`/api/archive/v2/identity?${new URLSearchParams(query)}`, signal ? { signal } : undefined);
    },
    async resource(pin: ArchivePin, path: string, signal?: AbortSignal) {
      const { detail, version } = await pinned(pin, signal);
      if (path === 'original') {
        const ref = version.objects.find((item) => item.role === 'card');
        if (!ref) throw new NativeArchiveUnavailable(404, 'SOURCE_UNAVAILABLE', 'The exact original is unavailable');
        return { body: new Blob([new Uint8Array(await object(ref, signal))]).stream(), hash: ref.sha256, byteLength: ref.byteLength, mediaType: ref.mediaType };
      }
      // JSON sidecars already have exact names/digests in the pinned manifest.
      // A portrait/attachment read must not fetch and parse the whole bundle.
      if (version.objects.find((item) => item.role === 'card')?.mediaType === 'application/json') {
        const document = detail.document as { data?: { assets?: unknown } } | null | undefined;
        const declared = document?.data?.assets;
        const index = /^declared\/(0|[1-9][0-9]*)$/.test(path) ? Number(path.slice(9)) : -1;
        const descriptor = Array.isArray(declared) && index >= 0 ? declared[index] as { uri?: unknown } | undefined : undefined;
        const refs = path === 'portrait' || descriptor?.uri === 'ccdefault:' ? version.objects.filter((item) => item.role === 'portrait')
          : typeof descriptor?.uri === 'string' ? version.objects.filter((item) => item.role === 'asset' && item.name === descriptor.uri) : [];
        if (refs.length === 1) {
          const ref = refs[0]!;
          return { body: new Blob([new Uint8Array(await object(ref, signal))]).stream(), hash: ref.sha256, byteLength: ref.byteLength, mediaType: ref.mediaType };
        }
      }
      const loaded = await prepareVersion({ detail, version }, signal);
      const resource = loaded.prepared.resources.find((item) => item.path === path);
      if (!resource) throw new NativeArchiveUnavailable(404, 'SOURCE_UNAVAILABLE', 'The referenced Archive asset is unavailable');
      return { body: new Blob([new Uint8Array(resource.bytes)]).stream(), hash: resource.hash, byteLength: resource.bytes.byteLength, mediaType: resource.mediaType };
    },
  };
}
export type NativeArchiveReader = ReturnType<typeof createNativeArchiveReader>;
