# Foundry development integration

Foundry remains an external SDK. Unity does not contain its implementations or
silently link whichever sibling checkout happens to exist. `packages/cards` and
`packages/store` and `packages/api` declare explicit development links, and the API host tests use
the same SDK as a development dependency. All resolve to sibling `.unity-foundry-sdk`, prepared
by `pnpm bootstrap`. The first identity
implementation is an unreleased additive change on `feat/unity-identity`, pinned
for this verification to commit
[`76990644da2b8d79bd57a2a7f3c6e46a5b6aee92`](https://github.com/character-foundry/character-foundry/commit/76990644da2b8d79bd57a2a7f3c6e46a5b6aee92).
Review: [Foundry draft PR #52](https://github.com/character-foundry/character-foundry/pull/52).

Branch status verified 2026-10-14: the remote `feat/unity-identity` branch contains
the pinned `76990644da2b8d79bd57a2a7f3c6e46a5b6aee92`. A fresh temporary Git
repository successfully fetched that exact SHA; the previous fresh-bootstrap
SHA-fetch blocker is resolved. Identity/lineage/sync remain
development APIs on that branch, not on default `master` or in a released npm SDK.
The pinned `7699064` raises identity limits from
256 to 8,192 asset bindings, 4 to 32 Mi UTF-16 canonical code units and 100,000
to 2 million JSON nodes, plus a 1,500-asset regression. It changes no schema or
hash format. Bootstrap fetches the exact SHA, so the verified branch push is
sufficient to make the pin available; an npm release is not required.

It adds `@character-foundry/character-foundry/identity`: canonical content identity,
asset digest bindings, explicit save/fork lineage and publication sanitization.
Existing hash APIs retain their behavior. The detailed contract and vectors live
in Foundry's `docs/identity-v1.md`; this is not a second implementation of them.

For normal development, run `pnpm bootstrap` from Unity. It clones the external
SDK into sibling `.unity-foundry-sdk`, checks out the pinned commit, installs and
builds it, then installs Unity with its frozen lockfile. Existing checkouts must
be clean and match the pin; the script never resets, cleans or upgrades them.
CI uses this same bootstrap. The external checkout remains outside Unity's git
repository. A future published SDK version can replace this explicit development
link after the contract is reviewed and released.

To check another isolated build explicitly:

```sh
git clone https://github.com/character-foundry/character-foundry.git ../character-foundry-sdk
git -C ../character-foundry-sdk checkout --detach 76990644da2b8d79bd57a2a7f3c6e46a5b6aee92
cd ../character-foundry-sdk
pnpm install --frozen-lockfile
pnpm --filter @character-foundry/character-foundry... build
cd ../character-unity
pnpm verify:foundry ../character-foundry-sdk/packages/character-foundry
```

Use an unused checkout directory and Foundry's documented toolchain. The verifier
requires the explicit path to a built public package. It resolves the public
identity export for both ESM and CJS, then bundles an actual Worker consumer and
executes it in local workerd. All three runtimes must match the fixed content and
revision digests, preserve the caller's original and reject tampered content.
It starts and disposes only its own emulator. No remote Workers resources are used.

`pnpm check` verifies the pinned checkout/link and runs this verifier against it.
Unity's card service now consumes the SDK loader, URI primitives, content identity
and revision lineage directly. Native API and browser profiles use SDK-backed saved-revision
exports with re-import verification. There is no app-local card hashing implementation.

The CharX preservation mode addresses the descriptor loss exposed by
`character-foundry-blr` for Unity's exports. It retains authored descriptors while
allocating safe distinct paths, incorporating the existing collision fix from
`9dda5b706b1f4d05cd63c3eeb87b02911b810d55`. Unity uses the new mode and verifies
reimported identity and actual asset bytes. Node ESM/CJS and workerd checks cover
opaque metadata and colliding names; legacy descriptor generation remains the default when
the preservation flag is omitted. The additive
SillyTavern transport adapter verifies and removes only declared transport additions;
the actual text-card JSON and supported PNG portrait/alias round trips pass without changing existing hash meanings.
See [export evidence and remaining work](card-export.md). General external asset transport
and image conversion remain open; basic asset editing is implemented.

Local SDK checks at this pin passed
the full build/test suite, type checking, public integration tests, lint and
ESM/CJS build verification. Remote CI status is recorded separately on the draft PR. The published-dependency check still reports CLI 0.6.0 workspace
ranges for core/schemas; the prior pinned commit reproduces the same failure.
That release metadata issue is separate from this unreleased development SDK.

The same development pin adds the unreleased `/sync` transport profile. Unity's
`pnpm verify:sync` consumes only that public export in Node ESM/CJS and local
workerd. It checks an independently generated signature fixture, exact body
bytes, actor/key matching, expiration and mandatory replay-callback behavior.
The fixture under `scripts/fixtures/sync-http-v1.json` is synthetic public test
material copied from Foundry's fixture at the pinned revision. It contains no
operational credentials. See [sync integration status](sync-foundation.md).

The same pin adds the draft publication-read contract and verified SDK client.
Unity uses portable manifests and signed read routes; the wire schemas and
identity/asset verification stay in Foundry. The pin also supplies command v1
codecs and a signed publish/fork client with explicit retry IDs, plus binary fork
bundles with exact asset verification and sender-attributed ancestry. Public actor
provisioning, persisted sender jobs and the two-host browser workflow are now
implemented in Unity; see [connected hubs](remote-hubs.md). Remote hosting and
live Archive adoption remain separate gates.

The editor's optional browser worker also consumes the public `/tokenizers`
export. Its strict `GptTokenizer.encode` calls and Unicode vectors establish the
actual o200k_base encoding at this pin; the legacy class's cl100k_base description
does not match the locked dependency's default. Unity does not use its silent
`count` approximation fallback. See [token-count evidence](text-token-counts.md).
