# Verification receipts and remaining work

Producing run: `5d4c3c1c-1b0c-41fc-a0a1-d33b1a9c196b` (2026-09-16 UTC).
These are engineering checks of working files, not independent acceptance.
See [candidate matrix](README.md), [reproduction](reproduce.md) and
[diagnostic failures](failures.json). No full-suite green result is claimed.

## Preparation, separately from tests

- All three checkouts visible, clean initial status and exact HEAD/version bytes
  retained before any npm lifecycle; stale generated version check exited **1**.
- Node 22.23.1 / npm 10.9.8; existing node_modules used. No SDK checkout npm ci.
- Flutter 3.41.7 / Dart 3.11.5; ordinary launcher failed writing read-only
  engine.stamp. Installed Dart + Flutter tools snapshot invocation worked.
  Flutter also emitted optional libimobiledevice/libusbmuxd cache write warnings;
  these are not device-tool qualification.
- Preview initially failed analysis/test/build because its generated package
  configuration referenced a deleted earlier worker directory. Normal
  `pub get --enforce-lockfile` with a private writable cache succeeded and left
  its manifest/lock pins unchanged; those initial checks remain recorded.
- PostgreSQL 16.15 binaries privately extracted from checksum-verified PGDG
  packages. Native initdb/start receipts are separate from tests. Each execution
  used a fresh owned cluster, private Unix socket, no TCP, explicit test-only URL,
  canonical migrations and isolated schemas. Both completed runs reported zero
  remaining custom schemas and stopped/removed the owned cluster.

## Passing checks

Counts overlap; do not add them into a claim of unique coverage. Exact commands,
exit codes and logs are retained in the deliverable checks.json/execution-logs.txt.

| Command / scope | Result | What it establishes |
| --- | --- | --- |
| `npm run check:package-version` after generation | Exit 0 | Manifest, both lock fields, generated source agree at 1.0.33 |
| `npm run build`; `npm run typecheck`; scoped reply-preference contract tsc | Exit 0 each | JS/server/React compiled; typed contracts checked |
| Version and CI workflow regressions | 22/22 pass | Pre-lifecycle drift detection, nonmutating checks, workflow ordering |
| Final version/media/huddle-controls + three React workspace files | 246/246 pass | Patched cleanup, optimistic navigation fallback and current UI fixtures |
| `test:reply-style-preference` | 97/97 pass | Saved preference contract/reconciliation fixtures |
| `test:thread-lifecycle`; `test:thread-list` | 197/197; 63/63 pass | Lifecycle and list contracts |
| `test:huddle-contract`; `test:ui-huddle` | 14/14; 30/30 pass | Huddle command/UI boundary contracts |
| JS media/state/durable-huddle recovery | 29/29 pass | Disconnect cleanup, reconnect, rejoin and state recovery fixtures |
| Scoped client reply / React reply / client thread list / message-context runners | 45; 17+3; 90; 62 pass | Their actual build prerequisites and respective client behavior |
| `npm run check:conformance` | Exit 0; four cross-runtime suites and seven capability tests | JS↔Flutter fixture parity, generated-contract synchronization |
| Final focused real PostgreSQL16 run (24 files) | **350/350 pass, zero skipped** | Mounted React preference HTTP/WebSocket/storage save/reload/reconnect, retry; threads/cursors/access, huddle lifecycle/auth/rejoin/screenshare, attachments, notification dispatcher and replay/idempotency |
| Flutter media + panel | **19/19 pass** | Actual current SDK provider-neutral cleanup/denial/leave/rejoin/control ownership fixtures |
| Flutter seven settings/thread/durable-event files | **252/252 pass** | Current SDK preference and thread widgets/controllers plus durable reducers |
| Flutter analysis `lib` and changed tests | Exit 0, 39 informational lints, no warnings/errors | SDK static analysis; existing generated/style notices remain |

## Failed diagnostic runs

The complete logs remain failures even where subsequent focused reruns pass.

- `npm run test:node`: **2859 total, 2745 pass, 106 fail, 7 cancelled, 1 skipped**,
  exit 1. This earlier aggregate run preceded final React fixture repairs.
  The runner discovers some tests requiring distinct scoped build directories
  without using their runners. Scoped reruns of those files passed after the
  proper build; this does not repair the aggregate runner or waive other failures.
- `npm run test:postgres`: **1029 total, 986 pass, 43 fail, zero skipped/cancelled**,
  exit 1. This run followed compiled-output import repair but preceded the final
  active-huddle insertion and idempotent-join expectation repairs. Those two
  huddle files now pass in the 350-test focused run. Full-suite rerun still needed. This aggregate includes SQL-boundary unit tests
  as well as real PostgreSQL tests; the failed maintenance fake is not a
  demonstrated failed transaction against the real database.
- Earlier PostgreSQL strip-only runs failed on TypeScript parameter properties.
  Tests now import the normal freshly built dist modules. Initial receipts are
  retained; they are not final-candidate evidence.
- Earlier Flutter combined/media runs failed or were interrupted at hanging
  widget teardown. The media/panel fixture now drives real and FakeAsync queues
  while disposing; the final 19-test run passes. Timeout exits remain recorded.

## Repair ownership and callback

The existing SDK engineering lead owns these unresolved verification failures;
return the repaired patch hashes and exact reruns to the existing task planner.
Do not infer that every failed assertion is a product bug or weaken assertions
without reconciling the source contract.

| Follow-up | Concrete next work / completion evidence |
| --- | --- |
| Aggregate Node harness and stale fixtures | Repair `scripts/run-node-tests.mjs` orchestration for scoped build-dependent client/React tests; reconcile response metadata, HTTP path/error fixtures, SQL boundary fakes and lifecycle teardown in failures.json. Run the canonical aggregate with configured worker limits until no failures/cancellations; account for the skip. |
| Canonical migration expectations | Update obsolete latest-migration/count snapshots in PostgreSQL schema/migration tests while retaining immutable migration ID/checksum assertions, fresh install and upgrade checks. Never change canonical migration SQL merely to satisfy stale counts. |
| PostgreSQL integration assertions | Repair conversation-list fixture UNION timestamp typing and the overlength `chat_idempotency_maintenance` schema prefix first. Reconcile conversation preference/read-cursor HTTP outcomes, create-command replay expectations, thread-follow fixture content, outbox fixtures rejected by `chat_outbox_events_timestamp_check`, maintenance SQL-boundary fake expectations and thread-summary reconnect request count (expected 3, actual 6). Preserve real SQL and authorization semantics; rerun `npm run test:postgres` on an isolated PG16 cluster. |
| Supported current UI/native/media QA | Planner prepares scoped service/QA Vault/Mobile Preview handoff; independent QA tests final React/Flutter candidate, real two-participant media, microphone denial, disconnect/rejoin and device cleanup. Historical PNGs and fake providers are insufficient. |
| Reviewed installable release and ERP gate | Main/release reviewer freezes approved public HTTPS Git commits and matching locks; clean consumers install/build through normal pipelines. Independent QA reviews final changed identity. Owner receives evidence and explicitly approves readiness/integration before ERP changes. |

The preview currently consumes older committed SDK bytes; its build/test results,
when present, qualify that pin only. No reviewed installable release of this dirty
candidate exists. Native app-store builds, provider credentials, OS notifications,
real storage adapters and ERP host integration remain unverified here.
