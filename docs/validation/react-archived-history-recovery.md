# React archived history recovery after authentication denial

Campaign: `e86154cb-28b8-4a74-85be-3140ec99a04f`.
Finding: `6c4a7968-df42-4657-b546-b6eba46ea2a4`.

## Failure boundary

Application client state. Handrail MCP confirmed the project context and a
healthy supervised Chat Lab service. The available dev logs contained earlier
WebSocket resets but no provider authentication failure. No Kubernetes deploy
targets or provider capability env requirements are configured for this project.
The supplied screenshot evidence was available; the resolved JSON attachment
paths were absent in this worker.

Before changing product source, the existing archived Retry browser regression
was extended to require visible recovered history. It reproduced the failure:
both detail and messages reads returned HTTP 200, the opening error disappeared,
and `Retained archived launch history` remained absent.

Discarding history after denied reads also revokes the lifecycle runtime. A
successful subsequent opening hydrated messages but left lifecycle access revoked,
which caused the React panel to suppress its timeline.

## Change

An existing-thread opening now captures a guarded lifecycle recovery callback
before starting fresh reads. Only successful opening and atomic cache hydration
can reconcile that denial. A changed identity, session, or revocation generation,
revoked parent, or inactive membership prevents reconciliation. Ordinary cache
updates and realtime events cannot grant access. The recovered lifecycle uses
canonical cached metadata, and archive restrictions continue disabling sending
and lifecycle actions. Both root-link and discovery openings share this path.

## Validation

- `npm run build`: passed, including full TypeScript compilation.
- `HANDRAIL_THREAD_LIFECYCLE_BUILD=../dist node --test --test-concurrency=1 test/client-thread-opening.test.mjs test/client-thread-lifecycle.test.mjs test/thread-panel.test.mjs`: 122 passed.
- Chromium: `chat-lab.archived-retry-layout.spec.mjs` and
  `chat-lab.archived-history.spec.mjs`: 2 passed with one worker, no retries.
- The recovery regression removes Authorization only on archived detail/messages
  GETs and uses real HTTP 401/200 responses. It verifies hidden history on denial,
  visible history after a normal Retry click without reload, and disabled Send
  at 1280×720, 1440×1000, and 390×844. Directory reads keep normal credentials.
- Runtime tests cover 401/403 recovery, retained archive state, cache-only
  non-recovery, and rejection of recovery across changed access boundaries.
- `git diff --check`: passed.

Browser validation used the existing Chat Lab PostgreSQL harness with production
routes/migrations and a disposable schema, not the managed campaign database.
This validates real authorization and client recovery, with no persistence
implementation change. Unit tests mock only HTTP boundaries. Browser artifacts
are in `build/archived-history-recovery-before` and
`build/archived-history-recovery-after`; unit output is in
`build/archived-history-recovery-unit.log`.

Existing workspace edits were preserved. No commit, push, PR, deployment, or
Handrail database/queue mutation was performed.
