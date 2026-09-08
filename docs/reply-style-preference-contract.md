# Reply-style preference contract handoff

Implemented for Owner Task item `aab4c0c2-0102-4abf-8627-c3d18ce9448b`.
The canonical source is [reply-style-preference.json](../contracts/http/reply-style-preference.json),
following [the accepted saved-style policy](reply-style-settings.md).
The original item defined wire data and parsers. The server now exposes the
query/command through the opt-in HTTP routes described below. Client state,
host precedence and UI remain their separate checklist items.

## Wire contract

`GET /preferences/reply-style` has no body or query parameters; the input parser
accepts `{}`. Tenant and user come only from the trusted authenticated session.
The result is one of:

```json
{"state":"absent","revision":0}
{"state":"saved","revision":1,"style":"current"}
{"state":"saved","revision":2,"style":"discord"}
{"state":"saved","revision":3,"style":"future-style-v2"}
```

Absence forbids `style`. Saved states require a positive safe integer revision
and a raw string. Unknown strings (including malformed style strings) round-trip
unchanged and resolve to Current. They remain saved, must not fall through to a
host default, and must not trigger a rewrite. Non-string styles are invalid wire
data. Neither unresolved loading nor failed reads are authoritative absence.

`PATCH /preferences/reply-style` accepts exactly:

```json
{"operation":"update_reply_style_preference","style":"discord","baseRevision":1,"idempotencyKey":"style:2"}
```

Only `current` and `discord` are writable. `baseRevision` is an integer in
`0..9007199254740990`. Idempotency keys are nonblank NFC strings of at most 255
UTF-8 bytes, with no surrounding whitespace, controls or unpaired surrogates.
Unknown fields and normalized/nested trusted identity or authorization aliases
are rejected. Identity is never a caller-selected field or conversation ID.

Results echo `operation`, `baseRevision`, `idempotencyKey` and `requestedStyle`:

```json
{"operation":"update_reply_style_preference","reconciliationStatus":"applied","baseRevision":1,"idempotencyKey":"style:2","requestedStyle":"discord","preference":{"state":"saved","revision":2,"style":"discord"}}
```

| Status | HTTP | Canonical preference rule |
| --- | --- | --- |
| `applied` | 200 | Saved requested style; revision exactly base + 1. |
| `replayed` | 200 | Original applied saved style and revision exactly base + 1. |
| `already_requested_state` | 200 | Saved requested style; revision exactly base. |
| `preference_revision_conflict` | 409 | Authoritative absent/saved state, including unknown strings; revision differs from base. |

Saving Current from absence is an explicit first save at revision 1, never a
no-op at revision 0. A CAS mismatch is a conflict even when styles match. A
replay carries its original snapshot, so later client reconciliation must not
regress newer confirmed state. Retries of a no-op/conflict retain the original
status/result. A reused key with different request data is rejected with 409,
not interpreted as an applied replay. Keys are scoped to tenant + user +
operation. Canonical read revisions can reach `9007199254740991`; requests must
remain advanceable. No deletion/reset operation is defined.

Feature: **`reply_style_preference_v1`**. Missing/false means unsupported. Set
`CreateChatServerOptions.features.reply_style_preference_v1: true` to opt in;
omitted or false stays disabled. The server advertises true only after its
read-only persistence readiness check succeeds. This feature covers the
preference API, not inline reply capability or
authorization. The preference is separate from conversation notification,
star, mute, participation and lifecycle state.

## HTTP readiness and errors

Both routes pass admission and trusted authentication before handling preferences.
They reject query parameters, caller identity headers recognized by the existing
transport guard, GET bodies, and malformed/unknown PATCH fields. PATCH requires
JSON and is bounded to 64 KiB; its idempotency key comes from the canonical body.
Success and error JSON responses use `Cache-Control: private, no-store`.

Readiness is uncached and checked for each metadata read and each valid enabled
preference request. It requires compatible migration history, the canonical
reply-style migration (0041), no pending prerequisites through 0041, schema usage,
the idempotency claim function's execute privilege, SELECT/INSERT/UPDATE on the
preference and idempotency tables, INSERT on audit/outbox tables, and a database
session accepting writes. Checks never apply migrations or write probe data.
This guarantees an installed handler and currently available persistence
prerequisites. It cannot guarantee the next transaction: concurrent privilege
changes, schema drift, custom triggers, storage exhaustion or outages can still
fail a read/save. Those failures return a sanitized 503, never an absent state or
success-shaped fallback. If migration metadata itself cannot be read, the existing
metadata endpoint fails rather than advertising capabilities. Host configuration
in `runtime.config.features` is requested support; wire metadata is checked support.

