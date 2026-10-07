# Releases

The chat SDK has two independently versioned distributions in separate repositories:

- `@handrail/chat` uses this repository's root `package.json`.
- `handrail_chat` uses the root `pubspec.yaml` in `handrail-sdk-chat-flutter`.

Their version numbers do not need to match. Shared protocol changes must validate
both affected SDKs using the shared-contract and cross-runtime conformance gates.

## Read acknowledgement upgrade boundary (2026-10-07)

The corrected server returns the complete HTTP `ReadCursorMutationOutcome`:
the five canonical result fields plus `reconciliationStatus` (`applied` or
`replayed`) and the request's `idempotencyKey`. Those two fields were always
required by `contracts/http/read-cursor.json`; the legacy server omitted them.
This correction still exposes a real incompatibility with previously working
non-durable JS readers. Do not roll out the server alone to those readers.

The independent review's eight public HTTP cases use baseline **1.0.54** at
`248fb8890b8e7e1ba15799aff06ef48156cca451` and the candidate at that base plus
production patch SHA-256
`6ab3aae1914f849213ec76c13565c36b310d91d513bb0f0414215ae40fd11767`.
The candidate has no published release SHA yet; use the parent's verified native
release commit, not an assumed next version number.

| Server | JS reader | Non-durable read/unread, first and same-key repeat | Durable first `mark_read` |
| --- | --- | --- | --- |
| Baseline | Baseline | Success | `malformed_response` |
| Baseline | Candidate | Success | `malformed_response` |
| Candidate | Baseline | `malformed_response` | Success |
| Candidate | Candidate | Success | Success |

These are eight server/reader/mode cases and 20 actual PATCH exchanges. Durable
rows cover first read only. A rejected acknowledgement can follow a committed
mutation; it does not prove the server did nothing. See the retained
[matrix](validation/ack-release-review-20261007/matrix.json),
[passing receipt](validation/ack-release-review-20261007/matrix-qualified.txt)
and [independent review](validation/ack-release-review-20261007/review.txt).

- **Non-durable JS 1.0.54 readers**, including React/UI using that client, need
  the corrected reader before consuming the candidate server. Treat other old
  pins using the same strict five-field reader as requiring correction; this
  matrix does not qualify every historical version.
- **Durable JS 1.0.54 and candidate readers** already require the complete
  outcome. Both succeed with the candidate server and reject the baseline
  server. The reader patch alone does not repair durable operation against the
  old producer. Published **Flutter 0.1.32** likewise requires the complete
  outcome; its parser/read runtime/visibility bytes are identical in 0.1.33 and
  the reviewed Flutter candidate. It needs the corrected server, not a relaxed
  reader. Its HTTP qualification is separate from the eight JS cases.
- **Reader-first rollout is supported for non-durable JS**: deploy the corrected
  reader while the legacy server remains, then enable the corrected producer
  once every supported consumer has a compatible reader. A coordinated matched
  upgrade is also supported. Hold server rollout wherever old non-durable
  readers remain. Realtime protocol 4 readiness and the current/previous
  realtime protocol promise do not negotiate this HTTP boundary; database
  schema rollback compatibility is also separate.
- Preview will upgrade its root server and React package together, then run
  exact installed-consumer checks with matching full-SHA public HTTPS Git pins
  and locks. That qualifies Preview only. SDK source checks do not establish
  installed-consumer acceptance or resolve the outstanding Preview 126/120
  result. No new negotiation, silent fallback, or blanket backward
  compatibility is promised.

### Keep transport outcomes separate from canonical results and events

`updateReadCursor` now returns an outcome. `parseReadCursorMutationResult` and
`createReadCursorUpdatedEvent` still require the strict five-field result;
passing the entire outcome to either helper rejects its transport metadata.
Validate the full HTTP outcome against the exact request **before** projecting
the canonical result. Also check the read-state user against the trusted actor:

