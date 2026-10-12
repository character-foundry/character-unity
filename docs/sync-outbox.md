# Durable return jobs

`services.forSession(proof).remote(connection).returns` exposes explicit enqueue,
list, get and send operations. Node and Worker composition use the same SQL
repository over a session-guarded driver. The [connected hub workflow](remote-hubs.md)
now provides operator configuration and browser review/retry controls.

```ts
import { createSyncToken } from '@character-foundry/character-foundry/sync';

const remote = services.forSession(proof).remote(connection);
const requestId = createSyncToken(); // retain this ID across an uncertain enqueue response
const job = await remote.returns.enqueue(actor, workspaceId, cardId, revisionId, requestId);
// Review job.baseUrl, job.publicationId, job.revisionId, job.frameHash and job.byteLength.
const result = await remote.returns.send(actor, workspaceId, job.requestId);
```

Enqueue prepares the selected saved revision offline and stores the exact verified
bundle as an immutable asset. Migration 8 pins its account, HTTPS actor,
destination, remote parent, local card/revision, digest, length and operation ID.
The database accepts only a ready frame in the same workspace and a sealed
revision of the selected card. It does not independently parse the frame; the
Foundry-backed service verifies it before persistence. Private signing keys and
account/session credentials are never included in the job.

Reusing an ID with the same selection returns the saved job without preparing or
uploading another frame. A changed selection or destination cannot replace it.
Concurrent first enqueues can leave an unused frame asset; cleanup remains
outstanding. Enqueue performs no network requests. A missing local response can
be recovered with the same ID or by listing the account's jobs.

## State and retries

| State | Evidence | Explicit next action |
|---|---|---|
| `prepared` | Saved intent and bytes; no attempt recorded | Review and send |
| `uncertain` | At least one attempt; no saved acknowledgment | Retry the same job after inspecting the reported error |
| `acknowledged` | A matching remote `forks.submit` receipt is saved | Use its remote draft reference for a separate publication decision |

Send verifies the stored frame's digest, length and parent binding before recording
an attempt. The attempt commits **before** the signed request is dispatched. A
crash immediately after that commit is conservatively uncertain even if nothing
was sent. Remote errors, cancellation, response loss or local receipt-write failure
also leave uncertainty; none proves that the receiver made no change.

A retry reads the same stored bytes and uses the same operation ID. It never
rebuilds from the current head. Foundry generates a fresh signature/nonce each time;
the receiving Unity host recovers its durable receipt. Concurrent sends are safe
against that receiver's idempotency contract and may record multiple attempts.
There are no background retries, leases or automatic publication.

Only a matching `forks.submit` acknowledgment can complete the job. Conflicting
receipts fail; saved intents, attempts and acknowledgments cannot be rewritten or
deleted. A completed job returns its local historical receipt without contacting
the peer. That receipt grants no current access to remote content. A peer may
later deny reads or retries because policy, grants or accounts have changed.

The host may rotate signing keys for the same actor and destination. A job cannot
be retargeted to another actor or URL. Local account/workspace authorization and
session expiry/revocation still apply to reading, sending and acknowledging jobs.
Revocation after dispatch can prevent saving the receipt without undoing the
remote commit; a new authorized session can recover it. There is no distributed
transaction between the two hosts.

`returns.list` pages all jobs owned by the account in that workspace, ordered by
operation ID, at most 100 per page. It includes destination metadata across
connections; filtering before pagination would lose jobs. `get` and `send` require
the configured connection to match the selected job.

## Validation and remaining work

Six requirements run on SQLite and persistent local D1: immutable bindings,
concurrent enqueue/restart, uncertain attempts and acknowledgments, account/session
revocation during writes and reads, rollback/lost local responses, and a populated
v7 upgrade. `pnpm test` writes `runtime/sync-outbox-conformance.md`.

The signed-sync integration suite uses an independent persisted Node sender and
either a SQLite API or actual workerd D1/R2 receiver. It edits through the sender's
account API, queues a specific saved revision, saves a newer head, loses the
receiver's successful response, restarts the sender, rotates the peer key and
recovers the same receipt from identical stored bytes. Corrupt local frame bytes,
retargeting, cancellation and revoked local sessions fail before sending.
Acknowledged jobs survive another restart and remain readable offline.

The browser now exercises two compiled Node hosts over real local HTTPS, lost
enqueue/return responses, retained drafts, exact attachments and explicit
receiving-hub publication. A separate local workerd sender dispatches signed
requests through a harness bridge and recovers D1/R2 jobs after restart. Remote
hosting, deployed workerd networking/limits and operational cleanup of abandoned
assets remain open. The container rehearsal verifies schema installation and
receiver behavior; the two-host browser rehearsal is separate. See [connected
hubs](remote-hubs.md) for configuration, endpoints and evidence.
