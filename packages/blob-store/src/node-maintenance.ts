import { lstat, open, opendir, realpath, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { BlobError } from './index.js';
import type { BlobRemover } from './maintenance.js';
import { validateRetiredKey } from './maintenance.js';

async function checkedDirectory(path: string) {
  if (path === parse(path).root) throw new BlobError('INVALID_KEY', 'Cleanup refuses a filesystem root');
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || await realpath(path) !== path) throw new BlobError('INVALID_KEY', 'Cleanup requires real Unity storage directories');
  return { path, dev: stat.dev, ino: stat.ino };
}
async function unchangedDirectory(expected: Awaited<ReturnType<typeof checkedDirectory>>) {
  const actual = await checkedDirectory(expected.path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new BlobError('INVALID_KEY', 'Cleanup storage directory changed; reopen and review again');
}
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** Opens an existing, explicit Unity blob root; never creates or scans a tree. */
export async function createNodeBlobRemover(root: string): Promise<BlobRemover> {
  const directory = resolve(root), assets = join(directory, 'assets');
  const storage = await checkedDirectory(directory), namespace = await checkedDirectory(assets);
  return {
    async removeRetired(key) {
      validateRetiredKey(key);
      await unchangedDirectory(storage); await unchangedDirectory(namespace);
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

/** Review token for one observed physical file, not permission to sweep a path. */
export interface NodeOrphanCandidate {
  version: 1; key: string; byteLength: number; device: string; inode: string;
  modifiedNs: string; changedNs: string; bornNs: string;
}
const orphanKey = /^(?:assets|\.pending)\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function candidate(key: string, stat: BigIntStats): NodeOrphanCandidate {
  return { version: 1, key, byteLength: Number(stat.size), device: String(stat.dev), inode: String(stat.ino),
    modifiedNs: String(stat.mtimeNs), changedNs: String(stat.ctimeNs), bornNs: String(stat.birthtimeNs) };
}
export function parseNodeOrphanReview(value: unknown): NodeOrphanCandidate[] {
  const objects: unknown = value && typeof value === 'object' && 'objects' in value ? value.objects : value;
  if (!Array.isArray(objects) || !objects.length || objects.length > 100) throw new BlobError('INVALID_INPUT', 'Review must contain 1–100 objects from orphan-preview');
  return objects.map((object: unknown) => {
    if (!object || typeof object !== 'object' || !('version' in object) || object.version !== 1
      || !('key' in object) || typeof object.key !== 'string' || !orphanKey.test(object.key)
      || !('byteLength' in object) || typeof object.byteLength !== 'number' || !Number.isSafeInteger(object.byteLength) || object.byteLength < 0
      || !('device' in object) || typeof object.device !== 'string' || !/^\d{1,40}$/.test(object.device)
      || !('inode' in object) || typeof object.inode !== 'string' || !/^\d{1,40}$/.test(object.inode)
      || !('modifiedNs' in object) || typeof object.modifiedNs !== 'string' || !/^-?\d{1,40}$/.test(object.modifiedNs)
      || !('changedNs' in object) || typeof object.changedNs !== 'string' || !/^-?\d{1,40}$/.test(object.changedNs)
      || !('bornNs' in object) || typeof object.bornNs !== 'string' || !/^-?\d{1,40}$/.test(object.bornNs)) {
      throw new BlobError('INVALID_INPUT', 'Invalid orphan review token; obtain a fresh preview');
    }
    return { version: 1, key: object.key, byteLength: object.byteLength, device: object.device, inode: object.inode,
      modifiedNs: object.modifiedNs, changedNs: object.changedNs, bornNs: object.bornNs };
  });
}
function sameCandidate(left: NodeOrphanCandidate, right: NodeOrphanCandidate) {
  return left.version === 1 && left.key === right.key && left.byteLength === right.byteLength && left.device === right.device
    && left.inode === right.inode && left.modifiedNs === right.modifiedNs && left.changedNs === right.changedNs && left.bornNs === right.bornNs;
}

/** Explicit, offline-only cleanup of recognizable crash leftovers. SQL-owned
 * assets always use their permanent retirement ledger instead. No idle work. */
export async function createNodeOrphanMaintenance(root: string, options: {
  tracked(keys: readonly string[]): Promise<readonly string[]>; now?: () => Date;
}) {
  const directory = resolve(root), storage = await checkedDirectory(directory);
  const namespaces = await Promise.all(['.pending', 'assets'].map((name) => checkedDirectory(join(directory, name))));
  async function directories() {
    await unchangedDirectory(storage);
    for (const namespace of namespaces) await unchangedDirectory(namespace);
  }
  function cutoff(value: string) {
    const milliseconds = Date.parse(value), now = (options.now?.() ?? new Date()).getTime();
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(milliseconds)
      || new Date(milliseconds).toISOString() !== value || milliseconds > now - 86_400_000) {
      throw new BlobError('INVALID_INPUT', 'Use a canonical UTC cutoff at least 24 hours old');
    }
    return BigInt(milliseconds) * 1_000_000n;
  }
  const old = (stat: BigIntStats, before: bigint) => stat.isFile() && stat.nlink === 1n
    && stat.size <= BigInt(Number.MAX_SAFE_INTEGER) && stat.mtimeNs <= before && stat.ctimeNs <= before && stat.birthtimeNs <= before;
  return {
    async preview(before: string, page: { afterKey?: string; limit?: number } = {}) {
      const age = cutoff(before), limit = page.limit ?? 50, after = page.afterKey ?? '';
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (after && !orphanKey.test(after))) throw new BlobError('INVALID_INPUT', 'Invalid cleanup page');
      await directories();
      // Directory iteration holds at most one page of names, not the corpus.
      const keys: string[] = [];
      for (const namespace of namespaces) {
        for await (const entry of await opendir(namespace.path)) {
          const key = `${basename(namespace.path)}/${entry.name}`;
          if (!orphanKey.test(key) || key <= after) continue;
          keys.push(key); keys.sort(); if (keys.length > limit + 1) keys.pop();
        }
      }
      const selected = keys.slice(0, limit), tracked = new Set(await options.tracked(selected.filter((key) => key.startsWith('assets/'))));
      const objects: NodeOrphanCandidate[] = [];
      for (const key of selected) {
        if (tracked.has(key)) continue;
        try { const stat = await lstat(join(directory, key), { bigint: true }); if (old(stat, age)) objects.push(candidate(key, stat)); }
        catch (error) { if (!missing(error)) throw error; }
      }
      await directories();
      return { objects, nextAfter: keys.length > limit ? selected.at(-1)! : null };
    },
    async remove(objects: readonly NodeOrphanCandidate[], before: string, confirmation: { storageStopped: boolean }) {
      const age = cutoff(before), selected = parseNodeOrphanReview(objects);
      if (confirmation.storageStopped !== true || new Set(selected.map((object) => object.key)).size !== selected.length) {
        throw new BlobError('INVALID_INPUT', 'Stop the owning host and pass 1–100 exact reviewed objects');
      }
      const results: { key: string; status: 'removed' | 'failed' }[] = [];
      for (const reviewed of selected) {
        try {
          await directories();
          if ((await options.tracked(reviewed.key.startsWith('assets/') ? [reviewed.key] : [])).length) throw new BlobError('INVALID_KEY', 'Object is SQL-owned; use retirement');
          const file = join(directory, reviewed.key);
          let handle;
          try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
          catch (error) {
            if (!missing(error)) throw error;
            await directories(); results.push({ key: reviewed.key, status: 'removed' }); continue;
          }
          try {
            const stat = await handle.stat({ bigint: true });
            if (!old(stat, age) || !sameCandidate(reviewed, candidate(reviewed.key, stat))) throw new BlobError('INVALID_KEY', 'Reviewed file changed or is linked; refresh preview');
            await directories();
            const current = await lstat(file, { bigint: true });
            if (!sameCandidate(reviewed, candidate(reviewed.key, current))) throw new BlobError('INVALID_KEY', 'Reviewed file changed; refresh preview');
            await unlink(file);
          } finally { await handle.close(); }
          const parent = await open(dirname(file), constants.O_RDONLY | constants.O_NOFOLLOW);
          try { await parent.sync(); } finally { await parent.close(); }
          results.push({ key: reviewed.key, status: 'removed' });
        } catch {
          results.push({ key: reviewed.key, status: 'failed' });
        }
      }
      return { results };
    },
  };
}
