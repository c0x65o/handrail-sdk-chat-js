# Reply draft persistence verification

Selected Owner Task item: `ba48d41b-1d5a-4d90-b290-73cf5750cac9`.
Verified locally on 2026-09-06. No application database, provider, preview,
release, or QA campaign was used.

## Change

Migration `0042-chat-draft-replies` replaces the draft content validator while
preserving the original format, text, mentions, attachments and blocks checks.
Optional `replyTo` requires exactly a canonical `messageId` and boolean
`notifyAuthor`. IDs are trimmed, NFC, safe Unicode, and 1–255 UTF-8 bytes.
PostgreSQL itself rejects JSON NUL and unpaired surrogates. Legacy drafts without
reply metadata remain valid. Drafts do not require a live source message.

Thread draft synchronization now checks current parent access and uses the
existing retained participant helper inside the command transaction, with
parent-before-child locking. Saving does not follow a thread. Replays refresh
parent and host authorization without rewriting retained state. Thread draft
reads require parent access even when child membership remains active. Host
entity authorization receives the existing synchronize/snapshot action and
trusted actor; required unavailable authorization fails closed. Non-thread
membership behavior remains compatible. An archived thread remains readable
under an accessible, unarchived parent, but retained setup cannot write it.

Files owned by this change:

- `src/server/postgres-schema-migrations.ts` — appended 0042 only; preserves sibling 0041.
- `src/server/synchronize-draft-command.ts` — thread authority and retained setup.
- `src/server/conversation-draft-snapshot-query.ts` — current parent read access.
- `src/server/create-chat-server.ts` — only the synchronizeDraft permissions argument.
- `test/postgres-reply-draft-persistence.test.mjs` — focused real Postgres companion.
- `test/postgres-draft-schema.test.mjs` — registry expectation follows current migrations.
- `test/postgres-synchronize-draft-command.test.mjs` — count deltas account for earlier subtests' actor-wide keys.
- `test/draft-synchronization-http.test.mjs` — existing transport fixture supplies non-thread discovery metadata.
- `tsconfig.draft-persistence.json` — scoped production compilation.
- This evidence document.

The task ledger records overlap with snapshot authorization item
`244ead40-da97-4fd0-8854-6b22cb590e3e`; its remaining snapshot work should reuse
this draft query change. Sibling migration and server edits were retained.

## Commands and results

From the SDK repository root, fresh source was compiled/bundled without a shared
dist build. Checks ran sequentially; Node test concurrency was one.

```bash
node_modules/.bin/tsc --project tsconfig.draft-persistence.json

node_modules/.bin/esbuild test/postgres-draft-schema.test.mjs test/postgres-synchronize-draft-command.test.mjs test/postgres-conversation-draft-snapshot-query.test.mjs test/postgres-reply-draft-persistence.test.mjs test/draft-synchronization-http.test.mjs test/conversation-draft-snapshot-http.test.mjs --bundle --platform=node --format=esm --packages=external --alias:@handrail/chat/server=./src/server/index.ts --alias:@handrail/chat/testing=./src/testing/index.ts --alias:@handrail/chat=./src/index.ts --out-extension:.js=.mjs --outdir=node_modules/reply-draft-tests

bash node_modules/.cache/reply-draft-tests/run-postgres.sh

node --test --test-concurrency=1 "$PWD/node_modules/reply-draft-tests/draft-synchronization-http.test.mjs" "$PWD/node_modules/reply-draft-tests/conversation-draft-snapshot-http.test.mjs"
```

The TypeScript check and bundling passed. The Postgres run passed **29/29 tests**
(four parent tests and 25 subtests), with no skips. It used
`createPostgresTestBackend`, URL-backed by a disposable native PostgreSQL 15
cluster, UTF-8, private Unix socket, TCP disabled, `max_connections=20`, and
`shared_buffers=32MB`. The harness owned unique schemas; the cluster was stopped
and removed on exit. SQL was never simulated.

The local runner uses the native recipe in `docs/integration-testing.md`:
`pg_config --bindir`, `initdb -U handrail_test --auth-local=trust
--auth-host=reject --encoding=UTF8 --no-locale`, then `pg_ctl` with the private
socket directory and the settings above. It sets `TEST_DATABASE_URL` only for:

```bash
node --test --test-concurrency=1 "$PWD/node_modules/reply-draft-tests/postgres-draft-schema.test.mjs" "$PWD/node_modules/reply-draft-tests/postgres-synchronize-draft-command.test.mjs" "$PWD/node_modules/reply-draft-tests/postgres-conversation-draft-snapshot-query.test.mjs" "$PWD/node_modules/reply-draft-tests/postgres-reply-draft-persistence.test.mjs"
```

Passing SQL coverage includes legacy upgrade with blocks, both ping values,
invalid shape/keys/types/IDs/Unicode/byte bounds, sync/readback/private outbox,
changed target/ping idempotency conflicts, stale revisions and clear tombstones,
unavailable/deleted/mismatched sources, unenrolled/unfollowed threads, private
channel/direct/group-direct parent revocation, host denial/missing/throwing
adapters, replay denial after revocation, archive policy, isolation, retained
roles/join time/cursors/preferences/follows, and rollback of new or established
state after an injected outbox boundary failure.

## Remaining evidence limits

The optional HTTP regression run reported **9 passed / 3 failed**, counting the
failed parent test: two malformed-route assertions expected 400 but received
404. All normal synchronization/read, replay, authorization and error-redaction
cases passed. An isolated baseline bundle restored the HEAD versions of the two
draft command/query files and removed only this task's server adapter argument
while preserving sibling changes. It reproduced exactly the same two assertion
failures (9 passed / 3 failed including the parent):

```bash
node node_modules/.cache/reply-draft-tests/build-baseline.mjs
node --test --test-concurrency=1 "$PWD/node_modules/reply-draft-baseline/draft-synchronization-http.test.mjs" "$PWD/node_modules/reply-draft-baseline/conversation-draft-snapshot-http.test.mjs"
```

These pre-existing routing assertions are separate from this persistence change;
no routing fix was made. Local TAP logs and runner scripts remain under ignored
`node_modules/.cache/reply-draft-tests/`. PostgreSQL 16/container mode and global
checks were not run. No Dart production files changed, so Dart analysis was not
applicable. No SQL acceptance gap remains for the local PostgreSQL 15 harness.
