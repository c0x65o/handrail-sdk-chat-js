# Flutter authorized archived history

Work request `71b9e9d4-72b7-4f8f-af4b-69d574f0cfa7`; accepted finding
`311adf90-3277-453f-965c-0612ddef3fa3`; approval
`9f7d97f4-3016-47d5-9d96-1dddbe5d1a0b`.
Campaign `40616bf8-6630-4252-bec1-141964ae2028`, dev, verified 2026-09-07.

## Failure boundary

This is Flutter controller state handling, not an environment or provider failure.
Before editing, Handrail MCP confirmed the current project/work request, no
provider capabilities or Kubernetes deploy targets, and healthy supervised
`chat-lab` health/readiness responses (200) on port 4167. The service's configured
launch builds the workspace. The available dev log tail contains Vite EPIPE at
21:16:50 UTC, before this archived-history capture at 21:31:06 UTC; the search
does not identify an archive/cursor credential failure requiring configuration
changes. The separate stopped Mobile Preview is not the campaign Flutter route.

`src/server/thread-access.ts` allows authorized reads of an archived child under
an accessible unarchived parent. `src/server/websocket-subscriptions.ts`
deliberately denies archived subscriptions. Flutter's conversation and timeline
controllers previously treated that subscription denial as loss of all read
access. A successful HTTP read arriving last restored the history; a subscription
denial arriving last hid it. Read-cursor writes are separately denied on archived
threads by `src/server/update-read-cursor-command.ts`.

The attached screenshots and the independently retrieved, hash-verified
[campaign settled export](campaign-settled.json) actually show retained history
and disabled composition. This differs from the reported hidden-history state
and is consistent with the response-order race. The new browser regression
independently reproduces the reported failure by holding the **real server's**
subscription rejection until successful HTTP history has rendered.

## Repair

For a known archived conversation, both controllers now revalidate HTTP read
access after realtime denial or revocation. They wait for any older refresh to
finish and issue a fresh authorized read; they do not infer read permission from
the archive flag or merely ignore a denial. Successful reads restore ready
history, and HTTP 403 still produces access-revoked state. Disposal guards remain
in force. Nonarchived realtime rejection/revocation behavior is unchanged.

Sending remains disabled by the existing archive handling. Server authorization,
read-cursor writes, lifecycle/restore permissions, routes, screen layout,
dependencies and mock_html are unchanged. Existing sibling workspace edits,
including private-draft hydration in the conversation controller, were preserved.

## Validation

- Eight new HTTP/socket-boundary controller regressions failed before the repair
  and passed afterward: [before](before-tests.log), [after](after-tests.log).
  They cover subscription denial and revocation followed by HTTP 200 or 403 for
  both controllers. Existing nonarchived revocation tests still pass.
- The timeline, conversation, durable-resource reducer (the suggested check),
  and thread-widget suites passed **104 tests** in [tests.log](tests.log).
  The same run also executed the broader read-cursor runtime suite: **31 passed,
  3 failed**. All three failures reproduce with only this patch's production
  additions temporarily removed and then restored byte-for-byte:
  [unrelated baseline](unrelated-before.log). They expect an old identity's read
  cursor to remain after identity replacement but receive null, and do not invoke
  the changed controllers. Follow-up is needed for these existing expectations:
  `old-identity persistence completion cannot project or dispatch`,
  `old-identity transport completion cannot mutate the new projection`, and
  `identity replacement cancels a retained retry wait`.
- Scoped Flutter analysis of both source files and their tests: **no issues**,
  [analyze.log](analyze.log). Release Flutter web compilation: **passed**,
  [build.log](build.log). The installed SDK is read-only; checks used its cached
  tool with `FLUTTER_ALREADY_LOCKED=true`, `--no-version-check`,
  `--suppress-analytics`, and `--no-pub`. Existing stamp/font warnings were nonfatal.
- Chromium browser regression, one worker, no automatic retries: failed before
  and passed after the fix. It uses the repository's existing URL-backed real
  PostgreSQL harness, migrations/routes, disposable schema and supported
  `create_archived_thread` fixture. No shared database reset or seed was run.
  Alice opens **Archived launch notes** through **Open Thread** at 390×844.
  The test releases the delayed real `access_denied` subscription response,
  requires a fresh successful messages GET, waits for denied read-cursor writes,
  and verifies visible **Retained archived launch history**, disabled composition,
  no access-revoked screen and no browser errors. Executing Flutter provenance
  must match the current source digest.
- `node --check examples/drop-in-react/e2e/flutter-archived-history.spec.mjs` and
  `git diff --check`: passed.

The Dart tests use existing narrow HTTP/socket fakes to prove controller state;
the browser uses real PostgreSQL to exercise the supported fixture and server
access policy. The managed campaign instance was not restarted or reseeded.
The compiled workspace web assets are refreshed; no commit, push, PR, or Handrail
queue/database mutation was performed.

### Browser evidence

- [Before log](browser-before.log), [before screenshot](browser-before/flutter-archived-history-A-f5b1b-fter-a-late-realtime-denial-chromium/archived-thread-390x844.png), [before requests and semantics](browser-before/flutter-archived-history-A-f5b1b-fter-a-late-realtime-denial-chromium/archived-history.json).
- [After log](browser-after.log), [after screenshot](browser-after/flutter-archived-history-A-f5b1b-fter-a-late-realtime-denial-chromium/archived-thread-390x844.png), [after requests, rejection and provenance](browser-after/flutter-archived-history-A-f5b1b-fter-a-late-realtime-denial-chromium/archived-history.json).

Run the browser regression after building current Flutter lab assets, from
`examples/drop-in-react`:

```sh
npx playwright test e2e/flutter-archived-history.spec.mjs --project=chromium --workers=1 --retries=0
```

Run the focused Dart checks from `flutter/handrail_chat`:

```sh
flutter test --no-pub --concurrency=1 test/timeline_controller_test.dart test/conversation_controller_test.dart test/durable_resource_event_reducer_test.dart test/handrail_thread_view_test.dart
```

## Original campaign evidence

The supplied runner attachment paths were absent. Both images were reviewed as
prompt inputs. The settled JSON was recovered with read-only
`get_goal_completed_work_result` and preserved byte-for-byte. Retrieval of
`observed-requests.json` was rejected as `artifact_too_large`; its full contents
were not independently inspected. The new browser evidence independently
records successful history reads and denied cursor writes.

All original artifact paths have prefix
`campaigns/40616bf8-6630-4252-bec1-141964ae2028/`:

| Artifact | Artifact ID | SHA-256 |
| --- | --- | --- |
| `59-flutter-archived-history.png` | `bf3509dc-56ba-4b75-a2de-940f0babd8d7` | `03136d47e21c3e99914adaa89e8206b5f03a76f8fcea1e159266afd5f2395707` |
| `60-flutter-archived-settled.png` | `224cf00c-d779-4d70-a0f5-b963c92f7b9f` | `67bb21eb7be54fca32b6e2317945da8f8477552064b64948067d745a47aca39d` |
| `60-flutter-archived-settled.json` | `bb0e1ef1-2117-47fb-98c1-caa16653b8ed` | `b8fd76e48be62ecda11d4e95abd95f78295bdd378fab13b87e1bda41311745dd` |
| `observed-requests.json` | `de564f1e-adba-4ba5-a005-056c2c506637` | `61c714ad3530ff54f8076af439ce7810ee6fb4047dfcd14bf3ca9c52be299565` |
