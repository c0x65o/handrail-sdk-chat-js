# Flutter Timeline Lab reply-style scenario

Owner Task `6cc9896a-0290-435f-8ac9-295d943d6552`, verified 2026-09-07.
SDK main started at `e14618bd39933a7d7ab57240dc460226dcd2eef2`.
This is **deterministic fixture/widget evidence**, not backend authorization,
live persistence, Mobile Preview, device validation, or live QA proof.

## Public configuration

The dependent preview launcher can import the existing example package and opt
in without changing the SDK widgets:

```dart
import 'package:handrail_message_timeline_lab/main.dart';

// Own this once in the host's State. Retain it across actor changes/recreation.
final replies = TimelineLabReplyStyleScenario();

// Give a recreated app a new key; constructor configuration is mount-time.
HandrailTimelineLabApp(
  key: ValueKey('reply-lab-bob-1'),
  replyStyleScenario: replies,
  replyActor: TimelineLabReplyActor.bob,
  onTransportRequest: recordFixtureRequest,
);
```

Use `TimelineLabReplyActor.alice` for Alice. Alice starts with saved **Current**;
Bob starts with saved **Discord-style**. `replyStyleScenario: null` (the default)
preserves the existing constructor, fixtures, controls and legacy behavior.
Existing no-argument `HandrailTimelineLabPreview` callers remain compatible.
No preview checkout or launcher was edited.

**Current Reply opens the source's separate thread. Discord-style Reply keeps
composition and the send in the current conversation, with a reference to the
source message.** It sends canonical `replyTo`, not a forward snapshot. Explicit
Create Thread/Open Thread remains independent of Reply and the saved style.
An existing named **Launch planning** discussion has retained history. One
additional message-rooted discussion can be created; its canonical root/thread
identity and original name survive repeated opening/creation by either actor.

The example uses production `HandrailChatWorkspace`, settings, composer,
message timeline/reference, discovery, thread lifecycle and subscriptions UI.
Preferences are actor-scoped fixture responses. Changing Bob's setting does not
change Alice's choice, conversation IDs or shared history. Fixture capability
advertisement is opt-in and uses the generated handshake feature constants.
Lifecycle and message-context authority are explicitly configured on the
existing client controllers, following the host integration documentation.

## Fixture and storage boundaries

`example/lib/reply_style_scenario.dart` is a part of the existing lab, intercepting
its HTTP boundary. Generated request/result models validate handshake metadata,
style preferences, source context, thread discovery (including bounded cursor
pages), named creation, lifecycle, follow, conversation preference, draft, read
cursor and send responses. No generated source, descriptor or template changed.
No generation was necessary.

The fixture holds two named/creatable thread identities, at most 50 authored
messages per scripted stream, actor preferences and the latest canonical private
draft event per actor/conversation. It is not a SQL repository, database,
authorization implementation or notification engine. Only explicit close/reopen
lifecycle writes are scripted; lock/unlock and full permission, notification,
replay/conflict and automatic inactivity/reopen matrices belong to existing
server/controller coverage. The old lab's unrelated controls remain available.

`TimelineLabReplyStyleScenario.storage` defaults to the existing
`InMemoryApplicationChatStorage`; hosts/tests may provide an existing
`ApplicationChatStorage`. Tenant/user/device scopes remain separate. The lab
waits for SDK initialization/storage restoration before mounting the scenario.
Draft mutations also emit the generated private durable event so canonical draft
snapshots are checkpointed. On recreation the fixture replays the latest
canonical draft through public `client.reconcileDraftEvent`, restoring the
existing draft runtime's projection. Neither the example nor its test creates
another send queue or serializes custom queue records.

The recreation test unmounts and disposes clients and creates new ones. It reads
the canonical normalized storage record, verifies restored text/reference/false
notify-author choice, and uses the existing fake realtime socket/network to
establish a session and then go offline. The public `client.sendMessage` hook
queues using the restored production composer's reply context. A subsequent
client restores that exact queued request, including IDs, destination and reply
metadata; switching style and opening another thread do not retarget it.

