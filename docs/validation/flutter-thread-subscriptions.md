# Flutter thread subscriptions

Owner Task item `c83d9e52-71d8-4d29-97c2-aa951efd8009`, verified 2026-09-07.
Repository implementation and deterministic local verification only.

## Behavior

`HandrailThreadView` now has a **Thread subscriptions** popup in its header.
Current style (including the absent-setting default) shows Follow/Unfollow;
the existing reply-style runtime's effective Discord style shows Join/Leave.
Both dispatch exactly the public thread follow controller's follow/unfollow
commands. Changing style while the view is open updates the labels and keeps
the mounted composer and thread destination.

Notifications offer all, mentions and none independently of Unmute, Mute
indefinitely and Mute for 1 hour. Timed mute uses the existing UTC expiry
contract; an unrelated notification save retains its exact existing expiry.
Saves patch only the chosen field onto the latest authoritative conversation
preference, preserving isStarred and the other delivery fields. Missing
canonical preferences disable preference writes and offer explicit loading
retry. No replacement defaults are synthesized by this menu.

Confirmed state supplies the displayed selection, including while optimistic
writes are pending. Local and controller pending state disable duplicate writes.
Conflicts reconcile through the public commands and require explicit retry.
Retry reissues the selected action against current confirmed state/revision;
it does not replay an obsolete full preference record. The public controller
continues to own command keys, reconciliation and any configured recovery queue.
The UI does not implement another queue or retry pending recovery work.

Loading, saving, sanitized failures and conflict/retry guidance are announced
by a live region. A single visible status line fits compact layouts; its full
text is available through semantics and a tooltip. Material popup keyboard
navigation, selected-choice semantics/checkmarks, and focus return are retained.

The private menu state is keyed by client and thread. It cancels its stream
listeners on disposal, rejects old popup callbacks, and ignores late results.
It never disposes client-owned controllers. Leave only unfollows: it does not
call membership leave, close navigation, release handles, clear drafts, advance
read cursors, reset unread state, change send destination or modify authority.
Existing shared lifecycle controls, Close panel, root context, and the mounted
composer remain in place.

## Files changed by this item

- `flutter/handrail_chat/lib/src/handrail_thread_view.dart`: header integration
  and private subscription widget using existing public APIs.
- `flutter/handrail_chat/test/handrail_thread_view_test.dart`: register the new
  cases and add narrow HTTP follow/preference response hooks to its harness.
- `flutter/handrail_chat/test/handrail_thread_subscription_cases.dart`: nine
  focused widget tests using actual public controllers and command dispatch.
- `docs/validation/flutter-thread-subscriptions.md`: this evidence.
- `build/flutter-thread-subscriptions-test.log`: final test output.

The pre-existing lifecycle changes in the first two files were extended and
preserved. The existing untracked lifecycle cases and lifecycle validation note,
other SDK work, React changes and preview repository were not edited by this item.
No generated contracts changed, so no generation was needed.

## Verification

Run sequentially from `flutter/handrail_chat`, using the installed invocation
from `docs/validation/flutter-thread-view-lifecycle.md`:

```sh
FLUTTER_ALREADY_LOCKED=true /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 test/handrail_thread_view_test.dart > ../../build/flutter-thread-subscriptions-test.log 2>&1
/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart analyze lib/src/handrail_thread_view.dart
```

Results: **31 tests passed, exit 0** (nine new subscription cases plus the 22
existing opening/lifecycle cases). Production analysis: **No issues found,
exit 0**. The subscription-only iteration used the same test command with
`--plain-name subscriptions`: **9 passed, exit 0** before adding keyboard/focus
assertions to the compact Leave case, also passed in the final full file run.

New coverage proves:

- Absent, explicit Current and Discord labels; exact follow/unfollow intents
  and thread targets; live style switching without composer replacement.
- All notification and mute choices, retained stars and exact existing timed
  expiry, plus one-hour expiry bounds.
- Optimistic saving state, disabled duplicate actions and confirmed selection;
  follow and preference conflicts with explicit retry using newer revisions.
- Conflict retry retains subsequently reconciled unrelated preferences.
- Missing canonical state after a public persisted-cache reset disables writes;
  loading, failed loading and successful explicit retry, then failed/retried mute.
- Keyboard-operated failed Leave and explicit retry at 240 logical pixels,
  accessible status/actions and focus return; unchanged persisted draft,
  composer identity/destination, read cursor/manual marker, nonzero unread count,
  preference record, root context and caller-owned handle; no other write route.
- Stale popup callback rejection, client replacement and unmount with late
  results; client-owned follow controllers remain usable.

An initial extra status row overflowed existing rich-draft lifecycle fixtures;
the final menu shares the header and limits visible status to one line. All
existing lifecycle cases pass after that correction. Earlier fixture issues
(timestamp clock, nested snapshot shape, asynchronous menu settling and semantics
handle teardown) were corrected. Two early shell attempts used the repository
root with a package-relative log path and failed before launching Flutter; the
commands above use the correct package working directory.

Flutter emitted the same non-fatal read-only `libimobiledevice.stamp` and
`libusbmuxd.stamp` warnings documented by the lifecycle item. Tooling completed
successfully. No unusual resource consumption was observed.

From repository root:

```sh
git diff --check -- flutter/handrail_chat/lib/src/handrail_thread_view.dart flutter/handrail_chat/test/handrail_thread_view_test.dart
git diff --no-index --check -- /dev/null flutter/handrail_chat/test/handrail_thread_subscription_cases.dart
git diff --no-index --check -- /dev/null docs/validation/flutter-thread-subscriptions.md
```

Tracked check: exit 0. New-file checks: exit 1 because files differ from
`/dev/null`, with no whitespace diagnostics.

The harness fakes only HTTP responses and uses the real normalized store,
controllers and commands. It does not prove SQL persistence or live delivery.
No SQL change/test, TypeScript compile, preview/device QA, QA campaign, provider
operation, deployment, CI/CD mutation, commit, push or PR was needed or performed.
