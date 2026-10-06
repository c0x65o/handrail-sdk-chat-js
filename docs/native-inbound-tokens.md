# Native inbound channel tokens

Native tokens let a sender server post plain messages to explicit channels in one
tenant. Trusted host administrators manage them through `NativeTokenManager` from
`@handrail/chat/ui`; Chat Lab exposes **Inbound channel tokens** in workspace
settings. Ada is its synthetic administrator. Grace and Margaret are denied by
the server. No custom role designer, reads, user impersonation, app install, OAuth,
webhook/event platform or external integration activation is included.

Current combined workspace delivery: boundary continuation WR
`121b9f48-254b-43cd-8785-2e3ac7b943ee`, worker
`b7633454-cf2b-41af-8c47-d0975ca06429`, preserving the implementation from WR
`a0285beb-c597-4f21-a940-c79c141e58f9`. Based on JS **1.0.48** at
`7ccdbcc42b9092fa0aef0ff258d840e2a6510306`. This patch is uncommitted and has no
installable release SHA. See [boundary qualification](validation/native-token-boundary-20261006.json)
for exact source/package hashes, edited files, tests and remaining managed checks.
The [prior qualification](validation/native-token-finish-20261006.json) retains
the unchanged Flutter reducer proof and original implementation evidence.
[September history](validation/native-token-history-202609.md) and the existing
validation JSON files are preserved as historical evidence, not current gates or
instructions to restart retired planners.

## Host integration

Apply `handrailChatPostgresMigrations` through the normal SDK migration runner in
the host's explicitly selected schema. Existing migration `0044-chat-native-tokens`
provides credentials, channel grants, retry receipts and shared authentication
counters. Rotation and lifecycle audit reuse the existing tables and durable audit
dispatcher; they need no migration changes.

Grant `native_tokens.manage` only in the trusted host's
`permissions.getCapabilities({actor})` policy. Caller roles cannot grant it. The SDK
uses the host session adapter; it implements no password login and changes no
password, MFA, failed-login or account-lockout policies. A native token gets only
`message.send` as an integration actor. Channel membership and host entity policy
continue to apply, including on retries.

```tsx
<NativeTokenManager
  endpoint="/api/chat"
  getHeaders={getCurrentHostSessionHeaders}
  sessionScope={session
    ? JSON.stringify([session.tenantId, session.userId, session.loginEpoch])
    : null}
/>
```

`sessionScope` must be a non-secret identity boundary. Change it synchronously on
every tenant/user change, logout/login or replacement authentication session, even
for the same user. Pass null while identity is unknown. The component aborts stale
requests, rejects late header/response resolution, clears token/form/error state
and scrubs the disclosure input, including detached DOM. A stable header callback
is supported; changing hidden host identity without rendering a new scope is not.
Never pass an integration secret as host session headers.

Secrets are disclosed once and are kept out of chat caches and browser storage.
Dismissal, successful revocation, session transitions and unmount scrub the input.
The UI requires confirmation before rotation, and shows metadata IDs for recovery.
A failed/interrupted creation may have committed: refresh metadata, inspect IDs,
and revoke unused credentials before creating again. A lost replacement secret
cannot be recovered: rotate again and configure the sender with the new secret.
Do not automatically repeat uncertain writes. Session cancellation cannot undo a
server commit; return to the original authorized session to inspect its metadata.

## HTTP API

Paths are relative to the chat API mount, `/api/chat` in Chat Lab. JSON responses
use `Cache-Control: no-store`.

| Request | Authority and behavior |
| --- | --- |
| `GET /native-tokens` | Host administrator. Returns metadata IDs, names, sender/creator IDs, timestamps and channel IDs; never a secret or verifier. |
| `POST /native-tokens` | Host administrator; `{name,channelIds}`. Name 1–80 characters, 1–50 channel IDs before deduplication. Must be an active member of each unarchived same-tenant channel and pass entity send policy. Returns `{token,secret}` once. |
| `POST /native-tokens/:id/rotate` | Host administrator; exactly `{}`. Rechecks channel/entity authority. Replaces the verifier atomically; old secret stops working at commit. Keeps token ID, integration sender, name, grants, creator and permanent retry history. No grant expansion or membership restoration. Revoked token returns 409; foreign/missing token 404. Returns `{token,secret}` once. |
| `DELETE /native-tokens/:id` | Same-tenant host administrator. Repeatable revocation, including when channel access has been lost. Foreign/missing token returns 404. |
| `POST /native-inbound/messages` | Native bearer credential; `{channelId,text,idempotencyKey}` only. Returns canonical `SendMessageResult` with `applied` or `replayed`. |

