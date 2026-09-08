# First React thread notification save

Work request `1fa34853-2270-4bfd-9cda-9ead92ae7f4e`, run `5e53fd17-f8cd-484d-832a-891fc04e5a5d`, validated 2026-09-07.

## Failure boundary and resulting change

The reported failure is an application preference snapshot serialization/hydration defect: a stored initial revision of 1 must reach the client's revision map before its first preference command. Inspection before editing found that the current checkout already contains the repair in `c82abe8` (see [original repair](initial-thread-notification-revision.md)). Thread creation and detail snapshots expose `currentPreference.preferenceRevision`; `normalizeConversationSummaries` retains it; the preference command reads that authority. The existing PostgreSQL regression and a fresh React browser reproduction both pass against rebuilt source. No additional product-source or configuration workaround is warranted.

Added `examples/drop-in-react/e2e/chat-lab.initial-notification-revision.spec.mjs` to cover the exact UI choice combination missing from the earlier integration regression. Bob creates a fresh named thread, selects Mentions only and Muted indefinitely, and saves once. The test observes real HTTP traffic and requires creation revision 1, a single PATCH using revision 1, HTTP 200 / `applied` with revision 2, success feedback without a conflict, and both choices retained after a full reload. A dedicated root message avoids reusing another browser test's thread.

## Verification

- `npm run build`: passed, including full SDK TypeScript compilation. Its unrelated generated package-version change was restored to the initial workspace content afterward.
- `node --test --test-concurrency=1 --test-name-pattern='hydrates preference revisions' test/client-conversation-preferences.test.mjs`: 2 passed; first save and stale snapshot ordering through detail/list hydration.
- `node --test --test-concurrency=1 test/notification-preferences.test.mjs`: 7 passed.
- `node --test --test-concurrency=1 test/postgres-initial-preference-revision.test.mjs`: 3 passed, including Bob and Alice, persisted revisions, genuine stale conflicts and an actor without a stored preference row. [Log](react-first-notification-save/postgres-test.log).
- `npm --prefix examples/drop-in-react run test:browser -- e2e/chat-lab.initial-notification-revision.spec.mjs --workers=1 --retries=0 --reporter=list`: 1 passed. [Log](react-first-notification-save/browser.log), [captured request/result](react-first-notification-save/first-save.json), [successful UI](react-first-notification-save/first-save.png).
- JavaScript syntax check and `git diff --check`: passed.

Persistence verification uses the existing URL-backed `createPostgresTestBackend` and Chat Lab harness with canonical migrations, real PostgreSQL 15, isolated schemas and teardown. The disposable PostgreSQL server uses a private Unix socket with TCP disabled and is stopped after each command. No persistence mocks, shared project data, or Handrail database/queue changes were used. The browser loads the rebuilt SDK through the existing example dependency; no dependencies were installed or changed except downloading Chromium into the run's temporary directory.

The first browser attempt timed out because the new test listened for POST instead of PATCH; the listener was corrected. A passing intermediate run logged WebSocket `ECONNRESET` around reload; notification HTTP and persistence assertions passed. No HTTP 5xx was observed. Flutter source was not changed, so the suggested Flutter reducer test was not run.

Handrail current context confirmed the active work request. Dev-service status reported the configured Chat Lab stopped with no scoped browser route. This verifies current local source, not the deployed campaign runtime; the campaign's exact deployed revision could not be established here. No deployment, commit, push or PR was performed. Existing unrelated workspace changes were preserved.

## Campaign evidence preserved

Campaign `298e20b4-4faf-4283-949d-3801cf437aa8`, dev, custom playbook; campaign work request `8ff41fa4-8f28-4ee9-b884-7e87614c7db5`; campaign run `fee77ab0-0d2f-42ba-825f-82575519ddf8`; finding `7395ca7b-759a-47d4-a96b-f5f78c01b9f4`; approval `45640503-3fa9-4d3a-b5e7-6eff64cbdf72`.

The supplied screenshot was reviewed and shows Bob's thread notification conflict feedback. The accepted finding reports the first request sent `expectedPreferenceRevision=0` despite creation revision 1, received 409, then succeeded on explicit retry. The attachment JSON files were absent from their resolved runner paths, so those historical transport values are attributed to the work request rather than independently reread JSON. Original artifacts remain unchanged; their supplied identifiers and hashes are retained below. Fresh independently captured transport evidence is linked above.

All names are relative to `campaigns/298e20b4-4faf-4283-949d-3801cf437aa8/`.

| Artifact | Original content | Supplied SHA-256 |
| --- | --- | --- |
| `25-notification-conflict.png` | [Original](/api/pm/qa-campaign-artifacts/f714f620-9379-4a15-a493-c424711ef3e3/content) | `66d9404da8bcd10f8881e57cbfc7fdc3ddd6c53a359c9fc0e1e492c9979fee20` |
| `notification-conflict.json` | [Original](/api/pm/qa-campaign-artifacts/0cc0f0ca-eac5-45ae-adf2-d4063e689069/content) | `b9ca7eaf1681678a053ac9e80528adec2dc90ce43fbcd15bb840eab6ed634da5` |
| `transport.json` | [Original](/api/pm/qa-campaign-artifacts/3fcfe99d-4e30-4827-ba46-bde22082e558/content) | `91b5d299e6aec63b264b1b234c21b8a41e57fbc630a5ebae50ecb9412804516c` |
| `canonical-after-leave.json` | [Original](/api/pm/qa-campaign-artifacts/d3a6b18a-455a-4dc9-bae5-c646e3b497b9/content) | `e9b2fa0717d2dd98c5930a0ccb86b9ab7e0dd0828dce23608481028bb0212340` |
