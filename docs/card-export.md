# Saved revision export

Architect's API and browser-only profiles and the hub share one export service.
Choose JSON, PNG, CharX or an explicit SillyTavern JSON/PNG profile beside the editor, then **Download saved revision**.
The download uses that editor's saved revision ID even if another tab advances
its card. Unsaved text remains in the editor. Export neither saves an edit nor
adds lineage to an untouched import. Accepted originals remain separately available.

The host authenticates the workspace owner. The service loads the explicit
revision, checks that it belongs to the requested card, reads and rehashes its
assets, and invokes public Foundry container primitives. It applies Foundry's
publication sanitization (`foundry.local` and `charx_media`) to the exported copy.
It then reparses the complete generated file and requires identical canonical
content identity and lineage before returning bytes. This is a preservation
check, not a promise that another application will retain the same content.

## Supported cases and explicit failures

- JSON carries cards without stored asset bytes. A revision with assets must use
  a container; JSON export does not silently leave dangling references.
- SillyTavern JSON also requires no stored assets. It adds an SDK transport marker
  for an unchanged JSON round trip through SillyTavern, then verifies restoration
  on import. This does not weaken ordinary JSON hash validation.
- SillyTavern PNG carries an existing PNG portrait and descriptors whose exact
  bytes alias it. Aliases use `ccdefault:` instead of separate PNG chunks, which
  SillyTavern drops. Other attachments fail before export. The SDK transport
  marker permits verified removal of the same known envelope additions as JSON.
  SillyTavern can re-encode a valid portrait: changed bytes still fail on reimport.
  Export never converts a portrait or promises that every encoder's PNG is stable.
- PNG requires an existing PNG portrait. Declared assets are written to PNG
  chunks, with their URIs relocated and verified against the same digest bindings.
  Opaque descriptors and extensions are retained. No placeholder portrait is
  fabricated and no image conversion is performed during a read.
- CharX uses Foundry's explicit descriptor-preservation mode. Opaque metadata,
  authored names and extension spelling remain unchanged; only URIs relocate to
  distinct safe ZIP paths. Assets must match the original descriptors in order
  with exact type/name/ext values. Colliding names retain distinct bytes. Missing
  portraits or other identity changes still fail verification. CCv2 → CCv3
  conversion is not implicit.

Known container losses return `EXPORT_LOSS` with no download; SDK validation
failures return `INVALID_INPUT` through HTTP. There is no “ignore lineage” or
silently lossy export option. Foundry's legacy generated-descriptor mode remains
available for compatibility, but Unity always requests preservation.

Asset input and generated output are each limited to 32 MiB. Reads have a
30-second deadline and accept cancellation. Corrupt or missing bytes fail before
an attachment is returned. Authentication is checked again after preparation.

## HTTP contract

`GET /api/workspaces/:workspaceId/cards/:cardId/export?revisionId=ID&format=json`
accepts exactly `revisionId` and `format` (`json`, `png`, `charx`, `sillytavern-json`, `sillytavern-png`). It requires the
host session and current workspace ownership. The attachment includes
`X-Unity-Revision`, a byte SHA-256 ETag, `no-store`, `nosniff` and a restrictive CSP.
The browser-only host invokes the same service over IndexedDB without HTTP.

## Evidence

Shared SQLite/IndexedDB service cases cover immutable originals/history, explicit
old revisions, exact lineage, opaque fields, PNG/CharX asset identity, rejection of
known losses, wrong-card revisions, foreign accounts and cancellation. HTTP checks
cover query validation, attachment headers and sessions. Chromium downloads from
both Architect profiles and a real second-account hub fork, checking saved content
while an unsaved draft remains intact. A browser-only workflow also exports and
reimports a PNG with opaque descriptors and colliding custom-asset names through
CharX, retaining exact identity, lineage, metadata and originals.

## Explicit SillyTavern compatibility

Select **SillyTavern JSON** for cards without assets that will pass through
SillyTavern's JSON import/export. Foundry's additive transport adapter records a
bounded list of fields absent at export under
`data.extensions.foundry.local.sillyTavernTransport`. On reimport it checks the
returned mirrored values, false favorite flags and ISO timestamp, removes only
those declared additions, then requires the original content digest and exact
lineage. Unknown fields remain meaningful. It stores no hidden prompt snapshot
and never restores a previous prompt over an external edit.