Rotation has no grace interval. Coordinate sender updates accordingly. Concurrent
rotations serialize; the last committed replacement is the valid secret. Prefer
one administrator coordinating each rotation. To change channel grants, revoke
and create a separately scoped credential; v1 rotation always preserves grants.

Bodies must be JSON within 20,000 UTF-8 bytes. Text is 1–16,000 characters; channel
IDs and idempotency keys are 1–200 characters. Unknown fields, threads, DMs,
attachments, mentions and arbitrary blocks are rejected. Errors are sanitized:
400 shape/size, 401 credential, 403 access, 404 token, 409 conflict/revoked rotation,
429 rate limit. Each native route shares PostgreSQL's rolling **10 requests per
60 seconds** budget keyed by the hashed socket peer. Forwarded headers cannot
select a new bucket. A proxy peer therefore has a stricter shared budget.
Rejections do not extend the window; 429 returns `Retry-After: 60`. Ordinary chat
operations do not consume that native budget. Configured host controls still apply.

Tokens have 256 cryptographically random bits, stored only as SHA-256 verifiers.
Native secrets cannot authenticate ordinary HTTP or WebSocket sessions. Reserve
the native bearer namespace even with mixed case, leading/trailing whitespace,
multiple spaces or tabs. The shared guard rejects these before host authentication;
the native inbound endpoint still requires its strict secret syntax. Ordinary host
credentials are passed through unchanged. Reserve
`native-integration:<UUID>` from ordinary host user identities. Directory lookup
presents `<name> (integration)`. Revocation retains historical metadata/member rows
for attribution; they cannot authenticate a revoked credential.

Send transactions serialize with revocation and rotation. Same-tenant channel
scope, live membership and entity authorization are enforced before persistence
or replay. Retry keys are scoped to the token/tenant; an identical request returns
the original message and a changed destination/text returns 409. Native receipts
survive ordinary 24-hour idempotency cleanup and rotation. Revocation denies
retries too. Retain receipts with message/token history while promising retries.

Creation, first revocation and each rotation append `native_token.created`,
`native_token.revoked` or `native_token.rotated` to `chat_audit_events` in the same
transaction. Records contain generated event/request IDs, tenant, actor, token
ID and server time, with empty metadata. Existing durable delivery enqueueing and
host audit dispatch apply. Repeated revocation adds no duplicate lifecycle event.
Audit failure rolls back the credential change. Names, request bodies, raw secrets
and verifiers never enter these lifecycle records. Hosts must also redact native
Authorization headers and disclosure responses from ingress/application logging.

## Sender examples and isolated verification

The [contact-form HTTP handler](../examples/native-contact-form/README.md) mounts
in an existing server with required host submission authorization, bounded fields,
a fixed destination, stable retries and sanitized errors. Keep `CHAT_NATIVE_TOKEN`
on the sender server, never in browser code, command literals or evidence.
`examples/drop-in-react/scripts/send-native-example.mjs contact` and `build` remain
synthetic command-line examples. This work enables no customer integration.

Run checks sequentially from the JS checkout:

```sh
npm run build
npm run typecheck
node --test --test-concurrency=1 test/native-token-boundaries.test.mjs test/native-candidate-binding.test.mjs test/native-contact-form.test.mjs test/request-context.test.mjs test/send-message-http.test.mjs test/websocket-upgrade.test.mjs test/websocket-session-revalidation.test.mjs
npm --prefix examples/drop-in-react run typecheck
npm --prefix examples/drop-in-react run build
npm --prefix examples/drop-in-react run check:graph
npm --prefix examples/drop-in-react run test:native-tokens
node --test examples/drop-in-react/test/NativeTokenProofPacing.test.mjs
# Set TMPDIR to a private writable scratch directory (short enough for Unix sockets).
PG_BIN=/usr/lib/postgresql/15/bin NATIVE_TOKEN_ISOLATED_BROWSER=1 bash test/run-native-token-postgres.sh
```

The helper creates its own PostgreSQL 15 cluster/private Unix socket, disables SQL
and parameter logging, uses the existing SDK harness, tears down owned schemas,
and stops its cluster on exit. It never connects to an existing DB. The optional
browser check requires installed Playwright Chromium (`PLAYWRIGHT_BROWSERS_PATH`
may select a writable worker cache). It starts the actual `startChatLab` fixture on
an ephemeral loopback port, uses the exact working-tree SDK resolver, exercises
UI creation/rotation/revocation plus HTTP contact delivery, attribution/reload,
retries and denial, then repeats on a clean instance. It is React browser runtime
proof; it does not build/exercise Flutter UI or qualify the managed proxy/service.
No browser traces, screenshots or videos are retained.

