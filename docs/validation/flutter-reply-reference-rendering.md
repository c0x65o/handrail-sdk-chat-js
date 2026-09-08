# Flutter timeline reply references

Selected Owner Task item: `ad2aac2e-476d-482b-8be4-dd888ed9113b`.
Owner Goal: `0175981e-9e78-4a38-900a-e1148040c0a2`.
Worker: `f2734676-8a7b-4ad4-8ac8-4d0b5b2a7d5c`.

## Checkout and ownership

The worker verified Handrail current context for SDK project
`1791fdf7-f197-483c-ba67-5c0da8f4315f`, task
`6ed34db0-9963-45d8-87b2-5635fb3b6a73`, work request
`c0881b22-cc4a-4f19-b08f-0ae34fb08f80`, with no Change Lane.
Checkout: `/opt/handrail/repos/handrail/handrail-chat/handrail-sdk-chat`;
branch `main`; starting HEAD `93712df4e6dccb6cf1c2e1983343f6e42f33d2ea`.
No applicable AGENTS.md was found in the repository or its ancestors.

Starting state differed from the planner inspection: prerequisite source-context
files were tracked and clean. Dirty files were Flutter/React composer sources
and tests, `scripts/test-composer-replies.mjs`, deleted tracked
`build/composer-replies-*` artifacts, and two untracked composer validation
notes. The selected production files were clean. Existing work was preserved.
The start/progress ledger recorded timeline/builder ownership and serialization
with the later Reply-by-style item.

This worker owns these changes (Flutter paths relative to `flutter/handrail_chat`):

- `lib/src/handrail_message_timeline.dart`: reference presentation, current-state
  observation, accessible source focus and bounded source window.
- `lib/src/chat_widget_builders.dart`: optional `replyContext` and typed
  `ChatMessageReplyContext` state/jump/retry input; existing constructors work.
- `lib/src/core/timeline_controller.dart`: additive `messageContext(messageId)`
  adapter to the existing client-owned shared registry.
- `test/handrail_timeline_reply_reference_test.dart`: 16 deterministic widget tests.
- This validation note.

During work, another process advanced HEAD to
`88b6f0c969a35578c3b6f92268e939b461e0dac8`, incorporating earlier portions of this
patch and sibling work. This worker ran no commit, push, reset, restore, stash,
clean, or branch-switch command. Final timeline/test refinements and this note
were left as workspace changes. Compare owned paths against starting HEAD to
review the complete item, not only the current unstaged diff.

## Behavior and authority

Previously a Flutter message row ignored `replyTo`. Now Bob's “Friday” carries a
concise reference to Alice's authorized current “Which launch date?” source.
Rendering has no style branch, so the reply means the same thing in either
presentation mode. Existing Reply-to-thread action routing is unchanged by this
item; selecting an inline reply or changing the saved style belongs to sibling
items.

The widget observes `client.messageContexts.forMessage(...)` via the timeline
adapter. It neither resets authority nor disposes the shared controller. As
with the composer, the host configures each shared source once per trusted
identity/access generation, outside widget builds:

```dart
final source = client.messageContexts.forMessage(MessageContextRequest(
  conversationId: conversationId,
  messageId: replyTo.messageId,
));
source.setAuthority(ChatMessageContextAuthority(
  tenantId: trustedTenantId,
  userId: trustedUserId,
  canRead: trustedCanRead,
));
// Update/clear authority when host identity/access changes. Every assignment
// invalidates prior source state, even for an unchanged actor: do not do this
// on ordinary builds or once per consumer. The server authorizes each read.
```

Unconfigured authority displays unavailable, even if the source is in normalized
timeline state. Accepted client identity/access changes retain the prerequisite
controller's invalidation guarantees; token-provider changes outside those APIs
require explicit host authority updates. No identity is inferred from a message.
The current source's author ID and at most 160 graphemes of its text are shown;
the context contract does not supply an author display name. Forward attribution
is never used. Source replies are not recursively expanded.

Observers render `controller.state` on each build, rather than retaining stream
event snapshots. Loading, transport error/retry, deletion and unavailability
replace source text. Jump/retry callbacks check live state before acting.
Custom builders receive replacement immutable inputs and must not persist them.

Tap, Enter and Space activate the reference. A mounted original uses the existing
row key and Scrollable.ensureVisible, then receives programmatic focus without
adding ordinary message rows to tab order. For an unmounted/unloaded original,
a dismissible dialog focuses the source and requests at most one bounded page
before and after its sequence. It displays at most the controller page size on
each side, even when another consumer has loaded more. The timeline has no
isolated-window seek API; this window avoids a history scan or hydrating source
text into normalized/durable state. Closing preserves the timeline's offset.
No thread is opened/created and no send destination or read cursor is changed.

