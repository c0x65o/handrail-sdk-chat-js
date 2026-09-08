# Flutter named-thread creation and canonical headers

Owner task item `e39828c5-6855-4491-8210-b18d0abeb024`, Owner Goal
`0175981e-9e78-4a38-900a-e1148040c0a2`. Verified 2026-09-07.

## Behavior and exact changed paths

- `flutter/handrail_chat/lib/src/handrail_named_thread_dialog.dart` (new):
  internal, scrollable Material name dialog with autofocus, labelled input,
  keyboard submission, live error/status semantics and cancellation. It calls
  the public `validateThreadConversationName` without trimming, normalization,
  grapheme limits or a separate length contract. The first validated submission
  calls `threads.forRoot(root).create(name: ..., initialFollow: true)`; Retry
  calls that controller's `retry()`. The name becomes read-only after submission,
  preserving the frozen request and idempotency key. Cancel permits a new intent.
  Eligibility and negotiated capability are checked again at submission.
- `flutter/handrail_chat/lib/src/handrail_message_timeline.dart`: adds optional
  `onCreateThreadRequested` using the existing public `HandrailThreadRequested`
  callback type. Explicit Create Thread/Open Thread is independent of Reply in
  both styles. Creation requires negotiated `ChatReplyThreadFeatures.namedThreads`
  and a handler; unavailable states have visible explanations. Canonical existing
  roots retain Open Thread even with naming disabled. Deleted/optimistic sources
  cannot create, and nested named creation is excluded. Existing reply-count
  controls, custom message builders and settled inline Reply routing remain.
  Controller-only fallback opening now releases the otherwise discarded retain.
- `flutter/handrail_chat/lib/src/handrail_chat_workspace.dart`: wires the dialog
  without replacing or modifying the composer. Known existing thread IDs open
  through `threads.openExistingThread`, including when a root summary disappears;
  fresh authorization failures show a recoverable message rather than opening
  from cached identity. Unnamed Current Reply creation remains available. Server
  reconciliation determines the canonical ID/name, never a client rename.
  Duplicate activation, route dismissal, conversation/client changes, disposal,
  delayed results and delayed/throwing host delegates release acquired retains.
  Host delegates still receive IDs; caller ownership remains unchanged. Closing
  a panel does not change follow, membership, lifecycle or notification state.
- `flutter/handrail_chat/lib/src/handrail_thread_view.dart`: default header shows
  the returned canonical name or `Thread` for legacy records. Root context shows
  the parent channel name (or safe direct/group labels) only while the public
  parent controller is ready. Missing/deleted/revoked roots use safe placeholders.
  Existing-read handles use their explicit authorized root context, never cached
  content as a replacement for unavailable context. Custom title/root/message/
  attachment builders remain supported. Supplied handles remain caller-owned.
- `flutter/handrail_chat/test/handrail_named_thread_cases.dart` (new): 18 widget
  cases sharing the established workspace HTTP boundary and controller fixtures.
- `flutter/handrail_chat/test/handrail_chat_workspace_test.dart`: registers the
  new test part and adds canonical thread detail to the existing HTTP fixture.
- `docs/validation/flutter-named-thread-creation.md` (this evidence).

Current Reply still opens a separate root discussion. Discord-style Reply still
selects a reference in the current conversation and sends there. Either style
can independently create a named discussion or open the same canonical existing
thread. Preference switches never rename discussions or move messages.

## Verification

Run sequentially from `flutter/handrail_chat` using installed Flutter artifacts:

```sh
FLUTTER_ALREADY_LOCKED=true timeout 90s /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 --reporter=expanded test/handrail_chat_workspace_test.dart --name 'named thread|reply routing|settings'
/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart analyze lib/src/handrail_chat_workspace.dart lib/src/handrail_message_timeline.dart lib/src/handrail_thread_view.dart lib/src/handrail_named_thread_dialog.dart
```

Results: **36 widget tests passed, exit 0** (18 new named-thread cases, 15 settled
Reply routing cases, 3 settings cases). **Scoped analysis: no issues, exit 0**.
The same focused widget command was rerun after final mounted checks/formatting.

From the repository root:

