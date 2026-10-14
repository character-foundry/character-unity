import assert from 'node:assert/strict';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const pin = JSON.parse(await readFile(new URL('../foundry-sdk.json', import.meta.url), 'utf8'));
const checkout = resolve(root, '..', '.unity-foundry-sdk');
try {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.equal(head, pin.commit, 'SDK checkout differs from foundry-sdk.json');
  assert.equal(status, '', 'SDK checkout has uncommitted source changes');
  const consumers = [];
  for (const directory of ['packages', 'apps']) for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const consumer = `${directory}/${entry.name}`;
    let manifest;
    try { manifest = JSON.parse(await readFile(resolve(root, consumer, 'package.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (manifest.dependencies?.['@character-foundry/character-foundry'] || manifest.devDependencies?.['@character-foundry/character-foundry']) consumers.push(consumer);
  }
  for (const consumer of consumers) {
    assert.equal(await realpath(resolve(root, `${consumer}/node_modules/@character-foundry/character-foundry`)),
      await realpath(resolve(checkout, 'packages/character-foundry')), `${consumer} is not linked to the pinned SDK`);
  }
} catch (error) {
  throw new Error('Foundry development dependency is not ready. Run pnpm bootstrap; preserve any existing SDK changes before resolving a checkout mismatch.', { cause: error });
}
