# Fixture provenance

`store.test.ts` contains hand-authored synthetic JSON: a CCv2-shaped card named
Aster with an opaque nested extension, and fixed 64-character synthetic digests.
It is not copied from any archived character, upstream app, or live database.
The algorithm label `test-fixture-v1` is deliberately not a public Foundry hash.
No output regeneration or golden-file acceptance is involved.

The contract preserves supplied JSON and identity; it does not independently
prove that a caller-supplied content digest matches the document. Foundry and the
trusted import/edit service will own that proof before exposing HTTP writes.

SQLite uses `better-sqlite3@13.0.3`. Local D1 uses the same Miniflare/workerd version
as the scaffold's Wrangler, `miniflare@5.20261006.1-alpha`, with compatibility date
2026-10-11 and its exported v4-options converter. Each case owns and disposes its
isolated database/runtime. Exact transitive versions are pinned in the lockfile.

To change this internal contract: update the requirement and corresponding shared
test together, review differences, then run `pnpm test`. Never replace a failed
semantic assertion by regenerating an expected result from the implementation.
