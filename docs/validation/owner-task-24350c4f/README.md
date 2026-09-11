# Chat SDK qualification — 2026-09-11

Owner task `24350c4f-985e-4762-ac15-445f69009f18`; worker request
`973fc624-c6aa-4cb0-acf2-8e3da58bdef6`; run
`7d122530-c788-48fb-bfaa-02378eeecb48`. This is implementation verification,
**not independent acceptance**. Recommendation: **not ready for Hitcents adoption**
until the final-patch QA, current-consumer runtime and ERP integration gates below close.

**2026-09-11 planning supplement:** work request
`0bb40a03-7913-4993-be3d-d60ef7fcb3cd` adds the
[concrete Hitcents recipe](../../hitcents-integration.md) and updates the matrix
using **planner source inspection**, not independent runtime verification.
The existing sole accountable lead and independent QA remain in place. The
earlier worker access failure below is preserved as history; supplied source
findings now support web seam planning without retrying denied ERP paths.
Mobile seam details and planner working-file hashes remain missing.

Source/test/patch artifacts are unchanged by this documentation supplement.
The original report is retained byte-for-byte as
[README.before.md](hitcents-planning/README.before.md); historical hash manifests
still describe that original report, not this updated index. See
[planning verification](hitcents-planning/verification.json) for this change's
checks and identities. The later [Flutter compatibility repair](flutter-compatibility/README.md)
supplements the original minimum-version/consumer limitations below; neither
generation alone establishes independent acceptance.

## Source and authority

The full saved brief and all four frozen owner memories were fetched using
`handrail_read_work_request_context`; no unavailable attachment was reported.
Current MCP scope confirms the Chat SDK project owns the three checkouts and
Hitcents is contextual/read-only. The current KB entries for database testing and
native mobile settings were read. Authentication override `do_not_manage` takes
precedence over the generic seed boilerplate: no administrator was provisioned.
No applicable `AGENTS.md` existed in repository or ancestor paths.

All three worktrees were clean at entry, on `main`, with HEAD equal to their
local `origin/main` tracking refs. No merge/rebase or pending edit was replaced.
The worker-start synchronization was deferred because the workspace was in use;
inspection showed no Git repair was needed. No reset, stash, fetch/rebase, commit,
push, PR, Handrail database/queue write, deployment, installation in Hitcents,
registry publication, or external provider message was performed.

| Repository | Entry/final committed HEAD | Version |
| --- | --- | --- |
| JS | `9f62a562c5235759efa4c0a05858acae755c0aff` | 1.0.25 |
| Flutter | `8926839d7467860a738c5526aacb7330a5510483` | 0.1.21 |
| Preview | `52fe6563bfeb9d1289fa39bcba40cd887ee7914e` | 0.1.12+1 |

The committed heads remain unchanged. Final modifications are uncommitted; see
`patch-identities.json` and `patches/` for reproducible changes relative to these
heads, and `evidence-sha256.json` for retained artifact hashes. Local tracking refs
are not a new remote publication receipt.

The JS examples' manifests and npm lockfiles pin SDK 1.0.20 at
`90bff33529df06720ff89ccd821360ac65eaf0d0`. Flutter examples pin SDK 0.1.20 at
`51bc3e1411858ce38980f5beded683dee957d1a3`, as does JS paired CI. Preview pins the
lab subdirectory at `8926839d7467860a738c5526aacb7330a5510483`, whose transitive
SDK remains `51bc3e1411858ce38980f5beded683dee957d1a3`. Both locks agree. Thus a
preview rebuild with existing pins cannot prove these workspace fixes.

## Changes and attribution

- React and Flutter: Current/default Reply inside an existing thread now focuses
  that thread's existing composer, retaining its draft/reference and destination.
  It no longer attempts nested thread creation. This includes the thread panel,
  a directly selected thread workspace, and safe unavailable behavior for a
  standalone timeline without a composer. Discord source selection and explicit
  parent Create/Open Thread remain separate. Compatible optional callbacks were
  added; no wire format, SQL migration or preference policy changed.
