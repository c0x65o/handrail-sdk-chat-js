# Native inbound channel tokens (unpublished v1 candidate)

This candidate includes repairs from source-review WR `0e4caa70-7a10-4106-af57-73c982f86f6e`, run `18a2e4fe-e593-427c-8e92-ca6779298987`. The required host session boundary and managed proof pacing are corrected; controlled PostgreSQL concurrency tests pass without a server change. Current repair evidence is in `docs/validation/native-token-source-repair.json`. Independent re-review and actual managed dev UI/HTTP acceptance, clean-state repetition and the second use case remain required. These source checks do not accept the stage.

Repair WR `4c03b0fe-e147-4466-8a15-c6551c97bec5`, run `1bfa7fa7-b065-421f-8541-0d0411af4a63`, started from pre-existing release-bot commit `f24378fccca9a667578dc8f5855231b89274d80c`. Relative to the reviewed candidate, only package.json/package-lock.json had advanced from 1.0.36 to 1.0.37. A scratch reconstruction reproduced the exact original source and full patch hash `bf326b19b732bd683c194c20c3dda4d02b438dae1d3547a270270293186842a3`; existing compiled bytes matched the reviewed package. The normal build synchronizes the generated client version to that existing package version. This repair makes no commit/push/publication. Readiness Task `bbc011e4-ff3f-416a-8266-262c1a9ea560` gates remain in force.

The following follow-up section is **historical evidence**, superseded by the independent review and this repair. Its 44 Flutter passes and original failures are preserved; they are not fresh repair-run results. The original reproduction was retained unchanged and rerun before rebuilding: one pass and two expected identity-safety failures. The maintained replacement regressions exercise the explicit session contract below.

## Historical source validation follow-up (September 16, 2026)

Work request `b39c00af-7789-4345-af36-90463dbb78e3`, run `602433ef-7ab9-44f5-9695-ef51658e68f6` verified the supplied handoff, evidence and patch hashes before testing. All 33 retained changed-file hashes, 14 browser artifact hashes and six earlier check-log hashes matched; the retained patch passed `git apply --reverse --check`. JS, Flutter and preview HEADs remain at their original baselines. Synchronization was deferred because the shared workspace was in use; inspection found no pending Git operation or candidate drift. No reset, stash, synchronization, dependency update, or ownership change was performed. The readiness Task's reservation gate still applies before managed delivery.

Candidate source: `cf247c3f3da659ec01a522ef8ec60340536ac9bf20867da53cd0cb2ff7428d61`.
Compiled package: `3ee5c0565de7b4e8ce161cf7ddb36fdb129ed517db04b1f638b40d94082321f1`.
Both were recomputed with `verifyCandidate()`. Documentation and the new test executor are outside the existing candidate fingerprint; their individual hashes and the full editable patch are retained separately. No implementation repair was needed and browser bytes did not change.

### Reproduce the PostgreSQL source test

The existing `createPostgresTestBackend` supports an explicit `TEST_DATABASE_URL` or its Docker fixture. The worker has PostgreSQL **15.19** binaries at `/usr/lib/postgresql/15/bin`; it does not need Docker or the declared dev database for this isolated source test. From the JS checkout, with a writable `TMPDIR`:

```sh
PG_BIN=/usr/lib/postgresql/15/bin bash test/run-native-token-postgres.sh
```

The executor creates a new private cluster under `TMPDIR`, database `native_token_validation`, role `native_token_test`, and a private Unix socket on port identifier 55432 with **no TCP listener**. Its fresh local trust authentication is restricted by the private directory, host authentication is rejected, and SQL/parameter logging is disabled. It selects only that cluster through `TEST_DATABASE_URL` and invokes exactly:

```sh
node --test --test-concurrency=1 test/postgres-native-tokens.test.mjs
```

All three tests passed: additive migration application/reapplication; real HTTP authorization, tenant/channel isolation, secret verifier and disclosure boundaries, canonical message/revision/outbox persistence, concurrent retries and conflicts, delayed retries, revocation, live membership/entity authorization and the 10-per-60-second limit; and fail-closed administrator capability checks. The existing harness owns unique schemas and uses pool limit 4. The post-test database query found zero remaining test schemas. The executor stops its own cluster on exit and retains its private fixture and logs for inspection. It never connects to an existing database. Keep the Unix socket path below the OS limit (107 bytes on this Linux executor).

