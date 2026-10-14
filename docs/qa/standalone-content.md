# Standalone JSON content QA

Scope: `cu-1o2.10`; same Unity database, immutable originals, typed lorebook/preset/persona revisions. No live Archive migration, original mutation, provider execution or signed-card protocol extension.

| Capability | Functional check | Visual state / evidence |
| --- | --- | --- |
| Native content kinds | Switch lorebook/preset/persona tabs and library/shared/mine collections | Desktop library and mobile library |
| Import/create | Import explicit kind, create edited initial JSON, preserve unknown fields and exact BOM original | Opened native editor and creation dialog |
| Deduplication | Re-import identical bytes; canonical equal JSON and concurrent imports | Visible already-have notice, one library membership |
| JSON editing | Invalid JSON fails visibly; valid Save adds one immutable revision; stale CAS refuses | Editor error, saved head and history |
| Numeric fidelity | Unsafe integers, lexically rounded fractional tokens, overflow and underflow refuse before import/dedupe/Save; raw text stays recoverable | Explicit precision-refusal UI in Node and browser profiles |
| Recovery/isolation | Reload invalid raw draft; other actor/workspace key remains inaccessible; stale base requires review | Recovery notice and stale-head comparison |
| History actions | Select old saved revision without repinning draft; export/fork that exact revision | Selected saved JSON and unchanged editor text |
| Sharing | Review complete saved JSON, explicit policy and acknowledgment; publish captured revision | Private-default review dialog, public policy detail |
| Shared reads | Browse mine/visible pages, permissioned original and private recipient fork | Shared JSON detail; immutable native source policies |
| Revocation | Stale policy CAS and changed ancestor visibility/fork policy refuse | Actionable API/UI errors, owned private fork preserved |
| Browser storage | Populated schema3 → additive schema4; old card bytes, favorites and pending jobs unchanged | Native browser-owned content, sharing explicitly unavailable |
| Efficiency | Read-only list/open/history/export/stats; no scrape, model, corpus copy or idle polling | Request/console diagnostics |

Exploratory cases: malformed UTF-8; raw Risu/Wyvern lorebook fallback; long titles/unknown nested fields; invalid partial draft; unconfirmed publication response; mobile overflow; account/session recovery while a publication review is open.

Store/module/API/client/recovery tests cover non-visual invariants on SQLite, local D1 and IndexedDB. Browser functional and screenshot passes use disposable local fixtures, never existing user databases. Any skipped provider/deployment/live-corpus gates remain explicit.
