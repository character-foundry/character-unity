# Fixture provenance

Fixtures are hand-authored UTF-8 bytes (`Aster: exact original bytes.` plus a
newline), empty data, zero-filled arrays and stalled streams. Expected SHA-256
digests come from Node's crypto implementation independently of the production
incremental `@noble/hashes@2.4.0` verifier. No live corpus or downloaded files are used.

The filesystem suite owns a temporary directory per case. R2 uses the pinned
`miniflare@5.20261006.1-alpha`/workerd runtime already used by Wrangler, compatibility
date 2026-10-11. esbuild bundles the actual `src/r2.ts`; no fake R2 implementation
is substituted. Every runtime/directory is disposed after its case.

These are specification-derived assertions, not generated golden files. Change
the requirement and the corresponding case together, review the semantic change,
and run `pnpm test`; never bless implementation output to hide a regression.