```sh
git diff --check -- flutter/handrail_chat/lib/src/handrail_chat_workspace.dart flutter/handrail_chat/lib/src/handrail_message_timeline.dart flutter/handrail_chat/lib/src/handrail_thread_view.dart flutter/handrail_chat/lib/src/handrail_named_thread_dialog.dart flutter/handrail_chat/test/handrail_chat_workspace_test.dart flutter/handrail_chat/test/handrail_named_thread_cases.dart docs/validation/flutter-named-thread-creation.md
```

Result: exit 0, no whitespace errors. New files were also checked directly for
trailing whitespace. Formatting was limited to new files and changed regions of
the three existing production widgets.

Coverage includes exact named payload and initial follow; canonical existing-root
reconciliation without rename; 100 supplementary scalars versus 101; empty and
contract whitespace boundaries; unpaired-surrogate rejection via the actual form
validator (Flutter's renderer rejects malformed UTF-16 before it can be painted);
frozen retry versus distinct new intent keys; failed/cancelled text, attachment
and reply/ping drafts; duplicate submission; cancellation/conversation change/
disposal during pending creation; last-retain release back to idle; delegated
navigation, delegate errors and disposal before a delegate returns; Current
entry points; Discord in-place sends in channels/DMs/groups/threads; unavailable
capability; nested/optimistic/deleted creation exclusion; canonical/legacy/custom
headers; parent denial and root deletion; caller ownership; compact success and
cancel; focus, keyboard activation and semantics. Existing settings cases retain
both composer identities, attachments and frozen queued-send payloads across
style switches at wide and compact sizes.

Development iterations corrected test fixture/timing issues and scoped lints.
Two test invocations initially ran from the repository root and exited 1 because
there was no pubspec there; subsequent commands above used the package directory.
An initial analysis caught a non-const Semantics constructor, corrected before
passing validation. An initial test compile caught a TextFormField inspection
and FutureOr fixture return, both corrected. A pending-handle assertion was
corrected to expect idle after last release, and a transition assertion now waits
for dialog dismissal. Parent-denial coverage led to explicitly reauthorizing
known threads even when their root summary disappears.

Flutter printed the documented nonfatal read-only `libimobiledevice.stamp` and
`libusbmuxd.stamp` warnings. The resource guard briefly queued analysis behind
other heavy commands; no resource-exhaustion failure occurred. One early failed
analysis reported 740 MiB peak, no swap and no OOM kills. Broad timeline/thread
suites were not rerun: their pre-existing first-test stalls are documented in
`flutter-reply-style-routing.md`; focused coverage above completes this item.

## Ownership, boundaries and limits

Initial/final observed SDK branch `main`, HEAD
`c41d76931ccbd48c5c1b5ff6dc0788d00530ddd8`. The pre-existing deleted temporary
Reply-routing baseline source/test and untracked Reply-routing validation note
were preserved. Concurrent React implementation/test/document changes were
preserved. Start/progress ledger updates recorded concrete overlap with waiting
Flutter discovery item `0229b15a-aff5-4946-8085-edfcdc1939b9` (workspace) and
lifecycle item `f8a23c14-6e9c-4216-8254-271636a1d2b5` (thread view). This worker
implemented neither sibling scope and observed no sibling Flutter edits.

Cancellation closes local UI; it cannot undo a creation request already accepted
by the server. Late successful responses are reconciled by the controller and
any UI retain is released. A later Open Thread reuses the canonical discussion.
Names are frozen for Retry; editing requires cancelling and starting a new intent.
The naming capability is separate from authorization, which remains enforced by
server commands/reads. No client-side permission expansion was added.

Parent labels require an already-ready parent projection; otherwise the safe
unavailable label is shown. Existing-thread root reads retain the prerequisite
controller's 50-message bound. Missing older roots therefore remain unavailable,
and authorized existing-read handles without attachment metadata do not invent
attachment previews. No new persistent navigation, discovery, participation or
lifecycle UI was added.

Verification uses HTTP service-boundary fixtures and real public controllers,
not a simulated SQL database. No SQL, generated descriptors/outputs, TypeScript
production files or dependency pins were changed by this worker, so SQL harness,
regeneration and TypeScript compilation were unnecessary. No preview edits,
provider calls, external sends, deployed/browser QA, QA campaign, deployment,
CI/CD mutation, commit, push or PR was performed. The patch remains uncommitted.
