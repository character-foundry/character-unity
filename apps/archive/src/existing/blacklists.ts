import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { missing, realDirectory } from './files.js';

export interface ExistingBlacklistEntry {
  provider: 'chub' | 'ct' | 'risuai' | 'wyvern';
  recordId?: string;
  sourcePath?: string;
}

const maxFileBytes = 4 * 1024 * 1024;
const maxEntries = 100_000;
const providers = ['chub', 'ct', 'risuai', 'wyvern'] as const;
const files = [
  { path: 'blacklist.txt', provider: 'chub' as const, comments: false },
  { path: 'ct-blacklist.txt', provider: 'ct' as const, comments: false },
  // Earlier RisuAI/Wyvern services used root lists before the common scraper data directory.
  { path: 'risuai-blacklist.txt', provider: 'risuai' as const, comments: true },
  { path: 'wyvern-blacklist.txt', provider: 'wyvern' as const, comments: true },
  ...providers.map((provider) => ({ path: `data/${provider}-blacklist.txt`, provider, comments: true })),
];

async function readList(root: string, path: string) {
  let target = root;
  try {
    for (const part of path.split('/')) {
      target = join(target, part);
      if ((await lstat(target)).isSymbolicLink()) throw new Error(`Legacy blacklist ${path} cannot contain symlinks`);
    }
    if (!(await lstat(target)).isFile()) throw new Error(`Legacy blacklist ${path} must be a regular file`);
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > maxFileBytes) throw new Error(`Legacy blacklist ${path} must be a regular file of at most ${maxFileBytes} bytes`);
      // One extra byte detects growth without allocating beyond the configured bound.
      const bytes = new Uint8Array(before.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      const after = await file.stat();
      if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error(`Legacy blacklist ${path} changed while being read; retry after its writer finishes`);
      }
      try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)); }
      catch { throw new Error(`Legacy blacklist ${path} is not valid UTF-8`); }
    } finally { await file.close(); }
  } catch (error) { if (missing(error)) return null; throw error; }
}

const hasControl = (value: string) => [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
function entry(provider: ExistingBlacklistEntry['provider'], value: string): ExistingBlacklistEntry {
  if (!value || value.length > 200 || hasControl(value) || /[\\?#]/.test(value)) throw new Error('expected a source ID or CT creator/card path of at most 200 characters');
  if (provider === 'ct' && value.includes('/')) {
    let decoded: string;
    try { decoded = decodeURIComponent(value); } catch { throw new Error('CT source path has invalid percent encoding'); }
    const parts = decoded.replace(/^\/+|\/+$/g, '').split(/\/+/).map((part) => part.trim().toLowerCase().replace(/\s+/g, '_'));
    if (parts.length < 2 || parts.some((part) => !part || part === '.' || part === '..' || hasControl(part) || /[:\\?#]/.test(part))) {
      throw new Error('expected a relative CT creator/card path');
    }
    return { provider, sourcePath: parts.join('/') };
  }
  if (/[\s/:]/.test(value)) throw new Error('source IDs cannot contain whitespace, slashes or colons');
  if (provider === 'chub' && (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new Error('expected a positive Chub numeric source ID');
  return { provider, recordId: value };
}

/** Reads only known lists beneath an explicitly configured legacy deployment root. Never writes. */
export async function loadExistingBlacklists(legacyRoot: string): Promise<ExistingBlacklistEntry[]> {
  if (!legacyRoot.trim()) throw new Error('A legacy Archive root must be explicitly configured');
  const root = await realDirectory(legacyRoot), entries = new Map<string, ExistingBlacklistEntry>();
  let count = 0;
  for (const file of files) {
    const body = await readList(root, file.path);
    if (body === null) continue;
    const lines = body.split('\n');
    if (lines.length > maxEntries + 1) throw new Error(`Legacy blacklist ${file.path} exceeds ${maxEntries} lines`);
    for (const [index, line] of lines.entries()) {
      // Common scraper files append "ID # reason"; Chub/root CT lists store the whole trimmed ID.
      const value = (file.comments ? line.split('#', 1)[0]! : line).trim();
      if (!value) continue;
      if (++count > maxEntries) throw new Error(`Legacy blacklists exceed ${maxEntries} entries`);
      let parsed: ExistingBlacklistEntry;
      try { parsed = entry(file.provider, value); }
      catch (error) { throw new Error(`Invalid legacy blacklist entry in ${file.path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      entries.set(JSON.stringify(parsed), parsed);
    }
  }
  return [...entries.values()];
}
