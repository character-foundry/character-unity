# Store conformance discrepancies

No intentional SQLite/local-D1 contract divergences are accepted for S01–S17,
H01–H05 or A01–A06. D1 includes trigger side effects in mutation change counts;
account operations interpret any positive count as the successful single-account
update and separately verify revoked sessions in the shared tests.

Review date: 2026-10-11. A new discrepancy must identify the clause, affected
adapter/cases, impact, disposition and review date. A production D1 deployment
has not been tested; local D1 results must not be represented as that evidence.
