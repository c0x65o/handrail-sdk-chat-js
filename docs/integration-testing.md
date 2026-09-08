# Full-stack integration testing

Use `createChatTestHarness` from `@handrail/chat/testing` when a test must prove
the real Handrail Chat persistence, HTTP, client, or realtime path. The harness
runs the shipped PostgreSQL migrations and the real server and client runtimes.
Its fakes are deliberately limited to host-owned edges such as authentication,
directory lookup, permissions, storage, notifications, audit, realtime fanout,
and media. Do not replace PostgreSQL queries or Handrail repositories with a
fake SQL interpreter or a broad repository mock.

For a focused database-only fixture, see the
[PostgreSQL harness test](../test/postgres-harness.test.mjs). The full-stack
[chat harness test](../test/postgres-chat-harness.test.mjs) exercises actors,
HTTP, WebSockets, failure injection, and teardown. The
[reconnect/idempotency scenario](../test/postgres-reconnect-idempotency.test.mjs)
covers the longer acknowledgement-loss, replay, retry, and cross-device flow.
The public surface is also locked by the
[createChatTestHarness type test](../type-tests/create-chat-test-harness.test.ts).

## Database and lifecycle contract

Choose the backend deliberately:

- Pass `testDatabaseUrl` or set `TEST_DATABASE_URL` to a dedicated test-only
  PostgreSQL service. The harness never reads the ordinary `DATABASE_URL`
  variable and never silently falls back to it.
- If neither test URL is supplied, the harness starts a disposable
  `postgres:16-alpine` container. Docker must be available for this mode.
- Every harness creates a uniquely named schema, configures its pool with that
  schema's `search_path`, and applies all shipped migrations inside it. Parallel
  harnesses therefore do not share chat tables.
- `teardown()` is idempotent. It closes tracked clients and sockets, stops the
  loopback server and runtime, closes the schema-scoped pool, and removes only
  the uniquely generated harness-owned schema. It stops a PostgreSQL container
  only when that backend started and owns the container.

Always call `teardown()` in `finally`, `afterEach`, or the equivalent hook for
your test runner. If several harnesses share an explicitly created
`createPostgresTestBackend`, tear down every harness before tearing down that
backend.

## Restore acceptance evidence

Use the [restore acceptance runner and execution definition](restore-acceptance.md)
for isolated PostgreSQL restore/replay proof, the original binding-error negative
control, and exact dev project-check/task activation requirements.

## Huddle renewal acceptance evidence

From the package root with dependencies installed, run:

```bash
node scripts/accept-huddle-renewal.mjs --native /absolute/path/to/new-evidence-directory
```

`--native` uses the disposable native PostgreSQL recipe below (`PG_BINDIR` or
`pg_config --bindir`), with a private socket and TCP disabled. Run as a non-root
user, with `TEST_DATABASE_URL` unset. Omit `--native` to use an explicit dedicated
`TEST_DATABASE_URL`, or the existing harness's disposable Docker fallback.
Application `DATABASE_URL` and inherited `PG*` connection settings are ignored.
The output directory must not exist; its parent and `TMPDIR` must be writable.

The runner snapshots current source, tests and build inputs (including uncommitted
bytes), runs actual `npm run build` in two isolated copies, and executes only
`test/postgres-join-huddle-command.test.mjs` against real PostgreSQL using
`createPostgresTestBackend` and unique schemas. Existing test doubles are retained
at host boundaries; no persistence mocks are added. The negative copy removes
only the renewal branch and retains the current tests. Acceptance requires all
12 positive cases to pass, and exactly the two renewal cases to fail with the
already-joined rejection in the negative run while the other 10 pass. Node's
summary includes the enclosing test (13 total; 3 negative failures including the
parent). Missing prerequisites, build failures, skips, cancellation, unexpected
failures, scope drift, or cleanup/preservation failures exit nonzero.

Full redacted build/TAP/PostgreSQL logs, the removed branch, source and compiled
SHA-256 identities, exit statuses, counts, and preservation results are retained
in the evidence directory. Temporary sources/builds and the owned native cluster
are removed; shared source/tests/dist are never built into or overwritten.
`evidence-metadata.json` contains the `environment`/`evidence` payload for
Handrail's supported `handrail_record_qa_runtime_evidence` artifact retention
contract, using `text/plain` and `application/json`. A queued worker should retain
these files through that contract and return the resulting stable artifact IDs
with the completed work result; a local path or prose pass claim alone is not
reviewer evidence. The runner itself does not call Handrail or change queue state.

## Thread-summary acceptance evidence

