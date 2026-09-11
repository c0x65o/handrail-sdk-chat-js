# Hitcents ERP integration recipe — planning supplement

This is documentation for owner task `24350c4f-985e-4762-ac15-445f69009f18`,
original work request `0bb40a03-7913-4993-be3d-d60ef7fcb3cd`, continued by
`fbbb5fd9-1672-413b-84d0-42ae5d06a564`, dated 2026-09-11, under strategy
`04195e83-6774-46f8-af9e-216d41186860`.
**Not ready for adoption:** the seams below identify concrete host work; they
do not establish an installed integration or independent runtime verification.
The existing sole accountable lead owns delivery; independent management owns
acceptance. The documentation correction is complete for review; future ERP
adapter implementation and adoption are separate, unauthorized work here. This
supplements the [SDK evidence package](validation/owner-task-24350c4f/README.md)
and [generic pilot guide](pilot-integration.md); it does not replace source
fixes, test results, or the existing independent review. The separate
[documentation revision](validation/owner-task-24350c4f/hitcents-planning/README.md)
records exact hashes, correction responses and verification without changing
runtime artifact `248f3f7986001f99414f5a149c477177059b1dcfc0a49be7c223a6190a5fc2eb`.

## Evidence provenance and limits

**Planner source inspection, supplied to this worker:** contextual Hitcents
project `0f617308-8c3a-4ad4-83e7-34b1fda024b3` remains strictly read-only.
The planner inspected web checkout
`/opt/handrail/repos/hitcents/hitcents-erp/hitcents-erp` at HEAD
`ce2d88ba445b23448af59854eb8c25fda793c2b2` and mobile checkout
`/opt/handrail/repos/hitcents/hitcents-erp/hitcents-erp-mobile` at HEAD
`5928f56c6c2167a279e5ffa845abb57f1d9211d7`.
Working-file hashes, rather than HEAD alone, identify the inspected content.
The September 11 planner turn `0b7dc5b6-cc39-4f59-956f-15c446de1e9f`
supplied 17 SHA256 identities, now saved with full checkout roots and expanded
relative paths in the [source provenance record](validation/owner-task-24350c4f/hitcents-planning/revision-2026-09-11/erp-source-provenance.json).
These are planner-inspected working files, not a claim of clean ERP worktrees,
committed-blob identity, or direct worker inspection/re-hashing. HEADs supply
checkout context only. Earlier missing-hash/mobile statements remain historical
in the preserved prior report and verification manifest.

The earlier worker's `read_source_code` request for ERP `package.json` failed
with repo not found; its reader exposed only the three Chat checkouts and no
project selector. That historical limitation remains recorded. This supplement
uses the supplied planner evidence without retrying denied paths or claiming
direct ERP inspection. Local SDK contracts and documentation were read directly.
No ERP install, predev, migration, source/configuration change, deployment, or
runtime probe is part of this work. In particular, **do not run ERP predev**:
it invokes migrations.

All ERP paths in the following table refer to the web checkout and are planner
source inspection, not independently reproduced runtime results. Mobile findings
are recorded separately below.

| Planner-inspected seam | Established source finding | Integration implication / missing evidence |
| --- | --- | --- |
| `src/server/auth/http.ts`, `src/server/auth/session.ts` | Session cookies authenticate through SessionService; middleware exposes principal/sessionToken. Sessions check active users, revocation, expiration and active roles, and store token digests. Principal has userId, roleNames and permissions, no tenant. | Server-derived actor mapping is possible. Explicit tenant policy and a credential-free active-session handle adapter are still required. |
| `src/server/database/schema.ts`, users/teams | users.teamId references teams. | A team is not a tenant identity. No tenant boundary is established by that foreign key. |
| `src/server/business/service.ts:258`, `src/server/business/http.ts` | listActiveUserReferences selects active users' id/displayName/initials; `/api/references/users` is guarded. | Starting point for the Chat directory, with host-authoritative access filtering. This is not proof of actor-filtered Chat search. |
| `src/server/database/client.ts` | PostgreSQL pool and Drizzle use hitcents_erp_app search_path. | Borrow the pool with a dedicated explicit Chat schema; review migrations and pool ownership. |
| `src/server/index.ts`, `src/server/app.ts` | startProductionHttpServer creates the HTTP server; shutdown handling exists; Express middleware/routes are mounted in app.ts. | Mount HTTP and attach upgrades to that same server. These entry points do not establish existing Chat fanout. |
| `src/server/database/schema.ts:923`, BusinessService.listFileItems/createFileItem | file_items stores folders, text documents and links, with content/url metadata. | No signed binary upload, object verification, authorized download or delete adapter is established. |
| `src/server/business/task-notifications.ts` | Task-assignment activity events are written. | Neither native push nor a Chat notification delivery adapter is established. |
| `src/browser/App.tsx`, ProductOutlet | Existing modules are selected. | No Chat integration is evidenced; guarded React placement and routing remain host work. |

