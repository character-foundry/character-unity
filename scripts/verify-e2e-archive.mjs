import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const result = JSON.parse(await readFile('runtime/e2e-archive-rehearsal.json', 'utf8'));
assert.equal(result.version, 'unity.browser-archive-rehearsal.v1');
assert.equal(result.unchangedFiles, true);
assert.equal(result.status.search, 'lance-fts-v1');
assert.ok(Date.now() - Date.parse(result.checkedAt) < 60000, 'Expected the completed rehearsal from this run');
console.log('Archive browser rehearsal preserved the copied SQLite database, originals and Lance index.');
