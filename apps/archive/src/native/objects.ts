import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/**
 * Write-once, content-addressed files: `objects/ab/cd/<sha256>`. A file is written to a temporary name,
 * flushed and renamed into place, so a reader never sees a partial object. Reads verify the digest.
 */
export function createObjectStore(root: string) {
  const path = (hash: string) => {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid object hash');
    return join(root, hash.slice(0, 2), hash.slice(2, 4), hash);
  };
  return {
    async put(bytes: Uint8Array): Promise<string> {
      const hash = sha256(bytes), target = path(hash);
      try { if ((await stat(target)).size === bytes.byteLength) return hash; } catch { /* not stored yet */ }
      await mkdir(join(target, '..'), { recursive: true });
      const temporary = `${target}.${randomUUID()}.tmp`;
      const file = await open(temporary, 'wx');
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      try { await rename(temporary, target); } catch (error) { await rm(temporary, { force: true }); throw error; }
      return hash;
    },
    async get(hash: string): Promise<Uint8Array<ArrayBuffer>> {
      const bytes = new Uint8Array(await readFile(path(hash)));
      if (sha256(bytes) !== hash) throw new Error(`Archive object ${hash} does not match its digest`);
      return bytes;
    },
  };
}
export type ObjectStore = ReturnType<typeof createObjectStore>;
