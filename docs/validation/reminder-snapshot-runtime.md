# Reminder snapshot runtime verification — 2026-09-06

Work request: `2981bd4e-9e92-4db0-85e9-43c22bcb4766`.
Campaign: `5804d021-2439-4fe5-a75c-93e44674c89b`.

## Failure boundary and repair

Before further product edits, authenticated probes of the supervised Chat Lab at
`127.0.0.1:4167` reproduced 200 for `?limit=100` and 400
`CHAT_MESSAGE_REMINDER_LIST_INVALID_REQUEST` for either boolean value of
`includeCancelled`. The checkout already contained the HTTP boolean parser,
cancelled snapshot serialization, client revision hydration, and host hydration
component. Service logs showed Vite client reloads; the backend was still the
long-running Node process.

Restarted `chat-lab` through `handrail_dev_service_action`. Its existing command
builds the SDK, installs the example dependencies, and starts a fresh Node
backend. No project environment/configuration or product behavior workaround was
needed. All three HTTP variants then returned 200. This before/after behavior
identifies a stale loaded backend as the failure boundary; it does not identify
which old closed-over parser function was cached.

Restarted instance: `cd49832edb4916427c6f5ff54821b4e4`, loaded at
`2026-09-06T02:16:23.288Z`. The existing loaded-functions fingerprint was
`1718af4125020f27a5723a68be740c7461981cd64f304715c5544b36dd49a473`.
This scoped fingerprint is supporting evidence, not a complete dependency hash.
The lab restart creates fresh fixture IDs; the original campaign rows were not
used for the subsequent UI verification.

## Verification

- `test/postgres-message-reminder-http.test.mjs` and
  `test/message-reminder-snapshot-cancellation.test.mjs`: passed. Real PostgreSQL
  15, dedicated worker-local cluster, existing schema-per-test harness and actual
  migrations/router/query/serialization. HTTP coverage includes cancellation
  revision 3, `lastScheduledDueAt`, true/false/omitted and invalid parameters,
  actor isolation, and pagination from cancelled A to scheduled B with equal
  due timestamps (message ID tie-break). Rescheduling with the recovered revision
  returns 200.
- `chat-lab.reminder-hydration.spec.mjs --project=chromium --retries=0`: passed
  against the restarted supervised dev runtime and again against an isolated
  Chat Lab on a dedicated UTF-8 PostgreSQL database. Both use real browser UI
  actions and record outgoing reminder commands. Four setup writes, no writes
  on reload, first reschedule with revision 3, cancellation at revision 4, no
  writes during Ada → Grace → Ada, first reschedule with revision 5. Seven total
  writes; no reminder HTTP failures or retries. B stays at revision 1 with the
  same canonical due time and visible indicator; Grace's private list is empty.
- SDK `tsc --project tsconfig.json --noEmit`: passed.
- Example-wide `npm run typecheck`: fails in existing
  `src/ConversationStateChatLab.tsx` and `test/chat-fixture.ts` fixture types
  (conversation shape and missing `isStarred`). These files were not changed.

The worker-local cluster was stopped after validation. An initial isolated lab
attempt exposed an SQL_ASCII test-database setup error during Unicode reaction
seeding; PostgreSQL logs identified it and using a dedicated UTF-8 database
resolved it without application changes. Playwright's missing browser was
installed under the worker temporary directory.

The README now distinguishes Vite browser reloads from Node backend restarts and
documents how to run the regression against an isolated or freshly restarted lab.
Existing uncommitted snapshot repairs were preserved. The service build also
regenerated the client package-version constant to match package.json (0.1.89).
