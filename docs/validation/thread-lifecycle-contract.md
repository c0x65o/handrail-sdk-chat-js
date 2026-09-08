# Thread lifecycle HTTP contract verification

Owner task: `a84be296-776e-4754-a0a6-64bc85826c3c`  
Date: 2026-09-06  
Repository: `handrail-sdk-chat`; patch left uncommitted.

The canonical source is `contracts/http/thread-lifecycle.json`. The dedicated
`scripts/generate-thread-lifecycle.mjs` renders only
`src/contracts/thread-lifecycle.ts` and
`flutter/handrail_chat/lib/src/generated/thread_lifecycle.dart` from its two
`scripts/templates/thread*lifecycle*` templates. Semantic descriptor changes fail
closed until the generator's supported hash and both validators are reviewed.
It reuses the existing `ThreadLifecycle` model and validators, including their
existing string-wire convention for closure metadata; it adds no second model.

The reserved `PATCH /conversations/:threadId/lifecycle` contract uses explicit
close/reopen/lock/unlock intent, expected revision, and idempotency key. The path
supplies the thread ID; body parsing rejects a duplicate body ID. Results echo
all correlation fields and include canonical before/after lifecycle snapshots.
The validators enforce the transition matrix, closure preservation, one-step
revision increments, no-op/conflict consistency and safe-integer overflow rules.
The before snapshot is needed to verify that close retains lock state and that
lock/unlock retain any existing closure pair. It is never a client input.

Revision comparison precedes no-op reconciliation. A locked reopen conflicts even
at a matching revision. Replay returns the original applied snapshots; no-op and
conflict retries retain their original status/snapshots. The canonical descriptor
specifies trusted tenant/actor idempotency binding and current authorization on
retries. Snapshot authenticity, idempotency storage and all server guards remain
implementation obligations for the sibling command/routing tasks.

`thread_lifecycle_v1` is reserved with missing=false and advertiseRuntime=false.
No runtime route, handshake advertisement, persistence, authorization command,
controller, UI or discovery behavior was added by this task. Archive and computed
hiding remain independent. Saved reply style cannot change shared lifecycle.

Shared files were re-read before narrowly adding exports in
`src/contracts/index.ts`, `src/client/index.ts`, and
`flutter/handrail_chat/lib/core.dart`, and five dedicated scripts in
`package.json`. Existing prerequisite/sibling changes in these and other files
were retained. No unrelated generator was run and the Flutter preview repository
was not changed.

## Checks

Expensive checks ran sequentially. Both test commands use one worker.

| Exact command | Result |
| --- | --- |
| `node scripts/generate-thread-lifecycle.mjs` | Generated the two scoped production outputs. |
| `npm run test:thread-lifecycle` | 197 passed, 0 failed. Includes TS JSON round trips, generator determinism, missing-output detection and independent TS/Dart drift detection in temporary directories. |
| `npm run typecheck:thread-lifecycle` | Passed, including root and client public exports, canonical lifecycle assignability and negative type checks. |
| `npm run check:thread-lifecycle` | Passed; generated outputs up to date. |
| `cd flutter/handrail_chat && /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart test --concurrency=1 test/generated_thread_lifecycle_test.dart` | 194 passed, 0 failed; imports the public core export. |
| `cd flutter/handrail_chat && /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart analyze lib/src/generated/thread_lifecycle.dart test/generated_thread_lifecycle_test.dart` | No issues found. |
| `git diff --check -- src/contracts/index.ts src/client/index.ts flutter/handrail_chat/lib/core.dart package.json` | Passed for shared-file edits. |

Both languages consume `test/fixtures/thread-lifecycle-http.json`: 47 valid,
84 invalid-request and 62 invalid-result cases. Additional language tests cover
non-finite numbers, direct constructors/serializers and the HTTP path/body
boundary. Cases exercise every intent from every valid state, all reconciliation
outcomes, every correlation field, forbidden aliases, closure pairs, locked/open
invariants, minimum/maximum safe integers, overflow and closure preservation.

Initial toolchain attempts were unavailable through their wrappers:
`npm run test:thread-lifecycle-dart` reported `dart: not found` in npm's PATH;
`/opt/handrail/.handrail/flutter-sdk/bin/dart test --concurrency=1 test/generated_thread_lifecycle_test.dart`
from the Dart package failed because its wrapper attempted to write the read-only
SDK `bin/cache/engine.stamp`. The installed cached Dart executable shown above
successfully ran both tests and analysis without modifying the SDK. The portable
npm script remains suitable for environments with Dart on PATH.

No SQL, database proof, QA campaign or operational action was needed. Runtime
integration remains scoped to the already listed sibling tasks, not a blocker
for this descriptor item.