This is **public runtime queue-hook coverage**, not offline Send-button coverage.
An exploratory offline Send-button attempt waited for the production composer's
pre-send draft synchronization (`handrail_message_composer.dart`); the SDK was
left untouched. This is a separate production follow-up observation, not a
blocker to this example/storage-hook item. The offline retained draft then
survives another recreation using the SDK's existing draft storage/recovery.
Saved style reads and canonical draft-event replay use the retained fixture
instance; destroying that instance/process does not demonstrate durable backend
persistence or a browser restart.

## Verification

Commands ran sequentially, with one Flutter test worker. From
`flutter/handrail_chat/example`:

```sh
FLUTTER_ALREADY_LOCKED=true /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 test/timeline_lab_test.dart > ../../../build/flutter-timeline-reply-full-tests.log 2>&1
FLUTTER_ALREADY_LOCKED=true /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 test/timeline_lab_test.dart --plain-name 'reply scenario:' > ../../../build/flutter-timeline-reply-scenario-tests.log 2>&1
```

Full file: **38 passed, exit 0**, including the four new scenario cases and
existing legacy thread, send/retry, huddle/media, reminder, membership and
conversation controls. The final focused rerun includes the additional fresh
client repeat-creation assertion: **4 passed, exit 0**.

The four focused cases cover:

- Alice posts “Which launch date?”; Bob uses the real Reply/composer widgets to
  send “Friday” in the channel. The HTTP request and canonical event/store retain
  the source reference, the source text renders through the context endpoint,
  and there are zero create-thread requests for inline Reply.
- Named creation carries the requested name; reopening and fresh-client repeated
  creation preserve the canonical root, thread ID and original name. Alice's
  Current preference and shared Friday message remain intact.
- Current Reply on a new root opens its canonical separate thread, without a
  requested name.
- Settings switches and real client recreation preserve the saved choice,
  draft/reference/false ping and exact SDK queued-send request. At **480 × 1100**,
  production discovery opens the named history; Join, close/reopen and Leave
  preserve the mounted composer and draft. Sending after Leave still targets
  that thread and history remains visible.

From the SDK repository root:

```sh
/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart analyze flutter/handrail_chat/example/lib/main.dart flutter/handrail_chat/example/lib/reply_style_scenario.dart flutter/handrail_chat/example/test/timeline_lab_test.dart > build/flutter-timeline-reply-analysis.log 2>&1
git diff --check -- flutter/handrail_chat/example/lib/main.dart flutter/handrail_chat/example/test/timeline_lab_test.dart
git diff --no-index --check -- /dev/null flutter/handrail_chat/example/lib/reply_style_scenario.dart
git diff --no-index --check -- /dev/null docs/validation/flutter-timeline-reply-styles.md
```

Scoped Dart analysis: **No issues found, exit 0**. No production Dart file was
edited. Tracked whitespace check: exit 0. New-file no-index checks return exit 1
because the files differ from `/dev/null`, with no whitespace diagnostics.
Only new Dart code/edited initializer snippets were formatted; no format-all or
autofix touched sibling files.

Earlier focused iterations corrected fixture wire shapes (timeline root flags
and the separate discovery follow envelope), API/type names, widget timing,
initialization/disposal ordering and private draft-event replay. One early edit
command and a later log read used a package working directory with root-relative
paths; both path errors were corrected. A 390px exploratory run exposed a
pre-existing overflow in untouched `handrail_channel_header.dart:293` with the
workspace action controls. This item proves the 480px layout, not 390px. No
production header fix or expanded QA campaign was attempted.

Flutter reported non-fatal read-only `libimobiledevice.stamp` and
`libusbmuxd.stamp` warnings, as documented by earlier Flutter validation items.
Analysis iterations peaked around 712–782 MiB with zero OOM kills; no unusual
resource consumption was observed. Checks finished normally after correcting
the reported source errors.

No SQL behavior changed, so no database harness was needed. No TypeScript source,
preview repository, production SDK file, deployment, provider integration,
external send, runtime configuration, QA campaign, commit, push or PR was changed
or invoked. The verified patch is intentionally uncommitted; sibling dirty work
was preserved.