Disabled routes return 501 `chat_reply_style_preference_disabled`. Unavailable
support returns 503 `chat_reply_style_preference_unavailable`. Invalid transport
or input returns 400 `chat_reply_style_preference_invalid_request`. Typed command
conflicts return 409 `chat_reply_style_preference_idempotency_conflict` or
`chat_reply_style_preference_idempotency_in_progress` with a generic message.
Revision conflicts retain the canonical 409 reconciliation body above. Admission
and authentication retain their existing sanitized errors and observability.

The same checked metadata reader serves HTTP and the existing handshake path;
this adds only the preference feature. No broad Discord-mode readiness or new
handshake acceptance policy is established. Saving Discord-style records a
presentation choice; implementing same-conversation Reply remains separate work.

## Changed files

- Canonical source: `contracts/http/reply-style-preference.json`.
- Generator: `scripts/generate-reply-style-preference.mjs`.
- Templates: `scripts/templates/reply-style-preference.ts.tpl`, `scripts/templates/reply_style_preference.dart.tpl`.
- Generated outputs: `src/contracts/reply-style-preference.ts`, `../handrail-sdk-chat-flutter/lib/src/generated/reply_style_preference.dart`.
- Public exports: `src/contracts/index.ts`, `src/client/index.ts`, `src/server/index.ts`, `../handrail-sdk-chat-flutter/lib/core.dart`.
- Scripts: `package.json` (focused generation, check, tests, typecheck).
- Shared wire fixtures: `test/fixtures/reply-style-preference.json`.
- Tests: `test/reply-style-preference.test.mjs`, `test/reply-style-preference-generation.test.mjs`, `../handrail-sdk-chat-flutter/test/generated_reply_style_preference_test.dart`.
- Type checks: `type-tests/reply-style-preference.test.ts`, `tsconfig.reply-style-preference-type-tests.json`.
- Handoff evidence: this document.

Shared export/script files were re-read before narrow insertions. Sibling changes,
including `../handrail-sdk-chat-flutter/test/generated_thread_creation_test.dart`, were
preserved. No commits, pushes, PRs, deployments, database work or QA campaigns.

## Verification (2026-09-06)

Checks ran sequentially with bounded test workers. From the repository root:

```sh
node scripts/generate-reply-style-preference.mjs
npm run test:reply-style-preference
npm run typecheck:reply-style-preference
npm run check:reply-style-preference
```

Generation succeeded; 97 Node tests passed; scoped TypeScript compile passed;
generation check passed. Tests verify deterministic rendering and independently
detect drift in each generated output. Runtime tests use the installed esbuild
transform; an initial attempt using TypeScript's removed `transpileModule` API
failed under installed TypeScript 7.0.2 and was corrected before the passing run.

From `../handrail-sdk-chat-flutter`:

```sh
/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart analyze lib/src/generated/reply_style_preference.dart lib/core.dart
/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart test --concurrency=1 test/generated_reply_style_preference_test.dart
```

Analysis found no issues; all 92 Dart tests passed, using the public pure-Dart
`core.dart` export and the same wire fixtures as TypeScript. With a normal writable
SDK installation, `npm run test:reply-style-preference-dart` runs this test suite.

Launcher limitations observed in this worker:

- `dart analyze lib/src/generated/reply_style_preference.dart` could not find `dart` in the guarded child PATH.
- `/opt/handrail/.handrail/flutter-sdk/bin/dart analyze lib/src/generated/reply_style_preference.dart` could not write the read-only `engine.stamp`.
- `/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot test --no-pub --concurrency=1 test/generated_reply_style_preference_test.dart` could not open the read-only Flutter cache lockfile.
- The first direct Dart test invocation still imported `flutter_test` and failed to load Flutter engine types. The test now uses the existing `package:test` dependency; the final direct Dart run above passed.

These limitations do not leave a contract-verification gap: this production
contract is pure Dart and its tests require no Flutter engine or database.
