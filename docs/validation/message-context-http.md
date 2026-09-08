# Message context HTTP route

Validated 2026-09-06 for Owner Task item `77eb0291-1b6d-4174-9717-6da797a2235c`.

The existing source query is now exposed at
`GET /conversations/:conversationId/messages/:messageId/context`. This resolves an
original message for reply context without opening a thread or changing message
destinations, membership, follows, preferences, or read state. Client/UI behavior,
style settings, and handshake capability advertisement remain separate tasks.

Changed files:

- `src/server/create-chat-server.ts`: canonical route registration, decoded path
  validation, query/body/trusted-header rejection, trusted actor and configured
  database/schema/permissions/storage wiring, canonical result validation, and
  private/no-store responses. Admission precedes authentication. Invalid requests
  return 400; authentication stays 401; database/permission infrastructure and
  malformed-result failures return sanitized 503. Available, deleted, and
  unavailable results return 200. Query authorization preserves indistinguishable
  absent/inaccessible results.
- `src/server/contracts.ts`: one admission route-template union member.
- `test/postgres-message-context-http.test.mjs`: focused real PostgreSQL HTTP tests.
- `test/create-chat-server.test.mjs`: new route in existing admission coverage.
- `tsconfig.message-context-http.json`: scoped server compilation.
- This validation record. No generated contract changes were needed.

Results:

- Scoped TypeScript compilation passed (server entry and imported dependencies).
- New PostgreSQL HTTP suite: **9/9 passed**, zero skipped.
- Existing PostgreSQL message-context query suite: **8/8 passed**, zero skipped.
- Existing route-template/admission-denial regressions: **2/2 passed**.
- Scoped `git diff --check`: passed.

The existing `createPostgresTestBackend` used a disposable native PostgreSQL 15
cluster, isolated schemas, and canonical migrations. Outbox publishing and
PostgreSQL maintenance were stopped before request measurements. All measured
HTTP SQL ran in `BEGIN READ ONLY`, consisted only of SELECTs, opened no command
connections, and left snapshots of every table unchanged. This includes thread
creation, read cursors, membership, follows, preferences, messages, and outbox.
Malformed input and admission/authentication denial execute no lookup SQL.
Tests also exercise deleted content redaction, retained child participation after
parent access revocation, entity denial and exceptions, tenant isolation, both
encoded identifiers, and malformed persisted canonical content.

The first HTTP run failed in fixture setup because its deletion timestamp preceded
the default creation timestamp. Explicit ordered fixture timestamps corrected it;
the HTTP rerun passed. The query suite passed in the initial run and was not
repeated. No pre-existing unrelated failure was encountered. The resource guard
briefly queued the rerun behind sibling heavy commands; no unusual consumption
was observed (the initial failed run reported 136 MiB peak, no swap/OOM kill).

Exact checks from the SDK root (expensive commands executed sequentially):

```bash
node_modules/.bin/tsc --project tsconfig.thread-list-http.json
node_modules/.bin/tsc --project tsconfig.message-context-http.json
GOMAXPROCS=2 node_modules/.bin/esbuild test/postgres-message-context-http.test.mjs test/postgres-message-context-query.test.mjs --bundle --platform=node --format=esm --packages=external --outdir=node_modules/.cache --out-extension:.js=.mjs
```

Disposable database setup and initial execution; the corrected HTTP rerun used
the same setup with only the HTTP bundle:

```bash
set -euo pipefail
context_pg_dir=$(mktemp -d /tmp/handrail-codex-heavy-command-locks/message-context-pg.XXXXXX)
trap '/usr/lib/postgresql/15/bin/pg_ctl -D "$context_pg_dir/data" -m immediate -w stop >/dev/null 2>&1 || true; rm -rf "$context_pg_dir"' EXIT
/usr/lib/postgresql/15/bin/initdb -D "$context_pg_dir/data" -U handrail_test --auth-local=trust --auth-host=reject --encoding=UTF8 --no-locale >"$context_pg_dir/init.log" 2>&1
/usr/lib/postgresql/15/bin/pg_ctl -D "$context_pg_dir/data" -l "$context_pg_dir/server.log" -o "-c timezone=UTC -c listen_addresses='' -c unix_socket_directories='$context_pg_dir' -c unix_socket_permissions=0700 -c max_connections=20 -c shared_buffers=32MB" -w start
TEST_DATABASE_URL="postgresql://handrail_test@/postgres?host=$context_pg_dir" node --test --test-concurrency=1 "$PWD/node_modules/.cache/postgres-message-context-http.test.mjs" "$PWD/node_modules/.cache/postgres-message-context-query.test.mjs"
```

Existing server regression tests were bundled from current source with package
aliases and the manifest path adjustment required by the relocated bundle:

```bash
GOMAXPROCS=2 node --input-type=module <<'JS'
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
await build({ entryPoints: ['test/create-chat-server.test.mjs'], bundle: true, platform: 'node', format: 'esm', packages: 'external',
  outfile: 'node_modules/.cache/message-context-server-regression.mjs',
  alias: { '@handrail/chat/server': './src/server/index.ts', '@handrail/chat': './src/index.ts' },
  plugins: [{ name: 'test-package-path', setup(b) {
    b.onLoad({ filter: /test\/create-chat-server\.test\.mjs$/ }, async ({ path }) => ({
      contents: (await readFile(path, 'utf8')).replace('new URL("../package.json", import.meta.url)', JSON.stringify(resolve('package.json'))), loader: 'js',
    }));
  } }],
});
JS
node --test --test-concurrency=1 --test-name-pattern='every recognized HTTP route|denial and adapter failures' "$PWD/node_modules/.cache/message-context-server-regression.mjs"
git diff --check -- src/server/create-chat-server.ts src/server/contracts.ts test/create-chat-server.test.mjs
```

Shared server/admission files were clean at entry and had no concurrent sibling
edits during this change. Existing client lifecycle and other workspace changes
were preserved; no Flutter files were edited. Validation was repository-local:
no global suite, UI QA, deployment, provider action, external send, commit, push,
or PR. No blocker remains for this routing item.
