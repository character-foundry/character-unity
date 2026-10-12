import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBrowserSearchFixture, fixtureInventory } from './browser-search-fixture.js';
import { openCopiedArchive } from '../src/copied.js';

const [operation, root, ...rest] = process.argv.slice(2);
if (!root || rest.length || !['seed', 'check'].includes(operation ?? '')) throw new Error('Expected seed NEW_DIRECTORY or check SYNTHETIC_DIRECTORY');
const marker = join(root, '.unity-browser-fixture.json'), version = 'unity.browser-search-fixture.v1';
if (operation === 'seed') {
  await createBrowserSearchFixture(root);
  await writeFile(marker, JSON.stringify({ version, files: await fixtureInventory(root) }), { flag: 'wx' });
}
const expected = JSON.parse(await readFile(marker, 'utf8'));
assert.equal(expected.version, version); assert.deepEqual(await fixtureInventory(root), expected.files);
const source = await openCopiedArchive(root);
assert.equal((await source.search({ text: 'forest AND NOT ocean' })).total, 12);
assert.deepEqual(await fixtureInventory(root), expected.files);
console.log(JSON.stringify(source.status()));
