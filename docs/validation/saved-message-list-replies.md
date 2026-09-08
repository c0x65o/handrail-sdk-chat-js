# Saved reply hydration and thread parent access

Verified 2026-09-06 for Owner Task item
`ff625bcf-4019-4aa0-a21e-1ec3469389a3`.

Saved-list current projections now hydrate persisted `reply_to_message_id` and
`reply_notify_author` using the existing canonical `replyTo` contract. References
contain only `messageId` and required boolean `notifyAuthor`; their conversation
is the saved reply's current conversation. Both ping choices and legacy omission
survive reload. Source deletion retains the reference without loading or copying
source text, author snapshots or forward attribution. The saved message itself,
when deleted or inaccessible, still returns the exact unavailable shell.

Thread saves previously relied on child membership. They now use
`authorizeThreadAccess` with `operation: "read"` and the trusted
`saved_message.list` entity action. Current parent membership/visibility and host
entity access govern content and attachment URL resolution. Parent revocation
overrides a surviving active child member; entity denial and thrown host errors
return inaccessible shells. Unexpected database errors still propagate. The
saved-list archive exclusion applies both to the page query and to the helper's
returned archive metadata, since shared read authorization permits archived
children. Non-thread access behavior is retained.

The list still uses one set-based page query. Each distinct unarchived thread on
the returned page adds at most one shared-helper query and one parent entity call
when applicable. These checks run sequentially and reuse results only within the
request; the pagination lookahead row adds no check. Thus database queries are
bounded by `1 + distinct unarchived page threads`. The original non-thread
one-query assertion and the repeated-thread two-query assertion pass.

## Files and verification

- `src/server/saved-message-list-query.ts`: hydration and parent authorization.
- `test/postgres-saved-message-list-query.test.mjs`: real PostgreSQL regressions.
- `tsconfig.saved-message-list-query.json`: focused compile of the query, helper
  dependencies, canonical migrations and existing PostgreSQL harness.
- This evidence document. No generated contracts required changes.

Commands ran sequentially from the SDK root:

```bash
GOMAXPROCS=2 GOMEMLIMIT=2GiB node_modules/.bin/tsc --project tsconfig.saved-message-list-query.json --pretty false
GOMAXPROCS=2 node_modules/.bin/esbuild test/postgres-saved-message-list-query.test.mjs --bundle --platform=node --format=esm --packages=external --alias:@handrail/chat/server=./src/server/index.ts --alias:@handrail/chat/testing=./src/testing/index.ts --alias:@handrail/chat=./src/index.ts --outfile=node_modules/saved-message-list-tests/postgres-saved-message-list-query.test.mjs
bash node_modules/.cache/websocket-parent-postgres.sh "$PWD/node_modules/saved-message-list-tests/postgres-saved-message-list-query.test.mjs"
git diff --check -- src/server/saved-message-list-query.ts test/postgres-saved-message-list-query.test.mjs tsconfig.saved-message-list-query.json docs/validation/saved-message-list-replies.md
```

Scoped TypeScript compilation and bundling passed. The test bundle resolves
canonical source without reading or rewriting shared `dist` implementation.
The temporary native runner is reproduced in
[websocket parent-access verification](websocket-parent-access.md#exact-verification-commands).
`TEST_DATABASE_URL` was unset; the documented runner provided a disposable native
PostgreSQL **15.19** instance to `createPostgresTestBackend` / `createHarness`.
TCP was disabled, the Unix socket private, connections capped at 20, shared buffers
32 MB, and Node test concurrency one. Tests applied canonical migrations to
isolated schemas; teardown stopped and removed the disposable cluster.

Final PostgreSQL result: **11 passed, 0 failed, 0 skipped**. Coverage proves:

- Reply reload with true/false notification choices and absent legacy references.
- Source soft deletion with deliberately retained stale database content exposes
  only the safe reference; deleting the saved reply returns an exact shell.
- Authorized thread replies retain their thread destination and resolve URLs;
  repeated saves authorize once, with access checked again on subsequent requests.
- Private-parent revocation with active child membership, parent entity denial
  and error, and parent/child archives return shells with zero URL calls.
- Public-parent access works without child or parent membership.
- Existing actor/tenant and private-note isolation, save metadata, attachment
  order, edited/deleted message redaction, and lossless keyset pagination pass.

The first SQL run passed 10 tests and failed one new deletion fixture because
`deleted_at` exceeded unchanged `updated_at`. Updating both fixture timestamps
together fixed it; the freshly rebuilt rerun passed all 11 tests. Whitespace
checks passed. No unrelated failures were encountered in these focused checks.

## Limits

Verification used local PostgreSQL 15.19; other versions, global suites, UI and
deployed environments were not exercised. There is no remaining local SQL
acceptance gap for this item. Sibling edits, including
`test/postgres-thread-lifecycle-schema.test.mjs`, were preserved. The patch is
uncommitted; no preview changes, QA campaigns, deployment, provider calls,
external sends, commits, pushes or PRs were performed.
