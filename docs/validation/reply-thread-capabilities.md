# Reply/thread capability gate verification

Verified SDK `main`, starting HEAD `39c194f15a5d0f51faa521ba9c94e3c321fbf282`.
The existing saved-style prerequisite patch and newly appearing sibling
TypeScript/Flutter client changes were preserved. No preview repository edits,
commits, pushes, PRs, deployment, provider calls, external sends or QA campaigns.

## Changed files for this item

- `contracts/realtime/handshake.json`, `scripts/generate-handshake.mjs`
- `src/contracts/generated/realtime-handshake.ts`, `src/contracts/realtime.ts`
- `flutter/handrail_chat/lib/src/generated/realtime_handshake.dart`
- `flutter/handrail_chat/test/generated_realtime_handshake_test.dart`
- `src/server/create-chat-server.ts` (integrates existing saved-style work)
- `src/server/reply-thread-readiness.ts`
- `test/create-chat-server.test.mjs` (preserves existing saved-style assertions)
- `test/handshake-generation.test.mjs`
- `test/postgres-reply-thread-capabilities-http.test.mjs`
- `test/postgres-thread-lifecycle-http.test.mjs`
- `test/postgres-thread-list-http.test.mjs`
- `tsconfig.reply-thread-capabilities.json`
- `docs/reply-thread-capabilities.md`, this validation record

## Focused results

- `./node_modules/.bin/tsc --project tsconfig.reply-thread-capabilities.json`: pass,
  production server and transitive source, no shared dist output.
- `node scripts/generate-handshake.mjs --check`: pass, both checked-in generated
  outputs match canonical source.
- `node --test --test-reporter=spec --test-concurrency=1 "$PWD/test/handshake-generation.test.mjs"`:
  3 passed, including canonical feature names and stale-output detection.
- Fresh source bundle of `test/create-chat-server.test.mjs`: 31 passed.
- Fresh source bundle of the new PostgreSQL capability HTTP fixture: 10 passed
  (nine behavior cases plus parent test). Covers absent/false and independent
  flags, host-policy separation, ordinary sends and legacy opening, same-channel
  reply with no root thread, authorization denial, retained named reads and
  canonical IDs after disabling flags, incompatible migration history despite
  schema version 43, missing columns, insufficient role privileges and read-only
  storage. Independent lifecycle survives missing reply columns; saved style
  remains separate.
- Existing PostgreSQL HTTP fixtures: lifecycle 8 passed, discovery 8 passed,
  saved style 13 passed, source context 9 passed.
- Existing PostgreSQL prerequisite fixtures passed: thread snapshot access (14),
  WebSocket thread authorization (5), notification dispatcher, conversation reply
  unread projections, edit-message command, soft-delete command (16), attachment
  preparation (13), attachment download (14), send-message command (14).
  These exercise canonical SQL and real isolated storage. Notification/storage
  adapters in those fixtures are local test boundaries; no external provider
  calls or messages are sent.
- From `flutter/handrail_chat`:
  `/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart analyze lib/src/generated/realtime_handshake.dart test/generated_realtime_handshake_test.dart`:
  no issues; same Dart executable with
  `test --concurrency=1 test/generated_realtime_handshake_test.dart`: 4 passed.
- `git diff --check`: pass.

## Reproduce fresh source artifacts and PostgreSQL checks

No test relies on a previously compiled shared `dist`. This is the exact private
bundle builder used (`node node_modules/.cache/build-reply-thread-gates.mjs`):

```js
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const names = ['create-chat-server', 'postgres-reply-thread-capabilities-http', 'postgres-thread-list-http', 'postgres-thread-lifecycle-http', 'postgres-reply-style-preference-http', 'postgres-thread-snapshot-access', 'postgres-websocket-thread-authorization', 'postgres-notification-dispatcher', 'postgres-conversation-reply-unread', 'postgres-edit-message-command', 'postgres-soft-delete-message-command', 'postgres-prepare-attachment-command', 'postgres-attachment-download-query', 'postgres-send-message-command', 'postgres-message-context-http'];
for (const name of names) {
  await build({entryPoints: [`test/${name}.test.mjs`], outfile: `node_modules/.cache/gates-${name}.mjs`, bundle: true,
    platform: 'node', format: 'esm', packages: 'external', alias: {
      '@handrail/chat/testing': './src/testing/index.ts', '@handrail/chat/server': './src/server/index.ts', '@handrail/chat': './src/index.ts',
    }, plugins: [{name: 'manifest-location', setup(b) { b.onLoad({filter: /create-chat-server\.test\.mjs$/}, async args => ({
      contents: (await readFile(args.path, 'utf8')).replace('new URL("../package.json", import.meta.url)', 'new URL("../../package.json", import.meta.url)'), loader: 'js',
    })); }}],
  });
}
```

