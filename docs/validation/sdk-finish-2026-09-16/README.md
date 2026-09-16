# SDK readiness candidate — sdk_finish, 2026-09-16

Recommendation: **not ready for ERP integration**. This is engineering verification,
not independent acceptance. Keep Hitcents ERP read-only. Full QA, reviewed public
HTTPS Git publication, clean pinned-consumer builds and the explicit owner
readiness/integration gate remain required. No commit, push, PR, deployment,
Handrail database/queue mutation or ERP modification occurred in this assignment.

The producing work request is `acc42b17-72fa-44ca-94b1-ee74e0a72785`, run
`5d4c3c1c-1b0c-41fc-a0a1-d33b1a9c196b`. The saved brief and all four attached
memories were read. The saved assignment ends mid-sentence after
`read/repo_changes sc`; no omitted runtime authority is inferred. The explicit
workflow scope is read/repo_changes in dev. No applicable AGENTS.md was found.

## Candidate integrity and preparation

All three checkouts were visible in the actual shell executor and initially clean
on main, equal to their local origin/main refs. No merge/rebase/lock repair was
needed after the reported deferred synchronization; no fetch was used to alter
that evidence. Working changes are identified separately from these base commits:

| Checkout | Base HEAD | Manifest version |
| --- | --- | --- |
| JS/server/React/UI | `39067acae0926257431106666c2605e61bc161e1` | 1.0.33 |
| Flutter | `dd928dd57c5adbeb5ed8e002270ffb8be9e4b292` | 0.1.22 |
| Preview host | `f5ff800e6b5d4098250c9f3967ea75cc2c4b13dd` | 0.1.13+1 |

Before any install/build, package.json and both package-lock version fields were
1.0.33; generated client source was 1.0.32 (SHA256
`8149aa8332432ac3b6b8609a21e20aa34e102fbecd2e0ee976ebf9885399b330`). The direct
check failed without rewriting it. The generator now produces 1.0.33. Check mode
also rejects missing/malformed locks and either mismatched root version field.
Every JS CI workflow gates npm ci with the dependency-free check. Lifecycle tests
execute the Node and PostgreSQL workflow command ordering with stale/aligned
fixtures and prove install-first ordering conceals drift. Flutter versions remain
independent; no dependency pin was changed.

The existing dependencies were used, with Node 22.23.1, npm 10.9.8, Flutter 3.41.7
and Dart 3.11.5. The shared Flutter launcher cannot write engine.stamp; the already
installed Dart binary and Flutter tools snapshot provide the documented read-only
SDK invocation. Analysis and tests are separate receipts. PostgreSQL 16.15 server
and client packages were extracted privately from the checksum-pinned PGDG URLs
in the historical reproduction recipe. No system package install was needed.
Preparation is not a database-test pass. Tests used a fresh private native cluster,
TCP disabled, local mode-0700 Unix socket, test-only TEST_DATABASE_URL, unique
schemas and the canonical shipped migrations. Ordinary DATABASE_URL was removed
from the test process. The owned cluster is stopped and removed after testing;
remaining-schema output is retained independently.

## Compatible repairs

- React workspace no longer lets its temporary created row mask a definitive
  unavailable response; selection falls back to an existing conversation.
- JS terminal media-provider disconnect releases tracks/subscriptions and permits
  fresh rejoin; provider reconnecting keeps the live session.
- Flutter media follows canonical huddle invalidation, closes provider resources,
  invalidates late connections/permissions/queued operations and permits rejoin.
  Successful leave clears ephemeral join material.
- PostgreSQL source tests now import freshly built output instead of asking Node
  strip-only mode to execute TypeScript parameter properties. Huddle tests no
  longer assume their migration is the last shipped migration, and the screen
  share parent passes its test context to subtests.
- Stale UI fixtures were reconciled with required isStarred metadata, exclusive
  Starred grouping, DM-first order, virtualized rows and actual accessible labels.
  These fixture repairs do not count as new product behavior.

## Acceptance matrix

“Implemented” means source exists. Passing unit/fixture tests do not establish
live media, native device behavior, current deployed UI or independent acceptance.
The exact command results and outstanding failures are in [verification](verification.md).

