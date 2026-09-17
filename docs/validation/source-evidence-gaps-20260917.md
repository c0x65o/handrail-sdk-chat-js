# Current client and package/browser source evidence

WR `36d770d0-08c2-4b3c-b486-c3df7bf4d1a0`, run `cbae7082-7990-4a9d-b0d8-8fd6e6164694`. Result: **follow-up required**. Current package/browser reproducibility is verified. Current changed-client tests pass on the inspected installed toolchain, but Flutter's installed resolution is not its checked-in lock; locked Flutter verification remains unverified. Independent review must assess these final bytes. This is source evidence, not Task, runtime, release or readiness acceptance.

No product source or dependency lock was changed. The repository addition is this focused validation report. Two disposable JS source copies and one Flutter source copy were made from actual tracked and nonignored files; all copied source/lock hashes still match the baseline. All preexisting repository files and historical generated artifacts remain byte-identical. No commit, push, version bump, publication, native preparation replay, service operation, database/queue change, ERP change or messaging occurred.

## Starting identities and preserved history

All five supplied attachments match their declared SHA-256 and saved source IDs. `source-audit.json` contains their identities, exact source file inventory, initial Git status, tool binaries, installed dependency records and actual mount table. The frozen context's four complete instruction sources and four memory publications were fetched; no missing source was reported. Current MCP context matched this project and work request. Main synchronization was deferred as `main_workspace_in_use`; no reset, stash, fetch, merge or synchronization was attempted. There were no pending index locks, merges, cherry-picks or rebases. Disposable copies avoided shared source mutation.

| Repository | Actual starting and final HEAD | Baseline pending changes |
| --- | --- | --- |
| JS | `b8f9e3ab5e27cf3d29649eb29e066ad92d99d21d` | Two modified runner scripts and one untracked runner regression test |
| Flutter SDK | `fa2572fb27aa5eb742c197e0766a7c602d2b3ff6` | None |
| Flutter preview | `e40655c780776ab933043609d8d2a410e9677d26` | None |

Preserved shared-runner files: `scripts/test-react-reply-routing.mjs` (`d02441ffbe24d73681a1383e667fe0c278dafa34adab9d2ef8e1362f95984299`), `scripts/test-react-reply-style.mjs` (`6d75eb40c3f972f58d2f07f0710f9e5ad512946e6e7a4c664351f06aacb9673b`), and `test/react-reply-runners.test.mjs` (hash in verification.json). Their reported 125 runner tests and 2 regression cases were not rerun or accepted here. Readiness Task `bbc011e4-ff3f-416a-8266-262c1a9ea560` owns review and original-receipt verification for WR `cd091fbc-9b1f-4e6d-80a3-e60e8d51b2e6`.

The attached independent review, WR `cf27f57c-7871-41f3-94ee-1d268a97855c` / run `be3a8745-743a-44fa-9097-677aeb8bc763`, remains authoritative historical evidence. Its reviewed-worktree revision differences are carried into verification.json, including version mirrors and new version/handshake tests. The only subsequent source changes at this worker's start were the three shared-runner files above. Native-token implementation and applicable historical tests remain unchanged; historical results are not reassigned to new tests.

## Focused result matrix

Counts below are actual fresh output, not inferred from successful exits. Commands, cwd, environment, timestamps, exit codes and full logs are in commands-results.json.

| Check | Result | Scope and count |
| --- | --- | --- |
| Version guard before npm lifecycle generation, both JS snapshots | Pass | `node scripts/generate-package-version.mjs --check`; JS manifest/lock/generated constant 1.0.38 |
| Package-version, handshake-generation and realtime-session-generation tests | Pass | 22 Node TAP tests, 0 failures/skips; includes nested version-gate cases |
| Current realtime contract/transport and candidate-binding tests | Pass | 20 Node TAP tests, 0 failures/skips |
| Normal JS install/build | Pass | Two separate `npm ci --include=dev --no-audit --no-fund` installations run the normal prepare/build pipeline; additional explicit `npm run build` passes |
| JS typecheck and generated handshake/realtime checks | Pass | Root TypeScript plus contract typecheck; both generator `--check` commands pass |
| React example installed lock/typecheck | Pass | Separate locked installs in both copies; example typecheck passes |
| React browser build and graph, copies A and B | Pass | 14 files each, graph 135 modules each; no SDK server implementation or installed older SDK modules in graph |
| Browser reproducibility/current identity | Pass | Same source/package manifests, 13 non-graph browser files byte-identical; only absolute module-graph roots differ, and normalized graphs are identical |
| Flutter core boundary and realtime transport | Pass for installed resolution | `flutter test --no-pub --concurrency=2 --reporter=expanded` executes 21 cases: 3 core/version/mirror cases and 18 transport cases |
| Pure-Dart boundary independently of Flutter test VM | Pass for same installed resolution | Direct Dart invocation of cached package:test with the existing package config, 3 overlapping boundary cases; do not add these to unique Flutter coverage |
| Flutter scoped analyze/compile | Pass for installed resolution | 5 relevant typed files analyzed with no issues; Flutter tests and direct Dart runner also compiled their exercised imports |
| Flutter SDK checked-in lock/current installed resolution | **Not verified; demonstrated mismatch** | 46 versioned dependencies differ; three SDK packages have no pubspec version and are recorded separately. No lock was regenerated |

