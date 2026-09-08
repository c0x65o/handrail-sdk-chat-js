# Offline reply persistence and recovery

Owner Task item: `95ca2d99-3565-46b9-bd05-62323fa4512e`.
Verified locally on 2026-09-06. Patch intentionally left uncommitted.

## Behavior and scope

Previously, enqueue detached and froze the reply correctly, but durable encoding
omitted `replyTo` and decoding did not accept it. A new recreated-storage regression
reproduced the missing references for both `notifyAuthor: false` and `true` against
freshly compiled production code before the fix.

Queued-send wire records now carry optional `replyTo`, validated by the canonical
send parser. Queue envelope and send contract versions remain 1; legacy records
without the field still hydrate. Snapshot versioning is unchanged. The original
conversation, content, source ID, ping choice and correlation keys survive recovery.
An inline reply remains in its channel or existing thread; it never opens a thread.

Recovery recreates the optimistic reply row from the frozen retained request,
because canonical cache checkpoints exclude optimistic rows. Unsupported/disabled
reply failures retain the exact intent, expose the existing failure code and retry
action, and pause the FIFO head until retry or reconnect. They do not automatically
retry in a tight loop. Other terminal send behavior is unchanged. Coordinated
results use the same reply retention and retry projection rules.

Changed files owned by this item:

- `src/client/application-chat-storage.ts`: optional wire field only.
- `src/client/create-chat-client.ts`: narrowly scoped retained reply recovery,
  failure settlement and coordinated-result handling. Existing prerequisite and
  sibling changes in this file were preserved.
- `test/client-application-chat-storage.test.mjs`: wire round trips, legacy records,
  unchanged versions and invalid canonical reply metadata.
- `test/client-offline-send-message-queue.test.mjs`: caller mutation, frozen nested
  data, recreated storage, true/false pings, exact tenant/user/device isolation,
  and concurrent atomic enqueues retaining both replies in FIFO order.
- `test/client-offline-send-recovery.test.mjs`: client recreation, reconnect,
  transport retry, stable keys/destination, unsupported/disabled manual retry,
  FIFO pause, one canonical removal, realtime-first settlement and late HTTP.
- `docs/validation/offline-replies.md`: this evidence.

`offline-send-message-queue.ts` already retains `intent.request` correctly and
needed no production edit. No generated source or Dart production file changed.

## Validation

All checks ran sequentially; Node tests used one worker.

- `node_modules/.bin/tsc --project tsconfig.client-replies.json`: PASS. Freshly
  emits the client production dependency graph to ignored `dist`.
- `node_modules/.bin/tsc --project tsconfig.application-chat-storage-type-tests.json`:
  PASS.
- `node_modules/.bin/tsc --project tsconfig.client-replies-type-tests.json`: PASS.
- `node --test --test-concurrency=1 --test-reporter=spec test/client-application-chat-storage.test.mjs test/client-offline-send-message-queue.test.mjs test/client-offline-send-recovery.test.mjs test/optimistic-message-sending.test.mjs`:
  PASS, **79 tests, 0 failures, 0 skips** against freshly compiled production code.
- `git diff --check -- src/client/application-chat-storage.ts src/client/create-chat-client.ts test/client-application-chat-storage.test.mjs test/client-offline-send-message-queue.test.mjs test/client-offline-send-recovery.test.mjs docs/validation/offline-replies.md`:
  PASS.

## Evidence gaps

The existing host feature configuration seam was changed between client instances
(`huddles: false` to `true`, which controls huddle presentation) before reply recovery.
No saved reply-style runtime or UI exists in the inspected client yet. Actual saved
Current/Discord-style switching remains integration coverage for the separately
scheduled preference/runtime items. Recovery never consults presentation state.

The additional `test/cross-tab-coordinator.test.mjs` run failed during construction
of retained-send clients: existing adapter fixtures omit `compareExchange`, while
the client requires it with `crossTab`. This requirement is also present in HEAD.
The affected ownership/follower/failover fixture groups never reached dispatch;
they were not edited. This leaves cross-tab reply recovery integration unverified;
the focused atomic queue mutation regressions pass.

An availability probe using the existing `createPostgresTestBackend()` failed:
`Unable to start container-backed PostgreSQL. Set TEST_DATABASE_URL to a test database URL or make Docker available.`
`TEST_DATABASE_URL` is unset. No SQL persistence assertions ran. The existing narrow
storage-adapter and HTTP fixtures prove client serialization/recovery behavior only;
they are not a substitute for PostgreSQL persistence tests. No handwritten database
was introduced, and no external provider, deployment or QA campaign was used.
