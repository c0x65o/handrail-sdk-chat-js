# React archived-history opening

Work request: `ee06e7d7-8499-44f3-903c-144a179255cd`.
Campaign: `40616bf8-6630-4252-bec1-141964ae2028` (dev).
Finding: `48b1e140-ed4b-4bc1-8886-d164260c4254`.
Approval: `7cc077b2-bde1-4d6a-a14e-4ad0ac10a238`.
Validated 2026-09-07.

## Failure boundary and campaign evidence

The supplied screenshot shows Bob opening **Archived launch notes**, with a
one-reply summary, and receiving **Thread unavailable**. The campaign reports
that both Open Thread and Retry sent
`POST /api/chat/messages/5607ba69-ae42-47fc-8b44-6b815eda7d9b/thread`,
operation `create_thread`, receiving `403 CHAT_AUTHORIZATION_FAILED`. It also
reports a later successful Flutter history GET.

Original evidence references, preserved from the work request:

- `campaigns/40616bf8-6630-4252-bec1-141964ae2028/50-archived-history.png`, artifact `b24172c1-c398-4f83-b67a-9be199907d53`, SHA-256 `3a1f67e9ddf5c6ab6f2eccfec32a42d18a7ecfc6c6bf523ffefd2709a66d1971`.
- `campaigns/40616bf8-6630-4252-bec1-141964ae2028/51-archived-retry.json`, artifact `1ae71eb6-c683-4b11-8d46-33d7983af5db`, SHA-256 `b2e449d9254b82a4d3c904acffce0864e90981d765ebb1b28821ff524eb4d7fa`.
- `campaigns/40616bf8-6630-4252-bec1-141964ae2028/observed-requests.json`, artifact `de564f1e-adba-4ba5-a005-056c2c506637`, SHA-256 `61c714ad3530ff54f8076af439ce7810ee6fb4047dfcd14bf3ca9c52be299565`.

The image supplied in the prompt was reviewed. The resolved attachment directory
does not exist in this worker, so the original JSON contents could not be read
independently; the request details above are campaign-reported evidence.

Before editing, Handrail MCP confirmed the active project/work request and a
healthy supervised `chat-lab` dev service on port 4167, with health/readiness
HTTP 200. Its configured launch builds this checkout before starting the lab.
The dev environment lists `CHAT_LAB_DATABASE_URL`, `CHAT_LAB_SEED_PROFILE`, and
the managed PostgreSQL keys. No Kubernetes deploy targets are configured.
The available campaign-window service log tail contains unrelated WebSocket
EPIPE messages, with no matches for the root ID, `create_thread`, `archived`, or
`CHAT_AUTHORIZATION_FAILED`; it provides no credential-failure evidence.

Source inspection identifies an application operation-selection error:
`useThread` and the root-panel Retry action call `client.openThread(rootId)`;
`beginThreadOpening` previously dispatched creation even when a canonical root
summary supplied the existing thread ID. `create-thread-command.ts` deliberately
rejects archived existing threads. `thread-access.ts` explicitly permits
authorized archived-history reads. The documented fixture creates a real thread,
adds retained history, and archives it through the SDK. This is consistent with
the reported 403 and requires no environment or authorization-policy change.

## Change

Root opening now delegates to the existing read-only thread-opening path when
the root summary identifies a thread. It publishes the existing root-keyed
loading/ready/error states, coalesces concurrent opens, and guards late completion
after close. Failed reads remain reads on Retry. Roots without a canonical thread
continue through creation. Server archive and access checks remain authoritative.

## Verification

- `npm run build`: passed (full TypeScript compile).
- `node --test test/client-thread-opening.test.mjs`: 36 passed, including new
  archived root opening and retries after HTTP 403/503 at the HTTP boundary.
- `node --test test/thread-panel.test.mjs test/thread-panel-import-guard.test.mjs`:
  62 passed.
- `npx tsc --project tsconfig.client-thread-opening-type-tests.json`: passed.
- From `examples/drop-in-react`,
  `PLAYWRIGHT_BROWSERS_PATH=/opt/handrail/repos/handrail/handrail-chat/handrail-sdk-chat/build/playwright-browsers npx playwright test e2e/chat-lab.archived-history.spec.mjs --project=chromium --workers=1 --retries=0`:
  1 passed. Chromium was installed into ignored workspace build
  storage after the first launch reported a missing executable.
- `git diff --check`: passed.

The browser regression uses the existing Chat Lab harness with URL-backed real
PostgreSQL, production migrations/routes and a disposable schema. It proves Bob's
inline Friday reply has the channel destination and original reply reference,
with zero threads before the documented `create_archived_thread` control. Bob
then opens the archived root, sees retained history, reloads, encounters an
injected network failure on the detail GET, and successfully retries. There are
zero thread-creation POSTs after fixture setup, exactly one persisted thread,
and the archived thread's Send button remains disabled. Normal UI directory
requests and read-cursor updates are included in the request evidence.

Fresh evidence:

- [Open screenshot](archived-history-open.png)
- [Retry screenshot](archived-history-retry.png)
- [Observed request methods/paths and database harness kind](archived-history-requests.json)

Validation ran against an isolated lab instance built from the changed workspace.
The original managed campaign instance was not restarted or re-seeded. Flutter
source is outside this patch; its suggested reducer check was not needed for the
React/client operation-selection change. Existing sibling workspace changes were
preserved. No commit, push, PR, or Handrail queue/database mutation was performed.
