# Lab database continuation — 2026-09-11

Source/test repair complete; live acceptance remains blocked. This is worker
evidence for the existing lead and independent verifier, not task acceptance.

## Diagnosis and exact artifacts

Scoped Handrail readers confirm project `1791fdf7-f197-483c-ba67-5c0da8f4315f`,
work request `8fa13e03-c2f6-48d3-bfc0-0daed5107d73`. All four attached memory
publications were read. See `diagnosis.json` for scoped reader provenance.

The service's materialized selection is **CHAT_LAB_DATABASE_URL**, a database-only
URL. Sanitized effective endpoint: `127.0.0.1:35513`, database
`handrail_chat_reply_styles_fab4ec11`. It has no embedded host, port or connection
query overrides; pg inherits PG settings. The worker shell separately selects
DATABASE_URL, so its environment must not be mistaken for Main's service env.
The service has no surviving process whose environment could be inspected;
selection is reconstructed from masked scoped metadata, materialized repo env,
the installed pg parser, source precedence and matching startup logs.

The managed resource inspection confirms its container is exited/unhealthy, with
matching ownership labels. Port 35513 is explicitly **last-known**, not a current
binding. Thus the evidence supports an unavailable managed resource, not a stale
embedded override. No connection was made to that database. Dedicated database
existence and role permissions remain unverified while it is stopped.

Revisions at start and finish:

| Repository | HEAD |
| --- | --- |
| JS | `e9c824ac1dde122d60404bebdaff35890f74c711` |
| Flutter SDK | `dd928dd57c5adbeb5ed8e002270ffb8be9e4b292` |
| Flutter preview | `f5ff800e6b5d4098250c9f3967ea75cc2c4b13dd` |

JS began with only the concurrent generated package-version edit (1.0.25 to
1.0.26); its bytes were preserved. No merge/rebase/index lock was present. The
server's deferred workspace synchronization was not bypassed: no reset, stash,
fetch, commit, pin change or Git operation was performed.

Against historical runtime artifact
`248f3f7986001f99414f5a149c477177059b1dcfc0a49be7c223a6190a5fc2eb`, the saved
independent 638-file source manifest matches 637 current files; the generated
package-version file differs. Both original lab scripts and both consumer
package manifests/locks match the retained historical full-source manifest.
Historical patches were not reapplied.

The example actually resolves `node_modules/@handrail/chat` version 1.0.20 at
public HTTPS Git pin `90bff33529df06720ff89ccd821360ac65eaf0d0`. The root package
is 1.0.26. Of 649 compared root dist files, 21 differ from installed dist,
including membership authorization/join behavior and Current-style thread Reply
UI fixes. `installed-vs-root-build.diff` contains the executable JS differences;
`initial-artifact.json` contains exact per-file hashes. The declared root build
does not replace that installed package. Private lab checks in this package use
the **actual installed package**, and cannot establish that the historical fixes
are being served.

Flutter's lab resolves Git SDK `51bc3e1411858ce38980f5beded683dee957d1a3`, not the
adjacent checkout's HEAD. Existing built web files are hashed in
`dependency-resolution.json`; their presence does not establish a successful new
build. The saved failed startup log also shows Flutter `pub get --enforce-lockfile`
continuing after DB startup failed, then failing locked dependency resolution.
No Flutter or compatibility suite was rerun and no lockfile was changed.

## Repair and verification

The lab now preserves options.databaseUrl → CHAT_LAB_DATABASE_URL →
TEST_DATABASE_URL → DATABASE_URL selection, rejects empty/malformed explicit
URLs, and never retries against a lower-priority database. Harness initialization
errors report the selector and allowlisted diagnostic code without retaining
driver messages, causes or credentials. Aggregate setup/cleanup failure remains
visible. CLI Flutter compilation now begins only after lab startup succeeds.

New source/tests are listed with final SHA-256 hashes in `final-artifact.json`.
No typed source changed; all seven changed/new JavaScript modules passed
`node --check`, and `git diff --check` passed.

- Negative control: the actual installed SDK treats an empty URL as container
  selection. A narrow testcontainers startup interceptor reproduced this before
  any container could start (`negative-control.json`).
- Nine focused checks passed: five selection/redaction unit checks and four new
  real PostgreSQL lab checks. These prove database-only PG inheritance, successful
  fixture startup, refusal/missing-database diagnostics without fallback, and
  cleanup after successful startup and occupied-port failure.
- Seven final unit checks passed after adding startup-order coverage: the five
  selection checks plus two Flutter startup/readiness checks.
