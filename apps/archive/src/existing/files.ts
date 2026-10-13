import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { NativeArchiveError } from '../native/store.js';
import { sha256 } from '../native/objects.js';
import { createHash } from 'node:crypto';

export async function realDirectory(path: string) {
  const root = resolve(path);
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw new Error('Archive directories must be real directories, without symlinks');
  return root;
}

export function safeRelative(path: string) {
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new NativeArchiveError('INVALID_INPUT', 'An Archive file path must stay inside its configured directory');
  }
  return path;
}

/** Opens only a regular file beneath an explicit root. No source URL is ever fetched here. */
async function openSafeFile(root: string, path: string) {
  safeRelative(path);
  let target = root;
  for (const part of path.split('/')) {
    target = join(target, part);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new NativeArchiveError('INVALID_INPUT', 'Archive file paths cannot contain symlinks');
  }
  const resolved = await realpath(target);
  if (relative(root, resolved).startsWith(`..${sep}`) || relative(root, resolved) === '..' || isAbsolute(relative(root, resolved))) throw new NativeArchiveError('INVALID_INPUT', 'Archive file escaped its configured directory');
  return open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
}

export async function readExistingFile(root: string, path: string) {
  const file = await openSafeFile(root, path);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 512 * 1024 * 1024) throw new NativeArchiveError('INVALID_INPUT', 'Archive objects must be regular files of at most 512 MiB');
    const bytes = new Uint8Array(await file.readFile()), after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.byteLength !== before.size) throw new Error('Archive file changed while being read; retry after its writer finishes');
    return { bytes, sha256: sha256(bytes), byteLength: bytes.byteLength, mediaType: mediaType(bytes, path) };
  } finally { await file.close(); }
}

/** Portrait pages need an object digest, not every image buffer held at once. */
export async function hashExistingFile(root: string, path: string) {
  const file = await openSafeFile(root, path);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 512 * 1024 * 1024) throw new NativeArchiveError('INVALID_INPUT', 'Archive objects must be regular files of at most 512 MiB');
    const hash = createHash('sha256'); let bytesRead = 0, header = new Uint8Array();
    for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) {
      const bytes = chunk as Buffer;
      if (!bytesRead) header = new Uint8Array(bytes.subarray(0, 16));
      bytesRead += bytes.byteLength; hash.update(bytes);
    }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytesRead !== before.size) throw new Error('Archive file changed while being read; retry after its writer finishes');
    return { sha256: hash.digest('hex'), byteLength: bytesRead, mediaType: mediaType(header, path) };
  } finally { await file.close(); }
}

export function mediaType(bytes: Uint8Array, path: string) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF') return 'image/webp';
  if (new TextDecoder().decode(bytes.subarray(0, 3)) === 'GIF') return 'image/gif';
  if (/\.(charx|zip)$/i.test(path) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) return 'application/zip';
  if (/\.json$/i.test(path)) return 'application/json';
  return 'application/octet-stream';
}

export const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
