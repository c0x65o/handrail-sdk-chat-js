# Flutter qualification follow-up — 2026-09-16

Work request `e1302338-7a3b-4549-9e32-d0b474dd153c`, producing run
`719f571e-fa1d-4ae0-90aa-50c72f2a97a8`, sdk_finish attempt 2. This supplements
[qualification-repair.md](qualification-repair.md); prior receipts keep their
original attribution. Full readiness is **not accepted**. Independent QA must
review the final changed candidate before release review and the explicit owner
readiness/integration gate. Hitcents ERP remains read-only.

## Reconciliation and scope

All 2,184 retained tracked/nonignored source files matched before editing:
JS 1,674 (`2bd001648606b676a35cc5388a514915e7d16a4ff7ed2c4e43e9f4177570203b`),
Flutter 495 (`519497ca6866936b8193785d87bc5f389ba5fa1f9a952a34c0df9bbfd1f84850`),
preview 15 (`293790039b4c43f0e2748d3c6bd971a2a371e0d2b248a60e6f87ceb2668401f4`).
No pending Git operation required repair. Deferred automatic synchronization was
resolved by inspecting actual source; no fetch, reset, stash, commit or push.
Earlier repairs and pending changes are preserved.

Node 22.0 compatibility pins, strict declaration isolation and its negative
controls, deterministic Dart generation, declared SDK minima, CI analyzer flags,
authentication policy, dependency/public Git pins and all checked-in package
locks remain unchanged. Only generated Dart bodies and their owning JS
source/templates change on the JS executable side. TypeScript/server behavior,
PostgreSQL migrations and preview source are unchanged.

## Cleanup diagnosis and compatible fixture repair

The builder diagnostic printed completion of `timeline.dispose()` and entry into
`client.dispose()`. Instrumentation in a disposable copy reached
`threadLifecycles.dispose()`, whose first await cancels its metadata subscription
to the client's `Stream.multi` lifecycle stream. The stream forwards cancellation
to the synchronous broadcast subscription. Direct awaiting stalled; pumping only
FakeAsync failed the new bounded completion assertion. Driving both the real
queue (`tester.runAsync` with a zero-duration yield) and FakeAsync (`tester.pump`)
completed disposal. This matches the existing workspace and huddle fixture
repairs. The forced-stop runner errors are not evidence of a product defect.

The full suite then exposed the same fixture issue in channel-list cleanup and
reaction-picker/read-tracker, application-lifecycle, channel-header, member-picker,
timeline, scope/state-builder and fixture-harness teardown. A shared test-only `pumpWidgetCleanup`
unmounts the UI, starts cleanup, drives both queues, asserts completion within
20 pumps, and awaits the original future to propagate errors. It is used by the
builder, channel-list, reaction-picker, read-tracker, application-lifecycle,
channel-header, member-picker, timeline, fixture-harness and analogous
typing-indicator fixtures. Every builder/cleanup assertion and awaited controller/client disposal
is retained, including the ordinary async builder action case. No test is skipped,
no timeout is increased.

## Product lifecycle regression

The first broader run that reached membership cancellation also exposed a real
client disposal race. The existing cancellation regression timed out after 30
seconds. A focused diagnostic confirmed cancellation-before/queued/active steps
completed, then stalled awaiting the queued-at-close result. Client disposal
cancelled active dispatcher work, but awaited controller/subscription cleanup
before closing pending command lanes. An active cancellation could therefore
resume its lane and dispatch a queued request after the one-time cancellation
sweep, leaving both the command and client disposal waiting on the transport.

The minimal correction moves the existing queued archive, membership, preference
and reaction shutdown block ahead of `closeActive()` and every asynchronous wait.
This synchronously closes queued work before an active drain can resume. It adds
no API, timeout, protocol change or cancellation shortcut. The regression retains
all cancellation/disposal assertions, keeps the transport response unresolved,
and now explicitly requires only the two pre-disposal requests/token calls;
queued-at-close, active-at-close and client disposal must all complete. Adjacent
archive/preference/reaction tests are included in focused validation. The final
full suite covers this product correction as well as the fixture repairs.

## Recovery, identity and timeline follow-through

Later full-suite coverage exposed synchronous store notification reentrancy in
edit and reaction recovery when a canonical baseline becomes available. Both
runtimes now defer projection/pump refresh to a microtask, following the existing
delete-recovery repair. Reaction projection also checks the current retained
intent status after asynchronous persistence, avoiding a duplicate projection
when a deferred notification already advanced it. Existing baseline-readiness,
FIFO and adjacent-intent coalescing regressions exercise these paths; the reaction
baseline case now also checks the reconciled aggregate and actor reaction flag.