This fixture establishes PostgreSQL 15 compatibility; the optional default Docker image (`postgres:16-alpine`) was not exercised. It provides no declared-runtime, UI acceptance or clean managed restart credit.

### Reproduce the Flutter source test

The installed SDK is still mounted read-only. An isolated copy was made with preserved metadata and no hard links to the original:

```sh
cp -a --reflink=auto /opt/handrail/.handrail/flutter-sdk "$TMPDIR/flutter-sdk"
git -C "$TMPDIR/flutter-sdk" rev-parse HEAD
# From handrail-sdk-chat-flutter:
CI=true FLUTTER_SUPPRESS_ANALYTICS=true \
  PUB_CACHE="$TMPDIR/flutter-sdk/bin/cache/pub-cache" \
  "$TMPDIR/flutter-sdk/bin/flutter" test --no-pub --concurrency=2 \
  test/durable_resource_event_reducer_test.dart
```

Use a fresh destination for each executor preparation. The copy and original are clean at revision `cc0734ac716fbb8b90f3f9db8020958b1553afa7`, Flutter **3.41.7**, Dart **3.11.5**. Both copies' Flutter entry point, engine version, Dart binary, Flutter test engine and tool snapshot hashes match. The original checkout's existing package configuration remains usable for read-only dependency resolution; no pub get, dependency installation, SDK upgrade or shared-cache permission change was needed. All **44 tests passed**, with the configured concurrency limit of two. The test compiles the exercised Dart code. A fresh JS `npm run typecheck` also passed.

The supported MCP SDK executor was inspected first: its runtime contract offers Node/Ruby/npm/bundle, not Flutter. The initial inspection required explicit commands; the corrected inspection with the exact PostgreSQL command then rejected this development request because it requires its own active read-only validation work request. Those failures are retained, not reported as passing independent verification. Both source checks above ran in this development worker's actual visible checkouts. Independent QA still needs its own assignment.

### Planner continuation

At that historical checkpoint, source-stage validation gaps were believed closed; the later independent review superseded that assessment. Preserve the full `native_token_delivery` acceptance criteria and shared readiness Task ownership. The following historical operations handoff remains authoritative for **dev_preview_delivery**: restore/inspect declared resource `c699099d-668d-4a0f-a5a0-7f52923f3e32` through `handrail_dev_resource_action`, prepare via `run_project_task` for runbook `977627c0-fdd0-479e-b2ae-8f016fe0ccaa` in `dev/project_workspace`, and use `handrail_dev_service_action` for service `812c4054-6ced-4616-94fb-13f672b3e897`. These operations require that subsequent stage's authority. This worker did not re-probe or recover the declared resource, start an acceptance host, or change Handrail configuration, database, queue or workflow state. Independent review, actual administrator UI plus external HTTP, retained first-run evidence, managed clean restart, repeat contact proof and build-status proof are still required. The isolated executors do not resolve the managed preparation executor's writable-cache prerequisite.

## Host integration and API

Apply the normal `handrailChatPostgresMigrations` with the SDK migration runner in the host's explicitly selected schema before enabling these routes. Migration `0044-chat-native-tokens` is additive; it creates token metadata/verifiers, tenant-scoped channel grants, permanent retry receipts and shared authentication counters. Existing migration checksums and message wire contracts are unchanged.

Grant `native_tokens.manage` only from the trusted host `permissions.getCapabilities({actor})` adapter to administrators. A role name or any caller field cannot grant it. The existing host session adapter remains authoritative; this SDK does not implement a password login. Existing session, membership and entity policies continue to apply. Host password/login endpoints remain the host's responsibility under the project's authentication requirements; this change adds no password, MFA or account lockout rules.

Embed `NativeTokenManager` from `@handrail/chat/ui` with `endpoint` (the chat API mount), a stable `getHeaders` callback, and the **required** `sessionScope: string | null`:

