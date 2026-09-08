# Dart message source context validation

Owner Task item: `0c586e78-7933-4d30-bd31-21d5aecd13fc`.
SDK checkout inspected at `509e29fa68e6257a583b859588832984e326dced`.

## Behavior and integration

The Dart SDK can resolve a referenced source that has never been loaded into its
timeline. This supports the target same-conversation Reply behavior: a reference
can show authorized source context without creating a thread or changing the
send destination. The existing separate-thread behavior remains available.
This runtime is presentation-mode independent; composing, settings, widgets and
named-thread UI remain sibling items.

```dart
final context = client.messageContexts.forMessage(
  MessageContextRequest(conversationId: conversationId, messageId: messageId),
  pageSize: 30,
);
context.setAuthority(ChatMessageContextAuthority(
  tenantId: tenantId,
  userId: userId,
  canRead: true,
));
final subscription = context.states.listen(renderContext);
await context.load();
await context.loadBefore(); // one bounded page, before the target sequence
await context.loadAfter();  // one bounded page, after the target sequence
// context.retry() reauthorizes the source and clears prior adjacent pages.
// For explicit navigation, use the existing resolver:
// await deepLinkResolver.resolveTarget(context.navigationTarget);
await subscription.cancel();
await context.dispose();
```

`forMessage` shares one controller per conversation/message pair. Configure its
authority once for the shared consumers; every `setAuthority` assignment starts
a new access generation, even for the same actor. The first consumer selects
the page size. Dispose the shared controller after all its consumers detach.
Hosts must update authority for token-provider identity/access changes outside
the client's accepted realtime/storage identity APIs. The server still
authorizes every request. State streams are current-first and immutable;
consumers must replace rendered snapshots when the controller publishes a
change and must not retain source text in durable preview metadata.

`client.getMessageContext` uses the existing snapshot reader for authenticated,
cancellable `GET /conversations/:conversationId/messages/:messageId/context`.
The generated parser validates the exact request identity. Successful available,
deleted and unavailable responses remain distinct from loading and retryable
transport, authentication, HTTP rejection, parse and actor-mismatch failures.
Failures do not become unavailable successes. Controller failures clear source
and adjacent text; retry performs a fresh source authorization.

For available/deleted results, an existing conversation-detail GET identifies
thread parent metadata before publishing context. Both source and parent use
the existing reference-counted realtime subscription mechanism. Context reads
do not hydrate the normalized store. Thread child membership is participation;
public-channel membership also does not determine read access. Private-parent
membership loss and parent archive projections invalidate inherited context.
Before parent metadata resolves, a new access revocation conservatively
invalidates the pending source, since that parent could own it.

Adjacent pages use only `getMessageTimeline`: backward `before=source.sequence`
and forward `after=source.sequence`, followed by each page's corresponding
exclusive cursor. The source remains separate. There is no history scan or
automatic page loop. Page reads are serialized, one bounded request per call;
callers await a page before requesting another direction or continuation.

Identity/access generations guard lookup, detail and pagination completions.
Accepted message edits/deletions and normalized canonical revision changes
clear text and maintain ephemeral, text-free revision floors. Older HTTP retry
responses cannot replace a known newer canonical message or deletion. If a
source is absent from normalized state, its realtime edit/delete follows the
existing snapshot-recovery boundary, which clears the context on loss of
connected readiness. Reconnect resolves fresh authorized source data. Parent
subscription rejection/revocation, accepted parent access loss, identity changes
and disposal cancel pending reads and clear text. Client disposal clears context
synchronously before awaiting other runtime teardown.

The actual existing navigation API is named `ChatDeepLinkResolver`, not
`ChatDeepLinkController`. `navigationTarget` reuses its
`ChatMessageDeepLinkTarget` / `ChatExistingThreadDeepLinkTarget` types. These APIs
are now exported by the pure-Dart core entry point. No URL parser or resolver
behavior was changed; conversation/message, legacy root-thread, and canonical
thread-ID/message formats remain accepted.

## Exact final verification

Run sequentially from `flutter/handrail_chat`:

```sh
FLUTTER_ALREADY_LOCKED=true /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 --reporter=expanded test/message_context_controller_test.dart test/chat_deep_link_test.dart test/generated_message_context_test.dart test/conversation_snapshot_query_test.dart test/message_timeline_query_test.dart test/thread_list_controller_test.dart > /opt/handrail/.handrail/codex-runs/9a7ac71a-90b0-4ab5-804d-9932758a7e35/tmp/message-context-final-tests.log 2>&1
/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart analyze lib/core.dart lib/src/core/message_context_controller.dart lib/src/core/conversation_snapshot_query.dart lib/src/handrail_chat_client.dart
```

Results: **250 tests passed, exit 0; scoped production analysis: no issues,
exit 0**. The test run includes 35 new source-controller tests and existing
deep-link, generated context, snapshot query, timeline query and sibling thread
discovery regressions. Controlled HTTP and socket boundaries exercise actual
query parsing, normalized reduction and realtime recovery; no datastore is
mocked and no persistence implementation changed.

The focused tests cover unloaded sources, shared future deduplication, exact
exclusive adjacent cursors and continuation, immutable pages, deleted versus
unavailable, transport/parse/authentication failures and retry, edit/delete
races during lookup/detail/pagination, normalized snapshot changes, private
parent revocation through durable and snapshot boundaries before and after
parent discovery, inherited versus participation access, host and accepted
client identity replacement, unloaded-source realtime recovery, reconnect,
shared subscription revocation/access regain and synchronous disposal.
Late completions cannot restore source or adjacent text.

From repository root:

```sh
git diff --check -- flutter/handrail_chat/lib/core.dart flutter/handrail_chat/lib/src/core/conversation_snapshot_query.dart flutter/handrail_chat/lib/src/core/message_context_controller.dart flutter/handrail_chat/lib/src/handrail_chat_client.dart flutter/handrail_chat/test/message_context_controller_test.dart docs/validation/flutter-message-context.md
```

Result: exit 0. During development, a reconnect test initially asserted before
the existing asynchronous lifecycle stream delivered its invalidation; the test
now waits for that boundary. Initial style infos were corrected. Flutter emitted
nonfatal read-only `libimobiledevice.stamp` and `libusbmuxd.stamp` warnings, as in
the prerequisite checks, but completed successfully. No unusual resource use
was observed. This is deterministic local verification, not deployed/mobile QA.

## Patch ownership

New files: `lib/src/core/message_context_controller.dart`,
`test/message_context_controller_test.dart` (under `flutter/handrail_chat`) and
this validation note. Existing files changed: `flutter/handrail_chat/lib/core.dart`,
`flutter/handrail_chat/lib/src/handrail_chat_client.dart`, and
`flutter/handrail_chat/lib/src/core/conversation_snapshot_query.dart`.

Shared client/query edits are additive and preserve the existing thread
discovery patch; its regression tests pass. Concurrent TypeScript source-context
files were observed and left untouched. Controller types are exported through
the client's existing Dart `part` pattern. Existing generated contracts suffice;
no generated files or canonical generators required changes.

No preview repository, UI, preference, reply/draft/offline metadata, database,
provider, external-send, deployment, PR, commit or push changes were made. The
patch remains uncommitted. Only the selected Owner Task item's authorized
progress ledger was updated; the broader convergence goal is not completed here.
