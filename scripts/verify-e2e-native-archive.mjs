import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Playwright intentionally stops its webServer during teardown; do not rely on
// that runner propagating a server's nonzero shutdown exit status.
const proof = JSON.parse(await readFile(process.argv[2] ?? 'runtime/native-archive-invariant.json', 'utf8'));
assert.equal(proof.version, 'unity.native-archive-invariant.v1');
for (const key of ['passed', 'harnessPassed', 'logicalSql', 'acceptedOriginals', 'retainedVersions', 'originalLanceTables']) {
  assert.equal(proof[key], true, `Native Archive ${key} proof did not complete`);
}
assert.equal(proof.permittedProjection, 'unity_library_search_v1');
const age = Date.now() - Date.parse(proof.checkedAt);
assert.ok(Number.isFinite(age) && age >= 0 && age < 60_000, 'Expected the completed immutable Archive proof from this run');
console.log('Native browser rehearsal left Archive SQL, originals, versions and original Lance indexes unchanged.');