```tsx
<NativeTokenManager
  endpoint="/api/chat"
  getHeaders={getCurrentHostSessionHeaders}
  sessionScope={session
    ? JSON.stringify([session.tenantId, session.userId, session.loginEpoch])
    : null}
/>
```

`sessionScope` is a non-secret identity boundary, not a bearer token. The host must change it synchronously with every tenant change, user change, logout/login, or replacement authentication session, including a new login for the same user. Use a login epoch/session identifier that is not itself a credential. Pass `null` immediately on logout or while identity is unknown. Do not defer this security update through a transition, and do not mutate the identity behind a stable getter without rendering the new scope. Routine bearer refresh within the same identity/session need not change scope. `getHeaders` must return only that session's host credentials; never pass an integration secret. An omitted/empty scope fails closed at runtime, and omission is a TypeScript error. The server remains the authorization authority.

The exported component enforces its own keyed scope boundary, including endpoint changes: it scrubs the disclosure input during layout cleanup (also clearing detached DOM), discards token/form/error/busy state, aborts pending requests, and invalidates every old generation. Delayed header resolution cannot dispatch a request after invalidation. Listing, creation, revocation, response-body parsing, errors and finalizers must all belong to the live generation before updating UI. StrictMode's setup/cleanup/setup cycle is supported. Changing the callback still invalidates work, but callback identity alone is not an authentication contract.

Secrets stay outside chat caches, React token metadata, application storage and persistent browser storage. Dismissal, revocation and unmount also clear disclosure. Cancellation cannot undo a write already accepted by the server: after an interrupted creation, the original authorized session must inspect its metadata and revoke an unused token; never blindly repeat an uncertain creation. The Chat Lab passes its fixed fixture tenant/actor scope to the reusable component. Ada is the sole fixture administrator; Grace and Margaret are denied server-side. These identities are for the scoped development host only.

Paths below are relative to the host's chat API mount (`/api/chat` in Chat Lab):

| Request | Authentication and behavior |
| --- | --- |
| `GET /native-tokens` | Host administrator; returns `{tokens:[{id,name,senderUserId,createdByUserId,createdAt,revokedAt,channelIds}]}` without secrets or verifiers. |
| `POST /native-tokens` | Host administrator; JSON `{name,channelIds}`. A trimmed name is 1–80 characters; 1–50 IDs before deduplication. The administrator must be an active member of every unarchived channel in their tenant and pass its entity send policy. Returns `{token,secret}` once. |
| `DELETE /native-tokens/:id` | Host administrator in the token's tenant. Revocation is repeatable; another tenant sees 404. |
| `POST /native-inbound/messages` | `Authorization: Bearer <native secret>`; JSON `{channelId,text,idempotencyKey}` only. Returns the canonical `SendMessageResult` with `applied` or `replayed`. |

Native bodies must be JSON and fit 20,000 UTF-8 bytes. Text is 1–16,000 characters; channel IDs and idempotency keys are 1–200 characters. Content is plain text (links can appear in it). Attachments, mentions, caller identity, roles, arbitrary blocks, threads, DMs and provider integrations are outside v1. Unknown fields are rejected, not merged into trusted state.

Failures use sanitized errors: 400 malformed input, 401 invalid/revoked credentials, 403 forbidden channel/capability/entity access, 404 unavailable token for management, 409 conflicting retry, 429 rate limit. Responses use `Cache-Control: no-store`. Every native authentication request, including invalid credentials and management requests, consumes a **shared PostgreSQL rolling limit of 10 requests in 60 seconds**. Rejections do not extend the window; 429 returns `Retry-After: 60`. The key hashes the socket peer address. Forwarded headers cannot select a new bucket; behind a proxy this deliberately applies the stricter shared proxy-peer budget. Ordinary chat reads/sends do not consume this native budget.

Secrets contain 256 cryptographically random bits. Only SHA-256 verifiers are stored. They are not ordinary sessions and are rejected before HTTP/WebSocket host authentication. Keep native tokens on sender servers. Do not log Authorization headers, token creation response bodies, screenshots of the disclosure, HAR files or network traces. Host admission/logging middleware must preserve that redaction boundary too.

