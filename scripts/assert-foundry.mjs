import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
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
  for (const consumer of ['packages/cards', 'packages/store', 'packages/api', 'packages/editor', 'apps/api', 'apps/hub']) {
    assert.equal(await realpath(resolve(root, `${consumer}/node_modules/@character-foundry/character-foundry`)),
      await realpath(resolve(checkout, 'packages/character-foundry')), `${consumer} is not linked to the pinned SDK`);
  }
} catch (error) {
  throw new Error('Foundry development dependency is not ready. Run pnpm bootstrap; preserve any existing SDK changes before resolving a checkout mismatch.', { cause: error });
}