Run `node scripts/accept-thread-summary.mjs --native /absolute/path/to/new-evidence-directory`
from the package root with dependencies installed. Native prerequisites and the
alternative dedicated `TEST_DATABASE_URL`/disposable container modes match the
huddle runner above. Application `DATABASE_URL` and inherited `PG*` settings are
ignored. The evidence parent and `TMPDIR` must be writable.

The runner snapshots current source and tests, including uncommitted prerequisites,
and compiles fresh isolated copies with `tsc --project tsconfig.json --incremental false --noEmitOnError`.
It executes only `test/postgres-thread-summary-query.test.mjs`: corrected suite,
old-SQL negative suite, then corrected suite again. Each corrected run requires
seven passing tests, zero failures/skips, and one separately counted enclosing
suite. The negative copy changes only cursor-dependent viewer SQL, preserving
shared-facts extraction and current tests. Exactly four tests must fail: missing
cursors throw in the empty-thread and eligible-viewer cases; retained cursors
incorrectly return two unread instead of zero for inactive/nonfollowing viewers
and the final loss-of-eligibility step. Exact names and diagnostics are required;
unrelated failures cannot satisfy acceptance.

Redacted commands, working directories, timestamps, versions, full TAP output,
exit statuses, exact SQL changes, source/compiled SHA-256 catalogs, and cleanup
and shared-input preservation checks are retained. Skips, stale compilation,
unexpected failures, leaked schemas or incomplete cleanup exit nonzero. Submit
`evidence-metadata.json` through `handrail_record_qa_runtime_evidence` as above and
return the stable artifact IDs; `manifest.json` indexes the execution and catalogs.
Dart parser execution remains separate. Existing generation/drift and analysis
proof is retained under recovery work request `555af3c7-bd2f-4dc7-bb1c-d43dd0db7aa4`;
this runner does not repeat that recovery.

## Focused PostgreSQL checks without Docker

If `TEST_DATABASE_URL` is unset and Docker reports that it cannot connect to its
daemon, the test fails before creating a schema or running regression assertions.
On a worker with native PostgreSQL server binaries, use a disposable local
cluster through the existing URL-backed harness. Run the following in Bash from
the package root as a non-root user, after installing package dependencies. Set
`PG_BINDIR` to the installed server's binary directory (for example,
`/usr/lib/postgresql/15/bin` on Debian).

The cluster uses a private temporary directory and Unix socket, with TCP disabled.
Local trust authentication is restricted by the directory/socket permissions;
the cluster and its data are removed on exit. No managed database URL or project
environment configuration is needed. `TMPDIR`, when supplied, must be an absolute,
writable path short enough for a PostgreSQL Unix socket.

```bash
(
  set -euo pipefail
  PG_BINDIR=${PG_BINDIR:-$(pg_config --bindir)}
  for binary in initdb pg_ctl; do
    test -x "$PG_BINDIR/$binary" || {
      echo "Missing PostgreSQL server binary: $PG_BINDIR/$binary" >&2
      exit 1
    }
  done
  npm run build
  pg_tmp=$(mktemp -d "${TMPDIR:-/tmp}/handrail-pg.XXXXXX")
  cleanup() {
    if test -f "$pg_tmp/data/postmaster.pid"; then
      "$PG_BINDIR/pg_ctl" -D "$pg_tmp/data" -m immediate -w stop || return 1
    fi
    rm -rf -- "$pg_tmp"
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  "$PG_BINDIR/initdb" -D "$pg_tmp/data" -U handrail_test \
    --auth-local=trust --auth-host=reject --encoding=UTF8 --no-locale
  "$PG_BINDIR/pg_ctl" -D "$pg_tmp/data" -l "$pg_tmp/postgres.log" \
    -o "-c listen_addresses='' -c unix_socket_directories='$pg_tmp' -c unix_socket_permissions=0700" \
    -w start
  TEST_DATABASE_URL="postgresql://handrail_test@/postgres?host=$pg_tmp" \
    node --test --test-concurrency=1 test/postgres-update-read-cursor-command.test.mjs
)
```

This runs only the cursor command file, including the future-cursor timestamp
regression and replay assertions that require unchanged persisted state and no
additional side effects. The harness still creates its unique schema and applies
the shipped migrations on real PostgreSQL. CI's PostgreSQL 16 container service
remains configured in [the integration workflow](../.github/workflows/postgres-integration.yml).