Three read-cursor fixtures expected old-actor state to survive identity replacement,
although the existing client explicitly clears its installed snapshot. These
expectations now require empty previous-actor state. The late-response regression
also hydrates user-2 read state and requires that exact object to survive an
old-user transport response. Storage isolation and all awaited cleanup remain.
No read-cursor product semantics changed.

The timeline fixture now prepares precompleted transport futures in their
FakeAsync zone, and its bounded settling helper yields both queues. This resolves
warm-entry hangs and allows mark-unread completion feedback, focus and scroll
assertions to run. Two additional demonstrated product defects had compatible
corrections: initial live-edge follow compares the previous offset rather than a
lazy-list extent estimate (which can grow between layouts); visible rows are kept
alive during earlier-page loading so a prepend does not destroy their element
before post-layout scroll correction. Existing cold/warm unread-entry, initial
loading, failed-page retry, anchor identity, transient scroll attachment, action
feedback, focus and scroll assertions remain. The complete timeline file passes
25 tests. These are widget/source checks, not runtime UI acceptance.

The final broad run also reached previously stale huddle/media fixtures: successful
leave already clears the descriptor and returns media to idle, so two tests now
require idle while retaining canonical-state and lifecycle-path assertions. The
fake media test now supplies its current actor through the same supported cache
fixture used by huddle boundary tests, and asserts start/join success before
connecting. An opaque token alone never establishes participant identity.

The workspace import guard found direct normalized-store access in existing-thread
navigation. That cached lookup now belongs to the public thread controller through
`knownThreadIdForRoot`, with an explicit parent-conversation boundary; the workspace
still uses `openExistingThread` for fresh authorization before presentation.
The import guard, workspace interaction suite and root-thread tests retain the
existing behavior, including no participation writes on read. Additional assertions
cover cached identity lookup and rejection of a different parent.

A completed full-suite run reached 2,422 passes and one remaining offline-send
fixture failure. The third timeline emission is a legitimate replay-cursor change
(event-1 to event-2) after HTTP already installed the second message. Diagnostics
record the exact three selections. The final test asserts their message IDs and
cursor sequence and requires both complete canonical message values to remain identical
on the late event, in addition to the existing single durable-queue removal and
cleanup assertions. This distinguishes exactly-once message reconciliation from
cursor notification; no send/reducer behavior is changed.

## Analyzer disposition

The exact existing command is `flutter analyze --no-pub lib test` under Flutter
3.41.7/Dart 3.11.5, after `flutter pub get --no-example`. The original 142 infos
were 73 `prefer_const_constructors`, 53
`curly_braces_in_flow_control_structures`, three `prefer_const_declarations`,
three `unnecessary_import`, one `avoid_single_cascade_in_expression_statements`,
and nine `deprecated_member_use` (zero warnings/errors).

Const, braces, imports and the cascade are corrected without changing assertions.
The cascade auto-fix initially produced invalid cast/assignment syntax; analysis
caught it and the final fixture uses an explicitly typed attachment variable.
Nested redundant const keywords introduced by the first fix pass were removed.
These intermediate failures remain in the logs.

The deprecated checks inspect the same Flutter 3.19-compatible RadioListTile
callback gate used by the product, and stable semantics flags. A helper preserves
all seven enabled/disabled assertions. Three precise `deprecated_member_use`
annotations document the older API requirement, matching established product
practice; no file-wide ignore, lint configuration change, `--no-fatal-infos`,
RadioGroup migration or SDK-minimum increase is used.

Generated ownership is preserved: durable event Dart is generated by
`scripts/generate-durable-events.mjs`; huddle and read-cursor Dart come from their
JS-owned `.dart.tpl` templates. Braces are fixed there, regenerated, then vendored
using `sync-flutter-contracts.mjs`, including the shared-contract hash lock.
Descriptors and protocol semantics are unchanged.

## Final qualification results

Flutter 3.41.7 / Dart 3.11.5: the complete affected builder file passes all six
cases; the timeline file passes 25; offline-send recovery passes 13. The final
`flutter analyze --no-pub lib test` exits zero with no findings. The final
`flutter test --no-pub --concurrency=2 --reporter=json` terminates successfully:
**2,423 passed, zero failed, zero skipped** in 120.45 seconds. Counts exclude
hidden test-loader events. All modified Flutter source/tests are included.

