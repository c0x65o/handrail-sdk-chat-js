# Thread notification recipient validation

Owner Task item: `c62ed01c-46c7-4123-9bbb-340461b14023`.

The previous dispatcher selected active child members. Thread delivery now selects
only existing participant/follow identities and concrete explicit or validated
reply-source-author mention identities. General traffic requires explicit follow
or the legacy active-child/no-follow fallback. Explicit unfollow still permits a
deliberate mention under `all` or `mentions`; `none` and effective mute suppress both.
Public-parent readers are never enumerated. Selection does not create or modify
members, follows, preferences, or unread cursors.

Thread candidates must pass current directory identity eligibility and the shared
parent/entity access helper. Child archive suppression is enforced separately.
Follow, mention eligibility, preference/mute, directory eligibility, and
child/parent/entity access are rechecked immediately before each send boundary,
including retries and after target decryption. Source-author identity comes from
a nondeleted source in the same tenant/conversation, never supplied author metadata.
Deduplication keys and minimized notification metadata are unchanged.

The server passes its existing directory and permission adapters to the dispatcher.
Standalone dispatcher callers must supply these optional adapters for thread
notifications; missing adapters fail closed for threads. Background recipient
actors carry persisted tenant/user IDs and an empty roles array: no session roles
are invented. Entity authorization uses the existing `conversation.subscribe`
action and must resolve current host access by identity. Nonthread and reminder
rules are preserved.

## Checks

Run from the SDK repository, sequentially. Scoped production compile passed:

```sh
GOMAXPROCS=2 GOMEMLIMIT=2GiB node --max-old-space-size=2048 node_modules/typescript/bin/tsc --project tsconfig.notification-thread-delivery.json
node --check test/postgres-notification-dispatcher.test.mjs
```

The focused suites used freshly compiled code and the existing
`createPostgresTestBackend` / `createHarness` schema-isolation pattern. A disposable
native PostgreSQL 15 cluster supplied `TEST_DATABASE_URL`; TCP was disabled and the
private socket permitted only the worker user. No fake persistence or external
provider was used. The cluster was stopped and removed by the shell trap.

```sh
set -eu
notification_pg_dir=$(mktemp -d "$PWD/.np-XXXXXX")
trap '/usr/lib/postgresql/15/bin/pg_ctl -D "$notification_pg_dir/data" -m immediate -w stop >/dev/null 2>&1 || true; rm -rf "$notification_pg_dir"' EXIT
/usr/lib/postgresql/15/bin/initdb -D "$notification_pg_dir/data" -U handrail_test --auth-local=trust --auth-host=reject --encoding=UTF8 --no-locale >"$notification_pg_dir/init.log" 2>&1
/usr/lib/postgresql/15/bin/pg_ctl -D "$notification_pg_dir/data" -l "$notification_pg_dir/server.log" -o "-p 5432 -c timezone=UTC -c listen_addresses='' -c unix_socket_directories='$notification_pg_dir' -c unix_socket_permissions=0700" -w start
TEST_DATABASE_URL="postgresql://handrail_test@localhost:5432/postgres?host=$notification_pg_dir" node --test --test-concurrency=1 test/postgres-notification-dispatcher.test.mjs test/postgres-notification-reminder-dispatcher.test.mjs
```

Final result: **172 tests passed, 0 failed, 0 skipped**, approximately 6.5 seconds.
Coverage includes general/explicit/synthetic traffic, missing and retained inactive
participation, public-parent reader exclusion, missing adapters, directory identity
mismatches/redaction/unavailability, leave/removal, preference/mute changes,
child/parent archives, entity revocation, source deletion, and retry suppression.
Assertions inspect the stubbed send boundary, deduplication, minimized metadata,
and unchanged participation/follow/preference/cursor state. Existing nonthread,
materializer rollback/paging, concurrent worker, and reminder tests also passed.
Initial fixture errors (unsupported `banned` state and deletion before the fixture's
2030 creation time) were corrected. The existing reminder string assertion requires
UTC PostgreSQL, so the disposable backend explicitly sets UTC.

Additional unit regression investigation:

```sh
node --test --test-concurrency=1 test/notification-dispatcher.test.mjs
node --test --test-concurrency=1 --test-name-pattern='onBatch aggregates|coalescing' test/notification-dispatcher.test.mjs
```

The full unit run reported two existing assertions and stalled later; it was
interrupted (exit 130). The focused pair exited 1 with the same two failures:
telemetry expected 35 ms / 2035 ms but received 40 ms / 2040 ms, and callback
observations expected `[17]` but received `[undefined, 17, undefined]`. Both were
reproduced against committed dispatcher source at
`2d68d7f88138568d283440e7daed58e7fe3e0bff`, loaded through a temporary Node loader after
stripping TypeScript types. The baseline command was:

```sh
timeout --signal=TERM 15s node --experimental-loader /opt/handrail/.handrail/codex-runs/1c01235d-0fe7-479e-84ab-9e777098098b/tmp/notification-baseline-loader.mjs --test --test-concurrency=1 --test-name-pattern='onBatch aggregates|coalescing' test/notification-dispatcher.test.mjs
```

It exited 1 normally with two failures (no timeout). This confirms they are
pre-existing lease-recovery unit-harness expectations, outside this item. They remain for convergence review.
The focused PostgreSQL suites all pass. No resource exhaustion was reported.

Only this item's dispatcher changes, two server adapter wiring lines, PostgreSQL
test extensions, scoped compile config, and this evidence note were authored here.
Existing dirty prerequisites and sibling edits were preserved. No commits, pushes,
PRs, deployments, real provider calls, or preview-repository edits were performed.