```ts
import {
  parseReadCursorMutationOutcome,
  parseReadCursorMutationResult,
  createReadCursorUpdatedEvent,
} from "@handrail/chat";

// rawHttpBody, request, actorUserId and eventMetadata come from the host.
const outcome = parseReadCursorMutationOutcome(rawHttpBody, request);
if (outcome.readState.userId !== actorUserId) {
  throw new Error("Read acknowledgement user does not match the actor");
}
const result = parseReadCursorMutationResult({
  operation: outcome.operation,
  conversationId: outcome.conversationId,
  readState: outcome.readState,
  latestSequence: outcome.latestSequence,
  unreadCount: outcome.unreadCount,
});
// eventMetadata contains eventId, protocolVersion, tenantId and occurredAt.
const event = createReadCursorUpdatedEvent({ ...eventMetadata, result });
```

Do not strip unknown fields at HTTP ingress or use the result parser to accept
an incomplete outcome. Partial metadata, wrong request correlation and wrong
users must still fail. Only the candidate's existing non-durable legacy path
accepts responses with neither outcome metadata field; durable parsing remains
strict. Stored receipts and user-private events remain canonical results, with
no transport metadata or historical receipt migration. See the retained
[strict-boundary proof](validation/ack-release-review-20261007/strict-boundaries.json).

## JavaScript/TypeScript SDK

1. Check the candidate with `node scripts/generate-package-version.mjs --check`
   **before** `npm ci` or `npm run build`. This checks exact generated bytes and
   both root version fields in `package-lock.json` against `package.json`.
   Preserve the pre-install CI gates and the test runner's pre-build gate:
   install/prepare/build generation can conceal drift in committed source.
2. Run `npm run build`, the scoped typechecks, and relevant tests. Keep the
   normal prepare build for Git consumers (`npm ci --include=dev` invokes it).
   Obtain independent review of the complete changed candidate.
3. After review and resolution of any publication holds, use Handrail's native
   Work Request finalization for version bump, commit and push to the public
   `handrail-sdk-chat-js` Git repository. Do not pre-increment package versions.
   Native finalization stages all dirty files; reconcile concurrent changes and
   their publication restrictions before enabling it.
4. Verify package, both lock versions and generated source in the actual
   receipted commit **before** installation or lifecycle generation. Reconcile
   that commit with the reviewed candidate and renew review for changed scope.
5. Consumers pin the full release commit in their public HTTPS Git dependency
   and matching lockfile. Build through the normal install pipeline.

`package.json` is canonical. The schema-1 declaration in
`.handrail/version-mirrors.json` tells Handrail's native writer to update
`src/client/generated/package-version.ts` using the exact text template
`export const CHAT_CLIENT_PACKAGE_VERSION = "{{version}}" as const;`.
The native writer updates the package, both lock versions and this mirror
without invoking the npm `version` lifecycle. That lifecycle remains useful
for npm-driven version changes, but cannot protect a native bump on its own.
The template must match the previous canonical version exactly once; stale,
missing or duplicate matches reject the bump before the canonical file changes.
Keep generated source aligned before finalization and check consistency again
after it, before any lifecycle can repair the evidence.

## Flutter SDK

1. Update the root `pubspec.yaml` and embedded package metadata in
   `handrail-sdk-chat-flutter`.
2. Run `flutter pub get --no-example`, analysis, and relevant Flutter tests.
3. With explicit owner authorization, commit and push the implementation and
   version to the public `handrail-sdk-chat-flutter` Git repository.
4. Consumers pin the full release commit in their public HTTPS Git dependency
   and matching `pubspec.lock`.

There is no separate packaging or registry publishing step. Do not install SDKs
through paths, workspace dependencies, registry versions, tarballs, branches, or
tags. For an upgrade, honor the frozen revision. For a new install, resolve the
latest committed SDK version and SHA. The migration's initial empty scaffold
commits are not installable SDK revisions; see [migration status](sdk-repository-split.md).