| Planner-inspected mobile seam | Established source finding | Integration implication / missing evidence |
| --- | --- | --- |
| `lib/auth/native_auth_client.dart` | Defines `SessionClient` / `SessionExpirationSource`, secure cookie storage, `authenticatedSessionHeaders` and `createAuthenticatedApiHttpClient`. Native HTTP supplies the ERP cookie. Unauthorized responses clear native state and notify the auth gate; `signOut` clears in `finally`. | Reuse authenticated HTTP for Chat token exchange; integrate expiration/logout cleanup. ERP cookies are never Chat credentials. This is not a Chat WebSocket transport. |
| `lib/http/api_http_client_web.dart` | Browser sessions use `BrowserClient.withCredentials`. | Let the browser carry the ERP session for exchange under host CSRF/origin policy; do not extract cookies into Chat tokens. |
| `lib/app.dart` | Creates `NativeAuthClient` from `config.apiBaseUrl`; contains `_PortalRouterDelegate` / `_featureOutlet`. | Concrete guarded shell/router placement for `ChatScope` / `HandrailChatWorkspace`; no installed Chat module is established. |
| `lib/config/app_runtime_config.dart` | Supplies trusted app runtime configuration. | Derive proposed exchange, API and realtime endpoints from the trusted API base, preserving any base path; this plan changes no configuration. |
| `lib/navigation/module_access_policy.dart` | No Chat module. | Add a future server-backed Chat access guard for navigation and direct links; existing module access does not grant Chat membership. |

Planner-inspected `package.json` declares web React **19.2.8** and Node
**>=22.12.0**; mobile `pubspec.yaml` declares Dart **^3.11.5**. Neither declares
a Chat dependency. These are consumer source constraints, not consumer install,
build, native runtime or adoption proof. Retained SDK compatibility results do
not establish that either ERP builds with the future selected Chat Git pins.

## 1. Freeze the pilot artifact and host policy

In a separately authorized adoption change, use independently accepted,
committed SDK revisions. Resolve the latest committed revision for a new
installation; honor a frozen revision for an upgrade. Use the public HTTPS Git
repositories at full 40-character SHAs and matching npm/pub lockfiles. Keep
compilation in the normal install/build pipeline (`prepare` for JS); no
tarball, file, registry, workspace, branch or tag dependency and no separate
packaging/publication step. Existing example pins do not include uncommitted
fixes. Record JS/Dart compatibility and consumer build results for the exact
selected artifacts; this recipe selects no new pin and changes no dependency.

The host must explicitly decide the Chat tenant policy. For a single-organization
pilot, a server-configured immutable organization identifier is a possible
policy **only after** the host confirms every permitted participant belongs to
that boundary. Otherwise implement authoritative organization membership and
selection on the server. Never derive tenantId from users.teamId, browser
scope, headers, query parameters, body fields or a deep link. Deny Chat access
until this policy is defined; a missing tenant claim is not a default grant.

## 2. Bridge authentication, authorization and directory

- Implement `ChatAuthAdapter.resolveActor` using the authenticated SessionService
  boundary: principal.userId becomes the stable Chat userId; active roleNames
  map to Chat roles; tenantId comes from the approved host policy. Validate ID
  format and use a stable server-owned mapping if conversion is necessary.
  No second Chat login or CRM/HR identity store is needed.
- Implement `permissions.getCapabilities` as an explicit mapping of current
  host permissions/roles to SDK capabilities. Implement `authorizeEntity` for
  host entities and directory lookup/search/subscription actions, deny unknown
  entities/actions, and retain tenant, membership and parent-thread checks.
  Chat membership must not grant access to an ERP record the actor cannot read.
