# Flutter inline reply composer validation

Owner Task item: `758248a4-5d29-4d24-9d76-4269d2d57c86`.

## Result and integration

Current Reply-to-thread routing remains sibling-owned. The composer now supports
an inline reference: sending stays in its existing conversation, including an
existing thread, without opening or creating a thread. Reply metadata is separate
from editable `MessageContent` and forwarding snapshots. This widget creates new
messages only; it does not expose message editing or rewrite existing ancestry.

Use a `GlobalKey<HandrailMessageComposerState>` to call
`selectReply(MessageContextRequest(conversationId: ..., messageId: ...))`.
It returns false for another conversation or when interaction is unavailable.
A fresh selection defaults `notifyAuthor` to true. `setReplyNotifyAuthor(false)`
records the explicit false choice; `cancelReply()` removes only the reference.
`replyTo` exposes the current immutable reference. The optional `replyBuilder`
receives `HandrailMessageComposerReplyControls`, containing the current reference,
authorized context snapshot and nullable ping/cancel/retry callbacks. Standard
controls include screen-reader labels and return focus to the input after
selection, ping changes, cancellation, lookup retry and send failure.

Configure `client.messageContexts.forMessage(request).setAuthority(...)` at the
host's shared ownership boundary, as documented in
[Flutter message context validation](flutter-message-context.md). The composer
only attaches/detaches its subscription: it does not assign authority or dispose
a controller shared with the timeline. Hosts must update authority when their
external token-provider identity/access changes, and bind composition to the
appropriate identity's client. Missing authority produces an unavailable preview.
Every rebuild reads the controller's current snapshot. Deleted, revoked, failed,
or identity-invalidated context cannot retain source text in the strip. Lookup
retry reauthorizes through the existing controller. The durable draft contains
only the reference, never source text.

Draft restoration, equality and empty-draft handling include `replyTo`. A
reference-only draft persists, including ping-only changes. Cancellation preserves
text, mentions and attachments. Rebuilds and remount restoration preserve explicit
false ping. Style/settings implementation remains a sibling: the tests exercise
presentation rebuilds and draft remounting without depending on that setting.

Submission captures the original client, conversation controller, typed
`ChatSendMessageInput`, and editable draft before asynchronous work. It schedules
that draft through the real durable runtime before sending. Retry retains the
captured content/destination/reference; deliberate edits create a new composition.
Generation guards prevent old completions from changing a rebound composer or
newer host edits. Successful sends clear only the matching original draft using
its captured revision. A newer remote draft remains durable and is displayed.
Rejected source sends retain the reference and attachments for retry or explicit
revision; no fallback strips the reference or creates a thread.

## Verification

Run sequentially from `flutter/handrail_chat`:

```sh
/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart format lib/src/handrail_message_composer.dart test/handrail_message_composer_test.dart
FLUTTER_ALREADY_LOCKED=true /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 --reporter=expanded test/handrail_message_composer_test.dart test/composer_rich_text_test.dart test/draft_runtime_test.dart > /opt/handrail/.handrail/codex-runs/6fc00173-7c67-4968-8435-5c5cc48cdca4/tmp/composer-final-tests.log 2>&1
/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart analyze lib/src/handrail_message_composer.dart
```

Results: **80 tests passed, exit 0; scoped production analysis: no issues, exit 0**.
The composer file contains 29 widget tests, including 12 new reply/race cases.
The harness exercises the real client command/query parsers and durable draft
runtime, with controlled HTTP/attachment boundaries. Tests cover target-only and
ping-only drafts, false-ping restoration, cancellation retaining attachments,
existing-thread sends/retries, no thread-creation HTTP request, rebinding during
both successful and failed pending sends, host edits during pending sends, newer
remote drafts, source lookup failure/retry, deleted/unavailable/revoked/changed
identity previews, late lookup invalidation, custom typed controls, semantics,
keyboard activation and focus recovery. Existing ordinary send, formatting,
attachment, mention and lifecycle tests also pass.

The widget harness drains both the fake widget clock and real asynchronous zone
for cancellation futures, and unmounts consumers before awaiting client teardown.
Development runs identified and corrected fixture constructor/timing issues and
the newer-remote-draft UI gap. Stalled development teardown runs were explicitly
interrupted (exit 130); these were not resource exhaustion failures. Flutter
emitted nonfatal read-only `libimobiledevice.stamp` and `libusbmuxd.stamp` warnings.
Final tests completed successfully. No SQL or database behavior changed, so no
PostgreSQL check was required. These are deterministic repository tests, not
mobile/deployed QA.

From repository root:

```sh
git diff --check -- flutter/handrail_chat/lib/src/handrail_message_composer.dart flutter/handrail_chat/test/handrail_message_composer_test.dart docs/validation/flutter-inline-reply-composer.md
```

Result: exit 0.

## Files and shared workspace evidence

Worker-authored files:

- `flutter/handrail_chat/lib/src/handrail_message_composer.dart`
- `flutter/handrail_chat/test/handrail_message_composer_test.dart`
- `docs/validation/flutter-inline-reply-composer.md`

Initial verified HEAD was `509e29fa68e6257a583b859588832984e326dced`, with the
handoff's sibling changes present. No shared client, timeline, core export,
canonical descriptor or generated file was edited by this worker. Existing
prerequisite APIs sufficed; no generation was needed.

During validation the checkout advanced externally to
`93712df4e6dccb6cf1c2e1983343f6e42f33d2ea`, whose commit includes earlier composer
edits. This worker ran no Git commit, push, staging or finalization commands and
did not undo that external checkpoint. Subsequent edits and this note remain
uncommitted at the final inspection. Compare the three paths against the initial
HEAD to review the full worker change, rather than relying only on the remaining
working-tree diff. Sibling work was preserved.

No preview repository, saved-setting implementation, timeline action routing,
thread navigation, database, deployment, provider, external send or QA campaign
was changed or invoked. Completion applies only to the selected composer item.
