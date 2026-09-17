# QA-43 acceptance harness and lifecycle repair

This is a bounded repair of HARNESS-43-CLEAN, HARNESS-43-ACTORS and the reproduced QA-43-RECOVERY-NOOP mechanism. It does not establish full SDK readiness or authorize ERP integration, publication or deployment.

Baseline: JS `275cfa924e757c30abbd2b5c5c46b4eee8edaca6` (1.0.43), Flutter `dc377a84f09033d532c455c6891e0085f67ebe23` (0.1.27), preview `e40655c780776ab933043609d8d2a410e9677d26` (0.1.16). All three were clean at inspection; JS package, both lock version fields and generated client version agreed before building. During verification, an external Handrail Release Bot advanced JS to `0f114108bd1a05ef0d7bd53267311a4109aafd91` (1.0.44), committing the initial harness/UI patch and package metadata. This worker made no Git writes or version edits and preserved that concurrent finalization. Final verification uses that exact head plus the remaining runtime/test changes; those changes and this documentation remain uncommitted for native finalization. Package, lock and generated client versions agree at 1.0.44 before the final build.

The harness self-test now creates its scratch directory under `os.tmpdir()`, registers teardown immediately, and asserts removal. Missing-prerequisite, failure/skip/retry rejection and inherited-environment isolation checks remain intact. Independent QA reproduced the original absent-`build/` ENOENT (2 passed, 1 failed), then verified the corrected test without creating repository `build/` (3 passed, zero skips).

The Flutter backend test now requires the exact Alice/Bob/Carol/Dave catalog, exactly four menu items and each exact visible label. Alice → Bob → Alice switching, shared conversation/history and error checks remain. Independent live PostgreSQL/Flutter baseline and candidate runs respectively failed the old two-actor assertion and passed the corrected test with one worker and zero retries.

## Reproduced cause and correction

The retained recovery-1 failure establishes no lifecycle request and both clients remaining open. Its original trace did not record actual DOM pointer targets or React handlers, so its exact event interleaving cannot be reconstructed retrospectively. Later passing runs are preserved as passes, not used to erase that failure.

A new diagnostic observed membership reauthorization immediately after the inline send. The controller correctly invalidated old authority and loaded a fresh snapshot, while `ThreadLifecycleControls` removed Close and Lock. A controlled experiment held the **real** send-triggered detail response until pointer-down on the enabled Close button, released it, awaited the resulting loading → ready transition, then released the pointer. Baseline pointer-down targeted node 1; pointer-up targeted replacement node 8 at the same position. No Close click/handler or lifecycle HTTP request followed. SQL remained open at lifecycle revision 1 and neither client received a lifecycle event. This reproduces the reported symptom with a causal trace, without a forced click, sleep, retry or mocked database.

The UI now retains previously displayed button nodes, disabled, during same-thread idle/loading reauthorization. They become actionable only when the existing runtime reports authority ready. Initial loading and legacy metadata still expose no actions; denied/archived/unsupported states remove controls. No click is queued or replayed across an authority gap. The hook is unchanged. Initial authority, session/generation cancellation, duplicate-command, conflict and idempotency guards remain. The in-flight timestamp-only exception below addresses a second demonstrated cancellation race.

The same pointer experiment on the candidate retains node 1 through reauthorization. Pointer-up and click reach that enabled node; its handler enters updating and emits exactly one Close request. Reopen emits one request. Both clients receive canonical revisions 2/3 and storage ends open at revision 3. This corrects the button-replacement mechanism; the original failure remains retained with its historical diagnostic limitation. Independent ordinary acceptance of this first candidate still failed and was not credited.

Independent QA's failed ordinary run showed an enabled Close entering “Updating thread…” and then returning open without HTTP. A deterministic test reproduced the second failure: start Close through the real command dispatcher, then hydrate a newer timestamp-only membership snapshot during asynchronous token acquisition. The old controller canceled its AbortController before fetch, producing zero lifecycle requests.

The runtime now preserves an already accepted in-flight command only when both parent/thread membership objects exist wherever changed and **every** field except `updatedAt` is equal. Key sets are compared conservatively, including future fields. It still calls the existing reauthorization read. Changes to role, user, tenant, state, joined-at generation or any other field retain cancellation/reset; denial from the reauthorization read still revokes authority and aborts the command. Session/parent revocation guards remain. This continues the original request with its original input/key/revision, not a retry, queued intent or replay. Timestamp refresh while no command is running retains the existing invalidation behavior.

Four command-boundary regressions distinguish timestamp-only continuation from role/joined-at/removal cancellation. An additional denied-reauthorization case holds token acquisition and proves zero HTTP writes after denial. Two focused UI regressions assert DOM identity, disabled no-write/no-replay, one subsequent enabled action and removal after denied reauthorization. The existing test fixture now declares its attachment-enabled ready state, required by the released composer and the retained attachment-send scenarios. This is fixture repair, not a product feature-policy change. The complete focused UI/runtime/import checks pass 99/99 with zero skips, preserving authorization, session, conflict and duplicate-action cases.