Toolchain: Node 22.23.1, npm 10.9.8, TypeScript 7.0.2, Vite 7.3.6; Flutter 3.41.7 (`cc0734ac716fbb8b90f3f9db8020958b1553afa7`), Dart 3.11.5, engine revision `59aa584fdf100e6c78c785d8a5b565d1de4b48ab`. Original binary/snapshot SHA-256 values are in source-audit.json. Initial and freshly installed npm package metadata match all 208 root and 295 example lock entries (version/integrity and installed manifest checks), with identical installed lock hashes across both builds. The existing public HTTPS Git rewrite was inspected; npm's SSH-shaped metadata/warning did not change the full-SHA consumer pin.

Checks ran sequentially using normal sandboxed command execution, disposable source copies, Node heap limit 2048 MiB, Node concurrency 1 and Flutter concurrency 2. Child processes used the writable delegated `handrail-heavy/source-gap-checks` cgroup. Memory limits were configured as unlimited by the worker; no limit was changed. Largest reported child ru_maxrss was about 777 MiB. No unusual memory growth was observed. The SDK-specific MCP executor rejected this writable WR because it requires an active read-only validation WR; this limitation and the ordinary sandbox fallback are recorded, not presented as a successful MCP executor run.

## Candidate and browser binding

Current source: `c4c43f31c86fd830e1cab8b3d1623d3cd8ce7b74af00dbc89fa974ff891c35fc` (316 entries).

Current package: `fd2f6f8575e70977c63c5f15ee225b5b4036abad7a07e3a1b78a824f9ba429e8` (657 entries).

Replacing only the two changed runner script hashes with their HEAD bytes reconstructs the attached review's source hash `19393a04dd80fbee62a3e6d50f149a6db8596137b035629f01362f70a2ddf87e`. The new runner test is outside the existing candidate fingerprint, but is included in the full source inventory. No provenance scheme was changed. The compiled package remains identical to the successful JS portion of settled preparation. At this worker's start the workspace dist/candidate.json already carried the new c4c43f... source identity; that existing build effect was preserved.

Both current browser builds embed the exact current source and package hashes in `assets/chat-lab-main-CfOUEo2_.js`. Existing candidate-binding and candidate-vite resolvers verified and selected the freshly built checkout package. The example manifest/lock remains pinned to `90bff33529df06720ff89ccd821360ac65eaf0d0`; that installed older SDK was not substituted for the candidate.

| Artifact | SHA-256 |
| --- | --- |
| Browser A aggregate (relative filenames/file hashes) | `a1f008c67ba52d113147e8d1451c05ba3b87f1fa78aa283d1805e00cabbecd49` |
| Browser B aggregate | `de6540ac654deb1086e6289cebadb256f6d6a63fe9836bee7a57f97d65d9e9a7` |
| Graph A bytes | `99bf39e2adaec8de0e7c63a69dc173828bf839a9c1c0ec1ad78ea4c2dfd9e2bb` |
| Graph B bytes | `d6953cfaad870646d60b8efa3b8f90e65735b98c73283c459e28d99cfb0ae766` |
| Normalized graph (both) | `e615497ee541fad8d7163947cc5b0d0bdb01c6e427d6fe6ac315b96408d1e087` |

Normalization replaces only each absolute JS snapshot root with `<candidate>` for comparison; retained originals were not edited. The graph is the sole byte difference. Browser JSON artifacts retain every file as exact base64 bytes, SHA-256 and size, plus readable raw and normalized graphs. The original 14 browser files match the attached review's hashes and still contain historical source/package identities; they remain unchanged in the repository and are separately retained as browser-original.json. No served identity is inferred from any saved build.

## Flutter dependency boundary and retained failures

