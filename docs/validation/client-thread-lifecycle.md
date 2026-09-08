# TypeScript thread lifecycle runtime

Selected item: `8c1558f2-b1c1-484a-8f41-b765abc56ee4`.

The existing thread conversation and history remain intact. The new headless API
reads shared lifecycle independently of reply style and offers explicit close,
reopen, lock and unlock commands. Opening, unfollowing and dismissing a panel keep
their existing meanings. No saved-style setting, visible lifecycle control,
Flutter code, server advertisement or database behavior is introduced here.

## Public API

`client.threadLifecycle` provides `load(threadId, parentConversationId)`,
`getState(threadId)`, `subscribe(threadId, listener)`, `close`, `reopen`, `lock`,
`unlock` and `retry`. `useThreadLifecycle(threadId, parentConversationId)` exposes
the same state and an `actions` object (including `reload`). It automatically
loads inside a ready ChatProvider; unmount releases only its observer.

State includes loading/updating/error/conflict/unavailable status, canonical
`lifecycle`, `legacy`, `actionsAvailable`, a safe error code, the frozen
`pendingInput`, and the correlated command `result`. A conflict is a resolved
canonical HTTP 409 result. Transport/key-reuse failures remain errors. Retry
retains the original thread, intent, expected revision and idempotency key even
when newer events or snapshots have arrived. Only an explicit new action chooses
a new revision/key. There is no additional durable queue or automatic action
replay on reconnect.

Actions require negotiated `thread_lifecycle_v1 === true` and an online client
with explicit lifecycle metadata. Missing/false support sends no lifecycle
request. Legacy absence is readable as open/unlocked (`legacy: true`) with no
invented revision; actions wait for canonical metadata. Server advertisement
remains deliberately deferred to its separate task.

Hydration uses a separate instance of the existing snapshot reader without cache
auto-hydration. It checks actor/session, thread/parent, active access and request
generations before admitting metadata. Existing realtime subscriptions and
cross-tab command/event coordination are reused. Child updates admit only newer
canonical revisions; parent invalidations trigger detail reads. Reconnect
supersedes old reads and sequentially refreshes known scopes. An update received
during initial loading waits for a successful authorized detail response.

Revocation clears lifecycle, pending intent and related history through the
existing `threads/discard-history` cache action. Late responses/events cannot
restore authority. Revocations remain tombstoned through ordinary reconnect;
resetting the trusted identity/session or closing/restarting the client clears
the boundary, after which a fresh authorized load is required. Ordinary
membership generation changes invalidate in-flight work as well. The runtime
owns lifecycle authority; it does not project partial detail responses over the
normalized cache's other facts or persist lifecycle commands.

## Files and overlap

- `src/client/thread-lifecycle.ts`: focused runtime and public state/API types.
- `src/client/create-chat-client.ts`: import; ChatClient property; runtime construction
  with the existing dispatcher/reader; client readiness and realtime-state
  callbacks; access-revoked callback; direct and cross-tab canonical-event
  callbacks; public getter; close cleanup. Existing thread opening/creation,
  sends, draft and participation implementation sections are unchanged.
- `src/client/durable-event-reducer.ts`: admit/validate both lifecycle event types
  and exclude them from envelope-time ordering. Revision admission belongs to the
  lifecycle runtime; parent invalidations carry no lifecycle snapshot.
- `src/client/index.ts`, `src/react/index.ts`,
  `src/react/thread-lifecycle-hook.ts`: minimal public exports/hook.
- `test/client-thread-lifecycle.test.mjs`,
  `type-tests/client-thread-lifecycle.test.ts`,
  `scripts/test-client-thread-lifecycle.mjs`,
  `tsconfig.client-thread-lifecycle.json`,
  `tsconfig.client-thread-lifecycle-type-tests.json`: scoped verification.

`src/client/normalized-cache.ts` was inspected and not edited. Sibling Flutter
work was not edited. During this run the shared checkout advanced to `c4e7a81`,
which captured an early runtime file alongside sibling work. This worker ran no
commit, push, PR, reset, restore, stash, clean or other Git finalization command;
remaining edits were left for Handrail's scoped finalization.

## Verification

Run:

```sh
node scripts/test-client-thread-lifecycle.mjs
```

The runner compiles current production client/React source, checks public API
types, then runs tests with `--test-concurrency=1`. It uses a unique temporary
build directory and deletes only that directory afterward. The existing opening
suite is reused with import paths redirected to this fresh compilation; no
stale `dist` exports are used. The lifecycle test also compiles fresh source when
invoked directly without the runner.

Result: **55 tests passed** (22 lifecycle runtime/client/hook cases plus 33
existing thread-opening cases); scoped production compilation and public API
negative/positive type coverage passed. Direct type commands:

```sh
node node_modules/typescript/bin/tsc --project tsconfig.client-thread-lifecycle.json --noEmit
node node_modules/typescript/bin/tsc --project tsconfig.client-thread-lifecycle-type-tests.json
```

Coverage includes two actors/sessions, old/equal/out-of-order revisions,
historical replay, correlated canonical conflicts versus key-reuse/malformed
responses, late reconnect detail, initial-load events, parent invalidations,
actor/session/parent/access and membership-generation changes, HTTP denial,
explicit intents, unsupported/legacy/offline behavior, and actual client draft
plus durable queued-send preservation after failed actions and hook dismissal.
React emits its existing `react-test-renderer` deprecation notice; assertions
pass. Tests use HTTP, socket and storage-adapter boundaries; no SQL persistence
claim or SQL harness is needed for this runtime item. No live-provider calls or
QA campaign were run. Global checks and visible UI/capability work remain outside
this selected item; there are no remaining scoped acceptance gaps.