The ordinary cross-client recovery test additionally requires HTTP success, exactly one Close and one Reopen request, visible React/Flutter state, SQL revisions and matching lifecycle WebSocket events on both clients. It captures closed and recovered images, response receipts and storage checkpoints. Its immediate Send → Close sequence remains; no readiness delay or action retry was added.

Independent final verification of the exact shared strengthened test at JS 1.0.44 plus the runtime diff passed 1/1 with workers=1, retries=0 and zero skips. Close and Reopen each issued exactly one successful HTTP request; SQL transitioned closed revision 2 → open revision 3, and React/Flutter each received WebSocket revisions `[2, 3]`. Both closed and reopened screenshots were inspected. The independent focused run passed 99/99 with zero skips. The suggested Flutter durable resource reducer check passed 44/44 with concurrency 2 after normal dependency resolution in the disposable SDK checkout; its shared lock remained untouched. The isolated PostgreSQL schema was dropped, the owned server stopped, disposable data removed, and fixture closed.

## Reproduction and evidence

Use [the existing acceptance instructions](flutter-cross-client-acceptance.md), installed prerequisites, a new owned evidence directory, and one browser worker/zero retries:

```sh
npm --prefix examples/drop-in-react run test:cross-client-harness
npm --prefix examples/drop-in-react run accept:flutter-cross-client-recovery -- "$NEW_OWNED_EVIDENCE_DIRECTORY"
```

Normal `npm run build` must prepare development candidate provenance before the dedicated acceptance command. This worker used a disposable Git archive and the existing candidate import resolvers. The shared Lab and preview dependency pins are older; only the disposable Flutter Lab was resolved through public HTTPS Git at full SHA `dc377a84f09033d532c455c6891e0085f67ebe23` with a matching lock. All 128 resolved Dart library files were checked against that frozen SDK. Shared Lab/preview manifests and locks are preserved; the external native JS version change is recorded above. Flutter is freshly compiled by each dedicated execution, with source digest, build timestamp and runtime identity checked by the harness. Native-device acceptance is separate.

The retained work-request package contains the independent QA verdict, exact source/patch/toolchain/import hashes, commands and counts, causal pointer/controller/HTTP/WebSocket/SQL traces, before/after images, source/reproduction bundle and cleanup receipts. Every run's outcome is retained, including the initial missing candidate-provenance setup failure, baseline actor/clean/pointer/command-cancellation failures, the independent first-candidate recovery failure, diagnostic passes, the interrupted stale-version final-v3 run (no acceptance credit), and the stale ready-state fixture failures encountered during focused testing. Failed executions are not acceptance credit.

Earlier qualification remains attributed to report artifact `9e91f6fd-bb67-58e1-af31-1c5e3e59787b` (SHA-256 `2a9a0814c0c1e2590f6a63c2d342034484728a3daf0af50451aaa0f86cb896de`) and execution artifact `13f18cdc-d89b-5bcb-a70a-8d76da9a64c4` (`add4d0b63d6eca9476b0074c73f5e906f6b0d2afa3cb3ac64a3df067bf3a8766`). Its clean-consumer, settings, thread and storage successes are preserved. Its historical 99-PG claim was corrected to 89 by that report; the later qualification separately reports 330 PG tests, 226 Flutter tests and 13 distinct browser cases. Those are prior evidence, not new counts from this repair.

## Remaining readiness gates

| Area | Status after this bounded repair |
| --- | --- |
| Harness / demonstrated Close failure mechanism | Corrected; independent 99 focused checks and exact real cross-client recovery passed; historical original interleaving remains unrecorded |
| Threads, saved reply settings, unread/notification transitions | Selected current and prior evidence retained; exhaustive cross-client matrix still required |
| Identity, directory, persistence, realtime, attachments | Existing implementations and prior qualifications retained; no exhaustive new host-adapter audit |
| Huddles / media / TURN / permissions / recovery | Required, still outside this bounded acceptance |
| Native devices / mobile host / provider notification delivery | Still unverified by Flutter web or unit/widget tests |
| Public installable release | External native 1.0.44 transition preserved; remaining runtime diff needs native finalization and reviewed public full-SHA release; no registry publication or deployment here |
| Hitcents ERP | Read-only; explicit owner readiness/integration gate remains |

The ERP recipe remains gated: finish the required matrix and independent full QA; review the finalized candidate and public full-SHA Git/lock installation; then request the owner's readiness/integration decision. Only an approved later integration may map ERP server-authoritative identity, directory permissions, persistence/realtime, files and notification adapters. No ERP installation or modification is part of this assignment. Effective authentication requirements, including enabled 10 requests/60 seconds, remain unchanged.