Each token has a reserved `native-integration:<UUID>` sender identity with ordinary member rows only for granted channels. Hosts must reserve this identity namespace; never authenticate it as an ordinary host user. Token creation advances membership revisions. Historical membership rows and metadata remain after revocation for attribution; they cannot make the revoked credential authenticate. Directory batch lookup exposes the metadata name as `<name> (integration)` to authorized users in the same tenant. Existing React and Flutter user-author message contracts remain intact.

Inbound sends call the existing `sendMessage` transaction, including sequence allocation, message/revision/audit persistence and the durable realtime outbox. Credential locks serialize with revocation; scope and live membership are checked again before persistence and replay. Entity policy is checked for both new sends and retries with the restricted integration actor. A host can deny integration sends to entity-linked channels. The token never inherits its creator's administrator capability.

Retry keys are scoped to the token and tenant. Identical requests return the original message; a changed destination/text under the same key returns 409. Native receipts survive the ordinary 24-hour idempotency cleanup, so delayed retries cannot create a second message. Receipts contain canonical results, never credentials. Retain them with token/message history; do not purge them while promising retries. Revocation also denies retries of previously accepted messages.

## Two sender examples

Set server-side `CHAT_NATIVE_TOKEN` through a secret store or non-logged process environment; never put a live token in a command literal, file, screenshot or issue. Set `CHAT_API_URL` to the authorized managed origin plus `/api/chat`, and `CHAT_CHANNEL_ID` to the token's allowed channel ID. From the JS checkout:

```sh
node examples/drop-in-react/scripts/send-native-example.mjs contact
node examples/drop-in-react/scripts/send-native-example.mjs build
```

The first sends a synthetic contact-form request with an `example.test` address. The second sends build identity `sdk-demo-042`, outcome `PASSED`, and an `https://example.test/builds/sdk-demo-042` link. The script prints only the message ID/reconciliation status or HTTP failure status. Repeating the same command is an idempotent retry; change the logical key when sending a new event. No external provider receives these fixture messages.

## Reproducible candidate binding

The manifest **and lockfile retain** the public HTTPS Git dependency at full SHA `90bff33529df06720ff89ccd821360ac65eaf0d0`. No registry, file, workspace, branch, tag or tarball dependency is introduced. This preserves the SDK installation policy. The unpublished checkout is selected through development resolvers, not a dependency upgrade or package publication:

- `npm run build` runs the normal compiler and writes `dist/candidate.json`: SHA-256 source and compiled-package manifests, with individual file hashes. No packaging step is required.
- `candidate-binding.mjs` verifies those bytes and registers a Node resolver for this checkout's `dist` exports. The lab's harness/provenance imports are deferred until binding is installed, including when another module imports the lab. The supported `dev:lab` entry point preloads it.
- `candidate-vite.mjs` aliases browser imports to the same `dist`, deduplicates React through the existing configuration and injects candidate hashes. The example typechecker uses matching compiled declarations. Browser graph verification asserts no server implementation code enters assets.
- `/__chat-lab/instance` exposes the startup candidate receipt, loaded-function provenance, instance ID and owned schema. `#root[data-candidate-source][data-candidate-package]` exposes the browser build identity. The validation receipt also hashes built browser assets.

Any implementation/source drift requires a new build and managed restart. Freeze shared source ownership during acceptance: Vite is a development server, not an immutable deployment. Re-run local `verifyCandidate()` and compare both remote/browser hashes before every QA run. A successful local build or a matching package version alone is not runtime evidence.

## Operations handoff: declared environment only

Worker `ee69e0a5-808b-4661-b017-66fe1473bc95`, work request `cfdb8ccf-c384-47c4-bde1-cd4d2722935d`, Task `683debf3-0399-4706-bf74-9d476d08ac43`. This source stage did not start, prepare, restart, deploy, commit, push, publish, change queue state or write Handrail control-plane data.

