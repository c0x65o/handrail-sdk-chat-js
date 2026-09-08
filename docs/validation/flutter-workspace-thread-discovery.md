# Flutter channel thread discovery

Owner item `0229b15a-aff5-4946-8085-edfcdc1939b9`, Owner Goal
`0175981e-9e78-4a38-900a-e1148040c0a2`. Repository-local verification, 2026-09-07.

## Changed paths and behavior

- `flutter/handrail_chat/lib/src/handrail_thread_list.dart` (new): public list
  backed by `client.threadLists.forParent`. Hosts supply trusted
  `ChatThreadListAuthority`; parent/identity/access changes clear the projection
  and detach old observable deliveries. The widget disposes controllers it
  creates and only cancels its subscription for supplied controllers. It shows
  canonical names (legacy fallback `Thread`), separate Following/Not following
  and unread facts, loading, empty, sanitized recoverable errors, refresh,
  cursor pagination and retry. Active/All chips appear only when the response
  declares `lifecycleSupported`. No membership, follow, lifecycle or creation
  command is issued by the list.
- `flutter/handrail_chat/lib/src/handrail_chat_workspace.dart`: channel header
  entry labelled `Browse channel threads`, available in both styles. It uses
  the public parent's ready authorized snapshot for tenant/user authority and
  parent context; neither child membership nor follow state grants read access.
  Parent/global access loss closes discovery and releases its retained history.
  List/open requests retain the controllers' server authorization checks.
  Selected canonical IDs go exclusively to `threads.openExistingThread`, with
  parent identity validation before the existing `_presentThread` delegate and
  handle safeguards. Dismissal, stale completion, selection/client changes,
  delegate outcomes and disposal release retains.
- Compact navigation keeps the channel composer mounted behind a fullscreen
  panel, retains the list behind an open thread, excludes hidden controls from
  focus, and supports labelled Back buttons, system Back, Escape and keyboard
  row activation. Returning from a thread restores list focus; returning to the
  channel restores trigger focus and the same composer/draft. Wide layouts reuse
  the existing side pane. Settings, search, members, reactions and huddle remain
  wired through the existing workspace panels.
- `flutter/handrail_chat/lib/ui.dart`: public list export.
- `flutter/handrail_chat/test/handrail_thread_discovery_cases.dart` (new): focused
  widget cases using real public controllers and the existing workspace HTTP
  boundary fixtures; no fake SQL repository or alternative discovery controller.
- `flutter/handrail_chat/test/handrail_chat_workspace_test.dart`: only registers
  the new test part and function.
- `docs/validation/flutter-workspace-thread-discovery.md`: this evidence.

Current Reply continues opening a separate root discussion. Discord-style Reply
continues composing a reference in the current conversation. Discovery gives
both styles access to the same canonical histories, including unfollowed named
threads and histories with deleted roots, without creating or following a thread.
Existing `HandrailThreadView` supplies the authorized deleted/unavailable-root
placeholder and canonical history. Its implementation and lifecycle controls
were not edited.

## Validation

Run sequentially from `flutter/handrail_chat`:

```sh
FLUTTER_ALREADY_LOCKED=true timeout 90s /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 --reporter=expanded test/handrail_chat_workspace_test.dart --name 'thread discovery|named thread|reply routing|settings'
/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart analyze lib/src/handrail_thread_list.dart lib/src/handrail_chat_workspace.dart lib/ui.dart
```

Results: **52 widget tests passed, exit 0**. **Scoped Dart analysis: no issues,
exit 0**. **Diff and new-file whitespace checks: passed, exit 0**. Analysis
covers every changed production path.

The selected set contains 16 discovery cases and the 36 prerequisite named-thread,
reply-routing and settings cases. Discovery assertions cover canonical ID reuse,
unfollowed named threads, deleted-root history in both styles, zero create/follow
writes, separate follow/unread facts, legacy names, pagination and failed-page
retry preserving its cursor, Active/All requests and absent capability, initial
failure/empty/denied states, compact semantics/keyboard/back/focus/draft identity,
parent revocation, late list/open results, revoked/changed identity authority,
client replacement, handled/throwing/late host delegates, and caller ownership.

From repository root:

```sh
git diff --check -- flutter/handrail_chat/lib/src/handrail_chat_workspace.dart flutter/handrail_chat/lib/src/handrail_thread_list.dart flutter/handrail_chat/lib/ui.dart flutter/handrail_chat/test/handrail_chat_workspace_test.dart flutter/handrail_chat/test/handrail_thread_discovery_cases.dart docs/validation/flutter-workspace-thread-discovery.md
```

Development iterations corrected fixture timestamp/read/cursor contracts, a
widget finder, compact focus scope, asynchronous test waits and a scoped
formatting regression caught by the header/settings assertions. One initial
analysis reported an incorrect lifecycle getter; corrected to the public
`authoritativeArchived` projection. Two initial check invocations used the repo
root instead of the Flutter package and failed without running checks; the
commands above use the correct package directory. Flutter emits the documented
nonfatal read-only `libimobiledevice.stamp` and `libusbmuxd.stamp` warnings.
The failed getter analysis reported 719 MiB peak, zero swap and zero OOM kills.

## Boundaries and remaining limits

Initial checkout: `main`, HEAD `e14618bd39933a7d7ab57240dc460226dcd2eef2`.
The planner's uncommitted Flutter prerequisites were already committed at this
HEAD. Unrelated React lifecycle tracked/untracked changes were preserved. No
concrete concurrent Flutter file overlap was observed. New files and changed
workspace regions were formatted; no repository-wide autofix was used.

Verification is deterministic widget/controller behavior at the HTTP service
boundary, not deployed QA or server persistence verification. No SQL, generated
contracts/templates, dependencies or TypeScript production code changed, so
PostgreSQL, generation and TypeScript checks are not required for this UI item.
Server authorization, list filtering and existing-thread source lookup bounds
remain the prerequisite implementations. Missing/older inaccessible root context
uses the existing safe placeholder; discovery never falls back to root creation.
No lifecycle UI, React discovery, preview edits, QA campaigns, provider calls,
external sends, deployment, CI/CD mutation, commit, push or PR was performed.
The verified patch is left uncommitted.