## Verification

Run sequentially from `flutter/handrail_chat` (logs under the worker tmp path
`/opt/handrail/.handrail/codex-runs/f2734676-8a7b-4ad4-8ac8-4d0b5b2a7d5c/tmp`):

```sh
timeout --signal=INT --kill-after=5s 60s env FLUTTER_ALREADY_LOCKED=true /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 --reporter=expanded test/handrail_timeline_reply_reference_test.dart test/timeline_controller_test.dart test/message_context_controller_test.dart > /opt/handrail/.handrail/codex-runs/f2734676-8a7b-4ad4-8ac8-4d0b5b2a7d5c/tmp/reply-render-focused-tests.log 2>&1
/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart analyze lib/src/handrail_message_timeline.dart lib/src/chat_widget_builders.dart lib/src/core/timeline_controller.dart test/handrail_timeline_reply_reference_test.dart > /opt/handrail/.handrail/codex-runs/f2734676-8a7b-4ad4-8ac8-4d0b5b2a7d5c/tmp/reply-render-analysis.log 2>&1
```

Results: **58 tests passed, exit 0 (16 new widget tests, 7 existing timeline
controller tests, 35 source-context controller tests). Scoped analysis: no
issues, exit 0**, covering every production file touched and the new test file.
Final analysis also verifies three test-only brace lint corrections following
the passing test run. HTTP transport is the controlled service boundary; actual
client, query parsing, timeline and context controllers, normalized state and
durable event reduction are exercised. No persistence implementation changed.

The widget tests cover authorized current author/text, shared ownership and
rebuilds, no-authority behavior and later host authorization, legacy builder
construction, initially unloaded jump/focus and return offset, exclusive bounded
cursors, Enter/Space on a mounted original, nonrecursive source ancestry and
forward-attribution exclusion, lookup and page failures/retry, deleted and
unavailable placeholders, deletion during a pending lookup, private-parent
revocation during lookup and an open window with stale completions, identity
invalidation of custom builder input/retained callbacks, source replacement, and
320-pixel width with 2.5x text without overflow. No command other than GET is
issued by source navigation; the original remains absent from normalized state.

An expanded attempt also included `test/handrail_message_timeline_test.dart` and
`test/chat_widget_builders_test.dart`. It stalled in the first existing timeline
test, `opens cold chat at unread 1`, and was interrupted (exit 130); it did not
reach the builder suite. To distinguish this from a rendering regression, the
worker wrote temporary copies of the starting-HEAD timeline and existing test,
with the test importing that original timeline through its package URI, then ran:

```sh
timeout --signal=INT --kill-after=5s 35s env FLUTTER_ALREADY_LOCKED=true /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 --reporter=expanded test/.reply_render_baseline_test.dart --plain-name 'opens cold chat at unread 1' > /opt/handrail/.handrail/codex-runs/f2734676-8a7b-4ad4-8ac8-4d0b5b2a7d5c/tmp/reply-render-baseline-test.log 2>&1
```

The starting timeline also stalled at that test and timed out, exit 124. Those
temporary files were removed. This is a pre-existing broader widget-harness
limitation, not a passing regression claim; it does not block the independently
passing selected-item tests. The new fixture follows the composer's existing
pattern of draining both fake widget time and the real cancellation async zone.

Initial local failures were corrected: fixture scope/cancellation setup, source
deletion fixture normalization, semantics-handle cleanup, two additional test
fixture/finder mistakes, a merged reference semantics label and narrow-dialog
heading overflow. Flutter emitted nonfatal read-only `libimobiledevice.stamp`
and `libusbmuxd.stamp` warnings, consistent with prerequisite validation. No
unusual memory consumption was observed; the only prolonged runs were the
documented stalled tests.

From repository root, scoped whitespace validation:

```sh
git diff --check 93712df4e6dccb6cf1c2e1983343f6e42f33d2ea -- flutter/handrail_chat/lib/src/handrail_message_timeline.dart flutter/handrail_chat/lib/src/chat_widget_builders.dart flutter/handrail_chat/lib/src/core/timeline_controller.dart flutter/handrail_chat/test/handrail_timeline_reply_reference_test.dart docs/validation/flutter-reply-reference-rendering.md
```

No generated contracts/templates needed changes. No preview-repository edits,
QA campaign, provider calls, external sends, deployment, PR, database or queue
mutation occurred. Only the explicitly authorized Owner Task item ledger was
updated. The broader convergence goal and remaining sibling tasks are not
completed by this item.
