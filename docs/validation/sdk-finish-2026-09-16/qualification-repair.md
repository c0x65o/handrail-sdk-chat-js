# Source qualification repair — 2026-09-16

Work request `b8956c44-813a-4c45-b6c9-07cae800181d`, producing run
`4e3340a4-8d7b-4d76-9862-09830e4fc40d`. This supplements the original readiness
package and verification plan; it does not replace historical receipts or grant
release/ERP acceptance. Independent QA must review the final changed candidate.

## Repairs

- Preserve Node `>=22.0.0`. Pin both `@testcontainers/postgresql` and
  `testcontainers` to 12.0.0 in production dependencies and the lock. The direct
  implementation pin constrains the PostgreSQL adapter's `^12.0.0` range during
  normal resolution. The resolved Undici is 7.29.1 (`>=20.18.1`). No engine checks
  are suppressed, exports removed, or runtime packages moved to development.
  The 11.14.0 alternative was rejected because its Dockerode/UUID graph reported
  four moderate audit entries; its diagnostic receipt is retained. The selected
  graph reports zero vulnerabilities. Existing URL-backed and container startup
  cleanup behavior remains covered by the canonical harness tests.
- Provision real Dart 3.11.5 in Node CI, matching the verified installed Flutter
  3.41.7 toolchain. Keep generation's language version 3.3 and all drift assertions.
  CI verifies the tool before testing and still checks version consistency before
  installation can regenerate source. A separate Node 22.0.0 job performs an
  engine-strict clean install/prepare build and strict consumers/export checks.
- Resolve temporary-directory symlinks and reject any candidate with an ancestor
  `node_modules`; fall back to a writable dependency-free location or fail closed.
  The declaration test copies production dependencies plus host React/types,
  compiles real package exports in strict NodeNext and Bundler modes, loads every
  public entry and the container adapter, then removes `@types/pg` and requires
  TS7016 in both affected declarations in both modes. No path alias or type shim
  masks dependencies. Both checkout-local and external TMPDIR are exercised.

## Attribution and candidate reconciliation

Before editing, all 2,182 retained tracked/nonignored files matched: JS 1,672,
Flutter 495, preview 15. Heads were respectively
`093962c51c797450fe73659824281ca26fa6ac5f`,
`f28cc4d0ed05f37d7c6ccd5f6f946b31e90bf631`, and
`a35ba3e0a0de16ecddcfefdfd927783a434cd817`.
No pending merge/rebase/index lock required repair. Deferred automatic workspace
synchronization was handled by comparing the actual candidate; no fetch, reset,
stash, commit or push occurred. All earlier working fixes are preserved.

Original source-map SHA-256 values:

| Repository | Original map |
| --- | --- |
| JS | d91176566389f178c27b561a9c29a23af3779c8826e7305ef46ab444fac61daa |
| Flutter | 519497ca6866936b8193785d87bc5f389ba5fa1f9a952a34c0df9bbfd1f84850 |
| Preview | 293790039b4c43f0e2748d3c6bd971a2a371e0d2b248a60e6f87ceb2668401f4 |

The saved final candidate identities contain complete sorted file maps and hashes,
Git states, package/lock/generated versions, effective dependency locks, emitted
files, tool identities and attachment checksums. The package version is 1.0.35;
preflight precedes both clean installs and confirms all four version fields.
Flutter/preview source and checked-in locks remain unchanged. Flutter root pub
resolution occurs only in the disposable source copy with its effective lock
recorded separately.

The `sdk-compatibility.json` public Flutter pin remains
`51bc3e1411858ce38980f5beded683dee957d1a3`. It is **not** this candidate pair.
Current paired checks explicitly select the retained Flutter sibling above.
Updating the public pin and testing published Git consumers belong to release
review; an unchanged public pin cannot qualify these unpublished repairs.

Original independent qualification (`f28cfbb4-3f54-41f4-aa51-23aec4c03664`):
two overlapping aggregate runs each reported 3,006 passes, three failures and one
skip. Two failures were missing Dart preparation, one was TMPDIR ancestry leakage.
Version/build/typecheck, 31 available generators and independently isolated strict
consumers passed. These results retain their original attribution and are not
rewritten as new passes. The attached independent focused preparation handoff
(`3a46df68-8974-409b-a359-72f8af31b7f9`) separately reported PG 8/8 and Flutter
44/44. Older engineering counts remain historical, not additive coverage.

