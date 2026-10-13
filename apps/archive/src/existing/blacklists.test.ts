import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadExistingBlacklists } from './blacklists.js';

describe('existing Archive blacklist carryover', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'unity-blacklists-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('loads root IDs and common scraper comments without changing the original lists', async () => {
    await mkdir(join(root, 'data'));
    await writeFile(join(root, 'blacklist.txt'), '123\r\n456\n\n');
    await writeFile(join(root, 'ct-blacklist.txt'), 'CT_old_id\n');
    await writeFile(join(root, 'data/chub-blacklist.txt'), '123 # same ID\n789 # removed\n# comment\n');
    await writeFile(join(root, 'data/ct-blacklist.txt'), 'CT_old_id # duplicate\nCT_new_id\n');
    await writeFile(join(root, 'data/risuai-blacklist.txt'), 'risu-uuid # reason\n');
    await writeFile(join(root, 'data/wyvern-blacklist.txt'), 'wyvern-uuid\n');
    expect(await loadExistingBlacklists(root)).toEqual([
      { provider: 'chub', recordId: '123' }, { provider: 'chub', recordId: '456' },
      { provider: 'ct', recordId: 'CT_old_id' }, { provider: 'chub', recordId: '789' },
      { provider: 'ct', recordId: 'CT_new_id' }, { provider: 'risuai', recordId: 'risu-uuid' },
      { provider: 'wyvern', recordId: 'wyvern-uuid' },
    ]);
    expect(await readFile(join(root, 'blacklist.txt'), 'utf8')).toBe('123\r\n456\n\n');
    expect((await readdir(root)).sort()).toEqual(['blacklist.txt', 'ct-blacklist.txt', 'data']);
  });

  it('keeps earlier root RisuAI/Wyvern lists and normalizes CT path aliases separately from IDs', async () => {
    await mkdir(join(root, 'data'));
    await writeFile(join(root, 'risuai-blacklist.txt'), '# old service\nrisu-id # removed\n');
    await writeFile(join(root, 'wyvern-blacklist.txt'), 'wyvern-id # removed\n');
    await writeFile(join(root, 'ct-blacklist.txt'), ' / Alice // My%20Card / \nCT_opaque_id\n');
    await writeFile(join(root, 'data/ct-blacklist.txt'), 'alice/my_card # same alias\n');
    expect(await loadExistingBlacklists(root)).toEqual([
      { provider: 'ct', sourcePath: 'alice/my_card' }, { provider: 'ct', recordId: 'CT_opaque_id' },
      { provider: 'risuai', recordId: 'risu-id' }, { provider: 'wyvern', recordId: 'wyvern-id' },
    ]);
  });

  it('treats absent lists as no work and never discovers a root from the current directory', async () => {
    expect(await loadExistingBlacklists(root)).toEqual([]);
    expect(await readdir(root)).toEqual([]);
    await expect(loadExistingBlacklists('')).rejects.toThrow(/explicitly configured/);
  });

  it.each([
    ['blacklist.txt', '123\nnot-a-chub-id\n', 'blacklist.txt:2'],
    ['blacklist.txt', '123 # unsupported root comment\n', 'blacklist.txt:1'],
    ['ct-blacklist.txt', 'alice/../card\n', 'ct-blacklist.txt:1'],
    ['ct-blacklist.txt', 'alice/bad%escape\n', 'ct-blacklist.txt:1'],
    ['ct-blacklist.txt', 'https://character-tavern.com/character/alice/card\n', 'ct-blacklist.txt:1'],
    ['data/wyvern-blacklist.txt', 'an invalid id # reason\n', 'data/wyvern-blacklist.txt:1'],
  ])('reports malformed records explicitly in %s', async (path, body, location) => {
    await mkdir(join(root, 'data'));
    await writeFile(join(root, path), body);
    await expect(loadExistingBlacklists(root)).rejects.toThrow(location);
  });

  it('rejects oversized files and excessive entry counts before returning partial data', async () => {
    await writeFile(join(root, 'blacklist.txt'), new Uint8Array(4 * 1024 * 1024 + 1));
    await expect(loadExistingBlacklists(root)).rejects.toThrow(/at most 4194304 bytes/);
    await writeFile(join(root, 'blacklist.txt'), '123\n'.repeat(100_001));
    await expect(loadExistingBlacklists(root)).rejects.toThrow(/exceeds 100000 lines/);
  });

  it('rejects invalid UTF-8 and symlinks instead of silently losing blocked entries', async () => {
    await writeFile(join(root, 'blacklist.txt'), new Uint8Array([0xff]));
    await expect(loadExistingBlacklists(root)).rejects.toThrow(/not valid UTF-8/);
    await rm(join(root, 'blacklist.txt'));
    await writeFile(join(root, 'actual.txt'), '123\n');
    await symlink(join(root, 'actual.txt'), join(root, 'blacklist.txt'));
    await expect(loadExistingBlacklists(root)).rejects.toThrow(/symlink/);
  });
});
