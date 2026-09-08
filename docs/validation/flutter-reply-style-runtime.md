# Flutter reply-style runtime verification

Owner Task `310ce7f0-20bd-4017-b5bf-b271fed2c9f7`, Owner Goal
`0175981e-9e78-4a38-900a-e1148040c0a2`. Local verification on 2026-09-06
(America/Chicago; worker UTC date 2026-09-07). Changes are uncommitted.

## Implementation and public API

- `flutter/handrail_chat/lib/src/core/reply_style_runtime.dart`: client-owned,
  headless preference runtime. `client.replyStyles` exposes current-first
  `states`, `state`, `select(ReplyStyle.current/discord)`, `retry()`, `refresh()`,
  and `configure(ChatReplyStyleConfiguration(...))`.
- `flutter/handrail_chat/lib/src/handrail_chat_client.dart`: narrow constructor,
  initialization, accepted realtime identity/reconnect, private-event dispatch,
  storage identity activation and disposal wiring.
- `flutter/handrail_chat/lib/src/core/conversation_snapshot_query.dart`: one
  diagnostic query name; the existing authenticated query reader performs GET.
- `flutter/handrail_chat/test/reply_style_runtime_test.dart` and
  `flutter/handrail_chat/test/reply_style_client_test.dart`: deterministic HTTP
  and realtime boundary tests, including existing storage-adapter preservation.

The runtime is a library part, so its public types are exported by the existing
`core.dart` client export without adding a second barrel or transport.
Configuration accepts `override` and `defaultStyle` as `ReplyStyle` or raw host
values; unknown present values resolve to Current and stop precedence. Resolution
is override > saved > default > Current. Raw saved values remain intact, including
unsupported strings. Null confirmed state is unresolved; `AbsentReplyStylePreference`
is authoritative absence. Refresh failures preserve confirmed style and disable
ordinary editing until a successful read or authoritative event.

State exposes confirmed preference/revision, effective style/origin,
unsupported-value indication, loading/saving, requested unsaved choice, safe error
messages, retry/edit gates and explanations. `capability` separately reports
unknown/available/unsupported preference API support. It neither establishes
inline-reply support nor bypasses authorization. Host overrides disable ordinary
selection without writing over saved preference.

HTTP-only hosts supply constructor `replyStyleIdentity` from their authenticated
session, or call `replyStyles.activateIdentity(...)` on login/account/tenant
switch; null detaches on logout. Existing storage identity activation also
invalidates the preference scope. Realtime clients use accepted session identity
and metadata automatically, including same-actor reconnects and device changes.
Preference scope is tenant + user; no local preference persistence is introduced.

PATCH uses the existing command dispatcher with automatic transport retries
disabled. Explicit retry reads authority first, then replays the unchanged input
with its original key. A confirmed revision conflict rebases on explicit retry
with a fresh key. Generated parsers validate every echo and HTTP status-specific
result. Exact mutation events can acknowledge a pending write; unrelated updates
cannot. All confirmations use monotonic preference revisions, including old
replays after newer updates. Identity epochs and existing cancellation signals
invalidate old token reads, HTTP reads, writes and retry continuations. Disposal
closes observation and cancels outstanding work.

Current continues to mean Reply-to-thread. Discord-style will mean Reply in the
current conversation, with Create/Open Thread separate. This patch supplies the
saved choice and host policy only; it changes neither action. UI routing,
controls, server capability advertisement and whole-feature readiness remain
separate checklist items.

## Checks

From `flutter/handrail_chat`, using
`/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart`:

```sh
dart analyze lib/src/core/reply_style_runtime.dart lib/src/core/conversation_snapshot_query.dart lib/src/handrail_chat_client.dart
dart test --concurrency=1 --reporter=expanded test/reply_style_runtime_test.dart test/reply_style_client_test.dart test/handrail_chat_client_test.dart test/durable_resource_event_reducer_test.dart
```

Final scoped production analysis: **exit 0, no issues**.
Final four-suite test run: **166 tests passed**, including **116 new runtime/client
cases** and **50 existing client/durable resource reducer regression cases**.
The new cases include 80 precedence combinations; unresolved/absent/unknown and
failed reads; reload and overlapping loads; capability absence/loss/regain and
separation from authentication; same-actor/device reconnect; private event
ordering, duplicate/stale/wrong-actor/wrong-tenant updates; exact response and
event correlation; applied/replayed/no-op/conflict results; offline and failed
save retry; event/response races; account/tenant switches with reads, writes and
retries in flight; logout and disposal.

The preservation test uses the existing `InMemoryApplicationChatStorage` adapter
and controllable HTTP/socket boundaries. It retains a draft with text,
attachment and reply reference, an offline queued thread reply with ping disabled,
and an authorized open-thread handle. Successful style saves, private updates and
host override changes leave the draft, exact queued request and encoded queue,
normalized state and open thread/parent context unchanged. Message pumps are
explicitly paused during this test. This verifies client isolation, not SQL
persistence; no fake database, Postgres operations or provider calls were used.

`git diff --check` passed. Expensive checks ran sequentially; tests used one
worker. TypeScript compilation and canonical regeneration are **not applicable**
to this worker's Dart-only production changes. Other workers' server, TypeScript,
contract and generated handshake changes were preserved, not claimed as this
patch's work.

## Execution limits and corrected intermediate failures

The attempted equivalent Flutter command was:

```sh
/opt/handrail/.handrail/flutter-sdk/bin/flutter test --no-pub --concurrency=1 test/reply_style_runtime_test.dart test/reply_style_client_test.dart test/handrail_chat_client_test.dart test/durable_resource_event_reducer_test.dart
```

It exited 1 before launching tests because `bin/internal/update_engine_version.sh`
cannot write the shared read-only `bin/cache/engine.stamp`. The exact same pure-Dart
suites passed through the direct SDK. No Flutter engine/UI/mobile QA was performed.

Intermediate test-development failures were corrected: a first invocation used
the repo root rather than the package cwd; test boundary types needed correction;
a broad `testing.dart` import pulled Flutter UI into a plain-Dart run (1,354 MiB
peak, no OOM kill), so imports now target the existing pure-Dart adapters; and the
preservation test initially awaited a deliberately paused draft command, causing
a 30-second timeout. It now observes the retained draft without awaiting server
settlement. No unrelated repository failure remains in the scoped final checks.

No preview repository edits, commits, pushes, PRs, deployment, external sends,
queue/database mutations or QA campaigns were performed. Only the required Owner
Task ledger tools were used to record task progress/completion.