## Reproduction

Use disposable copies of the exact reviewed source maps plus patches; never run
reconstruction over shared work. A source file map is the SHA-256 of each
tracked/nonignored file, serialized as sorted compact JSON for the map hash.
Retained `reproduction.json` includes actual preparation scripts and commands;
`execution-logs.txt` preserves complete relevant stdout/stderr, including failures.

Tooling: Node 22.0.0 (official nodejs.org Linux x64 archive checked against its
SHASUMS256.txt), current Node 22.23.1, and the existing installed Flutter 3.41.7 /
Dart 3.11.5. Installed Flutter framework is
`cc0734ac716fbb8b90f3f9db8020958b1553afa7`, engine
`59aa584fdf100e6c78c785d8a5b565d1de4b48ab`. Executable hashes record existing
installation provenance, not a newly authenticated Flutter archive. On a writable
SDK use normal `flutter`/`dart`; for this read-only SDK the saved task-local wrappers
invoke the real Dart executable and installed flutter_tools snapshot. They do not
stub formatting or tests. Use a private PUB_CACHE and run sequentially:

```sh
# At each runtime, before npm ci invokes prepare:
node scripts/generate-package-version.mjs --check
npm ci --include=dev --engine-strict
npm run typecheck
# Current Node, real Dart available via PATH or DART_SDK:
npm run test:node
# Both Node versions; on 22.0 omit newer test-runner flags:
node --test --test-concurrency=1 test/public-declaration-dependencies.test.mjs test/exports.test.mjs test/postgres-container-startup-cleanup.test.mjs
mkdir -p .tmp
TMPDIR="$PWD/.tmp" node --test --test-concurrency=1 test/public-declaration-dependencies.test.mjs
# Repeat with an external writable TMPDIR; do not disable the negative control.
# Current paired candidate only:
export HANDRAIL_CHAT_FLUTTER_ROOT=/absolute/disposable/handrail-sdk-chat-flutter
npm run check:durable-events
npm run check:flutter-contracts
npm run check:capabilities
npm run check:conformance
```

Run all `scripts/generate-*.mjs --check` sequentially. Before paired conformance,
resolve the exact Flutter source with `flutter pub get --no-example`, retaining
original/effective lock contents; run `flutter analyze --no-pub lib test` and
`flutter test --no-pub --concurrency=2`. Neither the example nor preview's older
Git consumer pins are substituted with local SDK dependencies.

