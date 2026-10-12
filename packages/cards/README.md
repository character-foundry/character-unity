# Card operations

Authorized application operations for workspaces, imports, opens, saves and
accepted-original downloads. Uses Foundry's public loader/identity subpaths;
there is no app-local format parser or card hash algorithm.

The host injects a trusted Actor. Every operation checks workspace ownership.
The underlying store remains a trusted repository; never expose it directly as
an HTTP mutation interface. Import and save inputs are copied before asynchronous
work. Accepted bytes and source provenance are immutable; edits create atomic
revisions using an expected head and Foundry lineage.

Run `pnpm bootstrap` before installation/checks to prepare the explicit SDK link.
See [workflow and limits](../../docs/card-workflow.md) and
[SDK pinning](../../docs/foundry-development.md).

The `/hub` export adds selected-revision publication, versioned visibility policies,
publication-scoped downloads and forks with verified asset copies and Foundry
lineage. Its host supplies authentication; Node supports local single-owner and
account-session profiles with the same business operations. See
[hub publication](../../docs/hub-publication.md) for ancestor restrictions and
original-file permissions, and [accounts](../../docs/hub-accounts.md) for the host boundary.

Saved-revision export reads an explicit revision and verifies generated JSON/PNG/CharX
through the same importer before returning bytes. Known asset/descriptor losses
raise `EXPORT_LOSS`; no history or original bytes are changed. See
[export contract](../../docs/card-export.md).

Explicit asset revisions atomically save an edited document with a complete binding
map and verified uploads. Retained bytes are scoped to the expected card revision;
originals and old revisions remain immutable. Authorized revision asset listing
and downloads expose no storage identifiers. See [asset revisions](../../docs/asset-revisions.md)
for the multipart contract, byte preservation, failure behavior and pending UI.
