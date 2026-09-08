# Flutter reply-style settings: local verification

Owner item `0ec01550-f55f-490a-a789-36bc72fd4a2d`, Owner Goal
`0175981e-9e78-4a38-900a-e1148040c0a2`. Verified locally on 2026-09-07 UTC
(2026-09-06 America/Chicago), against SDK HEAD
`39c194f15a5d0f51faa521ba9c94e3c321fbf282` with the existing uncommitted
prerequisites preserved. This patch is uncommitted.

## Implementation

`HandrailReplyStyleSettings` is exported from `package:handrail_chat/ui.dart`.
Hosts can embed it with their existing, initialized client's authenticated scope:

```dart
HandrailReplyStyleSettings(client: ChatScope.of(context).client)
```

The widget observes `client.replyStyles` and public lifecycle metadata. Client
initialization, authenticated identity, authoritative reads, precedence, writes,
reconnect synchronization and runtime lifetime remain client responsibilities.
No preference storage, transport, runtime or policy resolution was added.
Subscriptions detach on client replacement and widget disposal without disposing
client-owned objects.

The control uses the shared React wording **Reply and thread style**, **Current**
and **Discord-style**. Current Reply opens a separate thread; Discord-style Reply
references a message in the current conversation, with Create/Open Thread a
separate action. The control explains tenant + user scope and future-action-only
changes. This patch does not implement timeline routing, named-thread creation,
discovery or lifecycle controls; those remain sibling items.

Effective style and origin come directly from runtime state. The widget separately
shows provisional/unresolved reads, confirmed absence, differing saved choices,
unsupported values, requested unconfirmed choices, saving, safe errors and explicit
read-refresh/save-retry controls. Host enforcement locks editing without overwriting
the saved choice; a host default alone remains editable. Saving support is separate
from `ChatReplyThreadFeatures.inlineReplies` and `.namedThreads`, using public
negotiated metadata. Missing action capabilities explain limitations without
turning Discord Reply into a thread action.

Workspace settings are an additive icon in the conversation header, compact panel
header, channel navigation or empty workspace. Existing controls remain in their
surfaces; Close panel stays at the trailing edge. A scrollable Material dialog
retains the underlying conversation/composer/thread subtree. It does not call
`_openPanel` or `_closePanel`, which release thread handles. Close/Escape return
focus to the trigger. Removing the workspace or replacing its bound client dismisses
its dialog. The standalone widget cancels its subscriptions on client changes.

## Focused checks

Run sequentially from `flutter/handrail_chat`, with one test worker:

```sh
FLUTTER_ALREADY_LOCKED=true /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 --reporter=expanded test/handrail_reply_style_settings_test.dart
FLUTTER_ALREADY_LOCKED=true /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 --reporter=expanded test/handrail_chat_workspace_test.dart --name settings
/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart analyze lib/src/handrail_reply_style_settings.dart lib/src/handrail_chat_workspace.dart lib/ui.dart
```

- Settings suite: **10 widget tests passed, exit 0**. Covers saved selection and
  new-client reload; absent/default/explicit Current behavior; loading and failed
  read recovery; failed save retaining confirmed state and exact-input explicit
  retry; override and differing saved choice; unsupported values; independent
  preference/action capabilities; rebinding/disposal; 320-pixel width at 2x text
  scale with radio semantics and Tab/Space selection.
- Workspace settings subset: **3 widget tests passed, exit 0**. At wide (1100)
  and compact (390) workspace widths, opening settings and switching in both
  directions retain actual composer elements, displayed text and attachments,
  reply targets and false ping, active conversation, the same unreleased thread
  handle and parent/root context, both queued destination requests and their exact
  encoded storage record. Settings initiate no extra message sends or thread
  creation. Enter opens settings; Escape restores trigger focus. The third test
  checks the empty-workspace trigger, a 320-pixel/2x-text dialog, Close settings,
  accessible tooltip, and removing a workspace while its dialog is open.
- Scoped production analysis: **exit 0, no issues**. Two targeted deprecation
  suppressions retain the package's Flutter 3.19 minimum; adopting RadioGroup
  would require a newer minimum. No SDK upgrade was introduced.
- Scoped `git diff --check`: **exit 0**.

These tests reuse existing preference HTTP, workspace HTTP, realtime socket and
`InMemoryApplicationChatStorage` boundaries. They exercise real widget/client
state and encoded queue preservation, not SQL durability. The workspace fixture
normalizes the existing list's actor/tenant to its authenticated session. Queued
sends originate offline and remain retained; pumps are paused before opening
settings, after the normal ChatScope foreground binding. The style operation is
not permitted to initiate or modify those sends.

## Validation limits and development corrections

The installed Flutter tool snapshot successfully ran the Flutter engine/widget
harness. It emitted nonfatal read-only `libimobiledevice.stamp` and
`libusbmuxd.stamp` warnings. This is widget-test evidence, not a pure-Dart fallback.

An expanded check was also attempted:

```sh
FLUTTER_ALREADY_LOCKED=true timeout 60s /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 --reporter=expanded test/handrail_chat_workspace_test.dart --name 'settings|supports 320px|keeps keyboard|opens a thread panel'
```

It passed the three settings cases, then stalled on the existing
`supports 320px workspace navigation at 200 percent text scale` test and exited
**124** at the imposed limit. A prior whole-workspace attempt likewise stalled
on the existing negotiated-search case and was interrupted (exit 130). These
broader tests are **not claimed passed**; they do not invalidate the completed
focused settings acceptance. No whole-feature convergence or global checks are
claimed.

Development runs corrected test teardown that waited without advancing Flutter's
fake clock (interrupted, exit 130), fixture actor/tenant alignment and the fixture's
existing-thread badge versus Reply selector. Accessibility assertions were adjusted
to read radio semantics and the IconButton's tooltip, and to pump/dispose semantics
handles explicitly. A Flutter invocation from the repository root exited 1 before testing.
All newly added tests pass in the final commands above.

No preview-repository edits, canonical/generated contract changes, commits, pushes,
PRs, deployment, provider sends, database operations or QA campaigns were performed.
Only the explicitly required Owner Task MCP ledger updates were used.
