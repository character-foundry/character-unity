import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { ArchiveError, string } from '@character-unity/archive-client/contract';
function invalid(message: string): never { throw new ArchiveError('INVALID_INPUT', message); }
export function relative(value: unknown): string {
  const path = string(value, 2048);
  if (!path || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) invalid('Copy paths must be relative and contained');
  return path;
}
export async function contained(root: string, path: string) {
  const target = join(root, relative(path));
  let current = target;
  while (current !== root) {
    if ((await lstat(current)).isSymbolicLink()) invalid('Copied Archive paths cannot use symlinks');
    current = dirname(current);
  }
  const canonical = await realpath(target);
  if (!canonical.startsWith(`${root}${sep}`)) invalid('Copied Archive path escapes its root');
  return canonical;
}
/** Bounded descriptor reads; no creation, repair, chmod, journal or network I/O. */
export async function readCopy(root: string, path: string, max: number, keepBytes: boolean) {
  const target = await contained(root, path);
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1) invalid('Copy inputs must be regular files without hard links');
    if (before.size > max) throw new ArchiveError('TOO_LARGE', 'Copied Archive file exceeds its size limit');
    const hash = createHash('sha256'), chunks: Uint8Array[] = []; let length = 0;
    let header = new Uint8Array(0);
    const buffer = new Uint8Array(65_536);
    while (true) {
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      if (!length) header = new Uint8Array(buffer.subarray(0, Math.min(bytesRead, 100)));
      length += bytesRead;
      if (length > max) throw new ArchiveError('TOO_LARGE', 'Copied Archive file exceeds its size limit');
      const chunk = buffer.subarray(0, bytesRead); hash.update(chunk); if (keepBytes) chunks.push(new Uint8Array(chunk));
    }
    const after = await file.stat();
    if (before.size !== length || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new ArchiveError('SNAPSHOT_CHANGED', 'Copied Archive file changed while reading');
    }
    const bytes = new Uint8Array(keepBytes ? length : 0); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { hash: hash.digest('hex'), byteLength: length, bytes, target, header };
  } finally { await file.close(); }
}

