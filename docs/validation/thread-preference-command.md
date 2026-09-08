# Parent-authorized thread preferences

Verified 2026-09-06 for Owner Task item
`cdd6dfff-6b4c-4f8b-a1e5-702f9f5070da`.

Thread preference writes previously required active child membership. They now
check current parent visibility/membership and host entity access before returning
any private reconciliation result, including completed idempotency replay. The
trusted entity action is `conversation.preference.update`; an absent, denying or
throwing entity adapter fails closed for entity-bound parents. Parent and child
must be unarchived. Nonthread membership behavior remains unchanged.

The command locks parent before child and parent membership, then uses the shared
access helper. Applied writes use retained participant setup, with fresh access
checking. Reconciliation runs against the original preference first: missing rows
still start at revision zero, the first applied save is revision one, and helper
seeding cannot turn a first save into a conflict or no-op. Stale/no-op/replayed
requests do not run setup. Existing full desired-state preference input, audit,
private outbox and idempotency contracts remain in use. No follows, drafts,
existing cursors, message activity or lifecycle state are changed by this command.

Files owned by this item:

- `src/server/update-conversation-preference-command.ts`: authorization and retained setup integration.
- `src/server/create-chat-server.ts`: only four lines passing the trusted permissions adapter in `handleConversationPreference`. Existing sibling edits elsewhere in this shared file were retained.
- `test/postgres-thread-preference-command.test.mjs`: focused companion using `createPostgresTestBackend` / `createHarness` with canonical migrations.
- `tsconfig.conversation-preference-command.json`: compile both touched production files and their dependencies.
- This evidence document.

Verification ran sequentially with one test worker, against fresh bundled source
rather than shared `dist`:

```bash
node_modules/.bin/tsc --project tsconfig.conversation-preference-command.json --pretty false
node_modules/.bin/esbuild test/postgres-thread-preference-command.test.mjs test/postgres-update-conversation-preference-command.test.mjs --bundle --platform=node --format=esm --packages=external --alias:@handrail/chat/server=./src/server/index.ts --alias:@handrail/chat/testing=./src/testing/index.ts --alias:@handrail/chat=./src/index.ts --out-extension:.js=.mjs --outdir=node_modules/thread-preference-tests
bash node_modules/.cache/websocket-parent-postgres.sh "$PWD/node_modules/thread-preference-tests/postgres-thread-preference-command.test.mjs" "$PWD/node_modules/thread-preference-tests/postgres-update-conversation-preference-command.test.mjs"
git diff --check -- src/server/update-conversation-preference-command.ts src/server/create-chat-server.ts
```

The native test bootstrap is reproduced in
[the websocket validation record](websocket-parent-access.md). It starts a
disposable PostgreSQL 15.19 instance with TCP disabled, a private Unix socket,
20 connections and 32 MB shared buffers; supplies its URL to the existing harness;
and stops/removes the instance afterwards. The default `TEST_DATABASE_URL` was
unset and the ambient default connection refused connections. No shared database
or runtime configuration was modified.

Results: scoped TypeScript compilation and whitespace checks passed; PostgreSQL
**25 tests passed, zero failures/skips** (15 new thread subtests, eight existing
nonthread subtests, two parent tests). Coverage includes mentions/none/all before
follow; public-parent access without membership; missing-row revision-zero
conflicts; retained mute/star/revision/role/cursor/manual unread/draft/follow state;
exact retries and stale revisions; current membership/entity/missing-adapter/
throwing-adapter/archive denial on new writes and completed retries; denial at
initial authorization and setup recheck; and full rollback after outbox failure.
Private outbox payload and audit revision assertions passed. Initial fixture
failures from an omitted timezone and required archive actor were corrected.
No unrelated failures occurred in these focused checks. Global checks and other
PostgreSQL versions were not run. No remaining local SQL acceptance gap.

Changes remain uncommitted. No preview, deployment, provider, external-send,
commit, push or PR actions were performed.