- Server membership: first-time public joins now succeed after normal authorization;
  thread mutations and replay recheck current parent access under locks. Retained
  child ownership cannot bypass revoked or archived parent access. Invalid target
  parent access returns sanitized 403 after full rollback, rather than SQL/503.
- Regressions exercise default/current, missing inline support, draft and unread
  preservation, actual send destination, unavailable composers and restrictions.
- Added mounted React + actual PostgreSQL/HTTP/WebSocket preference flow: save,
  second-client propagation, reload, reconnect, real storage failure and retry,
  immutable source/mention opt-out, and distinct canonical named thread creation.
- Regenerated client version from package.json (the starting generated file said
  1.0.24 while the package was 1.0.25); corrected stale README/split claims.
- Repaired stale verification fixtures and the scoped React runner's relocated
  lifecycle import. Added a reusable serial PostgreSQL16 runner with current
  build, private cluster, unique schemas, leak detection and owned teardown.
- Flutter widget render capture is opt-in and uses already installed local fonts.

The root worker owns integration, verification, documentation, fixture repairs
and the final package. Scoped helpers contributed React and Flutter UI fixes and
the real-PostgreSQL React test and membership fixes. Their self-reviews are implementation assistance,
not separate independent QA. No competing controller was created.

## Verification and evidence limits

Final serial run: **24 PostgreSQL suites, 395 TAP tests passed**, no skips and
no schemas left behind. React routing/settings: **125 passed**; client preference
tests: **45 passed**. Flutter routing/settings/thread/reducer suites: **288 passed**.
Exports/embedding: **28 passed**; capability manifest: **7 passed**; **112** shared
Flutter contract files verified. Build and scoped typed checks pass. Dart analysis
exits 0 with seven existing test API deprecation notices. Counts include TAP
parent/subtests; related runners can overlap.

See [test results](test-results.json), [final PostgreSQL run](postgres-final-all-run.log),
[patch identities](patch-identities.json) and [reproduction commands](reproduce.md). PostgreSQL is **16.15 (Debian 16.15-1.pgdg12+2)**, extracted privately from
official PostgreSQL Debian packages without a system install. Tests use canonical
migrations and `createPostgresTestBackend`/`createChatTestHarness`; fakes remain
at host/provider edges. The cluster has no TCP listener, a private 0700 Unix
socket, 32 MB shared buffers and 40 maximum connections. Tests run one Node
worker or at most two Flutter workers. No application `DATABASE_URL` is used.
HTTP/WebSocket listeners inside the existing disposable test harness are test
fixtures, not a browser route or production service.

The runner checks for leftover schemas before stopping and deleting only its
owned cluster. An initial membership fixture failure leaked its schema; the
runner detected it, failed qualification, then removed the owned cluster. Initial
failure logs are retained in `initial/`; final results are separate. Historical
PostgreSQL15 evidence at starting revision `39c194f...` was not relabeled as PG16.

Node 22.23.1, TypeScript 7.0.2, React 19.2.8; Flutter 3.41.7, Dart 3.11.5.
Declared floors (Node >=22, React >=18.2 <20, Dart >=3.3 <4, Flutter >=3.19) were
inventoried, but minimum-version and React18 testing was not performed.
ESM root/client/react/ui/server/testing exports and the CSS subpath are the
supported package boundaries; server/testing are not browser dependencies.
Normal Git install uses `prepare` to compile; locks and dependency pins were
preserved. A new clean install from an uncommitted final patch is impossible.

Flutter's ordinary launcher failed writing the read-only shared engine stamp.
The installed Dart executable plus `flutter_tools.snapshot` ran widget tests;
`FLUTTER_ALREADY_LOCKED=true` avoided the unwritable shared lock. One snapshot
analyze attempt reached analysis but reported cache-stamp warnings and a test
helper lint; subsequent scoped Dart analysis is recorded separately (exit 0; existing Radio
`onChanged` deprecation notices in tests).