Ordinary content hashes and lineage verification retain their original rules.
Unmarked stale lineage, altered portable content, conflicting mirrors, marker
tampering and changed asset identities fail. No lineage is created during export
or reimport. The exact returned file remains the accepted source, including its
transport metadata; its restored document is the editable revision. Preexisting
independent envelope mirrors, creation timestamps, `chat`/`json_data`, or non-false
favorite fields are rejected because the observed external app overwrites them.

The **SillyTavern PNG** profile uses the same additive SDK marker and unchanged
identity contract. It supports implicit CCv2 portraits and CCv3 portrait aliases,
including opaque descriptor fields. It neither embeds backup portraits in private
metadata nor recovers missing attachment bytes. Source image re-encoding is a
meaningful asset change under the existing byte-hash contract and is rejected.
Explicit image conversion remains future work; a user can already upload a
chosen replacement through the asset editor as a new revision.

## Actual application evidence

Run from Unity with a clean external SillyTavern checkout and its installed
dependencies:

```sh
pnpm build
pnpm verify:sillytavern /absolute/path/to/SillyTavern
```

This starts built Unity API and fixture Archive servers plus an actual SillyTavern
Node server, all on isolated loopback ports with temporary profiles/databases.
It creates real Alice/Bob account keys through the operator CLI and exercises:

1. Alice imports exactly Aster and Cinder from the read-only Archive fixture.
2. Alice edits Aster and publishes only that saved revision.
3. Bob signs in independently and forks it into his workspace.
4. Bob exports the fork with the explicit SillyTavern JSON profile.
5. Actual SillyTavern endpoints import and export it with a real session/CSRF token.
6. Bob reimports it through Unity, retaining exact root/content/revision identity.
7. Archive bytes/snapshot, Alice's accepted original and Bob's fork source remain
   unchanged; the returned external file is retained byte-for-byte as its own source.
8. A description edit made through SillyTavern is rejected on reimport before any
   new Unity card is created. It cannot masquerade as the unchanged fork.

The same harness now repeats the publication/fork flow with an asset-bearing
revision. Alice explicitly uploads a synthetic PNG produced by the external
application's image encoder. Bob exports **SillyTavern PNG**, imports/exports it
through the real application, and reimports it into Unity. The exact portrait and
its alias, opaque descriptor fields, root/content/revision identities and accepted
originals survive. The returned PNG becomes its own exact accepted source.

Three negative checks prevent overclaiming this result:

- Changing the portrait through SillyTavern's actual edit-avatar endpoint fails
  SDK restoration and Unity reimport without creating a card.
- SillyTavern re-encodes an ordinary valid PNG even with no user edit. That return
  also fails SDK restoration and Unity reimport. The encoder-produced fixture
  establishes a supported case, not arbitrary PNG compatibility.
- Separate attachments are refused by the export profile before producing a file.

This passes with SillyTavern `ad29cbda62e92f145e44d7a10398a38af22ca986`
and Foundry `685b849eef277525f1ff24dc03c567aac4a05b56`.
`runtime/sillytavern-flow.json` records the resulting identities and assertions.
The command fails on an assertion and cleans up only its own children and data.
It accesses no production profile or live Archive. Plugins, automatic updates and
model downloads are disabled; the external checkout may update its ignored
frontend build cache.

`node scripts/probe-sillytavern.mjs /absolute/path/to/SillyTavern` is the smaller
SDK diagnostic. It records the raw mismatch and verified restoration separately
in `runtime/sillytavern-probe.json`. The original probe showed retained lineage
metadata with added field copies, `/data/extensions/fav`, `/fav` and `/create_date`;
ordinary verification correctly still rejects that raw changed envelope.

`node scripts/probe-sillytavern-assets.mjs /absolute/path/to/SillyTavern` records
portrait hashes and attachment retention in `runtime/sillytavern-assets-probe.json`.
The observed matrix is: ordinary PNG portrait bytes change; an encoder-produced
PNG portrait survives; a PNG attachment chunk disappears. The production profile
and actual-flow assertions follow that evidence without changing Foundry hashes.

This proves text-card JSON and a supported PNG portrait/alias flow against one
actual application version. Live Archive adoption, general portrait conversion,
separate attachment transport, external editing/derivative import and universal
third-party compatibility remain open. The optional external-app
command is separate from `pnpm check`; no external checkout is silently downloaded.
