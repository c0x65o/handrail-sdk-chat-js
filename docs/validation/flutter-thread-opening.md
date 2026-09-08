# Flutter named creation and authorized existing-thread opening

Owner Task item `8b365ec2-1b9c-4ad3-bc4e-cc9714d7e2f5`, verified 2026-09-06.

## Changed files and behavior

- `flutter/handrail_chat/lib/src/core/thread_opening_controller.dart` adds
  `threads.create(rootMessageId: ..., name: ..., initialFollow: ...)` and
  `threads.forRoot(id).create(...)`. Generated `ThreadCreationInput` validates
  the canonical name (already trimmed, 1–100 Unicode scalar values). Names are
  not normalized or silently applied to an existing thread. Server-returned
  IDs and names remain authoritative for all reconciliation outcomes.
- `threads.forRoot(id).retry()` and legacy `open()` retain the first validated
  request, including its name, initialFollow, parent/root IDs and idempotency
  key, after an ambiguous failure. Calling `create` after failure starts a new
  intent. Concurrent named/legacy calls share the first in-flight operation;
  calls while ready retain the existing thread without renaming it. Invalid
  named calls do not disturb a live handle's state or subscription.
- `threads.openExistingThread(threadId)` uses fresh conversation detail, thread
  timeline and parent timeline reads. Concurrent readers share their reads;
  later opens reauthorize even with a cached identity or a retained handle.
  There are no creation, join, follow, participant-setup, read-cursor or lifecycle
  writes. Type/ID validation precedes normalized hydration and subscription.
  Denial fails without returning a handle and releases previously retained
  existing-thread subscriptions. Disposal cancels pending reads and releases
  subscriptions through the existing controller machinery.
- Existing reads return `ChatExistingThreadOpenSuccess` with the normal
  `ChatThreadOpenHandle`, or `ChatExistingThreadOpenFailure` with a typed `code`
  and optional `httpStatus`. Separate result types preserve the existing
  non-nullable root-opening state API; failure before detail authorization
  does not invent a root ID.
- Handle state includes canonical parent/root IDs, authorized detail, and
  `rootContextStatus` (`available`, `deleted`, `unavailable`). `rootMessage` is
  present only for a live source from the fresh parent read. Deleted and missing
  sources do not prevent accessible thread history from opening. Cached source
  content is not used as the handle's root context. A failed parent read fails
  safely, including a 404 that could conceal revoked access.
- `flutter/handrail_chat/lib/src/handrail_chat_client.dart` adds public
  `createThread(...)` and `openExistingThread(threadId)` delegates and injects
  the existing snapshot reader. These are the only edits to this shared client
  file; reply-style and sibling client work were not modified.
- `flutter/handrail_chat/lib/src/chat_deep_link.dart` adds `/threads/:threadId`
  and `/threads/:threadId/messages/:messageId` under approved prefixes.
  Existing `/conversations/:id` and message links also use existing-thread
  opening when the authorized conversation is a thread, preserving their host
  callback target types. Scheme, host, port, prefix and identifier validation
  remain in force before I/O.
- Legacy `/conversations/:parentId/threads/:rootMessageId` links remain valid.
  They read the source freshly; a deleted/missing source is unavailable unless
  a canonical thread is already known and freshly authorized. Canonical history
  in that case is delivered as `ChatResolvedExistingThreadDeepLinkTarget`, with
  safe root context. The resolver retains the handle for the callback and
  releases it in `finally`, including host failure.
- Tests: `thread_opening_controller_test.dart`, `chat_deep_link_test.dart`, and
  shared HTTP fixtures in `test/fixtures/existing_thread_opening_fixtures.dart`.

The fundamental addition is named separate discussions and read-only access by
canonical thread ID. Existing root-based creation/opening remains available.
This item does not implement inline replies, saved style controls, discovery UI,
settings, or lifecycle mutations.

## Exact verification

Run sequentially from `flutter/handrail_chat`:

```sh
FLUTTER_ALREADY_LOCKED=true /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 test/thread_opening_controller_test.dart test/chat_deep_link_test.dart
/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart analyze lib/src/core/thread_opening_controller.dart lib/src/handrail_chat_client.dart lib/src/chat_deep_link.dart
```

Results: **34 tests passed; analysis reported no issues**, both exit 0.
Tests cover legacy reconciliation and errors, generated named serialization,
canonical names, frozen retry identity versus new intent, coalescing, retained
subscriptions, invalid input while ready, unfollowed/inactive-child readers,
deleted/missing/live root context, fresh denial at detail/thread/parent reads,
wrong type/ID, disposal, canonical thread/message routes, legacy routes,
origin validation and host callback cleanup.

From repository root:

```sh
git diff --check -- flutter/handrail_chat/lib/src/core/thread_opening_controller.dart flutter/handrail_chat/lib/src/handrail_chat_client.dart flutter/handrail_chat/lib/src/chat_deep_link.dart flutter/handrail_chat/test/thread_opening_controller_test.dart flutter/handrail_chat/test/chat_deep_link_test.dart
```

Result: exit 0, no whitespace errors.

The ordinary `flutter --version` launcher failed because `bin/cache/engine.stamp`
is read-only. Direct snapshot launch without `FLUTTER_ALREADY_LOCKED=true` also
failed on the cache lockfile. The command above ran successfully using installed
artifacts; Flutter printed non-fatal read-only stamp warnings for
`libimobiledevice.stamp` and `libusbmuxd.stamp`. No SDK files were edited.
No unrelated pre-existing test failures appeared in the focused final checks.

## Limits and scope

Root context lookup and initial thread history are each bounded to 50 messages.
An older uncached root can be unavailable even though it still exists; consumers
should use the explicit handle context. Further history uses normal timeline
pagination. Existing immutable snapshots held by a host are not retroactively
erased; each new existing-thread open reauthorizes, and continued delivery uses
the settled server subscription authorization path.

Tests use the repository's HTTP and realtime service boundaries, not a fake
SQL database. Persistence tests were unnecessary. No TypeScript production or
generated files changed in this item, so TypeScript compilation and regeneration
were not needed. No UI, browser QA, preview-repo, provider, deployment, commit,
push, PR or global project check was performed. Sibling TypeScript/server/test
and validation-document changes were preserved. This patch remains uncommitted.
