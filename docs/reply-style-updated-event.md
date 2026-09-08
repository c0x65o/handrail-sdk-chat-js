# `reply.style.updated` durable event

Contract-only handoff for Owner Task `ddc4cdb9-2480-4a17-9a7f-8825d758fa6e`.
The source is [durable-events.json](../contracts/realtime/durable-events.json).
Saved-state, revision, writable style and mutation-key semantics come from
[reply-style-preference.json](../contracts/http/reply-style-preference.json)
and its generated parsers; see [the HTTP handoff](reply-style-preference-contract.md)
and [saved-style policy](reply-style-settings.md).

## Exact wire shape

```json
{
  "eventId": "event-reply-style-1",
  "protocolVersion": 4,
  "tenantId": "tenant-1",
  "streamId": "user:user-1",
  "type": "reply.style.updated",
  "occurredAt": "2026-09-06T12:00:00.000Z",
  "payload": {
    "actorUserId": "user-1",
    "preference": { "state": "saved", "revision": 2, "style": "discord" },
    "updatedAt": "2026-09-06T12:00:00.000Z",
    "mutation": {
      "operation": "update_reply_style_preference",
      "style": "discord",
      "baseRevision": 1,
      "idempotencyKey": "style:2"
    }
  }
}
```

`actorUserId`, `preference` and `updatedAt` are required. `mutation` is optional
on the wire, but mandatory for an event originating from an applied PATCH.
Present `null` is not omission. No other payload fields are allowed. In
particular, there is no conversation destination, `replyTo`, duplicate top-level
revision or caller-selected tenant/user inside the preference or mutation.

The envelope tenant must equal the trusted tenant. Delivery is exclusively to
`user:<trusted userId>`, and `actorUserId` must equal that user. Another user's
private stream/actor is `private_stream_mismatch`; conversation or thread stream
delivery is `incoherent_payload`; an envelope tenant mismatch is
`tenant_mismatch`. Canonical parser errors map to the existing payload-safe
`incoherent_payload` category without leaking raw values.

`preference` is exactly the canonical **saved** HTTP state. Its revision is a
positive safe integer, up to `9007199254740991`. Every saved string is preserved
exactly, including unknown, blank or otherwise unsupported strings. Non-string
styles are invalid wire data. Absence/revision zero is not a saved update, and no
reset/delete event is defined. Unknown strings resolve using the HTTP contract's
Current fallback; event parsing does not rewrite them or apply host precedence.

`updatedAt` is the persisted saved-state update time, serialized as a valid UTC
calendar timestamp with exactly milliseconds, `YYYY-MM-DDTHH:mm:ss.sssZ`.
Impossible dates, normalized rollover dates, missing timezone, offsets, and
noncanonical precision are rejected identically by TypeScript and Dart. The
existing generic envelope rules for `occurredAt` remain unchanged. Use the
original occurrence time on durable redelivery; `updatedAt` is not delivery time.
Ordering and later client reconciliation must use the saved revision, not a
comparison of timestamp strings.

## Mutation correlation and later server emission

For an applied `PATCH /preferences/reply-style`, set `mutation` to the exact
canonical parsed request. The event parser passes this through the generated
HTTP input parser and validates the saved preference through the generated HTTP
**applied result** parser. Consequently the saved style equals the requested
style and the saved revision equals `baseRevision + 1`. Operation, supported
write values, advanceable revision bounds and exact bounded NFC idempotency-key
validation are all inherited rather than independently reimplemented.

The correlation tuple is trusted tenant + trusted user + operation +
idempotencyKey, bound to the exact style and baseRevision. A receiver can match a
pending request against all these fields; the parser itself cannot know that
receiver's pending request. A different otherwise valid key is another mutation,
not automatically a parser error. It must never acknowledge the receiver's
pending mutation. Never reuse a key with a changed request.

The future command worker must emit once for an applied state change, preserving
its original request, saved revision and timestamps in the durable record.
Replayed HTTP results reuse the original outcome and must not create a second
state-change event. No-op (`already_requested_state`) and conflict results do not
emit this event. Redelivery of an existing event retains its original payload;
later clients must deduplicate and avoid regressing newer saved revisions.

An authoritative saved-state update with no originating PATCH may omit
`mutation`. This permits forward-compatible saved strings to round-trip without
falsely asserting they were accepted by today's current/discord write API. It is
not permission to drop correlation from PATCH emissions or to introduce another
write endpoint. An unsupported saved string accompanied by a present mutation
is rejected because it cannot satisfy the canonical applied-result rules.

This event synchronizes the user's saved presentation choice. It neither embeds
message reply references nor routes or converts messages. Current retains
Reply-to-thread behavior; Discord-style's future Reply action stays in the
current conversation, with Create/Open Thread separate. This contract patch
implements neither action nor reducers, persistence, emission or capabilities.

## Verification (2026-09-06)

All expensive checks ran sequentially with bounded workers. From the SDK root:

```sh
DART_SDK=/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk node scripts/generate-durable-events.mjs
./node_modules/.bin/tsc --project tsconfig.durable-events.json
DART_SDK=/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk node --experimental-strip-types --test --test-concurrency=1 test/durable-events-generation.test.mjs test/durable-events.test.mjs
DART_SDK=/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk node scripts/generate-durable-events.mjs --check
node scripts/generate-reply-style-preference.mjs --check
```

Generation and both drift checks passed. Scoped TypeScript compilation passed
and freshly emitted `dist/contracts/generated/durable-events.js` before parser
tests ran. All **110 Node tests passed**, including deterministic drift testing,
all 19 registered event fixtures, existing reply-reference/named-thread coverage,
8 additional saved-style round trips and 72 rejection cases. The registry test
explicitly excludes only the contract-only `replyStyleUpdated` key while still
requiring every existing reducer registration to match.

From `../handrail-sdk-chat-flutter`:

```sh
/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart analyze lib/src/generated/durable_events.dart
/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart test --concurrency=1 test/generated_durable_events_test.dart
```

Final production-file analysis exited 0 with no errors or warnings and 27
informational brace-style lints in unchanged generated statements. Two such
lints in the new code were corrected in the generator before the final analysis.
All **104 Dart parser tests passed** against the same fixtures, including legacy
events, exact saved-string preservation and immutable parsed payloads. Direct
Dart SDK binaries were available; these pure contract tests need no Flutter
engine, preview, database or provider. No persistence behavior was tested.

### Integration limit requiring the later runtime item

The first Dart test run imported the broad `core.dart` barrel and failed to load:
`lib/src/core/durable_message_event_reducer.dart:159` exhaustively switches over
`KnownDurableEvent` and does not match the new `ReplyStyleUpdatedDurableEvent`.
This is a new integration dependency caused by adding the event subtype, **not a
pre-existing unrelated failure**. The parser suite now imports the generated
event, identifier and realtime-session contracts directly to verify the selected
contract-only item. The broad Flutter core currently cannot compile until the
later runtime/reducer work accounts for this event. No reducer case, silent
ignore or state application was added to conceal that dependency. Carry this
finding into item `310ce7f0-20bd-4017-b5bf-b271fed2c9f7` (reply-style runtime in
HandrailChatClient) or an explicitly authorized compile-compatibility follow-up.

Existing dirty/untracked reply-reference, draft and named-thread changes were
preserved using narrow edits and comparison against run-start copies. Other
sibling files changed during the run; no concrete competing edit to this task's
patch was detected. The patch remains uncommitted. No preview repository,
server, reducer, database, feature advertisement, deployment or QA campaign was
changed.
