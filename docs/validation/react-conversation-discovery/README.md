# React conversation discovery after actor switching and reload

Work request: `f772402b-43c8-489d-b79b-2c2d5c45aad5`.
Campaign: `40616bf8-6630-4252-bec1-141964ae2028` (dev).
Finding: `2d9b9817-7b98-49e7-85fd-97f7f6d58fec`.
Approval: `ddcca458-5e13-4fa9-9f0f-c538c72c10d9`.
Validated 2026-09-07.

## Failure boundary

Reviewed all six supplied campaign images: React initially shows Bob's DM and
group histories, then loses sidebar discovery and Alice search results after
actor return/reload. Flutter retains both conversations. Recreating the DM
recovers its existing history, followed by another discovery loss after reload.
The campaign reports HTTP 200 `existing_equivalent`; the original request JSON
could not be independently read because its supplied attachment path is absent
in this worker.

Before changing product code, Handrail MCP confirmed this work request and a
healthy supervised `chat-lab` dev service (health/readiness HTTP 200). The repo's
React `useConversations` hook skipped its server request whenever any list was
cached. Reply-style actors restore normalized snapshots on session startup, so
an old list permanently suppressed authoritative discovery. Conversation creation
can expose a selected conversation without updating that retained list.

An independent Chromium reproduction against the existing disposable PostgreSQL
Chat Lab harness confirmed this application boundary before the fix: Bob created
the DM and group and sent a source and inline reply into each; an authenticated
server list returned both IDs and SQL confirmed two persisted messages per ID;
after Bob → Dave → Bob, Alice search could not find the group. This requires no
environment, provider, authorization, seed, or database repair.

## Change

`src/react/query-hooks.ts` now requests the canonical conversation list when an
enabled consumer becomes ready, changes client/identity/scope, or remounts.
Cached entries remain visible during the refresh. List hydration and pagination
do not restart or cancel the initial request. Cleanup cancels obsolete requests;
errors reset for the new query. The existing server authorization and snapshot
normalization remain authoritative. Test clients now distinguish startup list
refreshes from pagination requests.

## Verification

- `npm run build`: passed, including full TypeScript compilation.
- `node --test test/react-query-hooks.test.mjs`: 13 passed. New HTTP-boundary
  coverage checks cached rendering, refresh, disabled queries, pagination,
  remounts, identity changes, and request cancellation using the real client.
- `node --test --test-timeout=20000 --test-name-pattern='conversation pagination|appended conversations|failed conversation page|conversation filter shows a scoped' test/chat-workspace.test.mjs`:
  5 passed.
- From `examples/drop-in-react`,
  `PLAYWRIGHT_BROWSERS_PATH="$PWD/../../build/playwright-browsers" npx playwright test e2e/chat-lab.conversation-discovery.spec.mjs --project=chromium --workers=1 --retries=0`:
  passed. Uses URL-backed real PostgreSQL, production migrations/routes, and a
  disposable schema. Proves persisted DM/group history, Alice search and reopening
  after actor return and reload, and absence of Bob's private conversations for
  nonmember Dave. No re-creation is needed for recovery.
- `git diff --check`: passed.

Fresh evidence: [actor return](actor-return.png), [reload](reload.png), and
[request methods/paths, conversation IDs and backend kind](discovery-requests.json).
The reload screenshot was inspected and shows both Alice and Alice, Carol in
filtered navigation with retained group reply history.

Broader checks exposed existing workspace failures: ten in
`chat-workspace.test.mjs` (row/section expectations, participant fixture,
unavailable-created fallback, and notification fixtures), plus three thread
control failures in `chat-workspace-default.test.mjs`. The combined run stalled
after its 52nd reported test and was stopped. Each reported failure was reproduced
with the old discovery guard restored temporarily in generated output, then the
patched output was restored. Baseline logs are preserved alongside this report.
These are follow-up work, not discovery regressions. The suggested Flutter
reducer check was not run because no Flutter source changed.

The first browser setup attempt reported a transient creation 503 and timed out
waiting for the response body despite UI reconciliation. MCP managed-service
logs had no matching creation error (the test uses a separate isolated runtime).
A direct isolated server-command diagnostic succeeded. Subsequent reproduction
and final verification use canonical database/UI assertions rather than awaiting
an abortable creation response body; the final browser run had no HTTP failures.

Validation used isolated test instances. The original managed campaign service
was not restarted/reseeded. No commit, push, PR, or Handrail database/queue mutation
was performed. Existing sibling workspace changes were preserved.

## Preserved campaign artifact references

All paths below have prefix `campaigns/40616bf8-6630-4252-bec1-141964ae2028/`.
Artifact content route: `/api/pm/qa-campaign-artifacts/<artifact ID>/content`.

| File | Artifact ID | SHA-256 |
| --- | --- | --- |
| `18-react-dm-reply.png` | `e2b97c9c-be8f-41c3-97a2-d98806238b79` | `e195e3b6accd56096c54112dedb9c91637cdced820865735a354bd3b325afc85` |
| `22-react-group-reply.png` | `4c845ce6-7fe8-428a-a3e5-a2bdd342d342` | `bdab2646dd4f4474d9a1c71b7e90243fd91d4b7ea1bfa66cf305ad5ba4a3f9ed` |
| `61-react-conversation-discovery-after-actor-return.png` | `e55763f6-6947-42df-a705-65b5396a8ef6` | `fbcb5680a73d35c7e3d78e56e1bc46f0af9813129b9101d8e105ca1137d66d6a` |
| `62-flutter-bob-retained-conversations.png` | `0e6ff063-80ac-4beb-91ae-d53ac189d2d5` | `ef2b41fc8cf9a22ea46d48dbed61d5295ef47c880970ec734009152e822b4a51` |
| `64-react-existing-dm-recovered.png` | `540f521e-ee95-4e4e-955a-0976817564c0` | `1bc652cd79b74d50658b81b147e213ae343e47872717783c433a72fdf308222c` |
| `69-react-dm-discovery-lost-again.png` | `27d6a2d5-760b-4aa8-a2e9-925d8f7c6429` | `278d46179a1568d81c21cfc21d721e912bf13075d4e9ced5d95b1fa12429b4de` |
| `observed-requests.json` | `de564f1e-adba-4ba5-a005-056c2c506637` | `61c714ad3530ff54f8076af439ce7810ee6fb4047dfcd14bf3ca9c52be299565` |
