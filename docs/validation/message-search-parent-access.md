# Message search uses current thread parent access

Owner Task item `dbdf3fb5-cb02-4c57-98f4-8b47b62d8a97`, verified 2026-09-06.

Thread search previously required active child membership, which excluded eligible
nonparticipants and could retain visibility after private-parent revocation.
Both explicit conversation filters and unfiltered candidates now share a SQL
join/predicate equivalent to `authorizeThreadAccess` with `operation: "read"`.
It checks the current same-tenant, unarchived channel/direct/group-direct parent
and its public visibility or active membership. Entity authorization uses that
parent's current metadata with `message.search`. Non-thread access is unchanged.

The set-based implementation avoids adding one helper query per thread. There
are at most 10 candidate queries per request (batch size at least 50, scan cap
500), plus one explicit-conversation preflight query. Entity results remain
cached by conversation within the request, including reuse of preflight results.
SQL budget tests count every query and prove that parent access adds none.
Both channel and thread cases scan 500, 500, then 4 candidates across pages,
with 17, 17, then 2 host calls, preserving the empty middle page's continuation.

Search retains named-thread titles and the original thread conversation/message
IDs, snippets, deterministic ordering and authorization-aware keyset pagination.
It does not index referenced source text or create participation, follow,
preference or read-cursor rows. Closed/locked and old inactive history remains
readable. Inactivity hiding is derived by discovery policy rather than stored as
a flag; search has no inactivity-policy filter. Administrative child archives
remain excluded, and archived parents cannot authorize their threads.
Filtered denial and sanitized thrown host-policy errors retain their behavior.

## Exact verification

Commands ran sequentially from the SDK root, with bounded compiler and test
workers:

```bash
GOMAXPROCS=2 GOMEMLIMIT=2GiB node_modules/.bin/tsc --project tsconfig.message-search-query.json --pretty false
GOMAXPROCS=2 node_modules/.bin/esbuild test/postgres-message-search-query.test.mjs test/message-search-query-budget.test.mjs --bundle --platform=node --format=esm --packages=external --alias:@handrail/chat/server=./src/server/index.ts --alias:@handrail/chat/testing=./src/testing/index.ts --alias:@handrail/chat=./src/index.ts --outdir=node_modules/message-search-tests --out-extension:.js=.mjs
bash node_modules/.cache/websocket-parent-postgres.sh "$PWD/node_modules/message-search-tests/postgres-message-search-query.test.mjs" "$PWD/node_modules/message-search-tests/message-search-query-budget.test.mjs"
git diff --check -- src/server/message-search-query.ts test/postgres-message-search-query.test.mjs tsconfig.message-search-query.json docs/validation/message-search-parent-access.md
```

The scoped compile includes the production query, its dependencies, canonical
migrations and existing test harness. Bundling aliases package imports to fresh
canonical source, without relying on or rewriting shared `dist` output.

The existing native runner, reproduced in
[websocket verification](websocket-parent-access.md#exact-verification-commands),
provided disposable PostgreSQL **15.19** through `TEST_DATABASE_URL` to
`createPostgresTestBackend` and `createChatTestHarness`. It disables TCP, uses a
private Unix socket, limits connections to 20 and shared buffers to 32 MB, and
stops/removes its cluster on exit. Canonical migrations run in isolated schemas.

Final result: **11 passed, 0 failed, 0 skipped** (9 PostgreSQL tests including
nested cases; 2 deterministic algorithmic tests). Scoped compilation and diff
whitespace checks passed. The SQL cases prove filtered/unfiltered no-participation
and explicit-unfollow access; retained child membership after channel/direct/
group-direct parent revocation; current parent entity denial/error; stable named
destinations and pagination; closed/locked/inactive history; archive exclusions;
source-text isolation; and unchanged private user state under read-only searches.

Two preliminary runs passed 9 and failed the 2 budget cases because the existing
budget seed's `UNION` inferred timestamp NULLs as text. Explicit casts on both
branches fixed the fixture; the fresh final run passed every case.

## Scope and limits

This worker edited only the search query, its PostgreSQL test file, scoped compile
configuration, and this evidence document. No shared helper/export edits or
concrete sibling file overlaps were needed. Sibling work was preserved.
During final verification, concurrent workspace commit `183fb79` included the
query, tests and compile configuration. This worker ran no commit, push or other
Git finalization commands and did not undo that concurrent commit. This document
remained uncommitted at the final status inspection. The requested uncommitted
state therefore could not be retained for the code without reversing another
writer's Git finalization. `git diff --check HEAD^ HEAD --
src/server/message-search-query.ts test/postgres-message-search-query.test.mjs
tsconfig.message-search-query.json` also passed for those checkpointed changes.
Verification covers local PostgreSQL 15.19, not other database
versions, global checks, UI, deployed environments or inactivity discovery policy.
There is no remaining local SQL verification gap for this item.