| Criterion | Required behavior / implementation | Current evidence and remaining acceptance |
| --- | --- | --- |
| candidate-integrity | JS manifest/lock/generated version agreement before lifecycles; independent Flutter distribution; compatible source changes | Pre-install failure retained, generated repair and workflow/lifecycle regressions. Build/typecheck results retained. Dirty patch/file hashes identify the candidate; no published candidate SHA exists. |
| threads-and-settings | Current/Discord preference saves, reload/reconnect, remote propagation, failed-save recovery; preference cannot reroute queued sends | JS/Flutter preference runtimes and settings UIs; contract/unit/widget checks, real PG16 mounted React/HTTP/WebSocket/storage test. Happy-dom is not browser evidence. Final live React↔Flutter save/reload/reconnect still requires QA. |
| threads-and-settings | Create/open one canonical named thread per root, navigation/deep links, authorized source context, unavailable/deleted sources, close/reopen/lock; retained drafts | Existing client/server/thread controllers and widgets; lifecycle/list contracts, React workspace tests and Flutter widget coverage. React created-conversation fallback repaired to exclude an unavailable optimistic row. Native routing/touch/keyboard/Back still unverified. |
| threads-and-settings | Independent unread cursors, follow/notification preferences, mention opt-out and authorized delivery | Real PG thread cursor/access/notification tests plus client reducers. Full suite failures remain explicit; no provider delivery or OS notification acceptance is claimed. |
| huddle-media | Start/join/leave/rejoin/end, mute, denial, transport loss, identity changes and cleanup | Server persistence/HTTP commands, JS media session/UI and Flutter provider-neutral delegate/controller. Cleanup regressions added. Unit fake providers prove ownership/control flow, not exchanged media. |
| huddle-media | Two real participants exchanging audio on supported React/Flutter surfaces, denied permissions, disconnect recovery and track/device cleanup | **Unverified runtime gate.** React lab has a WebRTC boundary; Flutter lab delegate is explicitly a local fixture. A supported real Flutter/native provider handoff and actual media observations are required. Neither disabled controls nor synthetic tracks establish this pass. |
| integration-essential-behavior | Trusted identity/tenant, permissions, directory visibility, revocation/logout | SDK auth/directory/permission adapters and real PG HTTP/socket authorization suites. Host ERP actor/tenant/session-handle policy remains future implementation. Current ERP source is not mounted in this worker; retained planner mappings are historical. |
| integration-essential-behavior | Canonical migrations, transaction persistence, realtime replay/idempotency, disconnect cleanup | Private PG16 tests use actual storage and HTTP/WebSocket boundaries. No in-memory SQL replacement. Full-suite failures must be repaired/reverified; passing subsets do not waive them. |
| integration-essential-behavior | Authorized files/uploads/downloads/cleanup, enabled notifications; unavailable adapters and disabled features fail safely | Existing storage/notification/media host boundaries with narrow edge fixtures, real SQL lifecycle tests and safe UI states. Provider storage, native picker/push and real media delivery remain host qualification. |
| integration-essential-behavior | Effective authentication policy | Snapshot d1901171900c: host authentication API limiting enabled at 10 requests/60 seconds. No password minimum/complexity or MFA requirement added. SDK admission is not the host login limiter; verify the host exchange/login boundary during later integration. |
| independent-full-qa | Independent final-candidate review across entire matrix, no unresolved blocking defects | **Pending.** The broad Node/PostgreSQL failures and runtime gaps prevent readiness. This engineer's checks cannot grant independent acceptance. Existing task planner owns the handoff; no new controller/campaign/monitor was created. |

## Runtime and historical UI evidence

Handrail dev-service status reported both chat-lab and Mobile Preview stopped,
with no scoped QA browser route. This worker did not start a persistent service
or browse a raw listener. QA capture/browser tools are not exposed in this run.
Fresh current React/Flutter captures are therefore **unverified**, not waived.
Runtime preparation requiring service/config/resource actions belongs in a
separately scoped handoff through the supported service, QA Vault and Mobile
Preview paths. It is not a prerequisite for the source/unit checks above.

Two existing bounded 390×844 captures were visually inspected: React
`docs/validation/react-thread-controls/after-390x844.png` shows a named thread,
source context, closed state and reachable controls; Flutter
`docs/validation/flutter-named-threads/browser/created.png` shows a named thread
with source context and composer. They are historical September 7 evidence,
not captures of this changed candidate or proof of interaction/media. Original
bytes/provenance are retained, and any delivered copies are labelled historical.
The earlier 4px Send-padding observation remains historical until fresh QA.

Preview pubspec/lock pin the demo at dd928dd…, while its transitive SDK is still
51bc3e1411858ce38980f5beded683dee957d1a3. A normal preview rebuild therefore does
not exercise this uncommitted Flutter patch. README now distinguishes those pins.
The preview is web-only. The existing SDK ERP native example declares Android
INTERNET in the main manifest and iOS ITSAppUsesNonExemptEncryption=false. No
new native scaffold was created; those settings do not establish microphone
permission configuration or device acceptance.

A release reviewer must select reviewed full HTTPS Git SHAs and matching locks
before final consumer/native qualification; no local/file dependency workaround
or ad hoc publication is authorized.

## Continuation and minimal ERP recipe

Use [the updated integration recipe](../../hitcents-integration.md). Retained ERP
web/mobile seam hashes support planning, not refreshed inspection or runtime
acceptance. The order remains: repair failing candidate checks; freeze and
independently QA the exact patch including real huddles; reviewed Git release and
clean pinned consumer build; present evidence and not-ready/ready recommendation
to the owner; only then seek the saved integration gate and scoped ERP work.

The existing SDK lead owns repair of each failure in verification.md and callback
to the existing task planner with final hashes and rerun receipts. Independent QA
owns final acceptance and supported UI/native/media evidence. Main/planner owns
any later runtime preparation outside this stage and release review. Do not reuse
historical cancelled work or September 11 monitoring references as live work.
