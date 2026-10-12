# Archive read client

Portable typed client for the internal `unity.archive-read.v1` contract. The
consumer and fixture service share wire validation, not Archive storage code.
No database, file paths, scraper jobs, inbox or mutation routes are accessible.
`pnpm build` also bundles this package for the browser to check that boundary.

```ts
import { createArchiveClient } from '@character-unity/archive-client';

const archive = createArchiveClient('http://127.0.0.1:9313');
const page = await archive.list({ tag: 'demo', limit: 20 });
const selection = await archive.select(page, ['aster']);
const selected = selection.cards[0];
if (selected) {
  const bytes = await archive.original(selection, selected.original);
  // Only bytes verified against the selected digest/length reach the caller.
}
```

The origin is operator configuration, never a card-supplied URL. The client sends
only GET requests, omits browser credentials and refuses redirects. It validates
versions, response shapes, snapshot identity and exact selection membership.
Requests have a 30-second default deadline and accept an AbortSignal. JSON reads
are capped at 8 MiB; object reads at the manifest length, at most 32 MiB. Downloads
are buffered within that bound and returned only after SHA-256 verification.
This is not a large-file streaming API or a remote authentication mechanism.

See [the contract](../../../docs/archive-read-contract.md) and
[test coverage](tests/COVERAGE.md). Current service mode is **fixture only**.