Verification on 2026-09-04 for campaign
`5d39c7e0-79ef-4e68-a7d4-1a1cc1c29861`: the focused file passed all nine subtests
(ten tests including the parent) on native PostgreSQL 15.19. PostgreSQL DDL logs
confirmed creation and removal of the `chat_cursor_cmd_*` schema, and a final
`pg_namespace` query found zero remaining test schemas. The cluster was stopped
and removed. Source was compiled with `tsc --project tsconfig.json`; the normal
`npm run build` was blocked by a pre-existing stale
`src/client/generated/package-version.ts` check. PostgreSQL 16 was not run locally.

### Cumulative replay verification in a queued worker

For the focused cumulative replay check, use the disposable native cluster recipe
above with these replacements:

- Compile with `npx tsc --project tsconfig.json`.
- Create the temporary directory with `pg_tmp=$(mktemp -d "$PWD/.pg.XXXXXX")`
  when the worker only permits writes in the checkout. The absolute socket path,
  including PostgreSQL's socket filename, must fit the platform's Unix socket
  limit; use a shorter authorized writable directory if necessary.
- Run `node --test test/postgres-websocket-live-delivery.test.mjs` with the recipe's
  `TEST_DATABASE_URL` assignment.

Check `id -u` before starting: native PostgreSQL requires a non-root worker
identity. A root-only worker with no Docker daemon and no dedicated
`TEST_DATABASE_URL` cannot run this check. The required runtime change is a
non-root worker with PostgreSQL server binaries and a writable temporary
directory, or an explicitly test-only PostgreSQL service injected through
`TEST_DATABASE_URL`. Do not substitute the project's ordinary `DATABASE_URL`.

Verification on 2026-09-05 for campaign
`eab2eabf-d331-4b7f-947f-bff80a886175`, work request
`e5937737-1194-451f-b6ee-e147866ea7cf`: this worker ran as UID 993, so native
PostgreSQL 15.19 could start without identity switching. With `TEST_DATABASE_URL`
unset, the original failure reproduced: six parent tests passed and both
PostgreSQL parents failed before entering their subtests. Fresh
`npx tsc --project tsconfig.json` exited 0. With the disposable cluster's private
Unix socket URL, the exact focused command passed all 12 tests with zero skips,
including both cumulative replay subtests:

- Overflow proved slow-consumer closure, listener/session disposal, no acceptance
  or delivery after closure, and bounded completion of the held resolver work.
- Below capacity proved canonical ordering and no duplicate delivery across
  overlapping batches.

A final `pg_namespace` query found zero non-system schemas other than `public`.
The cluster was stopped and its temporary directory removed. This verifies real
PostgreSQL migrations, queries, and WebSocket delivery through the existing
URL-backed harness; it does not provision a persistent backend for future workers
or change project environment configuration. PostgreSQL 16 was not run locally.

## Actors and host-edge fixtures

An actor fixture contains an opaque credential and a trusted server-side actor
with `tenantId`, `userId`, and `roles`. Add only the capabilities needed by the
scenario. Supplying `user` registers a tenant-scoped directory record for the
same actor. You can add or remove actors and directory users during a test,
replace an actor's capabilities with `setCapabilities`, and control entity
authorization with `setEntityAuthorization`.

The returned fixture exposes:

- `endpoint` and `webSocketEndpoint` for direct HTTP and WebSocket probes;
- `createClient(actor)` for a tracked, actor-bound Handrail Chat client;
- `connectWebSocket(actor, handshake?)` for an authenticated and accepted raw
  socket session;
- `clock.now()`, `clock.iso()`, `clock.set()`, and `clock.advance()` for
  deterministic adapter output;
- `calls.all()`, `calls.count()`, and `calls.reset()` for inspecting fake edge
  calls; and
- `failures.failNext()` or `failures.queue()` for deterministic, per-boundary
  failures. Failures are consumed in invocation order; `pending()`, `snapshot()`,
  and `reset()` let tests inspect or clear the queue.

These are edge controls, not substitutes for persisted state. Assert database
constraints and transactions through the harness's schema-scoped `pool`, and
assert consumer behavior through the public HTTP, socket, and client fixtures.

## HTTP, socket, and client smoke flow

The smallest useful full-stack test starts an actor-bound client, creates
persisted data through HTTP commands, and opens an authenticated socket. The
markers around this and the following examples are consumed by the repository's
documentation test.

