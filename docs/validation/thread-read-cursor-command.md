# Parent-authorized thread read cursors

Verified 2026-09-06 for Owner Task item
`638d20af-e77a-4fc5-b925-b866e484c5d0`.

Thread cursor writes previously required active child membership, and completed
idempotency responses bypassed current access checks. Thread targets now check
current parent visibility/membership and host entity access before returning a
completed result. The optional adapter uses the trusted action
`conversation.read_cursor.update`; absent, denying and throwing adapters fail
closed for entity-bound parents. Parent and child must remain unarchived.

The command discovers the parent, locks parent before child and parent membership,
and revalidates the relationship under those locks. Fresh writes call the retained
participant helper on the same transaction connection, including its fresh access
check. Setup preserves existing read/manual-unread and preference rows and never
changes follows or drafts. Cursor mutation retains its existing reconciliation:
stale advances fail with `cursor_regression`, equal-sequence explicit mark-read
clears manual unread, and unchanged mark-unread retains its timestamp. Nonthread
membership and completed-replay behavior remain unchanged. No lifecycle or
archive permission changes were introduced.

Files owned by this item:

- `src/server/update-read-cursor-command.ts`: authorization and retained setup.
- `src/server/create-chat-server.ts`: only four lines passing the trusted adapter
  in `handleReadCursor`; sibling changes were preserved.
- `test/postgres-thread-read-cursor-command.test.mjs`: focused SQL companion.
- `tsconfig.read-cursor-command.json`: compile both production files and dependencies.
- This validation record.

Verification commands ran sequentially, with one test worker, against freshly
bundled canonical source. Shared `dist` was neither consumed nor rewritten.

```bash
node_modules/.bin/tsc --project tsconfig.read-cursor-command.json --pretty false
node_modules/.bin/esbuild test/postgres-thread-read-cursor-command.test.mjs test/postgres-update-read-cursor-command.test.mjs --bundle --platform=node --format=esm --packages=external --alias:@handrail/chat/server=./src/server/index.ts --alias:@handrail/chat/testing=./src/testing/index.ts --alias:@handrail/chat=./src/index.ts --out-extension:.js=.mjs --outdir=node_modules/thread-read-cursor-tests
bash node_modules/.cache/websocket-parent-postgres.sh "$PWD/node_modules/thread-read-cursor-tests/postgres-thread-read-cursor-command.test.mjs" "$PWD/node_modules/thread-read-cursor-tests/postgres-update-read-cursor-command.test.mjs"
git diff --check -- src/server/update-read-cursor-command.ts src/server/create-chat-server.ts
```

The existing native bootstrap is reproduced in
[the websocket validation record](websocket-parent-access.md). `TEST_DATABASE_URL`
was initially unset. Installed PostgreSQL **15.19** supplied a disposable cluster
with TCP disabled, private Unix socket, 20 connections and 32 MB shared buffers.
`createPostgresTestBackend` / `createHarness` used its test URL, unique schemas and
canonical migrations. The cluster was stopped and removed on exit. No shared
database, runtime configuration, or simulated SQL backend was used.

Results: scoped TypeScript and whitespace checks passed, exit 0. PostgreSQL:
**29 passed, 0 failed, 0 cancelled, 0 skipped** (18 new thread subtests, nine
existing nonthread subtests, two enclosing tests). The first execution passed.

New coverage proves public/private parent access without child membership or
follow creation; retained role/join time, notification/mute/star/revision, drafts,
both follow states, cursor/manual-unread re-entry; exact replay without setup;
stale advancement rollback; equal-sequence mark-read reconciliation and future
timestamp ordering; parent membership/entity/adapter/archive revocation denying
fresh requests and completed retries; denied initial setup and setup recheck;
tenant/user isolation; relationship changes between discovery and locks; invalid
mutation rollback; and late outbox failure rollback for new and retained storage.
Audit and actor-private outbox payload assertions passed.

No unrelated failures occurred in these focused checks. No remaining local SQL
acceptance gap; other PostgreSQL versions and global checks were not run. The
patch remains uncommitted. No UI, Flutter, deployment, provider, external-send,
runtime configuration, commit, push or PR actions were performed.
