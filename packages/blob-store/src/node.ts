import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BlobError, defaultMaxBytes } from './index.js';
import type { BlobStore, StoredBlob } from './index.js';
import { byteStream, cancelBody, consumeVerified, validateIntegrity, validateKey } from './verify.js';

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export async function createNodeBlobStore(root: string, options: { maxBytes?: number } = {}): Promise<BlobStore> {
  const maxBytes = options.maxBytes ?? defaultMaxBytes;
  validateIntegrity({ hash: '0'.repeat(64), byteLength: 0 }, maxBytes);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await realpath(root);
  for (const name of ['assets', 'originals', '.pending']) {
    const path = join(directory, name);
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (!(await lstat(path)).isDirectory()) throw new BlobError('INVALID_KEY', 'Storage namespaces must be real directories');
  }
  async function get(key: string): Promise<StoredBlob | null> {
    validateKey(key);
    let handle;
    try { handle = await open(join(directory, key), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new BlobError('INVALID_KEY', 'Object is not a regular file');
      return { body: byteStream(handle.readableWebStream({ autoClose: true }).getReader()), byteLength: stat.size };
    } catch (error) { await handle.close(); throw error; }
  }
  return {
    get,
    async put(key, body, expected, options = {}) {
      let pending: string | undefined;
      try {
        validateKey(key); validateIntegrity(expected, maxBytes);
        const integrity = { ...expected };
        const temporary = join(directory, '.pending', crypto.randomUUID());
        const handle = await open(temporary, 'wx', 0o600);
        pending = temporary;
        let measured;
        try {
          measured = await consumeVerified(body, integrity, (chunk) => handle.writeFile(chunk), options.signal);
          await handle.sync();
        } finally { await handle.close(); }
        if (options.signal?.aborted) throw new BlobError('ABORTED', 'Upload aborted');
        try { await link(pending, join(directory, key)); }
        catch (error) {
          if (!hasCode(error, 'EEXIST')) throw error;
          const existing = await get(key);
          if (!existing) throw error;
          // Retrying may recover an object written before a database completion failure.
          await consumeVerified(existing.body, integrity, async () => {}, options.signal);
        }
        const parent = await open(dirname(join(directory, key)), constants.O_RDONLY);
        try { await parent.sync(); } finally { await parent.close(); }
        return measured;
      } finally {
        await cancelBody(body);
        if (pending) await unlink(pending).catch((error: unknown) => { if (!hasCode(error, 'ENOENT')) throw error; });
      }
    },
  };
}
