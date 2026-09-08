# Flutter Reply routing by saved style

Owner item `f6e0ea2e-f246-4c8b-888b-77a414465b71`, Owner Goal
`0175981e-9e78-4a38-900a-e1148040c0a2`.

Current Reply still opens the root's separate thread. Discord-style Reply now
selects a reference in the current conversation's composer; sending stays in
that channel, DM, group DM or existing thread. Selection creates no thread and
never changes destination. Existing thread-summary buttons remain independent,
including on deleted roots. Discord Reply is also shown beside an existing
thread summary. Deleted and optimistic-only sources cannot be selected; closing
a long-press menu rechecks the source's current canonical state.

## Public integration

`HandrailReplyRequested = bool Function(MessageContextRequest source)` and the
optional timeline `onReplyRequested` are exported by the existing UI export.
For a custom composer integration:

```dart
final composerKey = GlobalKey<HandrailMessageComposerState>();
// In the current conversation's timeline:
onReplyRequested: (source) =>
    composerKey.currentState?.selectReply(source) ?? false,
// In that conversation's HandrailMessageComposer:
key: composerKey,
```

The default workspace and thread view now provide this connection. Their stable
GlobalKeys do not depend on style. Existing destination ValueKeys remain on
wrappers. A thread's parent root context is not offered as an inline source for
the thread composer. The existing composer retains responsibility for draft
restoration, selection, ping, focus, attachments, sending and frozen retries.

The timeline observes the scoped client's `replyStyles.state.effectiveStyle`,
client lifecycle and realtime metadata. It reads public negotiated
`ChatReplyThreadFeatures.inlineReplies` independently of preference-saving
support. HTTP integrations must request the capability when configuring their
client. Without a scoped client the existing controller-only API keeps Current
behavior. Missing/unknown inline capability or a missing callback disables Reply
with visible accessible explanation; a callback returning false shows a safe
composer-unavailable reason. None of these cases falls back to a thread.

The existing labelled Material Reply button supports keyboard activation and a
long-press bottom-sheet menu. The menu closes before composer focus is requested.
Style/capability subscriptions detach on client rebinding and widget disposal;
client-owned runtime/controllers remain owned by the client. Source selection
passes IDs only, never assigns shared message-context authority and never treats
loaded source text as proof of access. Server authorization remains authoritative.

## Deterministic acceptance

The new `test/handrail_reply_routing_cases.dart` is a part of the existing
workspace widget suite, reusing its client, HTTP and thread fixtures. It adds
15 tests for actual default workspace/thread wiring, exact send payloads and
absence of thread requests: Alice's question/Bob's Friday send; channel, direct,
and group-direct destinations with/without summaries; existing-thread destination
and retained handle; absent/explicit Current; supported inline actions without a
preference API; unavailable and initially unknown capability; rebinding and
client-owned lifetime; keyboard, semantics and long press; selected source,
false ping, text and destination through style switches; absent/rejecting handlers;
and pending/deleted sources including deletion while the menu is open.

Three existing workspace settings tests additionally retain attachments, both
composer identities, source/ping, open thread handles and encoded queued-send
records across setting changes at wide and compact widths. The fixture uses the
existing normalized conversation seed and explicitly activates trusted HTTP
identity and requested capabilities. No SQL behavior or database was simulated.

## Scope and review

Initial checkout: SDK `main`, HEAD
`39c194f15a5d0f51faa521ba9c94e3c321fbf282`, with the supplied dirty prerequisite
runtime/settings changes. Existing workspace and workspace-test settings edits
were preserved. This item adds only routing to the three production widget
files, a test registration/import/part in the workspace suite, the new routing
cases and this note. Adjacent named-thread, discovery and lifecycle UI work owns
its separate surfaces; the overlap here is only composer wiring. No canonical
contract/template changes were necessary, so no generated outputs were changed.