- Add a host-owned `/api/chat/session` token exchange route, authenticated by
  the existing HTTP-only session. Follow the [pilot client contract](pilot-integration.md#reactvite-client):
  return only a short-lived Chat credential, bound server-side to the session
  and approved actor; validate it on Chat HTTP and upgrade requests. Do not
  return the ERP sessionToken. Refresh through the same session authority,
  reject revoked/expired sessions and apply host CSRF/origin policy with
  non-cacheable responses. This endpoint is planned host code, not an SDK route
  or an already-inspected ERP endpoint.
- During upgrade `resolveActor`, attach a safe server-owned session handle
  (for example a private request property referencing a server session record).
  Implement `revalidateActiveSession` by looking up current authoritative
  state through that handle, checking user/role activity, revocation and expiry.
  Do not retain raw tokens, cookies or credentials in a custom request property
  to evade SDK stripping. The existing raw-token SessionService resolver is
  **not automatically this adapter**; a handle-based lookup must be designed
  and verified. SDK revalidation strips common credential headers after auth;
  lost identity or a changed tenant/user closes the socket, while valid role
  changes cause capability/subscription rechecks. Test this after header
  stripping, including session logout while a socket is already connected.
- Implement `directory.getUser` and `directory.searchUsers` from the active-user
  reference query. Map id/displayName to userId/displayName; initials may support
  a host-rendered avatar fallback. Apply the authenticated actor's tenant and
  directory/entity visibility before results, limits and pagination. Recheck
  arbitrary batch IDs as well as searches; return redacted/unavailable results
  where appropriate. A guarded `/api/references/users` endpoint alone is not
  evidence of these filters. Never expose CRM contacts or HR records as chat
  identities. Flutter directory search needs the host delegate described in the
  [capability manifest](../contracts/cross-client-capabilities.v1.json).

Authentication requirements snapshot `cf4c7a5e0f82` remains authoritative for
this assignment: host authentication API rate limiting is enabled at **10
requests / 60 seconds**. SDK Chat admission does not cover the login API.
Ordinary passwords have no minimum or character-class requirements; MFA is not
required. Do not silently strengthen or replace this policy in the integration.
The effective `qa_admin_provisioning: do_not_manage` override conflicts with
the generic supplied create/update seed boilerplate and takes precedence: no
account provisioning or seed wiring here. Credential intent remains project
specific for dev/production, staging same as dev; an existing environment Vault
profile's username and password are authoritative. `devtesting@hitcents.com` is
only the missing-profile fallback. The supplied qa-login-dev/staging/production
profiles are unresolved. Any separately authorized bound seed consumes both
injected HANDRAIL_QA_LOGIN and HANDRAIL_QA_PASSWORD without persisting or printing
them; this recipe does not fetch credentials or establish ERP policy by inference
from the Chat project's requirements.

## 3. Mount persistence, HTTP and realtime

Use `createChatServer` with `database: { pool: applicationPool, schema:
"handrail_chat" }` as the proposed borrowed-pool configuration. Confirm adapter
compatibility with the exposed PostgreSQL pool. Keep Chat objects in that
dedicated schema; do not rely on or change the ERP pool's hitcents_erp_app
search_path. Review schema-qualified access, grants and the canonical SDK
migrations before an explicit authorized migration step. Follow the
[migration contract](server-embedding.md#postgresql-and-migrations), including
status/doctor, reviewed apply, compatibility and restore gates. Startup does
not migrate, but starts workers, so migrations must finish before construction
and traffic. No migration commands are run for this planning change.

In app.ts register the host token endpoint and mount
`app.use("/api/chat", chat.router)` with the required authentication boundary
and compatible request-body handling. Express removes the mount prefix;
custom dispatch must do so exactly once. In index.ts, after obtaining the
actual HTTP server from startProductionHttpServer, call
`chat.attachWebSocket(httpServer)` with
`webSocket.path: "/api/chat/_realtime"`. Upgrades retain the full URL and bypass
Express middleware: resolve their session independently through the same trusted
auth adapter. Use the SDK client's credential transport, never URL tokens.

Enforce a host-controlled browser origin allowlist on HTTP/token exchange and
the upgrade boundary before acceptance; ordinary Express CORS middleware does
not protect upgrades. Reject disallowed origins. Define the native client's
missing-Origin policy explicitly and still require authentication; missing
Origin must not grant browser/session trust. Compose this check in host admission
or auth used by the SDK; no automatic SDK origin allowlist is asserted here.

For a one-process pilot, explicitly choose `realtimeDelivery: "single_process"`;
process-local delivery supports only that instance. For multiple processes,
provide a host pub/sub `ChatRealtimeAdapter` with both `publish` and `subscribe`,
enable `features.realtime`, and select `realtimeDelivery: "clustered"`. Test
events across two instances and reconnect/replay after one stops. Existing
HTTP startup, a PostgreSQL pool and task activity writes do not demonstrate
fanout. Choose from declared host resources; no Redis/provider is inferred or
provisioned. Clustered readiness stays blocked until the adapter is verified.

Extend the existing idempotent shutdown coordinator: stop accepting new work,
close Chat sockets and await `chat.close()` to drain its workers, close the host
HTTP listener, and only then end the borrowed pool once all ERP borrowers have
finished. Chat never ends a borrowed pool or closes the host HTTP server. See
the [compiled embedding example](server-embedding.md#complete-embedding-example)
for exact SDK API usage; avoid awaiting HTTP closure while leaving WebSockets
open and waiting indefinitely.

## 4. Keep attachment and notification work explicit

The file_items catalog is useful ERP metadata, not evidence of a binary storage
backend. For a file-enabled pilot all four `ChatStorageAdapter` members need
host implementation and acceptance:

| SDK member | Required host behavior | Planner source status |
| --- | --- | --- |
| `createUploadUrl` | Prepare an expiring upload scoped to the authorized tenant, attachment and object key; bound size/type. Never accept arbitrary browser-selected object ownership. | Missing binary upload integration. |
| `verifyObject` | After upload, independently verify the expected object's existence, ownership, byte count and media metadata before finalization; do not trust client completion claims. | No object verification established. |
| `createDownloadUrl` | After current conversation/parent authorization, return a narrowly scoped expiring URL for the stored key. Recheck access on subsequent requests. | content/url catalog fields do not establish authorized binary downloads. |
| `deleteObject` | Delete only the owned stored object; repeated cleanup of `(tenantId, attachmentId, objectKey)` and an already absent object must succeed idempotently. | No binary delete/cleanup adapter established. |

Host picker, native permissions, allowed file types, malware policy and provider
selection remain host work. Keep `features.attachments` disabled and the file
experience unavailable until this integration passes upload/finalize/download,
revocation and retry/cleanup checks. A text-only pilot may defer files explicitly;
it must not claim attachment readiness from SDK lifecycle tests.

Task-assignment activity events are not Chat delivery. For notifications,
implement `ChatNotificationAdapter.send` with durable deduplication by
`deliveryId`, retry classification and only currently authorized recipients.
Preserve SDK membership/parent-access, mute and mention filtering; recheck host
recipient eligibility and device ownership at delivery. The adapter receives
bounded identifiers/metadata, not message bodies or credentials. Host work
includes provider delivery, device registration/rotation/logout cleanup,
OS permission prompts and denied-permission behavior, foreground/background
presentation and authorized notification deep links. Flutter supplies token
delegation/registration APIs; browser push registration remains a product
decision in the manifest. Leave `features.notifications` disabled until the
adapter exists. Unread/mentions in the app remain essential; external/native
push is conditional on the agreed pilot scope, not implied by activity events.

## 5. Place web and mobile clients, then qualify the exact integration

Add a guarded Chat module to ProductOutlet in App.tsx within the authenticated
application shell. Mount one `ChatProvider` and `ChatWorkspace` for each active
client/session, importing public client/react/ui exports and scoped styles.
Create the client with `/api/chat` and the session token exchange; only display
the module after server-authorized Chat access. Organization workspace scope
is a UI selection, not a tenant grant. Host routing resolves conversation,
message and thread deep links only after authorized hydration and preserves
the selected destination/source context. A direct URL must pass the same guard.

On logout or identity/tenant switch, unmount/dispose the old client, stop refresh
and subscriptions, clear that actor's host persistence (drafts, cursors and
cached state), revoke the session-bound credential and create a fresh client
only after the next identity is established. Check that cross-user state cannot
leak on reload. ChatProvider owns its mounted client lifecycle; host account
switch and storage cleanup remain explicit responsibilities.

The mobile mapping now uses the supplied inspected seams; the Chat integration
itself remains future host work:

1. Reuse the `SessionClient` owned by the authenticated app shell. Request the
   planned `/api/chat/session` exchange through
   `createAuthenticatedApiHttpClient` / `authenticatedSessionHeaders` on native
   HTTP, and `BrowserClient.withCredentials` on web. Carry the ERP cookie only
   to its trusted ERP session authority. Return a short-lived, session-bound
   Chat token and refresh through that authority; never expose ERP cookies as
   Chat credentials, persist them in Chat state, or put any token in a URL.
   Handle rejected/expired exchange by returning to the auth gate, without a
   retry loop that revives a logged-out session.
2. Derive the planned exchange/API/realtime endpoints from the trusted
   `app_runtime_config.dart` API base already used by `NativeAuthClient` in
   `app.dart`; never accept endpoint or tenant overrides from navigation input.
   HTTP authentication does not establish Chat WebSocket transport. A future
   host transport must implement the SDK credential handshake, reconnect and
   replay with the matching server upgrade boundary. Secure native HTTP cookie
   storage and browser `withCredentials` alone do not provide that transport.
3. Add the future Chat entry to `module_access_policy.dart` and route it through
   `_PortalRouterDelegate` / `_featureOutlet` only after authenticated,
   server-authorized Chat access. Place one identity-scoped `ChatScope` above
   `HandrailChatWorkspace` inside that guard. Resolve conversation/message/thread
   and notification deep links after authorized hydration; apply the same guard
   on cold start, direct links and Back navigation. Preserve intended reply
   destination/source; UI module visibility never substitutes for server access.
4. Bind foreground resume and network reconnect to session revalidation/token
   refresh, then authorized Chat snapshot/cursor replay. Supply connectivity,
   stable device identity and realtime session delegates together as required by
   `ChatScope`. Use an identity scope containing the trusted tenant/user/login
   boundary, never a credential. On `SessionExpirationSource` notification,
   logout or identity change, cancel pending exchange/refresh and stale async
   work, unmount the old scope, stop sockets/subscriptions, and clear the old
   identity's drafts, cursors and cached state before mounting the next client.
   `signOut` clearing in `finally` must also trigger Chat cleanup if remote
   logout fails. `ChatScope` disposes clients it creates; the host must dispose
   externally supplied clients and its own transports/stores.
5. Explicitly design identity-isolated draft/cursor storage and verify cold
   start, resume and account-switch behavior. Navigation/theme preferences do
   not prove Chat persistence. Directory search, file picker/permissions, push
   delivery/device cleanup and HTTP/WebSocket transport delegates remain future
   host work; do not claim them from the existence of SDK APIs. Reuse the
   [Flutter pilot guidance](pilot-integration.md#flutter-pilot); SDK example
   platform settings do not prove equivalent settings in Hitcents mobile.

Enable `inlineReplies` and `reply_style_preference_v1` only after their effective
HTTP/snapshot/WebSocket readiness passes the
[reply/thread prerequisites](reply-thread-capabilities.md). Test Current and
Discord styles, failed-save recovery, reload/reconnect, two-client propagation,
same-conversation references, mention opt-out and independent unread streams.
Create/Open Thread remains distinct and one-per-root; no flag or saved setting
grants permission or reroutes a queued send. Naming/lifecycle/discovery are
optional for basic text adoption, mandatory to verify if advertised; inactivity
also needs explicit host policy.

The existing lead delivers this separate documentation revision through the
current planner action `326c9a8e-a7c9-4871-a314-817741f5d86e`, preserving the
existing task, strategy and reviewer. Independent management accepts the exact
documentation revision; a successful worker result is not acceptance. Existing QA
`57d62709-f258-4f62-ab23-56b4e1101769`, action
`5630b283-1705-4b1e-9fa1-1bd5f584bf22` remains historical review context, with
final SDK patch/file hashes, the supplied planner ERP working-file hashes, and the
[compatibility repair evidence](validation/owner-task-24350c4f/flutter-compatibility/README.md).
Do not create a duplicate reviewer/controller. Planning review can close the
saved mapping/provenance/ownership corrections without implementing the ERP.
Future adoption acceptance separately requires the agreed
tenant policy, safe session handle, directory/entity filters, lifecycle/origin
wiring and applicable storage/push/fanout adapters; independently exercise those
on an authorized isolated PostgreSQL16 lab and browser/mobile route, including
access revocation and logout. Preserve registered UI evidence, minimum/current
compatibility results and the existing runtime blockers until reviewed evidence
closes them. Management review `9fc5fc15-2b7a-4475-bade-e63a87f1e27b` remains
`verification_pending` per the supplied task feedback. Preserve the original
inconclusive history and `fresh_capture=false` for all eight registered fixture
images; their reported Team delivery/inspection closes artifact access only.
Keep the low-severity **4px Send-padding clipping**, the independent **PG16/nonroot**
harness blocker, live save/read/reconnect and cross-client limitations, native
keyboard/touch/screen-reader gaps, and consumer/adoption limitations explicit.
Visible button paint does not prove live interaction. This run performs no new
import, compatibility rerun, capture or runtime check. It creates no
callback/queue/database record and performs no ERP adoption; the existing lead
delivers evidence and independent management decides acceptance. The existing
Main monitor retains routine reporting at September 11 13:00Z.