For PostgreSQL use the checksum-verified 16.15 Debian archives in the existing
[preparation recipe](reproduce.md#private-pg16-binary-preparation). Unset inherited
connection variables. Initialize an owned UTF-8 cluster, TCP disabled, private
0700 Unix socket, JIT disabled. Create disposable databases for current/minimum
runtime tests. Use the retained 110 explicit PostgreSQL paths with concurrency 1
and timeout 120000 on current Node, plus `test/integration-testing-docs.test.mjs`.
On Node 22.0 run harness/chat-harness/startup-cleanup/create-conversation tests
with concurrency 1. Require zero remaining custom schemas, drop both owned
databases, require zero remaining owned databases, then stop/remove the cluster.
No production or shared database is used.

## Fresh engineering verification

| Check | Result |
| --- | --- |
| Version preflight, engine-strict clean install/normal prepare build | Pass on Node 22.0.0/npm 10.5.1 and Node 22.23.1/npm 10.9.8 |
| Typecheck | Pass on both Node runtimes |
| Full current Node aggregate | 3,011 total: 3,010 pass, zero fail, one PostgreSQL smoke skip |
| Strict package consumers | Both Node runtimes, both local/external TMPDIR, both NodeNext/Bundler modes pass; both missing-@types/pg controls reject correctly |
| Minimum CI export/container checks | 18/18 pass; actual container adapter import plus startup/cleanup controls |
| Generation | All 32 generators pass, including real Dart formatting |
| PostgreSQL full explicit list | 1,141/1,141 pass, zero skips; canonical migrations on private PostgreSQL 16.15 |
| PostgreSQL documentation smoke | 4/4 pass; covers the earlier aggregate skip |
| Minimum Node PostgreSQL subset | 13/13 pass, zero skips |
| PostgreSQL cleanup | Zero custom schemas/owned databases; cluster stopped and removed |
| Flutter preparation | Original/effective root locks reproduce prior preparation exactly |
| Flutter focused durable reducer | 44/44 pass |
| Paired source checks | 112 shared files match; capabilities 7/7; all four TypeScript/Dart conformance suites pass |
| Broad Flutter analysis | **Exit 1:** 142 informational lints, zero warnings/errors; retained as nonpassing |
| Broad Flutter aggregate | **Incomplete:** stalled in unchanged widget-builder test; both attempts interrupted (exit 130), no full-suite pass credit |

The first new Node aggregate failed only the workflow command snapshot after the
Dart/engine-strict CI change (3,006 pass, one fail, one skip; three nested version
tests did not execute). The snapshot now includes the real prerequisite commands;
version-drift assertions remain intact. Its failed log is retained separately
from the final 3,010-pass receipt. These runs overlap and are not additive.

The selected dependency graph audits clean. An npm-resolution change also updates
its Testcontainers subtree; exact before/after and installed lock metadata are
retained rather than claiming only two lock entries changed.

The broad Flutter command exposed a remaining independent qualification obstacle
in the unchanged baseline. Progress stopped at the widget-builder case
“instantiates and invokes every typed builder.” The first full run and a diagnostic
`--timeout=30s` run were interrupted rather than claimed successful. Flutter's
`testWidgets` explicitly supplies the binding's ten-minute timeout, so that CLI
setting does not bound these widget tests. A separate externally bounded focused
reproduction exited 124 after 60 seconds; runner sink errors occurred during
forced shutdown and are not asserted to be the original product defect. Inspect `test/chat_widget_builders_test.dart:137` and
its analogous disposal awaits at 225 and 371; FakeAsync stream disposal is a
plausible cause, consistent with the earlier workspace/media fixture repairs,
but the exact cause still requires diagnosis. No Flutter source or assertions
were changed to force a result. Existing SDK engineering owns that follow-up:
repair the fixture/lifecycle cause, rerun this file and the complete Flutter suite,
and resolve or explicitly disposition the 142 informational analyzer findings.
The callback is a new final-candidate full-Flutter receipt for independent QA.

The original lock hash is
`eea72d79596aa8f25711079ebe30b6f8b9de269bcb9d92a4bb4576c9aee4e392`;
the disposable effective lock is
`9cc9a01c8d02359a78e4aae7ecf457fdad366bb80abee4b5cc8281395a8bb3dd`.
The effective development graph requires Dart >=3.9; declared Dart/Flutter minima
are unchanged. Real Docker startup and native/device execution were not available
or claimed; native PostgreSQL and container API/error cleanup checks are distinct.

## Readiness and next review

This repair preserves the original required outcome: Discord-style threads,
saved reply settings, working huddles, and full independent QA before ERP changes.
The existing [verification plan](verification.md) remains authoritative. Pending
rows are not waived by package or source tests:

| Required behavior/gate | Remaining evidence |
| --- | --- |
| Threads/settings | React and Flutter real UI, routing/source context, reload/reconnect, unread/notification semantics |
| Huddles | Two-participant media, join/leave/rejoin/mute, permission denial, disconnect recovery, native/device cleanup |
| Identity/persistence/realtime | Full independent acceptance matrix, host identity and authorization adapters |
| Files/notifications | Real host storage/push behavior and disabled/unavailable feature UX |
| Compatibility | React 18.2, Flutter 3.19/Dart 3.3, Windows and required platform combinations |
| Release | Independent QA on this final source, owner/publication review, public HTTPS full-commit SDK pins with matching locks and normal clean consumer installation/build |
| ERP | Explicit readiness/integration owner gate and required scope review; Hitcents ERP stays read-only |

No publication, deployment, shared runtime configuration, external message,
Handrail database/queue state change or ERP write is part of this repair.