Node 22.23.1 / npm 10.9.8: package-version preflight, normal
`npm ci --include=dev --engine-strict` (including prepare/build), and JS/contract
typechecks pass. All 14 focused generator/snapshot tests pass with zero skips;
all 32 generator drift checks pass. `npm run check:conformance` passes shared
contracts, seven capability tests and all four paired TypeScript/Dart suites.
The paired runner reports suite agreement but suppresses child stdout, so no
unemitted per-language test count is inferred. The retained results file records
these commands and reconstruction verification separately. These engineering
checks qualify source for independent QA; they do not accept the full SDK.

## Reproduction and evidence

The retained package contains full base-to-final patches plus untracked sources,
exact sorted source maps, commands, original/effective dependency locks, tool
hashes, final and diagnostic logs, failure dispositions and reconstruction scripts.
One interrupted intermediate aggregate log and an intermediate analyzer-failure
log were inadvertently overwritten by later same-named checks; receipts mark
this limitation. Membership cancellation is separately retained in focused
diagnostics, and the original analyzer classification is retained. Interrupted
attempts receive no pass credit.
Use existing base Git objects and `reconstruct.py` in a fresh directory; do not
reconstruct over shared work or initialize a repository. All source copies are
checked against the final map. The disposable Flutter development lock is the
only intentional tracked-source difference after preparation.

The installed Dart binary and Flutter tools snapshot match the previous retained
SHA-256 identities. The read-only SDK uses task-local wrappers invoking those
real tools, private PUB_CACHE and `FLUTTER_ALREADY_LOCKED=true`; no tool is stubbed.
Initial commands without that environment failed on the read-only cache lock and
are retained. Read-only iOS utility stamp warnings do not prevent Linux analysis
or widget tests and do not qualify native builds. The original Flutter lock hash
is `eea72d79596aa8f25711079ebe30b6f8b9de269bcb9d92a4bb4576c9aee4e392`;
the effective development lock is
`9cc9a01c8d02359a78e4aae7ecf457fdad366bb80abee4b5cc8281395a8bb3dd`, exactly matching
the prior recipe. Its Dart >=3.9 requirement does not prove declared Dart 3.3 /
Flutter 3.19 compatibility.

Meaningful checks run sequentially with Flutter concurrency 2 and Node test
concurrency 1. Independent reviewers should use
`handrail_run_read_only_tests profile=sdk` for supported local checks and separately
prepare Flutter as documented. Initial tool discovery returned no context readers. When the Handrail tools
became available later in this run, current context, the frozen request, and all
four attached owner memories were fetched and reviewed. They confirm the same
project/request, read/repo_changes scope, authentication snapshot and gates. The
supplied brief, corrections and five attachments were also inspected. Context
receipts are retained; no permission expansion or new controller was created.

## Acceptance and next owner

The existing [acceptance matrix](verification.md), [readiness recommendation and
ERP integration recipe](README.md), and [original preparation](reproduce.md) remain
intact. Required outcomes still include Discord-style threads, saved reply
settings, huddles and a full independent QA pass. Fixture/UI assertions are
engineering source evidence, not real reload/reconnect or native media acceptance.

The existing SDK lead/planner should deliver this final source and evidence to
independent QA. Remaining gates are real React/Flutter UI routing, source context,
reload/reconnect, unread/notification semantics; two-participant huddle media,
join/leave/rejoin/mute, permission denial, disconnect recovery and device cleanup;
identity/authorization and real storage/push adapters; minimum SDK/React 18.2 and
Windows/platform compatibility; reviewed public HTTPS full-SHA releases with
matching consumer locks and normal install/build; and explicit owner readiness /
integration approval before any ERP change. No gate is waived by source tests.

Prior Node 3,010-pass/one-smoke-skip and PostgreSQL 1,141-pass plus four documentation
smoke passes remain attributed to work request
`b8956c44-813a-4c45-b6c9-07cae800181d` / run
`4e3340a4-8d7b-4d76-9862-09830e4fc40d`; the documentation smoke covered that skip.
Minimum-Node receipts and strict consumer negative controls remain historical.
Those suites are not relabeled as fresh passes. Dart generation and paired
checks are rerun because this candidate changes their inputs.

No commit, push, PR, publication, deployment, shared runtime configuration,
Handrail database/queue state, real external message or ERP write occurred.
