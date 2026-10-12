import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const pin = JSON.parse(await readFile(new URL('../foundry-sdk.json', import.meta.url), 'utf8'));
const checkout = resolve(root, '..', '.unity-foundry-sdk');
function run(command, args, cwd = root, capture = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed (${result.status})${capture ? `: ${result.stderr}` : ''}`);
  return result.stdout?.trim();
}
if (pin.repository !== 'https://github.com/character-foundry/character-foundry.git' || !/^[a-f0-9]{40}$/.test(pin.commit)) {
  throw new Error('Invalid Foundry SDK pin');
}
let exists = true;
try { await access(checkout); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
if (!exists) {
  run('git', ['clone', '--no-checkout', '--filter=blob:none', pin.repository, checkout]);
  run('git', ['fetch', 'origin', pin.commit], checkout);
  run('git', ['checkout', '--detach', pin.commit], checkout);
}
// An existing directory is never reset, cleaned, repointed or silently upgraded.
if (run('git', ['remote', 'get-url', 'origin'], checkout, true) !== pin.repository
  || run('git', ['rev-parse', 'HEAD'], checkout, true) !== pin.commit
  || run('git', ['status', '--porcelain'], checkout, true)) {
  throw new Error(`Expected a clean Foundry checkout at ${pin.commit} in ${checkout}; preserve existing work and resolve the mismatch explicitly`);
}
run('pnpm', ['install', '--frozen-lockfile'], checkout);
run('pnpm', ['--filter', '@character-foundry/character-foundry...', 'build'], checkout);
console.log(`Prepared external Foundry SDK ${pin.commit} in ${checkout}`);
