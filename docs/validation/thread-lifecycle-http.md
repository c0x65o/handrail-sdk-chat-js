# Thread lifecycle HTTP dispatch

Owner task `681ec244-9096-4bff-bf1f-4bafd647bd1b`, verified 2026-09-06.

`PATCH /conversations/:threadId/lifecycle` and the existing archive endpoint are
one URL shape. `src/server/create-chat-server.ts` now reads the bounded JSON body
once and selects `update_thread_lifecycle` or the existing
`set_conversation_archive` parser/command. Unknown operations are rejected.

Lifecycle input uses `parseThreadLifecycleHttpInput`: the decoded path supplies
`threadId`, while the body supplies intent, expected revision and idempotency key.
Unknown fields and caller identity, role, moderation, permission and canonical
state claims are rejected. The authenticated actor, configured permission adapter,
database and schema go to `updateThreadLifecycle`. Its canonical result is checked
against the normalized input. Applied/replayed/no-op results return 200; canonical
lifecycle conflicts and sanitized command conflicts return 409. Authorization
retains the non-disclosing 403 response; internal/result failures return a sanitized
503 without canonical state.

Archive/restore retain their parser, command, matching Idempotency-Key header,
response format and validation. Both operations use the existing 64 KiB request
and response bounds and existing admission/observability route template
`/conversations/:conversationId/lifecycle`. Transport failures before operation
dispatch retain the archive route's existing error code. Lifecycle body validation
uses `chat_thread_lifecycle_invalid_request`; command conflicts and availability
failures use `chat_thread_lifecycle_conflict` and `chat_thread_lifecycle_unavailable`.

This changes how explicit HTTP operations reach the existing shared-state command.
It does not change Reply behavior or saved styles. Administrative archive remains
independent from close/lock. No handshake advertisement or route capability gate
was added: `thread_lifecycle_v1` remains reserved and client controls must still
require explicit server capability support. The separately owned discovery route
continues reporting lifecycle support as false. Existing sibling routing, exports,
commands and other working-tree changes were preserved.

## Checks

All bundles below use current canonical source, not shared `dist` artifacts.
Expensive commands ran sequentially with one Node test worker.

- `node_modules/.bin/tsc --project tsconfig.thread-lifecycle-http.json` — passed.
  The scoped configuration includes the touched production router and its imported
  dependencies.
- `test/postgres-thread-lifecycle-http.test.mjs` — passed, 8 reported tests
  (7 cases plus parent). Covers authenticated canonical applied/replayed/no-op
  results, path decoding/string preservation, stale revision and key reuse 409s,
  body spoof rejection, malformed/query/path/content-type/oversized/streamed body
  rejection before command work, authentication/admission order, trusted actor
  forwarding, non-disclosing permission/tenant/missing-thread denials, archive and
  restore compatibility, archived lifecycle denial, explicit reopen, unchanged
  capability advertisement, and sanitized internal failures.
- `node scripts/generate-thread-lifecycle.mjs --check` — passed.
- `node scripts/generate-conversation-archive.mjs --check` — passed.
- Scoped `git diff --check` — passed.
- Existing `test/postgres-thread-follow-http.test.mjs`, bundled with package imports
  redirected to source — failed before HTTP dispatch during fixture setup:
  PostgreSQL `23514`, `chat_messages_content_check`. Its fixture's message content
  is incompatible with the current schema. This unrelated test was not modified;
  this failure is a convergence follow-up finding, not a lifecycle-routing blocker.

The new suite uses `createPostgresTestBackend` / `createHarness`, canonical
migrations and an isolated schema on disposable PostgreSQL 15. SQL was never
reimplemented in a fake. The original new-test run caught two assertion mistakes
(permission-adapter argument shape and the existing archive error code's case);
those expectations were corrected before the passing run.

## Reproduce

From the SDK repository:

```bash
node_modules/.bin/tsc --project tsconfig.thread-lifecycle-http.json
node_modules/.bin/esbuild test/postgres-thread-lifecycle-http.test.mjs \
  --bundle --platform=node --format=esm --packages=external \
  --outfile=node_modules/.cache/postgres-thread-lifecycle-http.test.mjs
```

If no test database is already configured, the worker used this disposable local
instance (socket only, no host listener). Cleanup is limited to its own directory:

```bash
set -euo pipefail
thread_lifecycle_pg_dir=$(mktemp -d /tmp/handrail-codex-heavy-command-locks/thread-lifecycle-pg.XXXXXX)
trap '/usr/lib/postgresql/15/bin/pg_ctl -D "$thread_lifecycle_pg_dir/data" -m immediate -w stop >/dev/null 2>&1 || true; rm -rf "$thread_lifecycle_pg_dir"' EXIT
/usr/lib/postgresql/15/bin/initdb -D "$thread_lifecycle_pg_dir/data" -U handrail_test \
  --auth-local=trust --auth-host=reject --encoding=UTF8 --no-locale \
  >"$thread_lifecycle_pg_dir/init.log" 2>&1
/usr/lib/postgresql/15/bin/pg_ctl -D "$thread_lifecycle_pg_dir/data" \
  -l "$thread_lifecycle_pg_dir/server.log" \
  -o "-c timezone=UTC -c listen_addresses='' -c unix_socket_directories='$thread_lifecycle_pg_dir' -c unix_socket_permissions=0700 -c max_connections=20 -c shared_buffers=32MB" -w start
TEST_DATABASE_URL="postgresql://handrail_test@/postgres?host=$thread_lifecycle_pg_dir" \
  node --test --test-concurrency=1 \
  "$PWD/node_modules/.cache/postgres-thread-lifecycle-http.test.mjs"
```

The existing PostgreSQL follow regression was built using:

```bash
node_modules/.bin/esbuild test/postgres-thread-follow-http.test.mjs \
  --bundle --platform=node --format=esm --packages=external \
  --alias:@handrail/chat/server=./src/server/index.ts \
  --alias:@handrail/chat/testing=./src/testing/index.ts \
  --alias:@handrail/chat=./src/index.ts \
  --outfile=node_modules/.cache/postgres-thread-follow-http.test.mjs
```

It ran with the same disposable database setup and `node --test
--test-concurrency=1`, alongside the lifecycle suite in the initial run. No global
checks, Flutter edits, deployment, provider calls, external sends, QA campaign,
commit, push or PR were performed. Changes remain uncommitted.
