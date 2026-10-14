import type { BrowserMaintenance, BrowserCleanupItem } from '@character-unity/browser-storage';
import { StoreError } from '@character-unity/store';

const keys = ['assetId', 'storageKey', 'hash', 'byteLength', 'storedByteLength', 'state', 'mediaType', 'reason', 'lastRequiredAt'];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function fields(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new StoreError('INVALID_INPUT', 'Unexpected cleanup request fields');
}
async function json(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json') || !request.body) throw new StoreError('INVALID_INPUT', 'Expected a JSON cleanup request');
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      request.signal.throwIfAborted(); const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > 96 * 1024) throw new StoreError('INVALID_INPUT', 'Cleanup review exceeds 96 KiB');
      chunks.push(new Uint8Array(next.value));
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
    catch { throw new StoreError('INVALID_INPUT', 'Expected valid cleanup JSON'); }
    if (!object(value)) throw new StoreError('INVALID_INPUT', 'Expected a cleanup object');
    return value;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
function selection(value: unknown): BrowserCleanupItem[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new StoreError('INVALID_INPUT', 'Select 1–100 reviewed objects');
  for (const item of value) {
    if (!object(item)) throw new StoreError('INVALID_INPUT', 'Expected a reviewed object');
    fields(item, keys);
    if (['assetId', 'storageKey', 'hash', 'mediaType'].some((key) => typeof item[key] !== 'string')
      || !Number.isSafeInteger(item.byteLength) || Number(item.byteLength) < 0
      || !Number.isSafeInteger(item.storedByteLength) || Number(item.storedByteLength) < 0
      || !['ready', 'staged'].includes(String(item.state)) || !['orphan', 'deleted-card'].includes(String(item.reason))
      || !(item.lastRequiredAt === null || typeof item.lastRequiredAt === 'string')) throw new StoreError('INVALID_INPUT', 'Expected the exact reviewed object metadata');
  }
  return value as BrowserCleanupItem[];
}

/** Mounted only by the in-process browser host. There is no SQL/Workers HTTP
 * cleanup endpoint; this handler captures the fixed browser owner. */
export function createBrowserMaintenanceRoutes(maintenance: BrowserMaintenance, actorId: string) {
  return async (request: Request): Promise<Response> => {
    const headers = { 'cache-control': 'no-store' };
    try {
      request.signal.throwIfAborted();
      if (request.headers.get('x-unity-actor') !== actorId) return Response.json({ error: { code: 'UNAUTHENTICATED', message: 'Open the browser owner session first' } }, { status: 401, headers });
      const url = new URL(request.url), match = /^\/api\/workspaces\/([^/]+)\/browser-storage\/(preview|observe|apply)$/.exec(url.pathname);
      if (!match || url.search) return Response.json({ error: { code: 'NOT_FOUND', message: 'Browser cleanup route not found' } }, { status: 404, headers });
      let workspaceId: string;
      try { workspaceId = decodeURIComponent(match[1]!); } catch { throw new StoreError('INVALID_INPUT', 'Invalid workspace ID'); }
      if (match[2] === 'preview' && request.method === 'GET') return Response.json(await maintenance.preview(actorId, workspaceId, {}, request.signal), { headers });
      if (request.method !== 'POST' || match[2] === 'preview') return Response.json({ error: { code: 'INVALID_INPUT', message: 'Invalid cleanup method' } }, { status: 405, headers });
      const body = await json(request);
      if (match[2] === 'observe') {
        fields(body, ['assetIds']);
        if (!Array.isArray(body.assetIds) || body.assetIds.some((id) => typeof id !== 'string')) throw new StoreError('INVALID_INPUT', 'Expected orphan asset IDs');
        return Response.json(await maintenance.observe(actorId, workspaceId, body.assetIds, request.signal), { headers });
      }
      fields(body, ['before', 'items']);
      if (typeof body.before !== 'string') throw new StoreError('INVALID_INPUT', 'Expected the reviewed cutoff');
      return Response.json(await maintenance.apply(actorId, workspaceId, { before: body.before, items: selection(body.items) }, request.signal), { headers });
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      if (error instanceof StoreError) {
        const status = error.code === 'FORBIDDEN' ? 403 : error.code === 'NOT_FOUND' ? 404 : error.code === 'ACCESS_CHANGED' ? 409 : error.code === 'INVALID_INPUT' ? 400 : 503;
        return Response.json({ error: { code: error.code, message: error.message } }, { status, headers });
      }
      return Response.json({ error: { code: 'UNAVAILABLE', message: 'Browser cleanup could not be confirmed. Refresh the preview before retrying.' } }, { status: 503, headers });
    }
  };
}
