# React source-root retention

Work request `450cd662-cc6e-471f-86af-03e8d0975af5`; finding
`e069389a-9182-4768-a959-d8a7c5e8be6d`; campaign
`298e20b4-4faf-4283-949d-3801cf437aa8` (dev). Inspected repository HEAD:
`c82abe8d19a81ec599a9771e0c449ee0605c3242`. Validation: 2026-09-07.

## Failure boundary and repair

Handrail current context confirmed the scoped request. Dev-service status reported
the shared `chat-lab` healthy on port 4167; the separate Mobile Preview service
was stopped. The campaign Flutter surface is the shared lab's
`/__flutter-chat-lab/` route, not that separate service.

Source inspection found that ordinary thread-summary/cache-refresh invalidation
already preserves canonical roots. Reconnect handling still explicitly purged all
IDs tracked by message context. Resolving an inline preview tracks its source ID
even if the source was loaded by the ordinary channel timeline. Disconnect then
removed that source from both the entity cache and timeline. Reconnect resolved
the preview again, but an inline lookup does not hydrate a timeline row, leaving
the connected client with replies and no root. Temporary lookup failures used
the same destructive cleanup.

Before changing production code, a regression using the real client, normalized
cache, parser and websocket admission reproduced a root count of **0 instead of
1** at disconnect, after Bob-to-Alice identity switching and a remote canonical
thread summary. All 55 previous tests passed. This establishes an application
cache defect independently of project env, deployment, storage or provider
configuration. It does **not** prove that disconnect was the campaign's exact
uncaptured trigger.

`src/client/message-context.ts` now clears derived previews/windows and aborts
pending work on connection changes without deleting authorized canonical rows.
Offline/transport errors also retain those rows. The tracked IDs remain available
for destructive cleanup on access revocation, authentication failure, identity
change, deletion/unavailability and client close. The change preserves existing
thread entry points, UI modes and server authority.

## Campaign evidence reviewed and preserved

Both supplied screenshots were reviewed: the connected Alice view first lacks
the source while displaying two Friday replies; jump-to-original restores the
source and named-thread entry point. The runner's resolved attachment directory
does not exist, so the two DOM JSON attachments could not be opened independently.
Their reported zero/one counts remain campaign evidence, not fresh measurements.

A sibling repair had preserved `canonical-final.json`. Its SHA-256 exactly
matches the supplied attachment:
`fa6e7a2dd32213fc53302379c999898b0a9a8ca76c66db9d05c148a21e279831`.
The unchanged [copy](campaign-canonical-final.json) records the read-only
PostgreSQL inspection at `2026-09-07T18:09:12.105Z`: Alice's source
`832e136b-5ddc-41db-a2e4-9b3190f778a6` remains sequence 1 in Launch planning,
both Friday replies point to it, and the two named threads have distinct roots.

Original artifact references (preserved without modifying campaign/queue state):

- `campaigns/298e20b4-4faf-4283-949d-3801cf437aa8/48-react-root-missing-after-cross-client.png` — `/api/pm/qa-campaign-artifacts/3b218cf3-3d37-48ec-95b0-504f1fbca0bd/content`
- `campaigns/298e20b4-4faf-4283-949d-3801cf437aa8/react-root-missing.json` — `/api/pm/qa-campaign-artifacts/e6883372-2d76-488c-bbb2-ca11ac6e82f7/content`
- `campaigns/298e20b4-4faf-4283-949d-3801cf437aa8/49-react-jump-root-recovery.png` — `/api/pm/qa-campaign-artifacts/e0e32c25-80e5-4f39-9d63-af7ef644c030/content`
- `campaigns/298e20b4-4faf-4283-949d-3801cf437aa8/react-root-jump-recovery.json` — `/api/pm/qa-campaign-artifacts/c59954fd-1c02-41f7-985a-3bb3ecba5892/content`
- `campaigns/298e20b4-4faf-4283-949d-3801cf437aa8/canonical-final.json` — `/api/pm/qa-campaign-artifacts/5d0390d1-c414-4afb-a981-0e37faef9d72/content`

## Fresh verification

Checks ran sequentially with one test worker:

| Check | Result |
| --- | --- |
| `node scripts/test-client-message-context.mjs` before patch | 55 passed, new regression failed; [log](before.log). |
| Same command after patch | Scoped production compile/public typechecks and **62/62 tests passed**; [log](context-tests.log). Includes stale-response cancellation and access-loss cleanup. |
| `npm run build` | Full TypeScript compilation passed; [log](typescript-build.log). Incidental generated package-version change restored. |
| `node scripts/test-client-thread-lifecycle.mjs` | Scoped compile/public typechecks and **55/55 lifecycle/thread-opening tests passed**; [log](thread-tests.log). |
| `playwright test e2e/chat-lab.cross-client-root.spec.mjs --project=chromium --workers=1 --retries=0` | **1/1 passed** with actual React and compiled Flutter clients; [log](browser-tests.log), [evidence](browser-evidence.json), [screenshot](react-root-retained.png). |
| Suggested Flutter reducer test | Could not launch: `flutter` is absent from PATH; the absolute SDK executable attempts to update read-only `bin/cache/engine.stamp`; [log](flutter-check.log). No Dart code changed for this request. |
| Scoped `git diff --check` | Passed. |

The configured DB endpoint `127.0.0.1:34799` refused connections, and Docker was
unavailable. Browser validation instead used temporary native PostgreSQL 15 with
UTF-8, no TCP listener and a unique workspace Unix socket. `CHAT_LAB_DATABASE_URL`
was supplied only to the test process. The existing production-migration-backed
Chat Lab harness created and dropped its own schema; the temporary database was
stopped and removed afterward. No new database abstraction or mock persistence
was introduced. An initial temporary DB launch using SQL_ASCII failed migration
encoding conversion; initializing it as UTF-8 resolved that test setup issue.

The browser regression sends Friday from React and Flutter, creates the first
named thread from React, switches React from Bob to Alice while Flutter creates
the second named thread, and checks the visible root and its thread button.
It then closes the real SDK websocket and observes the DOM through reconnect:
the root never disappears and remains present exactly once, without jumping to
the original or reloading. Alice opens the canonical first discussion from the
source, then reloads her route with retained history. SQL verifies two distinct
named discussions and the first discussion's original root identity. HTTP,
websocket events, migrations and PostgreSQL storage are real; the regression
controls only transport timing. The existing compiled Flutter bundle's provenance
is recorded in the evidence; this request did not rebuild or change Flutter.

This is repository-local acceptance evidence, not a redeployment or rerun of the
original managed campaign. Existing sibling changes were preserved. No commit,
push, PR, project configuration change, or Handrail database/queue mutation was made.
