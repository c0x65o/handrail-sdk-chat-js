# Saved-message reply snapshot verification

Owner Task item: `41b6951c-c679-417c-bcbe-a7daef19fdd9`.
Verified locally on 2026-09-06.

Available saved-message projections previously rejected `replyTo`. They now
preserve an optional canonical `MessageReplyReference`: exactly `messageId` and
required boolean `notifyAuthor`. The source inherits the current message's
conversation. No source message text, author snapshot, forward attribution, or
new private-note data is copied. Absent references remain absent; deleted and
inaccessible projections remain exact `availability`/`reason` shells.

## Ownership and files

- `src/contracts/private-user-state-snapshot.ts`: handwritten TS contract/parser;
  adds the optional field and canonical message reference validation.
- `test/private-user-state-snapshot.test.mjs`: runtime acceptance and existing
  snapshot regressions.
- `test/fixtures/private-user-state-snapshots.mjs`: both notification choices.
- `type-tests/private-user-state-snapshot.test.ts`: optional canonical type,
  required boolean, forbidden destination, and unavailable-shell type checks.
- `flutter/handrail_chat/lib/src/core/saved_message_snapshot.dart`: new handwritten
  pure-Dart projection counterpart, reusing generated `MessageReplyReference`,
  message content, author, revision, identifiers, and attachment metadata types.
- `flutter/handrail_chat/lib/saved_message_snapshot.dart`: narrow public entrypoint.
- `flutter/handrail_chat/test/saved_message_snapshot_test.dart`: focused round trips
  and rejection coverage.
- This verification document.

Inspection found no generator or canonical descriptor for the existing private
snapshot contract, and no Dart saved-list projection parser. No generated file
needed editing or regeneration. `scripts/generate-messages.mjs` continues to own
`message.ts` and `generated/message.dart`; their existing reference type is reused.
Message reply identifiers use the canonical safe-identifier/255 UTF-8-byte rule,
including rejection of C0/C1 controls and U+2028/U+2029. This deliberately does
not add the stricter draft-only NFC normalization requirement.

Dart consumers import `package:handrail_chat/saved_message_snapshot.dart` and call
`SavedMessageProjection.fromJson(entryMessage, expectedMessageId: entryMessageId)`.
The parser checks current-message identity and attachment reference order and
restricts the saved content shape before delegating to generated message parsers.
This counterpart only covers the entry's message projection; saved-list paging,
private notes, save metadata, transport, and UI are outside its scope. Existing
`CanonicalActorPrivateSavedMessageState` remains save-state metadata. Sibling
edits to `core.dart` and `normalized_snapshot_state.dart` were not touched.

## Commands and results

All checks ran sequentially, with one Node/Dart test worker. From the SDK root:

```bash
node_modules/.bin/tsc --project tsconfig.private-user-state-snapshot-type-tests.json
GOMAXPROCS=2 GOMEMLIMIT=2GiB node_modules/.bin/tsc --project tsconfig.private-user-state-snapshot-type-tests.json --noEmit false --outDir node_modules/.cache/saved-reply-snapshot/compiled --declaration false --declarationMap false --sourceMap false
node --loader ./node_modules/.cache/saved-reply-snapshot/loader.mjs --test --test-concurrency=1 test/private-user-state-snapshot.test.mjs
```

Both scoped TS checks passed. The runtime suite passed **15/15**, with no skips.
The local loader redirects existing `dist/contracts` imports to freshly emitted
contracts when present, retaining the existing root/client/server export tests
without writing shared `dist` outputs. Loader and compiled output remain under
ignored `node_modules/.cache/saved-reply-snapshot/`. To reproduce the loader:

```js
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../../../', import.meta.url);
const dist = new URL('dist/contracts/', root).href;
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.startsWith(dist)) {
    const fresh = new URL('compiled/src/contracts/' + resolved.url.slice(dist.length), import.meta.url);
    if (existsSync(fileURLToPath(fresh))) return { ...resolved, url: fresh.href };
  }
  return resolved;
}
```

The emitted `compiled/package.json` contains `{"type":"module"}`.

The initial `dart format flutter/handrail_chat/lib/saved_message_snapshot.dart
flutter/handrail_chat/lib/src/core/saved_message_snapshot.dart
flutter/handrail_chat/test/saved_message_snapshot_test.dart` failed because the
Flutter launcher attempted to write the read-only SDK `bin/cache/engine.stamp`.
The installed bundled Dart binary worked without changing SDK/runtime settings:

```bash
/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart format flutter/handrail_chat/lib/saved_message_snapshot.dart flutter/handrail_chat/lib/src/core/saved_message_snapshot.dart flutter/handrail_chat/test/saved_message_snapshot_test.dart
cd flutter/handrail_chat
/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart test --concurrency=1 test/saved_message_snapshot_test.dart
/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart analyze lib/saved_message_snapshot.dart lib/src/core/saved_message_snapshot.dart test/saved_message_snapshot_test.dart
```

Formatting passed. Dart tests passed **5/5**. Scoped analysis reported **No issues
found**. Coverage includes legacy omission, both notification choices, canonical
UTF-8 boundaries, malformed/null references, missing/nonboolean notification
choices, unknown/destination/actor/source fields, unchanged current content,
identity mismatch, and exact deleted/inaccessible shells rejecting stale additions.

## Limits

No server hydration, database behavior, transport, UI, or full private-state Dart
parity is claimed. Server hydration remains the dependent task. No SQL check was
needed for these pure contracts. No preview changes, QA campaigns, operational
mutations, commits, pushes, or PRs were performed. Global checks were not run in
the shared convergence workspace. Changes are left uncommitted for review.
