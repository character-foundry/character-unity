import { StoreError } from './types.js';
import type { CardDocument, RevisionInput } from './types.js';

export function invalid(message: string): never { throw new StoreError('INVALID_INPUT', message); }
export function text(value: string, name: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(`${name} must contain 1–${max} characters`);
  return value;
}
/** Stable public actor identifier, shared by account provisioning and peer grants. */
export function actorUri(value: string): string {
  text(value, 'actor URI', 1024);
  let url: URL;
  try { url = new URL(value); } catch { return invalid('Expected a canonical HTTPS actor URI'); }
  if (url.protocol !== 'https:' || url.href !== value || url.username || url.password || url.hash || url.search) {
    invalid('Expected a canonical HTTPS actor URI');
  }
  return value;
}
export function hash(value: string): string {
  if (typeof value !== 'string' || value.length !== 64 || /[^a-f0-9]/.test(value)) invalid('Expected a lowercase SHA-256 digest');
  return value;
}
export function count(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${name} must be a non-negative safe integer`);
  return value;
}
export function limit(value = 50): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) invalid('Page size must be between 1 and 100');
  return value;
}

function json(value: unknown, seen: Set<object>, depth = 0): void {
  if (depth > 64) invalid('Document exceeds 64 levels of nesting');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') invalid('Document must contain only JSON values');
  if (seen.has(value)) invalid('Document contains a cycle');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    invalid('Document must contain plain JSON objects');
  }
  seen.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) json(child, seen, depth + 1);
  seen.delete(value);
}

export function document(value: CardDocument, maxBytes = 262_144): string {
  if (!value || Array.isArray(value) || typeof value !== 'object') invalid('Expected a document object');
  json(value, new Set());
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) invalid(`Document exceeds ${maxBytes} bytes`);
  return encoded;
}
export function revision(input: RevisionInput): string {
  text(input.authorId, 'authorId');
  text(input.identity.algorithm, 'identity algorithm', 80);
  hash(input.identity.hash);
  const encoded = document(input.document);
  const assets = input.assets ?? [];
  if (assets.length > 64) invalid('A revision can reference at most 64 assets');
  const paths = new Set<string>();
  for (const asset of assets) {
    text(asset.assetId, 'assetId');
    text(asset.path, 'asset path', 512);
    if (asset.path.startsWith('/') || asset.path.includes('\\') || Array.from(asset.path).some((char) => char.charCodeAt(0) < 32)
      || asset.path.split('/').some((part) => part === '..' || part === '.' || !part)) {
      invalid('Asset paths must be relative logical paths without traversal');
    }
    if (paths.has(asset.path)) invalid('Asset paths must be unique within a revision');
    paths.add(asset.path);
  }
  return encoded;
}
