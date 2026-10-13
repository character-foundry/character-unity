import type { Context } from 'hono';
import type { CardDocument } from '@character-unity/store';
import { CardError, importByteLimit, declaredAssetLimit } from '@character-unity/cards/contract';
import type { AssetBinding } from '@character-unity/cards/contract';
import { bytes } from './body.js';
import { documentByteLimit } from '@character-unity/store/validation';

/** Bound the complete request before invoking the platform multipart parser. */
export async function assetRevisionBody(c: Context, limit = importByteLimit, options: { requireHead?: boolean } = {}) {
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) throw new CardError('INVALID_INPUT', 'Expected a multipart asset revision');
  const metadataLimit = documentByteLimit + 2 * 1024 * 1024;
  const body = await bytes(c, limit + metadataLimit);
  let form: FormData;
  try { form = await new Response(body, { headers: { 'content-type': contentType } }).formData(); }
  catch { throw new CardError('INVALID_INPUT', 'Invalid asset revision form'); }
  const entries = [...form.entries()];
  if (entries.length > 65 || new Set(entries.map(([key]) => key)).size !== entries.length) throw new CardError('INVALID_INPUT', 'Duplicate or excessive asset fields');
  const raw = form.get('input');
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > metadataLimit) throw new CardError('INVALID_INPUT', 'Expected asset revision metadata');
  let input: Record<string, unknown>;
  try { input = JSON.parse(raw); } catch { throw new CardError('INVALID_INPUT', 'Invalid asset revision metadata'); }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['expectedHead', 'document', 'bindings'].includes(key))
    || (options.requireHead !== false && typeof input.expectedHead !== 'string')
    || (input.expectedHead !== undefined && (typeof input.expectedHead !== 'string' || input.expectedHead.length > 200))
    || !input.document || typeof input.document !== 'object'
    || Array.isArray(input.document) || !Array.isArray(input.bindings) || input.bindings.length > declaredAssetLimit + 1) throw new CardError('INVALID_INPUT', 'Expected a document, revision head and asset bindings');
  const files: File[] = [];
  for (const [key, value] of entries) {
    if (key === 'input') continue;
    if (!/^file:(0|[1-9][0-9]?)$/.test(key) || Number(key.slice(5)) >= 64 || !(value instanceof File)) throw new CardError('INVALID_INPUT', 'Unexpected asset file field');
    files[Number(key.slice(5))] = value;
  }
  if (files.length !== entries.length - 1 || files.reduce((sum, file) => sum + file.size, 0) > limit) {
    throw new CardError('INVALID_INPUT', `Asset files must be contiguous and total at most ${limit / 1024 / 1024} MiB`);
  }
  const uploads = await Promise.all(files.map(async (file) => ({ bytes: new Uint8Array(await file.arrayBuffer()), mediaType: file.type || 'application/octet-stream' })));
  return { expectedHead: input.expectedHead as string | undefined, document: input.document as CardDocument, bindings: input.bindings as AssetBinding[], uploads };
}
