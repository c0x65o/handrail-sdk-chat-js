# Flutter thread lifecycle controller validation

Owner task item: `e7021622-5462-440e-8e8c-05e9662289c7`.
Scope: Flutter SDK implementation and deterministic local verification only.

## Behavior and API

`client.threadLifecycles.forThread(threadId)` exposes current-first observable
`state`/`states`, canonical lifecycle and archive state, operation capabilities,
loading/saving/error/conflict states, and explicit `close()`, `reopen()`, `lock()`,
`unlock()`, `load()` and `retry()` methods. The existing `core.dart` client and
contract exports already expose these public types; no new export is necessary.

Supply current trusted host authority through `setAuthority(...)`, then `load()`.
Authority includes tenant/user scope, read/send/manage permission and parent
archive restriction. Missing authority disables operations. The current detail
contract does not project operation permissions; the SDK does not infer manage
permission from child membership or follow state. Hosts must update authority
when authentication or access changes, including token-provider identity changes
outside the accepted realtime/storage identity APIs. Calling `setAuthority`
always invalidates pending work, even for the same actor regaining access.

Writes require explicit `thread_lifecycle_v1: true` in both the client's requested
capabilities and server metadata. When realtime is configured, its current
accepted metadata must also explicitly enable the feature. The real server
still reserves and does **not advertise** this capability; this task does not
change backend advertisement. Supported behavior uses controlled test fixtures.
Reads continue through the existing parent-authorized detail route; subscriptions
use the existing parent-authorized child conversation subscription path.

Generated input/result validators enforce exact intent, thread ID, expected
revision and idempotency correlation. Transport retries preserve those fields,
actor scope and destination. An explicit retry after reconnect retains the same
logical request. Canonical HTTP 409 conflicts remain observable and `retry()`
does not resubmit them; choosing a transition method creates a new intent/key.
Other 409 errors remain sanitized failures, without invented canonical state.

Canonical detail hydration runs on load and reconnect. The normalized store now
merges thread lifecycle revisions independently of conversation timestamps and
archive revisions. Child lifecycle events apply canonical state; parent discovery
invalidation consumes its envelope without inventing child state. Late command
acknowledgements, historical replays, stale detail and thread-created events
cannot overwrite a newer lifecycle revision. Equal contradictory revisions fail
atomically. Missing legacy metadata remains open/unlocked with revision 1 as the
write baseline; administrative archive remains separate.

Actor/access changes cancel pending work and reject stale results. Subscription
revocation invalidates immediately, with subscription release deferred outside
synchronous realtime event delivery. Controller/client disposal releases all
owned stream subscriptions and retained delivery. This controller owns no durable
queue and does not alter drafts, sends, destinations, follows, unread state,
reply style, inactivity discovery policy or panel navigation.

The behavior addition is explicit shared thread close/reopen/lock/unlock state.
It is independent of the Current versus Discord-style reply preference. Existing
root-thread opening remains available and unchanged by lifecycle actions.

## Exact verification

Run sequentially from `flutter/handrail_chat`:

```sh
FLUTTER_ALREADY_LOCKED=true /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 test/thread_lifecycle_controller_test.dart test/durable_resource_event_reducer_test.dart test/durable_message_event_reducer_test.dart test/normalized_snapshot_state_test.dart test/thread_opening_controller_test.dart
/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart analyze lib/src/core/thread_lifecycle_controller.dart lib/src/core/thread_lifecycle_state.dart lib/src/core/normalized_snapshot_state.dart lib/src/core/durable_message_event_reducer.dart lib/src/core/durable_conversation_event_reducer.dart lib/src/handrail_chat_client.dart
```

Final results: **188 tests passed, exit 0; scoped production analysis: no issues,
exit 0**. New coverage consists of 22 lifecycle controller/reducer tests; the
remaining 166 tests exercise existing resource, message/conversation, snapshot
and thread-opening behavior. Tests use HTTP and realtime service boundaries,
without a database substitute. No TypeScript production or generated files
changed, so TypeScript compilation, generation and SQL checks were unnecessary.

From repository root, scoped whitespace verification:

```sh
git diff --check -- flutter/handrail_chat/lib/src/handrail_chat_client.dart flutter/handrail_chat/lib/src/core/thread_lifecycle_controller.dart flutter/handrail_chat/lib/src/core/thread_lifecycle_state.dart flutter/handrail_chat/lib/src/core/normalized_snapshot_state.dart flutter/handrail_chat/lib/src/core/durable_message_event_reducer.dart flutter/handrail_chat/lib/src/core/durable_conversation_event_reducer.dart flutter/handrail_chat/test/thread_lifecycle_controller_test.dart docs/validation/flutter-thread-lifecycle.md
```

Result: exit 0. Initial test helper compile/fixture/assertion issues and newly
exercised implementation issues were fixed before the final run. No unrelated
pre-existing test failures occurred in the focused final checks. Flutter emitted
non-fatal read-only `libimobiledevice.stamp` and `libusbmuxd.stamp` warnings; installed
Flutter tooling completed successfully without modifying SDK cache files.

Existing sibling thread-opening edits were preserved and settled into the shared
checkout during this run. Shared client integration is limited to the lifecycle
controller import/part, construction/public property, identity/access invalidation
and disposal. No preview repository, UI, deployment, external send, QA campaign,
commit, push, PR or CI/CD mutation was performed by this worker. The scoped patch
is left uncommitted.