SDK installations remain public HTTPS Git full-SHA pins with matching lockfiles;
no npm registry publication or separate packaging step is involved. The existing
example dependency pin is preserved. Local qualification uses the supported
`candidate-binding.mjs` / Vite development resolvers to rebuilt `dist`, not a
replacement file/workspace dependency. `dist/candidate.json` fingerprints source,
compiled package and the contact example. The browser root and
`/__chat-lab/instance` expose the same hashes. Rebuild and requalify after any drift.

## Managed qualification: next operations for the owning workflow

Read-only MCP inspection in this run found service
`812c4054-6ced-4616-94fb-13f672b3e897` stopped, with no listener or QA route.
Resource `c699099d-668d-4a0f-a5a0-7f52923f3e32` has a missing Docker container,
a retained volume and probe health down. Its stored port is last-known, not current.
The configured preparation task `977627c0-fdd0-479e-b2ae-8f016fe0ccaa` remains
`npm ci --include=dev && npm run setup:lab` in dev/project_workspace. This worker
performs no Handrail state writes, service actions, commits, pushes or deployment.

1. Recheck `handrail_dev_service_status` and the declared SDK dev database resource
   before choosing a managed execution window. Under separate operations authority,
   use `handrail_dev_resource_action` with `action=start`, `resource_type=postgres`
   and this exact resource ID to recover it non-destructively (never `recreate`).
   Verify reconciled bindings and reload consumers if requested. Inspect the selected DB binding;
   do not use a production/customer DB or reset a shared database. The lab picks
   explicit option, `CHAT_LAB_DATABASE_URL`, `TEST_DATABASE_URL`, `DATABASE_URL`,
   then the supported disposable-container default; explicit invalid selections
   fail without fallback.
2. Under the parent's separate operations authority, run the exact preparation
   task via `run_project_task` with `env=dev`. Its Flutter preparation needs the
   declared SDK with writable caches. The queued worker's read-only SDK can be
   tested using a fresh same-revision `cp -a --reflink=auto` scratch copy without
   hard links; never change shared SDK permissions or substitute another revision.
   If `.dart_tool/package_config.json` points to an unavailable cache, run
   `flutter pub get --enforce-lockfile --no-example` in the SDK checkout using
   the scratch Flutter executable and a private `PUB_CACHE`, then run the
   configured `flutter test --no-pub --concurrency=2
   test/durable_resource_event_reducer_test.dart`. This run repaired only generated
   cache resolution; Flutter source and lockfile remained unchanged.
3. Use `handrail_dev_service_action` on the existing service to start/restart.
   Keep port **4167**, health `/__chat-lab/health`, command
   `npm run build && npm --prefix examples/drop-in-react run dev:lab`. No Kubernetes
   deploy target is configured. Obtain its scoped QA route; do not guess a URL.
4. Recompute `verifyCandidate()` and compare server/browser hashes. Resolve General
   and a denied fixture channel using the authorized host conversation list.
   Supply `CHAT_LAB_QA_URL`, `CHAT_CANDIDATE_SOURCE_SHA256`,
   `CHAT_CANDIDATE_PACKAGE_SHA256`, `CHAT_LAB_ALLOWED_CHANNEL_ID`,
   `CHAT_LAB_DENIED_CHANNEL_ID`, and supported Chromium to
   `node examples/drop-in-react/scripts/verify-native-tokens-managed.mjs`.
   The runner uses one conservative request pacer across browser/HTTP calls,
   preserves the server limit, rejects uncertain automatic retries, and revokes
   its known fixture credential in cleanup. If creation is interrupted before its
   metadata ID is read, inspect/revoke that fixture via the authorized host UI.
   If the managed proxy requires its scoped browser session, use native QA tooling
   for the same sequence; never bypass proxy controls. Obtain dev-service logs for
   5xx before drawing conclusions.
5. Retain/read the sanitized first-run receipt, then use the managed lifecycle to
   stop/restart. Verify old owned schema removal, distinct instance/schema, same
   hashes and fresh fixture state. Repeat the full proof in a new browser context.
   Abrupt-shutdown orphan schemas require exact ownership evidence; never clean up
   by schema prefix. Managed acceptance and release remain the parent's decision.
