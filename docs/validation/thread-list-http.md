# Channel thread discovery HTTP integration

Validated 2026-09-06 for Owner Task item `1ce553fa-0d13-4ea0-aa57-e83b748aa6d7`.

## Behavior and scope

Previously the SDK had the discovery contract and query but no server route.
Hosts can now enable `features: { threadDiscovery: true }` in `createChatServer`
and request `GET /conversations/:parentConversationId/threads`. This adds a
paginated way to find existing authorized child discussions; it does not create
threads or change where Reply sends messages. The general conversation list is
preserved. Discovery defaults to false, as do the existing optional features.

The route uses `THREAD_LIST_PATH`, generated `parseThreadListHttpRequest`, and
existing `queryThreadList`. Admission runs before trusted context resolution.
Only the resolved actor, configured database/schema, and normalized shared
`threadListHandlerOptions` reach the query. Repeated query keys, malformed
cursor/limit values, unknown/identity keys, identity headers, and GET bodies
are rejected with a safe 400. Private and entity-backed parents retain query
authorization. Responses and errors use private/no-store caching.

Disabled discovery is advertised as false and returns 501
`chat_thread_discovery_disabled` without executing its query. Unexpected query
failures return 503 `chat_thread_list_unavailable` without SQL/schema details.
Enabled discovery is advertised in the existing metadata/handshake feature map.
No canonical descriptor or generated output needed changing.

`lifecycleSupported` remains false: this server currently has no trusted lifecycle
integration readiness gate. Discovery and an inactivity policy cannot establish
that readiness. The serialized lifecycle-route item
`681ec244-9096-4bff-bf1f-4bafd647bd1b` must preserve this handler and may connect it
to shared readiness once persistence, hydration, and enforcement are established.
That sibling was ready, not running, in the checked task context; the server and
admission files were clean before this worker's edits. Unrelated dirty client,
send/edit-message, attachment, and validation/test files were preserved.

## Results

- Scoped production TypeScript compilation: passed.
- New HTTP suite: 8/8 tests passed (parent plus seven subtests).
- Existing PostgreSQL thread-list query suite: 13/13 passed.
- Existing server metadata, route admission, defaults, and inactivity policy
  regression selection: 11/11 passed.
- Scoped `git diff --check`: passed.

Database tests used native PostgreSQL 15, a disposable Unix-socket-only cluster,
and the existing `createPostgresTestBackend` with isolated schemas and canonical
migrations. HTTP discovery ran in `BEGIN READ ONLY`, opened no command
connections, and left snapshots of every schema table unchanged, including
follows, membership, read state, preferences, messages, idempotency, audit, and
outbox rows. Background maintenance was stopped before measuring request effects.

The first HTTP run exposed a fixture error: creating a follow without parent
access violated the real database guard. The fixture now creates an authorized
follow and then revokes parent membership before testing denial. The corrected
suite passed; this was not an application failure. No PostgreSQL check was
skipped. No unusual resource consumption or process-launch failure occurred.

## Exact focused checks

Run from the SDK repository. Bundles use canonical source and avoid shared `dist`.

```bash
node_modules/.bin/tsc --project tsconfig.thread-list-http.json
node_modules/.bin/esbuild test/postgres-thread-list-http.test.mjs test/postgres-thread-list-query.test.mjs \
  --bundle --platform=node --format=esm --packages=external \
  --outdir=node_modules/.cache --out-extension:.js=.mjs
```

Disposable PostgreSQL setup and sequential execution (the final HTTP-only rerun
used the same setup and omitted the already-passing query suite):

```bash
set -euo pipefail
thread_list_pg_dir=$(mktemp -d /tmp/handrail-codex-heavy-command-locks/thread-list-pg.XXXXXX)
trap '/usr/lib/postgresql/15/bin/pg_ctl -D "$thread_list_pg_dir/data" -m immediate -w stop >/dev/null 2>&1 || true; rm -rf "$thread_list_pg_dir"' EXIT
/usr/lib/postgresql/15/bin/initdb -D "$thread_list_pg_dir/data" -U handrail_test \
  --auth-local=trust --auth-host=reject --encoding=UTF8 --no-locale \
  >"$thread_list_pg_dir/init.log" 2>&1
/usr/lib/postgresql/15/bin/pg_ctl -D "$thread_list_pg_dir/data" -l "$thread_list_pg_dir/server.log" \
  -o "-c timezone=UTC -c listen_addresses='' -c unix_socket_directories='$thread_list_pg_dir' -c unix_socket_permissions=0700 -c max_connections=20 -c shared_buffers=32MB" -w start
TEST_DATABASE_URL="postgresql://handrail_test@/postgres?host=$thread_list_pg_dir" \
  node --test --test-concurrency=1 \
  "$PWD/node_modules/.cache/postgres-thread-list-http.test.mjs" \
  "$PWD/node_modules/.cache/postgres-thread-list-query.test.mjs"
```

Existing server regression bundle redirects package imports to canonical sources
and preserves the test's package-manifest lookup after relocating its bundle:

```bash
node --input-type=module <<'JS'
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
await build({ entryPoints: ['test/create-chat-server.test.mjs'], bundle: true, platform: 'node', format: 'esm', packages: 'external',
  outfile: 'node_modules/.cache/thread-list-server-regression.mjs',
  alias: { '@handrail/chat/server': './src/server/index.ts', '@handrail/chat': './src/index.ts' },
  plugins: [{ name: 'test-package-path', setup(b) {
    b.onLoad({ filter: /test\/create-chat-server\.test\.mjs$/ }, async ({ path }) => ({
      contents: (await readFile(path, 'utf8')).replace('new URL("../package.json", import.meta.url)', JSON.stringify(resolve('package.json'))), loader: 'js',
    }));
  } }],
});
JS
node --test --test-concurrency=1 \
  --test-name-pattern='GET /_meta|every recognized HTTP route|public server subpath|fully configured construction|configured optional adapters|thread inactivity' \
  "$PWD/node_modules/.cache/thread-list-server-regression.mjs"
git diff --check -- src/server/create-chat-server.ts src/server/contracts.ts test/create-chat-server.test.mjs
```

Only focused repository checks ran. UI, client discovery, lifecycle integration,
preference work, global builds, and other PostgreSQL versions were outside this
item. No deployment, provider call, external send, QA campaign, commit, push, or
PR was performed. The patch is left uncommitted.
