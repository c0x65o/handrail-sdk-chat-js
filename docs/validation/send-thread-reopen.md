# Atomic thread send/reopen verification

Verified 2026-09-06 for Owner Task item `e640e9e1-ac1c-41e6-8382-7a3a24c904a9`.

## Behavior and scope

Previously, sending required active child membership and did not enforce closed
or locked thread state. Plain and inline thread sends now recheck parent/entity
access under parent-before-child conversation locks and compatible membership
write locks. Eligible parent readers can initialize or reactivate retained
participation using `ensureThreadParticipant` in the send transaction. Existing
roles, join times, private preferences, cursors, drafts and manual unfollow survive.

Closed/unlocked sends clear both closure fields and advance the bounded lifecycle
revision atomically with the message and outbox. An actual reopen emits one child
`thread.lifecycle.updated` and one minimal parent `thread.lifecycle.changed`,
alongside the ordinary message and summary events. Open sends emit no lifecycle
events. Locked sends reject even managers until explicit unlock; administrative
archives and parent-access denial still reject.

The permission adapter has optional `authorizeThreadSend` narrowing with canonical
parent/thread IDs and capabilities resolved by `getCapabilities`. Absence preserves
`message.send` fallback. Replays refresh current authority and return the original
sanitized message without participant, lifecycle, activity or event mutations,
including after a subsequent close/lock or inactive child membership. Existing
non-thread reconciliation and reply-source error/sanitization behavior remain.

This is shared backend behavior in both reply styles; it does not change reply
routing, UI, edit/reaction permissions or any saved style. The existing policy
records that there is no runtime automatic reply/mention-follow writer in the
send/notification/migration paths; this patch preserves existing follow behavior
and manual-unfollow protection and does not introduce such a writer.

## Checks

- `node_modules/.bin/tsc --project tsconfig.send-message-command.json`: passed.
  Includes touched production send code and its actual dependencies, including
  permission contracts, thread access and participant helpers; not only contracts.
- Canonical source bundles, then real PostgreSQL tests with one test worker:
  **31 passed, 0 failed, 0 skipped** (28 subtests and three parent tests).
- `git diff --check`: passed.

Suites: `test/postgres-send-thread-reopen.test.mjs`,
`test/postgres-send-message-command.test.mjs`, and
`test/postgres-update-thread-lifecycle-command.test.mjs`.

Coverage includes plain/inline closed sends, duplicate requests, exact event
payloads/cardinality and canonical message identities; parent readers without
child membership (including public parent readers with no membership); retained
inactive moderator state and private data; manual unfollow; legacy and explicit
host policy; locked manager/ordinary denial and explicit unlock; child/parent
archive, revoked membership/entity/capability denial; invalid source/attachment
and late parent-outbox/idempotency-completion rollback; revision exhaustion; and
both deterministic close-before-send and send-before-close races with unchanged
replay snapshots. Race tests observe actual PostgreSQL lock waits. Existing send
regressions also exercise reply sanitization after source deletion and direct
source/membership/archive changes blocked by send locks.

## Reproduction and backend provenance

The default backend failed because `TEST_DATABASE_URL` was unset and Docker-backed
PostgreSQL could not start. No database assertions passed on that attempt. Native
PostgreSQL **15.19** was available; verification used the repository's established
disposable native-cluster pattern, `createPostgresTestBackend` / `createHarness`,
an isolated schema and all canonical migrations. TCP was disabled, the Unix socket
was private, and the cluster was stopped and removed after each run. No shared
operator database or application runtime configuration was changed.

Build the test bundles (shared `dist` is never used or overwritten):

```bash
node_modules/.bin/esbuild \
  test/postgres-send-thread-reopen.test.mjs \
  test/postgres-send-message-command.test.mjs \
  test/postgres-update-thread-lifecycle-command.test.mjs \
  --bundle --platform=node --format=esm --packages=external \
  --outdir=node_modules/.cache/send-reopen
node_modules/.bin/tsc --project tsconfig.send-message-command.json
```

Run the following in Bash. The temporary directory is within this worker's writable
scratch root. Absolute test paths avoid the worker runner's relative-path launch
failure observed on the initial command.

```bash
set -euo pipefail
send_pg_dir=$(mktemp -d /tmp/handrail-codex-heavy-command-locks/send-pg.XXXXXX)
trap '/usr/lib/postgresql/15/bin/pg_ctl -D "$send_pg_dir/data" -m immediate -w stop >/dev/null 2>&1 || true; rm -rf "$send_pg_dir"' EXIT
/usr/lib/postgresql/15/bin/initdb -D "$send_pg_dir/data" -U handrail_test \
  --auth-local=trust --auth-host=reject --encoding=UTF8 --no-locale \
  >"$send_pg_dir/init.log" 2>&1
/usr/lib/postgresql/15/bin/pg_ctl -D "$send_pg_dir/data" \
  -l "$send_pg_dir/server.log" \
  -o "-c timezone=UTC -c listen_addresses='' -c unix_socket_directories='$send_pg_dir' -c unix_socket_permissions=0700 -c max_connections=20 -c shared_buffers=32MB" \
  -w start
TEST_DATABASE_URL="postgresql://handrail_test@/postgres?host=$send_pg_dir" \
  node --test --test-concurrency=1 \
  "$PWD/node_modules/.cache/send-reopen/postgres-send-thread-reopen.test.js" \
  "$PWD/node_modules/.cache/send-reopen/postgres-send-message-command.test.js" \
  "$PWD/node_modules/.cache/send-reopen/postgres-update-thread-lifecycle-command.test.js"
```

No global build, UI/Flutter check, provider call, deployment or QA campaign was
performed. No unrelated pre-existing failure was encountered in the scoped
checks. PostgreSQL versions other than the available native version were not run.

## Shared workspace observation

While this worker was implementing/tests were being written, the shared checkout
advanced externally to `183fb79`, incorporating the production implementation,
permission adapter, policy, source-based regression imports and scoped tsconfig.
This worker issued no commit, push, reset, restore, stash or other Git finalization
commands. Those externally finalized files were preserved. The additional replay
capability refresh, new regression suite and this evidence document were left as
workspace changes for Handrail review/finalization.