- Actual CLI subprocess check passed: blank CHAT_LAB_DATABASE_URL exits 1 and
  never launches a sentinel Flutter executable (`cli-failure.json`). It cannot
  reach a database or bind a lab listener because selection fails first.
- Native PostgreSQL 16.15 ran as uid 993 with a private 0700 Unix socket, TCP
  disabled, 40 connections and 32MB shared buffers. Tests ran sequentially with
  concurrency 1. Existing qualification/acceptance environment isolation and
  native-cluster patterns were reused; the old completed suites were not run.
- Prior extracted binaries were absent from this worker's exposed filesystem.
  The same two PGDG16 packages documented in `../reproduce.md` were extracted
  privately under this run's tmp directory, with both recorded SHA-256 values
  verified. No system package install or managed resource provisioning occurred.
- Cleanup verified zero residual fixture schemas, an untouched sentinel schema,
  closed disposable lab listener, stopped PostgreSQL and removed owned cluster
  and CLI sentinel directories. Other resources were not stopped or removed.
  Extracted tool binaries remain in run-private tmp, not a running dependency.
- Final scoped service status remains stopped: no supervisor, no port-4167
  listener, and no QA route. No browser or raw-listener HTTP probe was used.

The resource guard briefly queued the unit command behind existing heavy work;
it subsequently completed normally. No abnormal memory or launch failure was
observed. The original independent 23-test PostgreSQL receipt was not rerun.

## Concrete handoff to Main

1. Obtain/use authority in **Handrail Chat SDK**, project
   `1791fdf7-f197-483c-ba67-5c0da8f4315f`, for **dev managed PostgreSQL resource
   startup and generated environment reconciliation**. The current worker is
   explicitly forbidden to provision/start this dependency or change config.
   The exact supported action for the existing resource is
   `handrail_dev_resource_action(action="start", resource_type="postgres",
   resource_id="c699099d-668d-4a0f-a5a0-7f52923f3e32")`. Do not recreate it or
   bind a substitute database to last-known port 35513. That action can reconcile
   generated PG/DATABASE settings; it needs resource/configuration authority
   separate from the previously authorized service-only startup.
2. Inspect the resulting current binding and the selected dedicated database's
   existence/access. Keep the database-only CHAT_LAB_DATABASE_URL selection.
   If the dedicated database is missing or denies schema creation, stop and
   request authority for the exact development database creation/grant; do not
   redirect into handrail_chat or create it under this worker's authority.
3. Main can then start **only the exact declared service** with
   `handrail_dev_service_action(action="start",
   service_id="812c4054-6ced-4616-94fb-13f672b3e897")` in this project, retaining
   command `npm run build && npm --prefix examples/drop-in-react run dev:lab`.
   Check scoped status/logs and require the authorized QA route. No ad hoc
   service, full-runtime startup or raw listener is proposed here.
4. Before acceptance, resolve the two separate artifact blockers: installed JS
   still lacks the documented current membership/UI repairs, and the configured
   Flutter startup has a recorded frozen-lockfile build failure. Main/lead must
   select an authorized final-artifact build path and reconcile its exact
   installed dependencies; changing consumer pins/publication/configuration
   remains outside this request. Do not call the old installed package the
   repaired runtime, treat a root-only build as an SDK upgrade, or blindly
   regenerate Flutter locks. The evidence here is a concrete starting point,
   not a request to rerun completed compatibility suites.
5. Resume the **existing independent verifier**, through authorized Mobile
   Preview/QA Vault access, on the actual final React/Flutter artifact: Current
   and Discord styles, real save/read, failed save, reload/reconnect, propagation,
   reply destinations/context and distinct Create/Open Thread. Capture artifact
   identity with the live evidence and close browser sessions afterward.

Callback remains task `24350c4f-985e-4762-ac15-445f69009f18`, management strategy
`df610529-c0a7-4277-817b-c30142cf7c55`, existing planner action
`dd3e9335-d023-4a3c-a95d-6eebf156665c`. Return this package through the current
worker result; no queue/task/database mutation, new controller or replacement
verifier was created.

Retain accepted Hitcents planning (planning only), independent PG follow-up
`aa44e279-ea9b-49a4-b2a2-c561daa13a1f` (23 tests/11 hashes), historical
inconclusive QA and inspected media with `fresh_capture=false`, deterministic
fixture provenance, native keyboard/touch/screen-reader limitations and the 4px
Send-padding finding. Later documentation remains later than the 3AM cutoff.
Hitcents `0f617308-8c3a-4ad4-83e7-34b1fda024b3` remains read-only and was not
accessed or changed here. No production writes, publication, deployment or
adoption occurred. Overall readiness remains **not accepted**.