1. Coordinate the shared checkout/runtime reservation with readiness Task `bbc011e4-ff3f-416a-8266-262c1a9ea560` through the existing native Task planner. The startup synchronization was deferred (`main_workspace_in_use`). All three repo working trees were initially clean at the supplied baselines, and no Git operation was reset/stashed/discarded. This worker's exposed tools do not provide a readiness Task reader/reservation handoff, so that cross-task ownership gate remains for the planner. No new controller was launched.
2. Restore/check only the declared dev PostgreSQL resource `c699099d-668d-4a0f-a5a0-7f52923f3e32`. The current read-only MCP probe failed with `ECONNREFUSED 127.0.0.1:36834`. Provision/start requires the subsequent authorized operations stage. Do not point tests at another project, production or an operator schema. The existing harness creates unique schemas and uses pool limit 4. A test URL must be an explicitly approved SDK dev/test resource; otherwise its existing Docker testcontainer path must be usable.
3. Use preparation runbook `977627c0-fdd0-479e-b2ae-8f016fe0ccaa` via `run_project_task`, **dev / project_workspace**, in this JS checkout. Its command is `npm ci --include=dev && npm run setup:lab`; setup installs the locked example Git consumer and runs `build:flutter:lab`. Required: Node >=22 with `registerHooks` (verified executor: 22.23.1), npm, network/cache for locked installs, and the declared Flutter SDK with writable build caches for that native executor. The queued worker sees all three repository checkouts, but its Flutter cache is read-only. Do not substitute another SDK/runtime. No dependency installation was needed for this worker's JS checks; its existing modules were usable.
4. Run focused checks below sequentially. `TEST_DATABASE_URL` is read by the existing test harness; it never uses `DATABASE_URL` implicitly. The live lab's existing selection order is explicit option, `CHAT_LAB_DATABASE_URL`, `TEST_DATABASE_URL`, `DATABASE_URL`, then Docker. Explicit invalid selections fail without fallback. Operations must verify the selection targets the declared SDK dev resource before startup; do not silently let a missing selection substitute another environment.
5. Start/restart only dev service `812c4054-6ced-4616-94fb-13f672b3e897` using `handrail_dev_service_action`. It is a host-process service, port **4167**, health `/__chat-lab/health`, command `npm run build && npm --prefix examples/drop-in-react run dev:lab`. It was stopped with no supervised listener or QA route during this worker. No Kubernetes deployment target exists. Use the service's scoped QA route; never a raw listener or guessed URL. If a probe/UI hits 5xx, obtain `get_dev_service_logs` before interpreting the failure.
6. Independent QA must verify the final candidate and schema, create the token through Ada's actual UI, post from an external HTTP client, see integration attribution and persistence after reload, and prove denial, retry conflict, ordinary-user management denial and UI revocation. Retain sanitized first-run evidence and read it back before any cleanup. PostgreSQL fixture tests are supporting evidence, not acceptance.

Prepare the example's locked dependencies before source testing:

```sh
npm ci --include=dev --prefix examples/drop-in-react
```

This preserves the existing public HTTPS full-SHA SDK dependency and lockfile. The candidate binding resolves the working checkout's rebuilt exports; no tarball, registry publication, file/workspace dependency or Git pin rewrite is involved. An independent executor must mount these nested dependencies (including Vitest/jsdom) as well as the root dependencies; a missing nested mount is an unavailable check, not a passing test. Do not commission unrelated broker repairs. The source repair executor and exact argv/output are retained with its report.

Useful checkout checks (all from `handrail-sdk-chat-js`, one heavy command at a time):

```sh
npm run build
npm run typecheck
node --test --test-concurrency=1 test/native-token-boundaries.test.mjs test/native-candidate-binding.test.mjs test/request-context.test.mjs test/send-message-http.test.mjs
node --test --test-concurrency=1 test/postgres-native-tokens.test.mjs
npm --prefix examples/drop-in-react run typecheck
npm --prefix examples/drop-in-react run build
npm --prefix examples/drop-in-react run check:graph
npm --prefix examples/drop-in-react run test:native-tokens
node --test --test-concurrency=1 examples/drop-in-react/test/NativeTokenProofPacing.test.mjs
```

