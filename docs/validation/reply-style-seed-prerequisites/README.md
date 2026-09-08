# Reply-style campaign seed prerequisites

Work request `f2564cc8-6d08-4b71-bd01-ea8dc68e06ad`, finding `526b684a-33ca-428b-a65f-1c63892bf98b`, campaign `298e20b4-4faf-4283-949d-3801cf437aa8`. Validated 2026-09-07.

## Failure boundary

Before editing, inspection of `examples/drop-in-react/scripts/chat-lab-backend.mjs` independently confirmed the campaign's missing prerequisites: only Alice/Bob, both saved preferences, both management grants, no inactivity feature/resolver, and no archived fixture/control. The React and Flutter actor lists also contained only Alice/Bob. This is a test seed/host integration omission, not a missing provider secret, resource injection, or production application authorization defect. Handrail MCP confirmed the current work request and reported both dev services stopped. No deployed configuration was changed.

The three supplied screenshots were reviewed: Bob's saved Discord preference, Alice's independent saved Current preference, and Bob's group dialog offering only Alice after searching `a`. The resolved attachment directory is absent on this worker, so the four JSON artifact files could not be opened independently. Their supplied observations agree with the source. Original artifact names, API references, and supplied hashes are preserved in [campaign-artifacts.json](campaign-artifacts.json); these hashes are provenance supplied by the request, not a claim to have rehashed unavailable files.

## Result and supported controls

The `reply-styles` profile now provides the following actors in both React and Flutter selectors, the directory and lab sessions:

| Actor | Initial preference | Authorization |
| --- | --- | --- |
| Alice | Saved Current | Create/send/manage threads; archive/restore |
| Bob | Saved Discord | Create/send/manage threads; archive/restore |
| Carol | Absent (Current SDK fallback, revision 0) | Create/send; no thread/member management |
| Dave | Absent | Observer: read history; denied create/send/manage |

All four are members of Launch planning. Bob can search `a`, select Alice and Carol, and create a group DM. [Screenshot](group-prerequisites.png). Carol's settings show the actual absent-preference fallback, without inserting a row merely by reading it. [Screenshot](carol-absent-preference.png). Use a fresh disposable lab instance to repeat the absent-preference case after saving Carol's preference.

`GET /__chat-lab/instance` includes a `prerequisites` manifest, also available at `GET /__chat-lab/reply-styles`. It supplies actors, initial preferences/grants, canonical channel/root IDs, the current inactivity policy, and control operation names. The manifest describes **seeded** preferences; use the ordinary preference endpoint/settings to inspect later changes.

Only the `reply-styles` lab exposes the following JSON POST controls at `/__chat-lab/reply-styles`:

```json
{"operation":"set_inactivity_policy","hideAfterMs":1000}
```

Sets a positive integer inactivity interval in milliseconds. The default is 86400000 (one day). `hideAfterMs: null` disables hiding; sending 86400000 restores the default. This uses the existing server policy resolver and actual persisted message timestamps. Query `GET /api/chat/conversations/{parentId}/threads?view=active` versus `?view=all` with a lab actor's session bearer token to observe hiding without closure, archive, or deletion. A new message restores activity under the same policy. Refresh discovery after changing the lab policy; the control does not fabricate a lifecycle event.

```json
{"operation":"create_archived_thread"}
```

Creates an Alice-authored root, named thread **Archived launch history**, and reply **Retained archived launch history**, then archives that thread using the real SDK command and server authorization. Returns root/thread/reply IDs and the archive result. Repeated/concurrent calls return the same fixture within that lab instance. Authorized users can read its history; sending/managing is denied while archived; thread discovery excludes it. Alice/Bob may restore it with the existing SDK `restoreConversation` operation and current lifecycle revision. The initial seed remains thread-free so the existing inline-reply/no-thread acceptance case retains its meaning. Create this fixture after that case.

Example from the lab's browser console:

```js
const fixture = await fetch('/__chat-lab/reply-styles', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ operation: 'create_archived_thread' }),
}).then(response => response.json());
```

These controls are confined to the disposable Chat Lab schema and reject cross-site browser requests, non-JSON POSTs, malformed operations and oversized requests. Other seed profiles return 404. No production routes, permission rules, or `mock_html` were changed. The harness gained an optional pass-through for the existing server inactivity-policy resolver; there is no replacement persistence implementation.

## Verification

- SDK compile: `node_modules/.bin/tsc --project tsconfig.json`, followed by `node scripts/copy-ui-styles.mjs`: passed.
- Scoped React compile: `node_modules/.bin/tsc --project examples/drop-in-react/tsconfig.reply-styles.json --noEmit`: passed.
- `node --test --test-concurrency=1 examples/drop-in-react/test/ChatLabReplyStylesPrerequisites.test.mjs examples/drop-in-react/test/ChatLabServer.test.mjs examples/drop-in-react/test/ChatLabThreadFollow.test.mjs`: **13 passed**. [Log](prerequisites.log). Covers actual HTTP sessions, absent persisted preference, group membership, denied role, policy enable/disable, timed hiding and send recovery, readable archived history, idempotent fixture creation, input rejection, and isolation from other profiles. Added the new suite to `test:lab`.
- `npm --prefix examples/drop-in-react run test:browser -- e2e/chat-lab.prerequisites.spec.mjs --workers=1 --retries=0 --reporter=list`: **1 passed**. [Log](browser.log). Real React actor selection/settings, two-person group selection and creation, persisted group membership, and Dave's unavailable creation control. The log includes Vite WebSocket EPIPE messages during page navigation; HTTP and acceptance assertions passed.
- Flutter `test --no-pub --concurrency=1 test/durable_resource_event_reducer_test.dart test/backend_lab_thread_lifecycles_test.dart`: **46 passed**. [Log](flutter.log). Lifecycle host permissions now distinguish Alice/Bob, Carol, and Dave.
- Scoped Dart analysis of the two changed lab sources and lifecycle binding test: **no issues**. [Log](dart-analysis.log). JavaScript syntax checks and `git diff --check`: passed.

Persistence checks use the repository's existing `createChatTestHarness`, canonical migrations, real PostgreSQL 15 and isolated schemas with teardown, on a disposable PostgreSQL instance using a private Unix socket with TCP disabled. No shared database, Handrail database, queue, Vault credentials, or campaign records were modified. Flutter role tests use existing narrow HTTP/socket fixtures and do not claim database coverage.

The ordinary Flutter launcher failed with exit 127 when the guarded shell lacked `flutter` on PATH; its absolute invocation then failed with exit 1 attempting to write the read-only SDK `engine.stamp` (no OOM kills). The documented cached-tool invocation succeeded:

```sh
FLUTTER_ALREADY_LOCKED=true /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 test/durable_resource_event_reducer_test.dart test/backend_lab_thread_lifecycles_test.dart
```

Before rerunning the deployed campaign, restart its reply-styles lab from reviewed source and rebuild its Flutter lab assets using the existing build/provenance flow. This run validated an isolated React/backend runtime and Flutter source tests; it did not publish or restart the stopped dev services. Existing sibling workspace changes were preserved; no commit or push was made.
