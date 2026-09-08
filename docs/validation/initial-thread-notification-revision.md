# Initial thread notification preference revision

Work request: `60f0b282-d23b-49f9-b1e6-102215363302`.
Finding: `da22ad52-eb66-476a-8c23-e69c24e4b5a9`.

## Failure boundary and repair

This is an application serialization/hydration defect. `ensureThreadParticipant`
creates default conversation preferences; the canonical PostgreSQL migration
initializes their `preference_revision` to 1. The preference mutation correctly
compares against that stored revision. However, the thread creation response and
conversation detail/list queries omitted it, and both client snapshot reducers
left their preference revision maps empty. The first mutation therefore used 0.
No environment, provider configuration, database reset, or schema change is needed.

Conversation creation, thread creation, conversation detail/list, and thread list
snapshots now expose `currentPreference.preferenceRevision` from the database,
including 0 when the actor has no preference row. React/TypeScript and Flutter
hydrate that authority into their revision maps, order versioned preferences by
revision, and retain pending local projections. Lower-revision snapshots cannot
replace newer canonical preference values. The additive field is optional for
legacy snapshots; both parsers validate nonnegative safe integers. Generated Dart
output and its generator/HTTP descriptor are updated together.

## Preserved campaign evidence

Campaign `ab6cb21d-834b-4cd7-8a68-fb958924a76f`, dev, custom playbook.
Campaign work request `07e977bc-f964-483b-bb06-fde6848a16a1`, Codex run
`7d605cde-81d4-47ff-9cf6-83bffe5ba7af`. Approved action
`7ed8c678-3d97-45a4-8091-bf92cac595fa`.

The three attached images were reviewed: Bob's initial conflict, his successful
retry, and Alice's independent initial conflict. The reported transport values
are expected revision 0 versus authoritative revision 1, with HTTP 409; Bob's
retry at revision 1 succeeds. Original artifact references are preserved below.
The resolved attachment directory was absent in this worker, so the transport
JSON bytes could not be independently reread; these transport values are from
the accepted work request, not a newly captured browser trace.

| Artifact under `campaigns/ab6cb21d-834b-4cd7-8a68-fb958924a76f/` | Original content endpoint |
| --- | --- |
| `31-thread-state.png` | `/api/pm/qa-campaign-artifacts/ff301518-74a3-4159-887b-7d534aa755ba/content` |
| `32-notification-retry.png` | `/api/pm/qa-campaign-artifacts/ec30166c-27d0-486e-92cb-af5d0c62dc60/content` |
| `46-alice-first-preference-conflict.png` | `/api/pm/qa-campaign-artifacts/de5e7551-83ac-4299-b7f3-3bba8eac4fff/content` |
| `transport-evidence.json` | `/api/pm/qa-campaign-artifacts/cbf8db3b-3b76-4320-a428-19f24ae31d66/content` |

Transport artifact supplied SHA-256:
`eadbfdb36368f18b6cc61a64d6e952f8420f41d889cee4bfee1fae7622ca7f7d`.

## Verification

- `tsc --project tsconfig.json`: passed; compiles all TypeScript source.
- `node scripts/generate-conversation-snapshots.mjs --check`: passed.
- Node snapshot contracts, generation, and notification UI suites: 33 passed.
- Focused detail/list client preference regressions: 2 passed. Both fail with the
  original `normalized-cache.ts` and pass with the patch.
- PostgreSQL regression and scoped detail/list queries: 7 passed. Used the repo's
  `createPostgresTestBackend` URL-backed harness against disposable local
  PostgreSQL 15.19 with isolated schemas and canonical migrations. No persistence
  mocks or shared application databases. The first-save regression calls the real
  thread creation and snapshot queries and connects the real client to the real
  preference command through an HTTP transport boundary fixture. Bob and Alice
  each send revision 1 once, receive `applied`, and reopen at revision 2 with
  Mentions only. A stale revision-1 update still conflicts; a visitor without a
  stored row receives revision 0. The owned test server was stopped afterward.
- Flutter preference client, generated snapshot, and suggested durable resource
  event reducer suites: 71 passed, `--no-pub --concurrency=1`. The normal Flutter
  launcher cannot write the SDK's read-only `bin/cache/engine.stamp`. Executing
  the existing cached `flutter_tools.snapshot` with the bundled Dart executable
  and `FLUTTER_ALREADY_LOCKED=true` ran the tests successfully without changing
  the installed SDK.
- `git diff --check`: passed.

Logs are in `build/notification-revision-*.log` and
`build/notification-revision-postgres/{test,queries,final}.log`.

Broader checks exposed existing failures outside this repair: three client
preference tests expect different authentication/stale-event outcomes, and four
older client snapshot tests have incomplete fixtures. All seven reproduce with
the original cache source. Broader PostgreSQL tests also encountered a fixture
`UNION` text/timestamp type mismatch and an existing create-conversation
idempotency timestamp-order constraint failure; the latter occurs during the
claim insertion before the changed snapshot query. No changes were made to those
behaviors. Existing detail/list fixture expectations were updated for the newly
returned revision field, and those scoped tests pass.

Handrail MCP confirmed the active work request and reported both configured dev
services stopped with no browser route. Validation here is local integration and
client testing, not a replay of the dev browser campaign. No deployment, PR,
commit, push, or Handrail database/queue mutation was performed.
