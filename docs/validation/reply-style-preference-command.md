# Transactional reply-style preference save verification

Owner item: `9df6f7d6-310b-425c-bbb0-7db44d4af5dd`.
Verified 2026-09-07 in the SDK convergence workspace; patch left uncommitted.

`updateReplyStylePreference` saves only the trusted tenant/user's style. The
existing Current choice is retained as an explicit supported save, while an
absent choice remains absent until the first explicit save. The future
Discord-style UI action will reply within the current conversation; Current
retains Reply-to-thread. This command saves that choice only: it does not
implement UI actions, route messages, grant capabilities, or change any shared
conversation facts.

The command follows existing idempotency claim, SHA-256 canonical request hash,
transaction, audit, retention, rollback and connection-release conventions. A
schema/operation/tenant/user advisory transaction lock protects both absence and
existing rows across different keys. Row locking and a guarded upsert protect
the persisted revision. The canonical HTTP parsers validate requests and every
response. Revision comparison precedes value comparison. Stored conflict styles
are preserved exactly, without applying display fallback. Completed keys return
the original result, with only applied becoming replayed. Conflicts store HTTP
status 409; other completed results store 200.

An applied save atomically writes the preference, one existing-table audit
record targeted at the actor user, one `reply.style.updated` outbox event on that
user's private stream, and the idempotent response. The event carries exactly
`{actorUserId, preference, updatedAt, mutation}`; the timestamp is read back from
the persisted row. No-op, conflict and replay emit no event or audit.

## Checks and results

- `./node_modules/.bin/tsc --project tsconfig.reply-style-preference-command.json`
  passed against the actual command source and its imported dependencies, with
  no emit. No dependency on the sibling query implementation.
- Source-bundled isolated PostgreSQL command suite: **10/10 passed**, no skips.
  First saves, explicit Current from absence, switch-back, stale absence/saved
  state (including matching style), no-op, original snapshots on retry after
  later changes, changed-style and changed-revision key reuse, tenant/user key
  isolation, concurrent different-key first saves/existing updates and same-key
  retries all passed.
- Unsupported stored style conflict preservation passed using a temporarily
  relaxed style constraint in the isolated test schema, followed by a supported
  save and constraint restoration. The shipped migration remains unchanged.
- Real PostgreSQL triggers injected audit insert, outbox insert and final
  idempotency completion failures, for both absent and existing preferences.
  Full state/effect/idempotency snapshots remained unchanged; connections were
  released and retry with the rolled-back key succeeded.
- Every applied change had exactly one private event parsed by the canonical
  durable event parser, with exact mutation, persisted style/revision/timestamps,
  retention, matching audit and original idempotent response/hash. Parsing for
  another tenant or user failed. Nonempty conversation/message, membership,
  follow, notification preference, read cursor and draft fixtures were unchanged,
  including a closed, locked and archived named thread.
- Existing source-bundled storage/migration suite: **50/50 passed**, no skips,
  covering fresh installation and legacy upgrade.
- `git diff --check` passed. No canonical contracts changed; generated outputs
  needed no regeneration. No Dart production files changed.

The initial combined run passed all storage tests and eight command subtests,
then caught a test-envelope conversion error: PostgreSQL's bigint protocol
version was passed as a string into the event parser. The fixture now converts
it to a number, matching the production outbox publisher. The corrected command
suite passed; a subsequent run with explicit closed/locked/archived fixtures
also passed. No production command failure or unrelated project failure was
observed. Global checks were intentionally outside this concurrent task's scope.

## Reproduction

From the SDK root, bundle source without writing shared `dist`:

```sh
./node_modules/.bin/tsc --project tsconfig.reply-style-preference-command.json
./node_modules/.bin/esbuild test/postgres-update-reply-style-preference-command.test.mjs --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/reply-style-command-tests.mjs
./node_modules/.bin/esbuild test/postgres-reply-style-preference-schema.test.mjs --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/reply-style-command-schema-tests.mjs
```

Used the repository's documented disposable native PostgreSQL pattern through
`createPostgresTestBackend` and its URL-backed, schema-isolated harness. Native
PostgreSQL was **15.19**; pool maximum four, Node test concurrency one, checks
sequential. TCP disabled, private Unix socket, test-only cluster, no managed or
application database access. Each harness confirmed schema removal. Cluster
shutdown and directory cleanup ran on exit. PostgreSQL 16 was not exercised.

```bash
set -euo pipefail
reply_pg_dir=$(mktemp -d "$PWD/.reply-pg.XXXXXX")
trap '/usr/lib/postgresql/15/bin/pg_ctl -D "$reply_pg_dir/data" -m immediate -w stop >/dev/null 2>&1 || true; rm -rf -- "$reply_pg_dir"' EXIT
/usr/lib/postgresql/15/bin/initdb -D "$reply_pg_dir/data" -U handrail_test --auth-local=trust --auth-host=reject --encoding=UTF8 --no-locale > "$reply_pg_dir/init.log"
/usr/lib/postgresql/15/bin/pg_ctl -D "$reply_pg_dir/data" -l "$reply_pg_dir/server.log" -o "-c listen_addresses='' -c unix_socket_directories='$reply_pg_dir' -c unix_socket_permissions=0700 -c max_connections=20 -c shared_buffers=32MB" -w start
TEST_DATABASE_URL="postgresql://handrail_test@/postgres?host=$reply_pg_dir" node --test --test-reporter=spec --test-concurrency=1 "$PWD/node_modules/.cache/reply-style-command-tests.mjs" "$PWD/node_modules/.cache/reply-style-command-schema-tests.mjs"
```

The first failed test run reported 118 MiB memory peak, zero swap and zero OOM
kills; it was an assertion/parser error, not a resource failure.

Sibling query files and their concurrent `src/server/index.ts` export were
preserved. This item's barrel change adds only the command export. No HTTP,
client, UI, preview, capability advertisement, live runtime, deployment, provider,
QA campaign, commit, push or PR changes were made. No acceptance blocker remains
for this selected command item.