During verification Handrail externally advanced HEAD to
`c41d76931ccbd48c5c1b5ff6dc0788d00530ddd8`, including this worker's routing
changes. This worker ran no commit, staging, push or other Git finalization
command and preserved that external checkpoint. Compare the scoped paths with
the initial `39c194f` revision for the complete patch; the remaining verification
note is uncommitted. No preview-repository changes, provider/external sends,
database mutation, deployment or QA campaign occurred.

## Verification commands and results

Run sequentially from `flutter/handrail_chat`, one test worker:

```sh
FLUTTER_ALREADY_LOCKED=true /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 --reporter=expanded test/handrail_chat_workspace_test.dart --name 'reply routing|settings'
FLUTTER_ALREADY_LOCKED=true timeout 60s /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 --reporter=expanded test/handrail_message_composer_test.dart test/handrail_timeline_reply_reference_test.dart
/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart analyze lib/src/handrail_message_timeline.dart lib/src/handrail_chat_workspace.dart lib/src/handrail_thread_view.dart
```

Results: routing/settings **18 tests passed, exit 0**; composer/reply-reference
components **45 tests passed, exit 0**; scoped production analysis **no issues,
exit 0**. The 63 passing tests include all selected-item acceptance checks.

From repository root, the full scoped patch whitespace check also exited 0:

```sh
git diff --check 39c194f15a5d0f51faa521ba9c94e3c321fbf282 -- flutter/handrail_chat/lib/src/handrail_message_timeline.dart flutter/handrail_chat/lib/src/handrail_chat_workspace.dart flutter/handrail_chat/lib/src/handrail_thread_view.dart flutter/handrail_chat/test/handrail_chat_workspace_test.dart flutter/handrail_chat/test/handrail_reply_routing_cases.dart
```

Broader regression attempts, using the same Flutter prefix above:

```sh
# Timed out on the first existing unread-position test, exit 124.
FLUTTER_ALREADY_LOCKED=true timeout 60s /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 --reporter=expanded test/handrail_message_timeline_test.dart test/handrail_timeline_reply_reference_test.dart test/handrail_message_composer_test.dart test/handrail_thread_view_test.dart
# Completed 45 component tests, then stalled on the first existing thread-view test; exit 124.
FLUTTER_ALREADY_LOCKED=true timeout 60s /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 --reporter=expanded test/handrail_message_composer_test.dart test/handrail_timeline_reply_reference_test.dart test/handrail_thread_view_test.dart
```

Both stalls were reproduced against the **original `39c194f` widget sources**,
using temporary copies alongside the production sources so shared working files
were never replaced. Test copies imported those original classes. The two
baseline commands below each exited **124**, stalled on the same first test;
there was no failed product assertion before timeout:

```sh
FLUTTER_ALREADY_LOCKED=true timeout 15s /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 --reporter=expanded test/handrail_reply_routing_baseline_temp_test.dart --name 'opens cold chat at unread 1$'
FLUTTER_ALREADY_LOCKED=true timeout 15s /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 --reporter=expanded test/handrail_reply_thread_baseline_temp_test.dart --name 'renders a caller-owned existing thread'
```

All four diagnostic copies were removed afterward. Handrail's concurrent
checkpoint had included the two timeline diagnostic copies; their removal is
therefore a scoped tracked deletion in the final patch. They are temporary
baseline artifacts, not production or sibling functionality.

Development-only failures corrected fixture identity/capability setup, normalized
conversation seeding and client replacement through the existing ChatScope keyed
mount contract. Baseline thread-copy imports initially failed to compile because
of duplicate enum types and because HEAD changed during preparation; the final
comparison explicitly used the recorded starting revision. Those compile attempts
exited 1 and are not claimed as baseline runtime evidence.

Flutter emitted nonfatal read-only `libimobiledevice.stamp` and
`libusbmuxd.stamp` warnings. Forced timeout shutdowns also emitted stream-channel
cleanup errors. No resource-exhaustion failure was observed. These existing suite
stalls do not block the selected item's passing deterministic routing acceptance;
no global checks, deployed QA, database behavior or entire convergence completion
are claimed.
