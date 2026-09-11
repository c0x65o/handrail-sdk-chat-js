# Independent PostgreSQL16 follow-up

Main ran the three previously blocked checks as unprivileged UID993 in a disposable copy. All23 tests passed. Current source in638 source/test/script files matched the recorded JS base plus patch; package hashes matched reproduce.md. No app DATABASE_URL fallback; private Unix socket, TCP disabled. Zero leaked schemas, clean shutdown and owned cluster deletion verified.

Reproduction: use the pinned PGDG packages and qualify-reply-threads command from ../reproduce.md in a disposable writable SDK copy with existing dependencies. Run with an existing permitted unprivileged identity; do not bypass a caller sandbox or authorization denial. The current harness writes logs into its copy: preserve historical evidence by copying out only the fresh logs afterward. It cannot initdb as root.

This closes the independent PostgreSQL harness/test gap only. Preserve original inconclusive QA, historical fixture provenance, live browser/Flutter cross-client/native gaps and adoption holds. Existing lead should inspect this result and exact logs; no repeat import or test run is requested.
