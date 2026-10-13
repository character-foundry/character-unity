import { StoreError } from './types.js';
import type { ArchivePin, ArchiveReferenceSummary, CardDocument, ContentIdentity, ImportIdentity, RevisionInput } from './types.js';

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
export function archivePin(value: ArchivePin): ArchivePin {
  return { archiveId: text(value.archiveId, 'archiveId'), cardId: text(value.cardId, 'Archive cardId'),
    versionId: text(value.versionId, 'Archive versionId') };
}
export function contentIdentity(value: ContentIdentity): ContentIdentity {
  return { algorithm: text(value.algorithm, 'identity algorithm', 80), hash: hash(value.hash) };
}
export function importIdentity(value: ImportIdentity): ImportIdentity {
  const result: ImportIdentity = {};
  if (value.fileHash !== undefined) result.fileHash = hash(value.fileHash);
  if (value.identity !== undefined) result.identity = contentIdentity(value.identity);
  result.moduleHash = value.moduleHash == null ? null : hash(value.moduleHash);
  result.lineageHash = value.lineageHash == null ? null : hash(value.lineageHash);
  if (!result.fileHash && !result.identity) invalid('An import requires a file or content identity');
  return result;
}
export function archiveSummary(value: ArchiveReferenceSummary): ArchiveReferenceSummary {
  const string = (value: string, name: string, max: number) => {
    if (typeof value !== 'string' || value.length > max) invalid(`${name} must contain at most ${max} characters`);
    return value;
  };
  if (!Array.isArray(value.tags) || value.tags.length > 100 || !Array.isArray(value.flags) || value.flags.length > 30
    || typeof value.portrait !== 'boolean') invalid('Invalid Archive summary');
  const summary: ArchiveReferenceSummary = { name: string(value.name, 'name', 500), creator: string(value.creator, 'creator', 500),
    description: string(value.description, 'description', 4000), tags: value.tags.map((tag) => string(tag, 'tag', 200)),
    source: text(value.source, 'source', 80), format: text(value.format, 'format', 80),
    changedAt: string(value.changedAt, 'changedAt', 80), portrait: value.portrait,
    tokensTotal: value.tokensTotal === null ? null : count(value.tokensTotal, 'tokensTotal'),
    flags: value.flags.map((flag) => text(flag, 'flag', 80)) };
  for (const field of ['greetingCount', 'alternateGreetingCount', 'lorebookEntryCount', 'assetCount', 'versionCount'] as const) {
    if (value[field] !== undefined) summary[field] = count(value[field], field);
  }
  if (value.spec !== undefined) summary.spec = text(value.spec, 'spec', 80);
  if (new TextEncoder().encode(JSON.stringify(summary)).byteLength > 32768) invalid('Archive summary exceeds 32768 bytes');
  return summary;
}
export function assetPath(value: string): string {
  text(value, 'asset path', 512);
  if (value.startsWith('/') || value.includes('\\') || Array.from(value).some((char) => char.charCodeAt(0) < 32)
    || value.split('/').some((part) => part === '..' || part === '.' || !part)) {
    invalid('Asset paths must be relative logical paths without traversal');
  }
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

/** Largest card document (big RisuAI lorebooks and scripts). The D1 driver holds hosted libraries to 2 MB. */
export const documentByteLimit = 16 * 1024 * 1024;
export function document(value: CardDocument, maxBytes = documentByteLimit): string {
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
  // Portrait, up to 8191 declared assets (large RisuAI packages) and a RisuAI module.
  if (assets.length > 8193) invalid('A revision can reference at most 8193 assets');
  const paths = new Set<string>();
  for (const asset of assets) {
    text(asset.assetId, 'assetId');
    assetPath(asset.path);
    if (paths.has(asset.path)) invalid('Asset paths must be unique within a revision');
    paths.add(asset.path);
  }
  return encoded;
}
