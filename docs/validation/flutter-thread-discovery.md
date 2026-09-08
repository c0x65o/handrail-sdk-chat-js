# Flutter channel thread discovery validation

Owner task item: `ef347976-9fe1-4e89-8d62-4f1ccaa2bc49`.
Scope: SDK Dart controller/query integration and deterministic repository-local tests.

## Behavior and public surface

The SDK can now discover named child threads from a parent channel, independently
of opening a root message. Existing root-thread opening remains available.
Discovery does not change the Current / Discord-style preference, join or follow
threads, mutate membership or notification preferences, mark messages read, or
own panel navigation, drafts or send destinations. Widget discovery remains the
separate dependent item.

All types are available through the existing `core.dart` export of
`handrail_chat_client.dart`; the controller follows the existing lifecycle
controller's Dart `part` pattern. Generated thread-list contracts were sufficient
and were not modified.

```dart
final discovery = client.threadLists.forParent(parentConversationId);
discovery.setAuthority(ChatThreadListAuthority(
  tenantId: tenantId,
  userId: userId,
  canRead: true,
));
final subscription = discovery.states.listen(renderDiscovery);
await discovery.refresh();
// discovery.loadMore(), discovery.retry(), discovery.state
// On leaving this surface:
await subscription.cancel();
await discovery.dispose();
```

`forParent` accepts `view: 'active' | 'all'`, `pageSize`, injected `now`, and an
injected cancellable `schedule`. Each invocation creates a client-owned
controller, allowing independent surfaces and views. `setScope` changes parent
and view with fresh explicit authority. `setAuthority` always invalidates pending
work, even for the same actor regaining access. Hosts must update authority when
permissions or token-provider identity change outside accepted client identity
and realtime APIs; server authorization is still performed on every page.

`client.listThreads(ThreadListRequest(...), options: ...)` exposes the generated
query through the existing authenticated snapshot reader, including token
refresh, cancellation, typed sanitized failures and diagnostics. Observable
state is current-first and immutable, with initial loading, refresh, pagination,
empty, error/retry, denied and disposed states. Refresh cancels and supersedes
any previous request instead of allowing its page to enter the replacement list.
Pages merge by canonical thread ID in generated creation-time/C-collation order.
Parent/root/creation identities cannot change across accepted pages.

Discovery HTTP reads do not hydrate or prune the shared normalized store. Rows
project newer normalized lifecycle revisions, canonical follow revisions and
read/preference timestamps without coupling these independent authorities.
A stale active HTTP page cannot restore a thread closed by newer normalized
lifecycle state. An empty discovery response leaves an open thread, its draft
and an in-flight send's destination intact.

Relevant normalized conversation/private-state changes and accepted durable
conversation/thread/read events refresh discovery. Parent-stream
`message.thread_summary.updated` handles new unopened threads;
`thread.lifecycle.changed` invalidations deduplicate revisions per controller's
actor/parent/thread scope. The latter hook runs after canonical reduction has
accepted the event, without changing reducers or inventing canonical child
lifecycle. Discovery retains the existing parent subscription with reference
counting; it does not subscribe to each child. Reconnect reloads authority.
Parent subscription rejection/revocation, durable parent access revocation,
identity changes, explicit scope changes and disposal invalidate pending reads
and cancel timers. Subscription release is deferred outside synchronous event
delivery to avoid reentrancy.

While `states` is observed, active discovery schedules the nearest server
`hideAt` deadline using the page's `evaluatedAt` relative to request start on the
injected local clock. This handles server/client clock offset and conservatively
accounts for request latency. Elapsed deadlines back off from 1 to 64 seconds
instead of causing an immediate refresh loop. Very large valid policies use a
maximum one-day authority-check interval to stay within platform timer bounds.
Failed reads require retry/reconnect instead of automatic error loops. Disabled
or absent inactivity policy creates no timer. All-view rows remain discoverable
after inactivity, so all view needs no expiry timer. Last-observer cancellation
and disposal cancel scheduling.

## Exact final verification

Run sequentially from `flutter/handrail_chat`:

```sh
FLUTTER_ALREADY_LOCKED=true /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 test/thread_list_controller_test.dart test/thread_lifecycle_controller_test.dart test/thread_opening_controller_test.dart test/conversation_snapshot_query_test.dart test/generated_thread_list_test.dart
/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart analyze lib/src/core/thread_list_controller.dart lib/src/core/conversation_snapshot_query.dart lib/src/handrail_chat_client.dart
```

Results: **133 tests passed, exit 0; production analysis: no issues, exit 0**.
The test run includes 26 new discovery tests and 107 existing lifecycle,
thread-opening, snapshot-query and generated discovery contract tests. Tests use
controlled HTTP/realtime boundaries and deterministic cancellable timers; no
SQL or persistence implementation is being simulated.

New tests cover two-page merge/order/immutable identities; loading, empty,
malformed scope/actor responses and sanitized error/retry; refresh versus late
pagination; parent summary creation and lifecycle revision invalidation for
unopened children; nearest expiry with clock offset, elapsed deadlines and
large policy bounds; disabled/all semantics; unobserved/disposed/account/parent
timer cancellation; parent/account/disposal late-response races and same-actor
access regain; HTTP, durable and subscription access loss; independent
follow/read/membership/preferences; newer normalized lifecycle/private state;
open-thread/draft/send preservation; shared parent subscription and reconnect.

From repository root:

```sh
git diff --check -- flutter/handrail_chat/lib/src/core/thread_list_controller.dart flutter/handrail_chat/lib/src/core/conversation_snapshot_query.dart flutter/handrail_chat/lib/src/handrail_chat_client.dart flutter/handrail_chat/test/thread_list_controller_test.dart docs/validation/flutter-thread-discovery.md
```

Result: exit 0. Initial fixture, compile, working-directory and style issues were
corrected before the final checks; no unrelated test failures remain in this
focused run. Flutter emitted the same nonfatal read-only `libimobiledevice.stamp`
and `libusbmuxd.stamp` warnings documented by the lifecycle prerequisite; installed
tooling still completed successfully. No unusual resource consumption observed.

The shared client patch is ten additive lines for import/part, construction,
public ownership, accepted-event notification, access/identity invalidation and
disposal. The shared query file adds one diagnostic enum value. Existing
prerequisite/sibling changes were preserved; normalized state and reducers were
not edited. No generated contracts, TypeScript, SQL, UI or preview files changed.
No live QA, provider action, deployment, commit, push, PR or queue mutation was
performed. The scoped patch is left uncommitted; only the authorized Owner Task
ledger is updated. This evidence completes the selected Dart discovery item,
not the broader convergence goal.
