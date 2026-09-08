# Reply-style preference HTTP validation

Owner item: `238c46d9-2e09-4206-b880-ede4ff4693d9`.
Verified 2026-09-07 against SDK HEAD `39c194f15a5d0f51faa521ba9c94e3c321fbf282`.
Patch remains uncommitted in the registered main checkout.

Authenticated GET/PATCH `/preferences/reply-style` now expose the prerequisite
private query and transactional command. Routes share admission, trusted actor
resolution, request observability, private/no-store JSON, strict canonical input
parsing and sanitized errors. Applied/replayed/no-op results return 200; revision
conflicts preserve their canonical 409 reconciliation result; both typed
idempotency conflicts return stable sanitized 409 errors.

Hosts explicitly enable `features.reply_style_preference_v1`; its default is
false. Wire metadata additionally checks installed compatible migrations and
current persistence privileges/write availability. Disabled support returns 501,
unavailable support returns 503. The exact readiness guarantee and limitations
are documented in [the contract handoff](../reply-style-preference-contract.md#http-readiness-and-errors).
This saves a presentation choice only. Current Reply still opens a thread;
Discord-style Reply is intended to compose in the same conversation. No reply
action, client/UI behavior, broad Discord readiness or separate handshake
acceptance policy was implemented here.

## Changed files and preserved sibling work

- `src/server/create-chat-server.ts`: handlers, opt-in feature, readiness and errors.
- `src/server/contracts.ts`: exact admission route template.
- `contracts/http/reply-style-preference.json`: gated runtime advertisement metadata.
- `scripts/generate-reply-style-preference.mjs`: matching descriptor validation.
- `test/reply-style-preference-generation.test.mjs`: gated metadata expectations.
- `test/create-chat-server.test.mjs`: default feature and admission expectations.
- `test/postgres-reply-style-preference-http.test.mjs`: real PostgreSQL HTTP coverage.
- `tsconfig.reply-style-preference-http.json`: scoped production compile.
- `docs/reply-style-preference-contract.md` and this validation note.

The query/command implementations, prerequisite tests, scoped tsconfigs,
`docs/validation/reply-style-preference-command.md` and both existing
`src/server/index.ts` export insertions were preserved. No competing changes to
the edited server routing file appeared during this task. The later handshake
item must build on this checked preference feature without treating it as broad
reply readiness. No linked-preview or client/UI files were changed.

## Results

Checks ran sequentially; Node test concurrency one, PostgreSQL harness pool max
four. Private source bundles used `node_modules/.cache`; shared `dist` was not
overwritten.

- `./node_modules/.bin/tsc --project tsconfig.reply-style-preference-http.json`:
  passed against the changed production source and its imported dependencies.
- `node scripts/generate-reply-style-preference.mjs`: passed. Generated TS/Dart
  outputs are byte-for-byte unchanged; no Dart production change or analysis needed.
- `node scripts/generate-reply-style-preference.mjs --check`: passed.
- `npm run test:reply-style-preference`: **97 passed**, no skips.
- Source-bundled `test/postgres-reply-style-preference-http.test.mjs`:
  **13 passed**, no skips, including trusted authentication, admission metadata
  and denial before database access; absent/explicit Current/Discord saved reads;
  tenant/user and key isolation; strict malformed input/query/body/header
  rejection; unknown saved strings; original replay snapshots; no-op/stale
  revision/key reuse/in-progress reconciliation; request-id audit correlation;
  disabled/default/uninstalled/pre-0041/read-only/missing-table capability checks;
  real trigger failures with rollback and sanitized 503 responses.
- Source-bundled `test/create-chat-server.test.mjs`: **31 passed**, no skips.
- `git diff --check`: passed.

PostgreSQL **15.19** ran in a disposable native cluster using the existing
`createPostgresTestBackend` URL-backed, schema-isolated harness. TCP disabled,
private Unix socket, no application/shared database access. Teardown dropped
test schemas; the shell trap stopped the cluster and removed its directory.
PostgreSQL 16 and deployed environments were not exercised.

## Reproduction

From the SDK root, bundle and run the HTTP tests:

```bash
./node_modules/.bin/esbuild test/postgres-reply-style-preference-http.test.mjs --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/reply-style-http-tests.mjs
set -euo pipefail
reply_pg_dir=$(mktemp -d "$PWD/.reply-http-pg.XXXXXX")
trap '/usr/lib/postgresql/15/bin/pg_ctl -D "$reply_pg_dir/data" -m immediate -w stop >/dev/null 2>&1 || true; rm -rf -- "$reply_pg_dir"' EXIT
/usr/lib/postgresql/15/bin/initdb -D "$reply_pg_dir/data" -U handrail_test --auth-local=trust --auth-host=reject --encoding=UTF8 --no-locale > "$reply_pg_dir/init.log"
/usr/lib/postgresql/15/bin/pg_ctl -D "$reply_pg_dir/data" -l "$reply_pg_dir/server.log" -o "-c listen_addresses='' -c unix_socket_directories='$reply_pg_dir' -c unix_socket_permissions=0700 -c max_connections=20 -c shared_buffers=32MB" -w start
TEST_DATABASE_URL="postgresql://handrail_test@/postgres?host=$reply_pg_dir" node --test --test-reporter=spec --test-concurrency=1 "$PWD/node_modules/.cache/reply-style-http-tests.mjs"
```

For the existing server regression suites, private esbuild bundles alias
`@handrail/chat/server` to `src/server/index.ts` and `@handrail/chat` to
`src/index.ts`. The test's package-manifest URL is adjusted from `../package.json`
to `../../package.json` in memory to account for the private output location.
The ignored builder and bundles remain in `node_modules/.cache`:

```bash
node node_modules/.cache/reply-style-build-regressions.mjs
node --test --test-reporter=spec --test-concurrency=1 "$PWD/node_modules/.cache/reply-style-create-chat-server.mjs"
node --test --test-reporter=tap --test-concurrency=1 --test-timeout=5000 "$PWD/node_modules/.cache/reply-style-create-chat-server-http-outcomes.mjs"
```

## Remaining limit and initial failures

The adjacent HTTP-outcomes suite passed six tests but its existing message-audit
test, `HTTP request id correlates the response and existing message audit`,
returned **503 instead of 201**. Its failed assertion leaves runtime workers
open, so a bounded rerun also reached the five-second file timeout. A separate
private bundle substituting `git show HEAD:src/server/create-chat-server.ts`
reproduced exactly the same 503/201 assertion and timeout. This is a pre-existing
send-message test limitation, outside the selected preference route item. The
new preference HTTP suite proves its own audit correlation with real PostgreSQL.
The adjacent test was not modified or replaced with a new database fake.

An initial configuration-suite run caught one fixed-length default-feature
expectation that needed the new false entry; the corrected suite passed.
Initial private regression launches using relative bundle paths reported
`Could not find 'node_modules/.cache/...'`; absolute paths resolved the launcher
issue. Failed launches/diagnostic runs reported 11–99 MiB memory peaks, zero swap
and zero OOM kills. Failed runs with open handles were interrupted or bounded by
test timeout before continuing. No unusual resource consumption was observed.

No global checks, auth provisioning, configuration changes, deployments,
provider calls, external sends, QA campaigns, commits, pushes or PRs were made.
No blocker remains for this selected routing item.
