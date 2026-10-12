import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { BlobError } from './index.js';
import type { BlobRemover } from './maintenance.js';
import { validateRetiredKey } from './maintenance.js';

/** Opens an existing, explicit Unity blob root; never creates or scans a tree. */
export async function createNodeBlobRemover(root: string): Promise<BlobRemover> {
  const directory = resolve(root), assets = join(directory, 'assets');
  if (await realpath(directory) !== directory || !(await lstat(assets)).isDirectory() || await realpath(assets) !== assets) {
    throw new BlobError('INVALID_KEY', 'Cleanup requires real Unity storage directories');
  }
  return {
    async removeRetired(key) {
      validateRetiredKey(key);
      const file = join(directory, key);
      try {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.nlink !== 1) throw new BlobError('INVALID_KEY', 'Cleanup refuses symlinks, hard links and non-files');
        await unlink(file);
      } catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error; }
      const parent = await open(assets, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
    },
  };
}