The inspected root SDK lock remains unchanged. Its existing generated package_config.json resolves, for example, test 1.30.0 instead of locked 1.24.9, analyzer 10.0.1 instead of 6.4.1, and flutter_lints 5.0.0 instead of locked 4.0.0 (also outside the manifest's ^4.0.0 range). flutter-dependencies.json records the complete mismatch list, generated config, all resolved paths, and aggregate hashes of actual dependency library bytes. These passing --no-pub tests establish behavior of the current client source on that installed resolution only. They do not establish that the checked-in lock resolves on Flutter 3.41.7, compliance with all manifest constraints, a minimum-toolchain run, or a clean dependency install.

Initial `dart test` attempted to reconcile the old lock and failed trying to write the read-only cache's `hosted-hashes/pub.dev/shelf_web_socket-1.0.4.sha256`. Its exit 1 and stack are retained. No source or lock changed. A bounded writable copy of Flutter launcher/tool metadata, with immutable SDK/engine/cache directory links, allowed ordinary `flutter test --no-pub` and `flutter analyze --no-pub`. Initial analysis failed because that copy omitted Flutter's dev directory; linking the remaining original top-level entries read-only corrected the tool preparation, and the same analyze command passed. The direct Dart runner reused the existing generated package configuration without invoking pub; it is explicitly not a substitute locked-resolution claim.

Preliminary local cgroup admission failed before test launch because the parent cgroup has enabled subtree controllers; using its delegated leaf succeeded. A redundant nested worker-slot lock was interrupted before a test launched and removed. Both events and the SDK MCP rejection are retained in commands-results.json. Vite's existing >500 kB chunk warning remains; it did not fail the builds.

Preserve settled native operation `822b6d83-d082-4d30-a0a4-e82d502e42b6` / run `1f411d6e-6a69-480f-add5-186edcd004ad`: npm installations and JS build succeeded there, then the actual SDK example's enforced Flutter lock failed with 16 proposed dependency changes and exit 65. Its source bytes, installations/build effects, failure receipt and example lock are unchanged. No `setup:lab`, `build:flutter:lab`, enforced-resolution replay or asset-skipping option ran here. That repair remains in `chat_lab_preparation_repair`; the separate preview lock is not its substitute.

## Criteria and next dependencies

| Stage criterion | Preserved assessment |
| --- | --- |
| 1. Administrator controls/non-admin denial | Historical source/component/isolated HTTP support retained; actual administrator dev UI still required |
| 2. Restricted sender/tenant/identity authorization | Historical support retained for unchanged source and applicable tests |
| 3. Secret security/revocation/rate limiting | Historical support retained; enabled 10 requests/60 seconds remains the requirement |
| 4. Canonical delivery/attribution/idempotency | Historical support retained for unchanged persistence/migration implementation and tests |
| 5. Client compatibility | Fresh version/handshake results above supplement historical support; final locked Flutter candidate checks remain incomplete |
| 6. Exact unpublished source/package/browser binding | Fresh reproducible source-stage evidence now available for independent review; served identity still pending |
| 7. Setup/restart/two examples documentation | Historical support retained; no runtime clean-state repetition claimed |

Historical 7 PostgreSQL, 52 focused Node, 28 maintained component and 44 Flutter reducer passes remain historical, with their original applicability limits and missing raw-output receipts as described in reconciliation.md. The earlier 40 independent component cases and shared-runner 125+2 claims are not combined into new coverage. No DB harness was run in this assignment. The original execution.json receipt retains its original WR/run and seven successful commands; it does not cover the changed version tests. Preserve the prior planning/context discovery failure, earlier identity/TypeScript/PostgreSQL/fixture/metadata failures and corrections, operation f339e179-8ef9-4fcc-9e11-5e2430026512, and both platform-repair histories described by the attached reconciliation; none is relabeled successful here.

Next: the existing Task lead should obtain independent review of these exact evidence bytes, then continue the existing Chat Lab preparation repair. It must reconcile a supported Flutter toolchain with the actual SDK/example locks and generated resolution, including the newly explicit SDK-root dependency mismatch, and rerun affected focused checks under that final locked resolution. If source/locks change, recompute identities and invalidate affected evidence. Do not silently regenerate locks or bypass enforcement to claim this gate.

Native delivery through the declared preparation/lifecycle path, actual served server/browser identity and owned schema/instance, actual administrator create/list/revoke UI, non-admin denial, external contact-form HTTP persistence after reload, denied channels, attribution, idempotency/conflict and revoked-send checks remain mandatory. Retain/read back that evidence before a supported clean isolated restart, repeat the complete proof, and demonstrate build-status identity/outcome/link as the second payload. Final independent acceptance is still required. No production, ERP or external provider messaging is authorized by this evidence.

The selected evidence package has been locally read back and hash-checked. Server collection and saved-artifact references must be verified by the existing Task lead after worker completion; local files or this result alone do not prove server retention or acceptance.