<!-- integration-testing-example:smoke:start -->
```ts
import assert from "node:assert/strict";

import type { TenantId, UserId } from "@handrail/chat";
import { createChatTestHarness } from "@handrail/chat/testing";

const tenantId = "smoke-tenant" as TenantId;
const userId = "smoke-user" as UserId;
const teammateId = "smoke-teammate" as UserId;
const harness = await createChatTestHarness({
  schemaPrefix: "guide_smoke",
  actors: [
    {
      credential: "smoke-token",
      actor: { tenantId, userId, roles: ["employee"] },
      capabilities: ["conversation.create", "conversation.read", "message.send"],
      user: { tenantId, userId, displayName: "Smoke User" },
    },
    {
      credential: "teammate-token",
      actor: { tenantId, userId: teammateId, roles: ["employee"] },
      capabilities: ["conversation.read", "message.send"],
      user: { tenantId, userId: teammateId, displayName: "Smoke Teammate" },
    },
  ],
});

try {
  const client = harness.createClient("smoke-token");
  const teammate = harness.createClient("teammate-token");
  assert.equal((await client.start()).state, "ready");
  assert.equal((await teammate.start()).state, "ready");
  assert.equal((await client.listConversations({
    scope: { type: "organization" },
    limit: 20,
  })).status, "success");
  assert.equal((await teammate.listConversations({
    scope: { type: "organization" },
    limit: 20,
  })).status, "success");

  const created = await client.createDirect({
    intendedMemberUserIds: [teammateId],
  });
  assert.equal(created.status, "success", JSON.stringify(created));
  if (created.status !== "success") throw new Error("direct creation failed");

  const sent = await client.sendMessage({
    conversationId: created.value.conversation.conversation.id,
    content: { format: "plain", text: "hello from the full stack" },
  });
  assert.equal(sent.status, "success", JSON.stringify(sent));

  const teammateTimeline = await teammate.getMessageTimeline({
    conversationId: created.value.conversation.conversation.id,
    direction: "backward",
    limit: 20,
  });
  assert.equal(teammateTimeline.status, "success", JSON.stringify(teammateTimeline));
  if (teammateTimeline.status !== "success") {
    throw new Error("teammate timeline failed");
  }
  assert.equal(teammateTimeline.value.messages.at(-1)?.content?.text, "hello from the full stack");

  const connection = await harness.connectWebSocket("teammate-token");
  assert.equal(connection.accepted.type, "chat.session.accepted");
  assert.match(harness.endpoint, /^http:\/\/127\.0\.0\.1:/u);
  assert.match(harness.webSocketEndpoint, /^ws:\/\/127\.0\.0\.1:/u);
} finally {
  await harness.teardown();
}
```
<!-- integration-testing-example:smoke:end -->

## Reconnect and one logical idempotent retry

Keep the same logical client message ID and idempotency key when retrying after
an ambiguous transport failure. `retryMessage` preserves both values from the
failed optimistic projection. The example below simulates a response lost after
the server committed, closes the realtime connection, retries, and reconnects.
The retry returns the already committed outcome instead of inserting a second
message.

<!-- integration-testing-example:reconnect:start -->
```ts
import assert from "node:assert/strict";

import type { TenantId, UserId } from "@handrail/chat";
import { createChatClient } from "@handrail/chat/client";
import { createChatTestHarness } from "@handrail/chat/testing";

const tenantId = "retry-tenant" as TenantId;
const userId = "retry-user" as UserId;
const credential = "retry-token";
const logicalClientMessageId = "logical-message-1";
const logicalIdempotencyKey = "logical-send-1";
const harness = await createChatTestHarness({
  schemaPrefix: "guide_retry",
  actors: [
    {
      credential,
      actor: { tenantId, userId, roles: ["employee"] },
      capabilities: ["conversation.create", "conversation.read", "message.send"],
      user: { tenantId, userId, displayName: "Retry User" },
    },
  ],
});

try {
  const setupClient = harness.createClient(credential);
  await setupClient.start();
  const created = await setupClient.createChannel({
    name: "Retry fixture",
    visibility: "private",
  });
  if (created.status !== "success") throw new Error("channel creation failed");
  const conversationId = created.value.conversation.conversation.id;

  let loseFirstCommittedResponse = true;
  const observedIdempotencyKeys: Array<string | null> = [];
  const client = createChatClient({
    endpoint: harness.endpoint,
    getAccessToken: () => credential,
    commands: { retry: { maxAttempts: 1 } },
    optimisticMessages: {
      generateClientMessageId: () => logicalClientMessageId,
      generateIdempotencyKey: () => logicalIdempotencyKey,
    },
    async fetch(url, init) {
      const isSend =
        init?.method === "POST" &&
        String(url).endsWith(`/conversations/${conversationId}/messages`);
      if (!isSend) return fetch(url, init);

      observedIdempotencyKeys.push(new Headers(init.headers).get("idempotency-key"));
      const response = await fetch(url, init);
      if (loseFirstCommittedResponse) {
        loseFirstCommittedResponse = false;
        assert.equal(response.status, 201);
        throw new Error("simulated acknowledgement loss after commit");
      }
      return response;
    },
  });

  await client.start();
  await client.getConversation({ conversationId });
  const firstAttempt = await client.sendMessage({
    conversationId,
    content: { format: "plain", text: "persist exactly once" },
  });
  assert.equal(firstAttempt.status, "transport");

  client.realtime?.close();
  const retried = await client.retryMessage(logicalClientMessageId);
  assert.equal(retried.status, "success");
  if (retried.status !== "success") throw new Error("retry failed");
  assert.equal(retried.value.reconciliationStatus, "replayed");
  assert.deepEqual(observedIdempotencyKeys, [
    logicalIdempotencyKey,
    logicalIdempotencyKey,
  ]);
  client.realtime?.restart();
  client.close();
} finally {
  await harness.teardown();
}
```
<!-- integration-testing-example:reconnect:end -->