For the existing Flutter check use configured project-workspace task `1ef67036-3996-447c-95a1-1d795b921c7e`, command `flutter test --concurrency=2 --no-pub test/durable_resource_event_reducer_test.dart`, after its declared SDK cache is available. The similarly named isolated task does not establish project-workspace visibility.

`examples/drop-in-react/scripts/verify-native-tokens-managed.mjs` is an optional independent acceptance runner against an **already managed** service; it never starts app/database services. It requires `CHAT_LAB_QA_URL`, `CHAT_CANDIDATE_SOURCE_SHA256`, `CHAT_CANDIDATE_PACKAGE_SHA256`, `CHAT_LAB_ALLOWED_CHANNEL_ID` (the default General channel) and `CHAT_LAB_DENIED_CHANNEL_ID`, plus the operations executor's supported Playwright browser. Resolve those IDs through the authorized host conversation list in the fresh fixture. The runner uses a fresh browser context, checks both hashes and the owned schema, and exercises contact, retries, conflicts, denial, reload, build status and UI revocation. It uses the browser library without the test runner so error-context snapshots cannot retain the secret. No traces, screenshots or video are enabled. Its output is a sanitized JSON receipt. It has not been run here. Native QA tooling can exercise the same sequence if the managed proxy requires its scoped browser session; do not bypass proxy access controls. The runner now routes every native browser request (including StrictMode listings and dialog reopenings) and external HTTP request through one conservative 10-per-60-second scheduler. It reserves slots until 60.25 seconds after response completion and serializes attempts. An explicit SDK 429 is known to occur before route dispatch, so it honors `Retry-After` (at least 60 seconds) and retries that rejected request at most twice; repeated 429 remains failure. Transport failures, timeouts and 5xx have uncertain write effects and are never automatically replayed. Initial unknown/shared traffic can therefore cause a bounded wait or explicit failure, never a skipped denial or revocation assertion. No server setting or counter is changed. Browser waits allow pacing to finish. The regression exercises 13 requests, including two listings per mount, contact/retry/conflict/denied-channel/build, reopen/revoke/post-revocation and ordinary-user denial, through the actual browser and fetch adapters. The current component suppresses its first StrictMode request before dispatch, but the proof retains the larger budget. This scheduler does not add the separate manual attribution, ordinary-user UI, clean-state or second-run acceptance assertions; independent QA must still perform all of them.

## Clean isolated restart

The current lab creates `handrail_chat_lab_<32 hex>` through `createChatTestHarness` on every startup. Browser reload retains PostgreSQL messages within that instance. Graceful managed shutdown calls harness teardown, which drops only schemas registered as owned by that harness; it does not reset the database/public/operator schemas. This is intentionally disposable lab state, not persistence across server restarts.

After first-run evidence has been retained and read back, record instance ID/schema/hashes and request the normal managed stop/restart. Verify the old owned schema was removed through scoped database readers, the new instance ID **and** schema differ, the candidate hashes remain identical, and the new fixture contains neither the old token metadata nor test messages. Use a new browser context without storage state/cookies from the first run. Repeat the complete contact-form, denied-channel and revocation proof, then the build-status example through the same UI/HTTP mechanism. Retain second-run evidence separately, including all previous failures.

If shutdown was abrupt or teardown failed, the in-memory ownership ledger cannot authorize automatic orphan cleanup after restart. Report the exact leftover schema and its retained ownership evidence to operations; do not add broad prefix-based `DROP SCHEMA`, database resets, restores or shared-database cleanup. A runtime source repair invalidates affected acceptance: rebuild, deliver via the native lifecycle and repeat independent checks.

The original planning-run failure `befa5e1f-add1-41c9-abc5-a8dd9a09e0ae` is retained: the context reader was advertised but rejected the planner because it lacked a worker attachment. Recovery used its supplied brief and scoped readers. The shared correction remains with Dev Chat `9c594130-8db3-4771-9e2b-3c725f29c1fe`; no duplicate repair was commissioned. This worker successfully read the frozen instruction sources and all four attached memory publications. Goal activation separately failed with “This direct tool has no verified Task stage effect scope”; continuing this same assignment did not create a replacement controller.
