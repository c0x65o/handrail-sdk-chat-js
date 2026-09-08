# Thread attachment preparation verification

Verified 2026-09-06 for Owner Task item `a02e74bf-6950-421c-9f05-1d453de59ab4`.

## Change

Previously, preparation joined active child membership and rejected an eligible
parent reader's first thread upload. Preparation now locks parent, child and the
actor's parent/child membership rows in the established send order. Within that
transaction it checks current parent access, `message.send`, `attachment.prepare`,
entity policies for both actions, and optional `authorizeThreadSend` narrowing.
Absent host narrowing retains the legacy `message.send` fallback.

Only an authorized missing/inactive participant invokes `ensureThreadParticipant`.
Active participants receive no membership updates. Existing roles, join times,
cursors, preferences, drafts and manual follows/unfollows survive preparation,
reactivation and replay. Locked/archived children and inaccessible/archived parents
deny, even when the child retains active membership or the upload was previously
prepared. Reconciliation refreshes authority again after its attachment row lock,
since external host policy can change while that lock waits.

Closed/unlocked preparation leaves closure, lifecycle revision, activity, messages
and events unchanged. An actual send still checks its original destination and
performs the existing atomic reopen. No send authority is persisted with an upload.
Destination-bound preparation hashing, nonthread authorization, attachment
validation/reservation limits, descriptor validation and idempotency paths remain.

Edits are confined to `src/server/prepare-attachment-command.ts`,
`test/postgres-prepare-attachment-command.test.mjs`, the scoped compile configuration
and this evidence. The existing test now imports canonical sources and uses the
current harness `teardown` API. Sibling send, contracts, server routing and all
Flutter/preview work were preserved; no shared build output was overwritten.

## Results

- Scoped TypeScript compile: **passed**, no diagnostics. It covers the touched
  production command and its actual imported dependencies.
- Three source-bundled PostgreSQL suites: **34 passed, 0 failed, 0 skipped**
  (29 subtests and five top-level tests). Preparation accounts for 13 checks;
  unchanged send and thread-reopen regressions account for 21.
- Scoped `git diff --check`: **passed**.

Preparation coverage includes first private/public parent readers without child
membership; closed/unlocked preparation even at the maximum lifecycle revision;
concurrent idempotency; retained state and no active-member timestamp changes;
new/replayed locked, archive, parent membership, entity, capability and host-policy
denials before storage and without durable effects; storage/descriptor failures,
late reservation failure and replay-reactivation rollback; observed PostgreSQL
parent, child, membership, idempotency and attachment lock waits; destination hash
conflicts; and independently authorized final attachment send/reopen. Existing
nonthread, tenant isolation, metadata limits and opaque upload replay assertions
also pass. No SQL implementation was faked; only the storage/host boundaries are
stubbed.

The initial default-backend attempt had **1 pass, 2 failures, 0 skips** because
`TEST_DATABASE_URL` was unset and container-backed PostgreSQL could not start.
Native PostgreSQL **15.19** was available. The first native run reproduced
`ChatAuthorizationError` on first eligible preparation; it had **1 pass, 3 failures,
0 skips**, including stale `dispose` cleanup calls. Those calls were corrected to
`teardown`. An intermediate expanded run had **8 passes, 4 failures, 0 skips** from
fixtures violating the real locked-implies-closed constraint; those fixtures were
corrected. The subsequent 33-check run and final 34-check run passed. No unrelated
pre-existing failures remain in these scoped checks.

## Reproduce final verification

Run sequentially from the SDK repository. Bundles are derived directly from
canonical sources into an ignored, task-specific directory, never shared `dist`.

```bash
node_modules/.bin/tsc --project tsconfig.prepare-attachment-command.json
node_modules/.bin/esbuild \
  test/postgres-prepare-attachment-command.test.mjs \
  test/postgres-send-thread-reopen.test.mjs \
  test/postgres-send-message-command.test.mjs \
  --bundle --platform=node --format=esm --packages=external \
  --outdir=node_modules/.cache/prepare-thread
```

The native fallback follows `docs/validation/send-thread-reopen.md`. It creates a
private Unix-socket cluster with TCP disabled, uses `createPostgresTestBackend` /
`createHarness` isolated schemas and all canonical migrations, then tears down the
schemas and stops/removes the cluster. No shared database or runtime configuration
is changed. Absolute paths avoid the worker's relative-path test launch issue.

```bash
set -euo pipefail
prepare_pg_dir=$(mktemp -d /tmp/handrail-codex-heavy-command-locks/prepare-pg.XXXXXX)
trap '/usr/lib/postgresql/15/bin/pg_ctl -D "$prepare_pg_dir/data" -m immediate -w stop >/dev/null 2>&1 || true; rm -rf "$prepare_pg_dir"' EXIT
/usr/lib/postgresql/15/bin/initdb -D "$prepare_pg_dir/data" -U handrail_test \
  --auth-local=trust --auth-host=reject --encoding=UTF8 --no-locale \
  >"$prepare_pg_dir/init.log" 2>&1
/usr/lib/postgresql/15/bin/pg_ctl -D "$prepare_pg_dir/data" \
  -l "$prepare_pg_dir/server.log" \
  -o "-c timezone=UTC -c listen_addresses='' -c unix_socket_directories='$prepare_pg_dir' -c unix_socket_permissions=0700 -c max_connections=20 -c shared_buffers=32MB" \
  -w start
TEST_DATABASE_URL="postgresql://handrail_test@/postgres?host=$prepare_pg_dir" \
  node --test --test-concurrency=1 \
  "$PWD/node_modules/.cache/prepare-thread/postgres-prepare-attachment-command.test.js" \
  "$PWD/node_modules/.cache/prepare-thread/postgres-send-thread-reopen.test.js" \
  "$PWD/node_modules/.cache/prepare-thread/postgres-send-message-command.test.js"
```

```bash
git diff --check -- src/server/prepare-attachment-command.ts \
  test/postgres-prepare-attachment-command.test.mjs \
  tsconfig.prepare-attachment-command.json docs/validation/prepare-thread-attachments.md
```

Verification was local and deterministic with one test worker. No deployment,
provider calls, external sends, QA campaign, commit, push or PR was performed.
PostgreSQL versions other than the available native 15.19 were not tested.
