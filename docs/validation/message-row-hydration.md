# Shared message row hydration

Owner Task `5f53ea4b-aaa1-42c3-9ff9-2e5cfada5731`, validated 2026-09-06.

`src/server/message-timeline-query.ts` directly exports `StoredMessageRow` and:

```ts
rowToMessage(
  row: StoredMessageRow,
  request: Pick<MessageTimelineRequest, "conversationId">,
  actor: TrustedChatActorContext,
  storage: Pick<ChatStorageAdapter, "createDownloadUrl">,
): Promise<MessageTimelineMessage>
```

The internal `StoredMessageTimelineRow` extends `StoredMessageRow` with
`conversation_type`, `entity_type`, `entity_id`, `replay_event_id`,
`older_available`, and `newer_available`. The serializer body and timeline SQL,
authorization, and pagination are unchanged. Callers must authorize the row
before hydration and provide trusted actor/storage context. No barrel changed.

The type fixture constructs a message-only row including aggregates and calls
the helper using just conversation identity. Existing PostgreSQL coverage
verifies attachment download hydration, reactions, edit metadata, deleted shells
without downloads, thread summaries, persisted reply references with both ping
choices, and references retained after source deletion.

## Exact validation commands and outcomes

Commands ran from the SDK root, sequentially. Canonical-source aliases bypass
package exports pointing to shared `dist`; no shared `dist` was rebuilt.

```bash
GOMAXPROCS=2 node_modules/.bin/esbuild test/message-timeline-http.test.mjs test/postgres-message-timeline-query.test.mjs --bundle --platform=node --format=esm --packages=external --outdir=node_modules/.cache --entry-names=hydration-[name] --out-extension:.js=.mjs --alias:@handrail/chat/server=./src/server/index.ts --alias:@handrail/chat/testing=./src/testing/index.ts --alias:@handrail/chat=./src/index.ts
node --test --test-concurrency=1 "$PWD/node_modules/.cache/hydration-message-timeline-http.test.mjs"
```

Passed: 2 tests, 0 failures, 0 skips. The HTTP fixture needed focused corrections
for the existing `admitted_conversation` SQL prefix, conversation type, nullable
reply columns, and the additional parent authorization query for threads. Its
default-limit assertion now selects the timeline query rather than the last
query. The initial canonical-source run failed both tests due to stale fixtures.

```bash
set -euo pipefail
hydration_pg_dir=$(mktemp -d /tmp/handrail-codex-heavy-command-locks/hydration-pg.XXXXXX)
trap '/usr/lib/postgresql/15/bin/pg_ctl -D "$hydration_pg_dir/data" -m immediate -w stop >/dev/null 2>&1 || true; rm -rf "$hydration_pg_dir"' EXIT
/usr/lib/postgresql/15/bin/initdb -D "$hydration_pg_dir/data" -U handrail_test --auth-local=trust --auth-host=reject --encoding=UTF8 --no-locale >"$hydration_pg_dir/init.log" 2>&1
/usr/lib/postgresql/15/bin/pg_ctl -D "$hydration_pg_dir/data" -l "$hydration_pg_dir/server.log" -o "-c timezone=UTC -c listen_addresses='' -c unix_socket_directories='$hydration_pg_dir' -c unix_socket_permissions=0700 -c max_connections=20 -c shared_buffers=32MB" -w start
TEST_DATABASE_URL="postgresql://handrail_test@/postgres?host=$hydration_pg_dir" node --test --test-concurrency=1 "$PWD/node_modules/.cache/hydration-postgres-message-timeline-query.test.mjs"
```

Passed: 3 tests, 0 failures, 0 skips. Used the existing test backend, isolated
schemas and canonical migrations on a disposable PostgreSQL 15 cluster. The
cluster was stopped and removed; no shared database was used.

```bash
GOMAXPROCS=2 node_modules/.bin/tsc --project "$PWD/tsconfig.message-row-hydration-type-tests.json"
git diff --check -- src/server/message-timeline-query.ts test/message-timeline-http.test.mjs
```

Both passed (exit 0). The scoped typecheck includes the production helper and
its transitive dependencies, with strict repository compiler options.

Initial harness launch issues: relative Node test paths returned `Could not
find 'node_modules/.cache/message-row-hydration/message-timeline-http.test.mjs'`;
absolute paths resolved that launch issue. A bundle nested in that directory
then failed `Cannot find module '../../package.json'`; placing bundles directly
in `node_modules/.cache` preserved the server's package-relative lookup. These
were harness failures, not passing test evidence. No unusual memory consumption
or OOM was observed.

Sibling dirty work was preserved. No global checks, commits, pushes, PRs,
deployments or runtime/CI changes were performed. The verified patch remains
uncommitted. Dependent item `f7e93e4b-3473-4f83-9a4a-7b8b6129e4f0` can import the
helper and row type directly; context lookup/routing remains that separate task.