The first React negative-control assertion compared whole DOM objects and stalled
while reporting failure. It was interrupted (exit130); observed heavy-cgroup
memory was 56,779,284,480 bytes and returned to 26,472,448 bytes afterward.
No OOM is inferred. Replacing the assertion with a boolean identity check gave
six expected baseline failures in under a second with a 112 MiB recorded peak.
The final regression checks the visible rich editor, not its hidden textarea.

React UI evidence is functional mounted DOM, including a real PostgreSQL test;
it is not browser screenshot acceptance. Flutter PNGs are inspectable renders
captured within successful widget tests using transport fixtures, not a running
Flutter↔PostgreSQL integration. See Flutter's sibling
`docs/validation/owner-task-24350c4f/media/`. The thread fixture intentionally
shows unavailable source context; it does not prove a successful source fetch.
No browser was launched and no raw preview listener was visited.

## Prioritized pilot matrix

This inventory combines inspected SDK source, the
[cross-client manifest](../../../contracts/cross-client-capabilities.v1.json),
retained SDK tests and supplied **planner source inspection** of Hitcents web.
ERP findings are not independent runtime verification. “SDK supported” does not
mean ERP-integrated; “must” is a pilot requirement, not a passed acceptance gate.
See the [recipe provenance](../../hitcents-integration.md#evidence-provenance-and-limits)
for both ERP HEADs and the missing working-file hashes.

| Priority / capability | Retained SDK evidence / contract | Hitcents planner source inspection and remaining acceptance work |
| --- | --- | --- |
| Must: trusted identity, tenant isolation, access revocation | Actor-bound HTTP/WS and parent authorization tests; active-session adapter contract. | auth/http.ts and auth/session.ts authenticate active sessions/users/roles with revocation/expiry and token digests. Principal has no tenant; users.teamId is a team FK, not tenant identity. Host must define tenant policy, map actors/capabilities/entities and implement a safe session handle for revalidation after credential stripping. The raw-token resolver is not that adapter. |
| Must: authorized directory | Directory lookup/search adapters; Flutter search is host-composed through its directory delegate. | service.ts:258 listActiveUserReferences and guarded `/api/references/users` provide id/displayName/initials for active users. Add actor-authoritative visibility filters to both lookup and search; never promote CRM/HR records into Chat identities. |
| Must: channels, DMs, group DMs, membership | Client creation/actions and React/Flutter workspace/member picker surfaces; real harness/authorization coverage. | Map principal permissions through getCapabilities/authorizeEntity, including directory and ERP entity policies. Chat membership cannot grant ERP record access; integration remains unverified. |
| Must: persistence and lifecycle ownership | Canonical PostgreSQL migrations; compiled embedding guide covers owned/borrowed pools and shutdown. | database/client.ts exposes pool + Drizzle with hitcents_erp_app search_path. Use explicit dedicated Chat schema and reviewed migrations; no ERP predev. Integrate shutdown in index.ts; Chat drains before the host ends the shared pool. |
| Must: send/edit/delete/retry/idempotency | Canonical SQL, reconciliation and reconnect tests; Current thread bug fixed. Draft/reference/destination remain immutable for queued operations. | Verify the exact pinned host clients against the final accepted SDK artifact; planner inspection is not a send/retry result. |
| Must: reconnect, replay, multi-client state | Real WebSocket replay/reconnect and same-user preference propagation. | index.ts creates the server, app.ts mounts Express: plan `/api/chat` plus `/api/chat/_realtime`, independent upgrade auth, origin checks and cleanup. Single-process support only until host publish/subscribe fanout is implemented and verified across processes; entry points do not establish clustered readiness. |
| Must: reply/thread setting and source context | Both UIs tested, real React settings/storage flow, independent flags, safe unavailable paths, failed-save recovery. | ProductOutlet has no evidenced Chat integration. Guard ChatProvider/ChatWorkspace; exchange the session for a short-lived Chat token. Verify effective metadata, reload/reconnect, distinct Reply/Create Thread, same destination and canonical root in the actual integration; Flutter↔PG16 remains unverified. |
| Must: unread and mentions | Independent parent/thread cursor and reply mention tests; explicit mention remains independent of reply-ping opt-out. | Preserve stream-specific reads and preferences in the mounted host UI. Task-assignment activity events do not establish Chat delivery or native notifications. |
| Conditional: external/native notifications (must if promised) | Durable dispatcher is supported; platform presentation is host-composed. Flutter token registration is supported; browser registration is a product-decision gap. | task-notifications.ts writes task activity only. Implement notifications.send, deliveryId deduplication, authorized recipients/devices, retry handling, native permissions, token/logout cleanup and deep links. Keep disabled until verified; do not claim push from activity events. |
| Must for files: attachments; deferrable only for explicit text-only scope | Real SQL lifecycle/download/authorization tests; four storage adapter members required. | schema.ts:923 file_items and listFileItems/createFileItem store folders/text/links and content/url metadata. Missing binary integration: createUploadUrl, verifyObject, createDownloadUrl, deleteObject. Keep attachments disabled until ownership, metadata, authorized access and idempotent cleanup pass; host selects picker/malware policy. |
| Must: authorized search/navigation and logout | PostgreSQL search/source-context authorization; React host router composition and Flutter public deep-link resolver. | App.tsx ProductOutlet is the web placement seam. Guard direct routes, hydrate authorized targets, preserve destination; dispose old clients and clear actor-scoped drafts/cursors/cache on logout or identity switch. Mobile auth/router/persistence seams have not been supplied. |
| Must: keyboard/mobile/accessibility | React focus/keyboard and Flutter semantics/long-press evidence; compatibility repair adds minimum/current compilation and smaller-viewport regression coverage. | Real browser keyboard, mobile touch, screen reader and OS keyboard acceptance pending. A mobile repo HEAD alone does not verify its auth, transports, lifecycle, picker or permissions. |
| Must: install/build and compatibility | Existing pins/locks and public exports inventoried; later Flutter compatibility repair retains minimum 3.19/Dart 3.3 and current-SDK evidence. | Adopt only full public HTTPS Git SHA pins with matching locks and normal build pipeline; no install here. Exact final independently reviewed artifacts, clean consumer evidence and planner working-file hashes still need lead reconciliation. |
| Conditional: named threads, lifecycle, discovery | Creation race/canonical root, named reads, lifecycle/discovery tests. | Optional for basic text pilot; verify effective readiness if advertised. Inactivity requires explicit host policy. A saved preference alone cannot enable any of these. |
| Optional: saved items, archive UI, follow controls | Flutter saved-message client operations/widgets, archive widget and follow widget have product-decision gaps in manifest. | Host/product choice; headless support is not widget parity and not an adoption essential. |
| Optional: custom status/presence UI | Host owns status mutation; Flutter widget parity incomplete. Typing is supported. | Host/product choice, independent of the active-user directory starting point. |
| Optional: huddles/video/screen share, reminders, federation, eDiscovery | Some public surfaces are supported; full parity and provider/scale/SLO qualification are not established. | Outside the text pilot acceptance boundary; no new media/provider infrastructure inferred. |

## Minimal integration recipe and blockers

The original recipe below records the earlier worker's access boundary and
generic adapter plan. Its requirement to first obtain ERP source is now
supplemented by [planner-inspected web seams and the concrete recipe](../../hitcents-integration.md).
Do not retry the unchanged denied path. Remaining source evidence is the
planner's exact working-file hashes and mobile seam details; runtime readiness
and host policy/adapter work remain separate gates.

1. Historical source-access blocker: the worker requested **read-only source access** for contextual Hitcents in the
   worker source reader. Actual attempted read:
   `read_source_code(source=project, repo_name=hitcents-erp, path=package.json)`
   failed: repo not found; available repos were only the three Chat checkouts.
   The exposed source reader has no project_id selector. Linked-project metadata
   confirms web and mobile repo names and Git-pinned financial dependencies but
   does not reveal auth/tenant/directory/storage/router implementations. Those
   mappings below are required adapter seams, not invented ERP facts.
2. Against the final independently accepted committed SDK revisions, select full
   public HTTPS Git SHA pins and matching npm/pub lockfiles in a separately
   authorized pilot. Do not install into Hitcents during this request.
3. Map the existing ERP session to trusted actors; directory lookups/search to
   tenant-filtered ERP users; capabilities/entity access to ERP authorization.
   Preserve the effective login rate policy (10 requests/60 seconds) in host
   auth infrastructure; no SDK seed or second user store is needed.
4. Select host-owned PostgreSQL schema/pool and storage adapter. Review and apply
   explicit migrations before mounting `/api/chat`; startup never migrates.
   Verify uploaded object ownership/metadata before finalization. Provide trusted
   WebSocket upgrades at `/api/chat/_realtime`, active-session revalidation and
   clustered fanout if multiple processes are used.
5. Mount React ChatProvider/ChatWorkspace in the existing UI; Flutter ChatScope
   and workspace in the existing mobile shell. Host owns authenticated token
   refresh, local storage identity isolation/logout clearing, deep links,
   platform file/notification permissions and push delivery. Native ERP example
   has Android release INTERNET and iOS exempt-encryption flag; preview is web
   only, and no biometric setup is inferred.
6. Enable reply flags only after migrations/privileges pass effective HTTP,
   snapshot and WebSocket readiness. Preference opt-in alone must not enable
   inline sends. Validate old and new clients before cutover.

**Historical independent work / callback:** the earlier report designated the existing parent
planner action `c023ec27-2941-4bc2-8acc-d6484bfae9ee` on owner task
`24350c4f-985e-4762-ac15-445f69009f18`; existing Main monitor
`2f329f54-479e-46ab-8ab2-b1c1023d7bdb` retains the September11 13:00Z brief.
No queue/controller/callback record was created because this worker is forbidden
to modify Handrail state. For this continuation, return the supplement through
existing planner action `38009aa1-7df9-451b-b9bd-a12e3a33015d`; preserve the sole
accountable lead and reuse independent QA `57d62709-f258-4f62-ab23-56b4e1101769`,
action `5630b283-1705-4b1e-9fa1-1bd5f584bf22`. The lead reconciles final patch
identities and review results, then handles any explicitly authorized
commit/pin/publication. Do not dispatch a duplicate reviewer.

**Historical runtime blocker (not re-probed by this documentation run):**
`handrail_dev_service_status` returned both chat-lab and
Mobile Preview stopped, with no scoped QA browser route. Mobile config exposed
only a loopback fallback, which this task prohibits visiting. Dev Vault profile
listing returned zero profiles; provisioning is `do_not_manage`. Required next
step is an authorized isolated lab/QA route and applicable authenticated handoff,
with consumers pinned to the final committed SDK. Do not substitute the raw
listener or change runtime configuration from this worker. Independent QA must
save registered browser/mobile media and test Flutter↔PG16, cross-client sends,
reload/reconnect and failure recovery there. Then reconcile the supplied ERP
mapping, outstanding host adapters/mobile details and later compatibility
evidence, and finish native accessibility acceptance before adoption.

## Inspectable widget media

These five PNGs were saved during passing widget tests; they are local fixture
media, not registered Mobile Preview/browser acceptance.

- [Current thread composer focus](../../../../handrail-sdk-chat-flutter/docs/validation/owner-task-24350c4f/media/current-thread-reply-widget.png)
- [Discord thread reference](../../../../handrail-sdk-chat-flutter/docs/validation/owner-task-24350c4f/media/discord-thread-reply-widget.png)
- [Confirmed Discord preference](../../../../handrail-sdk-chat-flutter/docs/validation/owner-task-24350c4f/media/reply-settings-confirmed-discord-widget.png)
- [Failed save retains effective style](../../../../handrail-sdk-chat-flutter/docs/validation/owner-task-24350c4f/media/reply-settings-failed-save-widget.png)
- [Recovered save](../../../../handrail-sdk-chat-flutter/docs/validation/owner-task-24350c4f/media/reply-settings-recovered-save-widget.png)