Run the server configuration fixture separately:

```bash
node --test --test-reporter=spec --test-concurrency=1 --test-timeout=15000 "$PWD/node_modules/.cache/gates-create-chat-server.mjs"
```

The existing `createPostgresTestBackend` / isolated-schema harness used an owned,
disposable native PostgreSQL 15 instance via `TEST_DATABASE_URL`. TCP was disabled,
Unix socket permissions were 0700, shared buffers 32 MB, maximum connections 20,
and tests used one worker. Schema creation/migrations and test-role grants were
confined to this disposable database. Its process/data directory were removed
on exit. No production/shared database was used and no database fake was added.
The exact runner (`node_modules/.cache/run-gates-postgres.sh`) is:

```bash
#!/bin/bash
set -euo pipefail
cap_pg_dir=$(mktemp -d "$PWD/.cap-pg.XXXXXX")
trap '/usr/lib/postgresql/15/bin/pg_ctl -D "$cap_pg_dir/data" -m immediate -w stop >/dev/null 2>&1 || true; rm -rf -- "$cap_pg_dir"' EXIT
/usr/lib/postgresql/15/bin/initdb -D "$cap_pg_dir/data" -U handrail_test --auth-local=trust --auth-host=reject --encoding=UTF8 --no-locale > "$cap_pg_dir/init.log"
/usr/lib/postgresql/15/bin/pg_ctl -D "$cap_pg_dir/data" -l "$cap_pg_dir/server.log" -o "-c timezone=UTC -c listen_addresses='' -c unix_socket_directories='$cap_pg_dir' -c unix_socket_permissions=0700 -c max_connections=20 -c shared_buffers=32MB" -w start
export TEST_DATABASE_URL="postgresql://handrail_test@/postgres?host=$cap_pg_dir"
for suite in "$@"; do
  node --test --test-reporter=spec --test-concurrency=1 --test-timeout=30000 "$PWD/node_modules/.cache/gates-$suite.mjs"
done
```

Commands run with this runner (suites execute sequentially):

```bash
bash node_modules/.cache/run-gates-postgres.sh postgres-reply-thread-capabilities-http postgres-thread-lifecycle-http postgres-thread-list-http postgres-reply-style-preference-http
bash node_modules/.cache/run-gates-postgres.sh postgres-reply-thread-capabilities-http postgres-thread-snapshot-access postgres-websocket-thread-authorization postgres-notification-dispatcher postgres-conversation-reply-unread postgres-edit-message-command postgres-soft-delete-message-command postgres-prepare-attachment-command postgres-attachment-download-query postgres-send-message-command postgres-message-context-http
bash node_modules/.cache/run-gates-postgres.sh postgres-message-context-http
bash node_modules/.cache/run-gates-postgres.sh postgres-reply-thread-capabilities-http
```

The first two groups initially ran without an explicit database timezone. All
prerequisite fixtures except source-context passed; its literal date fixture
expected midnight UTC but the inherited timezone produced 06:00 UTC. Setting
`-c timezone=UTC` (shown above) and rerunning that fixture passed all 9 tests.

Initial new-test failures were fixture issues (required idempotency headers,
lifecycle body/path shape, parent participant setup, fixed feature count and
cleanup assumptions); they were corrected against existing contracts. The
worker's test launcher rejected relative bundle paths; absolute paths work.
`dart` by short command name was unavailable inside its guard; the absolute SDK
executable passed. A failing fixed-count configuration assertion left workers
open; that run was interrupted and subsequent runs used a bounded file timeout.
Failed runs reported 2–130 MiB memory peaks, zero swap/OOM kills; no unusual
resource consumption or unavailable database evidence remains.

Readiness is an uncached preflight, not a guarantee against later outages or
permission changes. See [the prerequisite matrix](../reply-thread-capabilities.md).
No global build or unrelated validation campaign was run.