The repository's longer
[reconnect/idempotency integration test](../test/postgres-reconnect-idempotency.test.mjs)
also proves cursor replay order, duplicate-event suppression, one durable
message/audit/outbox effect, and cross-device read convergence.

## Tenant isolation

Register each credential against its trusted tenant. The server ignores
client-authored identity and scopes every persistence query to the resolved
actor. This example creates a public channel in tenant A, then verifies that a
tenant B list snapshot cannot observe it.

<!-- integration-testing-example:tenant-isolation:start -->
```ts
import assert from "node:assert/strict";

import type { TenantId, UserId } from "@handrail/chat";
import { createChatTestHarness } from "@handrail/chat/testing";

const tenantA = "tenant-a" as TenantId;
const tenantB = "tenant-b" as TenantId;
const userA = "user-a" as UserId;
const userB = "user-b" as UserId;
const capabilities = ["conversation.create", "conversation.read"];
const harness = await createChatTestHarness({
  schemaPrefix: "guide_tenant",
  actors: [
    {
      credential: "tenant-a-token",
      actor: { tenantId: tenantA, userId: userA, roles: ["employee"] },
      capabilities,
      user: { tenantId: tenantA, userId: userA, displayName: "Tenant A User" },
    },
    {
      credential: "tenant-b-token",
      actor: { tenantId: tenantB, userId: userB, roles: ["employee"] },
      capabilities,
      user: { tenantId: tenantB, userId: userB, displayName: "Tenant B User" },
    },
  ],
});

try {
  const clientA = harness.createClient("tenant-a-token");
  const clientB = harness.createClient("tenant-b-token");
  await Promise.all([clientA.start(), clientB.start()]);

  const created = await clientA.createChannel({
    name: "Tenant A public channel",
    visibility: "public",
  });
  if (created.status !== "success") throw new Error("channel creation failed");

  const tenantBList = await clientB.listConversations({
    scope: { type: "organization" },
  });
  assert.equal(tenantBList.status, "success");
  if (tenantBList.status !== "success") throw new Error("list query failed");
  assert.equal(
    tenantBList.value.items.some(
      (conversation) =>
        conversation.id === created.value.conversation.conversation.id,
    ),
    false,
  );
} finally {
  await harness.teardown();
}
```
<!-- integration-testing-example:tenant-isolation:end -->

## Failure injection and assertions

Queue failures at the smallest host boundary involved in the behavior:

```ts
harness.failures.failNext(
  "directory.getUser",
  "directory unavailable for this invocation",
);
harness.failures.queue("storage.verifyObject", ["first failure", "second failure"]);

assert.equal(harness.failures.pending("storage.verifyObject"), 2);
assert.equal(harness.calls.count("directory.getUser"), 1);
harness.clock.advance(1_000);
```

The adapter call is logged before its queued failure is consumed, so a failed
edge invocation remains observable. `calls.reset()` and `failures.reset()` keep
multi-phase tests deterministic.

## Safety boundaries

Never point this harness at production, staging, an operator database, or any
shared database. Never use ordinary `DATABASE_URL` as an implicit fallback.
Supply only a deliberately test-only `TEST_DATABASE_URL`, an explicit
`testDatabaseUrl` with the same safety properties, or let the harness own a
disposable container.

Do not reset or remove a database, truncate shared tables, restore dumps, alter
cluster settings, terminate other sessions, or run cluster-wide cleanup from a
test. The harness needs none of those operations. Its cleanup is limited to the
uniquely generated schema it owns and, for the container-backed mode, the one
container that backend started. A URL-backed PostgreSQL service is never stopped
or otherwise treated as harness-owned.
