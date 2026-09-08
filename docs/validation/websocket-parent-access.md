# Websocket parent authorization verification

Verified 2026-09-06 for Owner Task item
`174a9aa4-1724-43c9-99b5-0eed42907a99`.

## Change and reproduction

Thread subscription reads now call `authorizeThreadAccess` with
`conversation.subscribe`. Parent membership and host entity permission determine
access independently of child membership or follow state. The subscription
consumer retains its archived-child restriction and requires a literal `true`
from the host adapter. Reconnect and buffered replay retain their existing shared
authorization path.

Parent-scoped revalidation now examines subscribed children even when their
session does not subscribe to the parent. Relationship lookup is tenant-scoped
and runs inside the existing session operation queue. Revocation uses the existing
removal path, counts, messages and queued-delivery cleanup. A failed relationship
lookup conservatively revokes conversation subscriptions in the selected actor
scope; actor-private streams remain intact.

Before the production patch, the new PostgreSQL suite reproduced four failing
subtests: an eligible unfollowed child was rejected; a denied child remained in
replay; a parent notification revoked zero child streams; and inherited host
denial was ignored. This used real SQL, not a simulated database.

## Results

- Scoped TypeScript compilation: passed, exit 0.
- PostgreSQL/thread/replay/live-delivery suites: **39 passed**, no failures or skips.
- Stream authorization/session revalidation/replay regressions: **29 passed**,
  no failures or skips.
- Scoped `git diff --check`: passed.

The new SQL coverage includes public/private channel and direct/group-direct
parents, no child membership, follow/unfollow, retained membership after parent
loss, inherited host denial/error/malformed result, fresh/reconnect subscription,
replay and buffered replay, active child-only revocation, queued and later delivery
exclusion, counts, unrelated parent scope, user-stream scope, same-ID tenant
collisions with different parent relationships, user isolation, and archives.

The default backend initially failed because `TEST_DATABASE_URL` was unset and
Docker was unavailable. The existing native recipe in `docs/integration-testing.md`
resolved this: disposable PostgreSQL 15, private Unix socket, TCP disabled,
`max_connections=20`, `shared_buffers=32MB`, canonical migrations and unique schemas
owned by `createPostgresTestBackend`/`createHarness`. The cluster was stopped and
removed after each run. No SQL acceptance gaps remain. PostgreSQL 16 container
execution was unavailable; no deployed environment or global checks were run.

Two initial artifact launches also failed (relative test path under the worker
wrapper; an extra output-directory level broke package metadata lookup). Absolute
test paths and the two-level output directory below resolved both.

## Exact verification commands

Run sequentially from the repository root. Bundles resolve current canonical
sources, including the existing replay test's direct `dist` import; shared `dist`
is neither consumed nor rewritten.

```bash
node_modules/.bin/tsc --project tsconfig.websocket-parent-access.json

node --input-type=module <<'JS'
import { build } from 'esbuild';
import { resolve } from 'node:path';
await build({
  entryPoints: ['test/postgres-websocket-thread-authorization.test.mjs', 'test/postgres-websocket-replay.test.mjs', 'test/postgres-thread-access.test.mjs', 'test/websocket-stream-authorization.test.mjs', 'test/websocket-session-revalidation.test.mjs', 'test/websocket-live-delivery.test.mjs', 'test/websocket-replay.test.mjs'],
  bundle: true, platform: 'node', format: 'esm', packages: 'external',
  alias: { '@handrail/chat/server': './src/server/index.ts', '@handrail/chat/testing': './src/testing/index.ts', '@handrail/chat': './src/index.ts' },
  plugins: [{ name: 'canonical-replay', setup(build) { build.onResolve({ filter: /\.\.\/dist\/server\/websocket-replay\.js$/ }, () => ({ path: resolve('src/server/websocket-replay.ts') })); } }],
  outExtension: { '.js': '.mjs' }, outdir: 'node_modules/websocket-parent-tests',
});
JS

bash node_modules/.cache/websocket-parent-postgres.sh "$PWD/node_modules/websocket-parent-tests/postgres-websocket-thread-authorization.test.mjs" "$PWD/node_modules/websocket-parent-tests/postgres-websocket-replay.test.mjs" "$PWD/node_modules/websocket-parent-tests/postgres-thread-access.test.mjs" "$PWD/node_modules/websocket-parent-tests/websocket-live-delivery.test.mjs" > node_modules/.cache/websocket-parent-postgres.tap 2>&1

node --test --test-concurrency=1 "$PWD/node_modules/websocket-parent-tests/websocket-stream-authorization.test.mjs" "$PWD/node_modules/websocket-parent-tests/websocket-session-revalidation.test.mjs" "$PWD/node_modules/websocket-parent-tests/websocket-replay.test.mjs" > node_modules/.cache/websocket-parent-regressions.tap 2>&1

git diff --check -- src/server/websocket-subscriptions.ts src/server/websocket-upgrade.ts test/websocket-stream-authorization.test.mjs
```

The temporary native runner `node_modules/.cache/websocket-parent-postgres.sh`
contains exactly:

```bash
#!/usr/bin/env bash
set -euo pipefail
pg_bin=$(pg_config --bindir)
pg_thread_tmp=$(mktemp -d /tmp/handrail-codex-heavy-command-locks/thread-pg.XXXXXX)
cleanup() {
  if test -f "$pg_thread_tmp/data/postmaster.pid"; then
    "$pg_bin/pg_ctl" -D "$pg_thread_tmp/data" -m immediate -w stop
  fi
  rm -rf -- "$pg_thread_tmp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"$pg_bin/initdb" -D "$pg_thread_tmp/data" -U handrail_test --auth-local=trust --auth-host=reject --encoding=UTF8 --no-locale > "$pg_thread_tmp/initdb.log"
"$pg_bin/pg_ctl" -D "$pg_thread_tmp/data" -l "$pg_thread_tmp/postgres.log" -o "-c listen_addresses='' -c unix_socket_directories='$pg_thread_tmp' -c unix_socket_permissions=0700 -c max_connections=20 -c shared_buffers=32MB" -w start
TEST_DATABASE_URL="postgresql://handrail_test@/postgres?host=$pg_thread_tmp" node --test --test-concurrency=1 "$@"
```

The scoped patch remains uncommitted. Sibling changes, generated contracts,
migrations, server assembly, shared exports, Flutter and preview code were not
edited by this task. No unrelated pre-existing failures were encountered in the
focused checks.
