# React thread controls at compact heights

Work request `69c40a14-38b3-4c4e-b95b-1029ad597e63`, finding `6b55e3a8-ce36-414d-8579-7f18aaab09b4`, approval `2f25668b-e4e6-4046-9dfd-b994ae7783b6`. Validated 2026-09-07 in run `0a3d60d9-ad91-42f8-9724-ac80671a4be5`.

## Failure boundary and change

Application CSS. Before changing product source, the existing real PostgreSQL/Playwright harness reproduced normal Close clicks intercepted by the root paragraph and composer at 1280×720. Preparing the closed thread at 1440×1000 and opening it through All threads at 1280×720 then reproduced a clipped Reopen button whose center hit the composer. The earlier composer-overlap repair in SDK HEAD `c82abe8` did not cover a wrapping title combined with an inline channel draft.

The thread grid allowed its controls/history scroll area to collapse to zero after reserving the header, root and composer. `src/ui/styles.css` now reserves a minimum 4rem controls/history viewport and allows the conversation body to scroll when it and the composer cannot fit together. Root context and header stay separate. At sufficient heights the composer remains visible; at compact heights it can be scrolled into view. Existing desktop side-by-side and mobile navigation behavior is preserved.

Handrail current context confirmed the project/work request. Dev service status reported Chat Lab stopped with no listener or route. Validation therefore used rebuilt local source and an isolated test service; no deployed configuration or shared data change was required. No managed dev restart/deployment was performed.

## Evidence

- [Before at 1280×720](before-1280x720.png), [before center hit test](before-hit-test-1280x720.json): `receivesClick: false`.
- [After at 1280×720](after-1280x720.png), [after center hit test](after-hit-test-1280x720.json): `receivesClick: true`.
- [After at 1440×1000](after-1440x1000.png), [after at 390×844](after-390x844.png).

The regression uses Bob's Discord-style inline reply to Alice, the campaign's wrapping thread title, a retained channel draft, and All threads discovery. It checks the Reopen center hit and ordinary Reopen, Close, Leave and Join clicks at all three sizes; PostgreSQL confirms shared close/reopen state. The draft and reply reference remain intact when returning to the channel. A separate real message avoids consuming other tests' seed thread; cleanup waits for the cleared test draft to persist.

## Checks

- `npm run build`: passed, including SDK TypeScript compilation and stylesheet copy. The generated package-version change was restored because versioning is outside this repair.
- `node --test --test-concurrency=1 test/thread-panel.test.mjs test/thread-panel-import-guard.test.mjs test/ui-styles.test.mjs`: 89 passed.
- Browser cases: `chat-lab.thread-controls-layout.spec.mjs`, `chat-lab.thread-layout.spec.mjs`, and `chat-lab.thread-notification-layout.spec.mjs`, using `--workers=1 --retries=0 --reporter=list`: **3 passed together**. [Browser log](browser.log), [unit log](unit.log); additional screenshots and intermediate runs are in `build/thread-controls-validation/`.
- `git diff --check`: passed.

Harness: existing Chat Lab migrations/seeds and per-run schema teardown on an isolated PostgreSQL 15 instance (UTF-8, loopback port 35931), supplied through `CHAT_LAB_DATABASE_URL`; Chromium installed under this run's temporary directory. This exercises actual lifecycle persistence and thread-message destinations, without persistence mocks. Flutter was unchanged; its suggested reducer check does not exercise React layout.

Initial harness startup failed because the temporary Unix socket path exceeded PostgreSQL's 107-byte limit; disabling that unused socket allowed the loopback test server to start. Intermediate attempts caught an overly large controls minimum, shared fixture/draft interference, and one blank-page startup timeout. Some harness setup attempts logged a transient conversation-creation 503 before startup completed; requested Handrail diagnostics confirmed the managed service was stopped with no logs, so those diagnostics do not describe the isolated test service. These attempts and their logs remain under `build/thread-controls-validation/`.

## Campaign provenance retained

Campaign `298e20b4-4faf-4283-949d-3801cf437aa8`, environment `dev`, playbook `custom`; campaign work request `8ff41fa4-8f28-4ee9-b884-7e87614c7db5`, campaign run `fee77ab0-0d2f-42ba-825f-82575519ddf8`.

The supplied `19-bob-shared-closed.png` image was reviewed in the work-request prompt: the named thread, wrapping title, root context, and retained inline channel draft compete for the compact vertical space. The original JSON and image attachment filesystem paths were not present in this worker. The separate `23-react-reopen-overlap.png` was referenced but not supplied, so neither its contents nor the original JSON were independently inspected. The request's reported pointer-interception evidence was independently reproduced as documented above.

Original artifact references (unchanged):

| Campaign artifact | Preserved reference |
| --- | --- |
| `campaigns/298e20b4-4faf-4283-949d-3801cf437aa8/19-bob-shared-closed.png` | [Original image](/api/pm/qa-campaign-artifacts/1e908058-3f45-42bb-b9af-00b7faa34039/content), SHA-256 `8cd7e0eab4612112c6a8dd2b796c806471d090611b1795e47257531d34660fd5` |
| `campaigns/298e20b4-4faf-4283-949d-3801cf437aa8/react-overlap-hit-test.json` | [Original hit test](/api/pm/qa-campaign-artifacts/f4238ba0-9f02-491d-80b4-eab6b3f9d4ba/content), SHA-256 `28226a2b4111c27c9fa8ae068a80284bcf8ecd3d16196eddf1cb21229a415816` |
| `campaigns/298e20b4-4faf-4283-949d-3801cf437aa8/23-react-reopen-overlap.png` | Original campaign-relative path retained; no content endpoint supplied. |

Existing unrelated workspace changes were preserved. No commit, push, PR, Handrail queue/database update, shared project data update, or deployment was performed.
