# Chat SDK qualification — 2026-09-11

Owner task `24350c4f-985e-4762-ac15-445f69009f18`; worker request
`973fc624-c6aa-4cb0-acf2-8e3da58bdef6`; run
`7d122530-c788-48fb-bfaa-02378eeecb48`. This is implementation verification,
**not independent acceptance**. Recommendation: **not ready for Hitcents adoption**
until the final-patch QA, current-consumer runtime and ERP-source gates below close.

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

This inventory combines inspected public source, the cross-client manifest and
the focused evidence here. “SDK supported” does not mean ERP-integrated.

| Priority / capability | SDK evidence and remaining host requirement |
| --- | --- |
| Must: trusted identity, tenant isolation, access revocation | Actor-bound HTTP/WS and parent authorization tests; host must derive tenant/user/roles from authoritative session, never client fields. ERP session/directory implementation still unreadable. |
| Must: channels, DMs, group DMs, membership | Client creation/actions and React/Flutter workspace/member picker surfaces; real harness/authorization coverage. Host entity capability mapping remains integration work. |
| Must: send/edit/delete/retry/idempotency | Canonical SQL, reconciliation and reconnect tests; Current thread bug fixed. Draft/reference/destination remain immutable for queued operations. |
| Must: reconnect, replay, multi-client state | Real WebSocket replay/reconnect and same-user preference propagation; shared production fanout still host-owned. Single-process mode must not be horizontally scaled without clustered adapter. |
| Must: reply/thread setting and source context | Both UI implementations tested, real React settings/storage flow, independent flags, safe disabled/unavailable paths, failed-save recovery. Full current Flutter↔PG16 runtime remains unverified. |
| Must: unread, mentions, notifications | Independent parent/thread cursor and reply mention tests; explicit mention remains independent of reply-ping opt-out. Provider notifications/permissions/device setup belong to host. |
| Must for files: attachments | Real SQL lifecycle/download/authorization tests; host must provide prepare/verifyObject/download/delete and tenant-scoped object access. Malware policy and native file picker remain host decisions. |
| Must: authorized search/navigation | PostgreSQL search + source-context authorization; UI/controller support. Host router/deep links must preserve tenant and destination; Flutter has public deep-link resolver. |
| Must: keyboard/mobile/accessibility | React focus/keyboard and Flutter widget semantics/long-press cases; readable fixture PNGs. Real browser keyboard, mobile touch, screen reader, viewport/OS keyboard acceptance pending. |
| Conditional: named threads, lifecycle, discovery | Creation race/canonical root, named reads, lifecycle and discovery tests. Advertise only effective readiness; inactivity needs explicit host policy. Optional for basic text pilot. |
| Optional: saved items, archive UI, follow controls | Flutter saved-message commands/widgets, archive widget and follow widget still have product-decision gaps in manifest. Headless support alone is not widget parity. |
| Optional: custom status/presence UI | Host owns status mutation; Flutter widget parity incomplete. Typing is supported. |
| Optional: huddles/video/screen share, reminders, federation, eDiscovery | Not acceptance requirements for this text pilot; full parity and provider/scale/SLO qualification are not established here. |

## Minimal integration recipe and blockers

1. Main first enables **read-only source access** for contextual Hitcents in the
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

**Independent work / callback:** return this evidence to the existing parent
planner action `c023ec27-2941-4bc2-8acc-d6484bfae9ee` on owner task
`24350c4f-985e-4762-ac15-445f69009f18`; existing Main monitor
`2f329f54-479e-46ab-8ab2-b1c1023d7bdb` retains the September11 13:00Z brief.
No queue/controller/callback record was created because this worker is forbidden
to modify Handrail state. Main should dispatch independent QA against the exact
patch identities, then handle any explicitly authorized commit/pin/publication.

**Runtime blocker:** `handrail_dev_service_status` returned both chat-lab and
Mobile Preview stopped, with no scoped QA browser route. Mobile config exposed
only a loopback fallback, which this task prohibits visiting. Dev Vault profile
listing returned zero profiles; provisioning is `do_not_manage`. Required next
step is an authorized isolated lab/QA route and applicable authenticated handoff,
with consumers pinned to the final committed SDK. Do not substitute the raw
listener or change runtime configuration from this worker. Independent QA must
save registered browser/mobile media and test Flutter↔PG16, cross-client sends,
reload/reconnect and failure recovery there. Then finish read-only ERP seam
mapping and the minimum-version/native accessibility checks before adoption.

## Inspectable widget media

These five PNGs were saved during passing widget tests; they are local fixture
media, not registered Mobile Preview/browser acceptance.

- [Current thread composer focus](../../../../handrail-sdk-chat-flutter/docs/validation/owner-task-24350c4f/media/current-thread-reply-widget.png)
- [Discord thread reference](../../../../handrail-sdk-chat-flutter/docs/validation/owner-task-24350c4f/media/discord-thread-reply-widget.png)
- [Confirmed Discord preference](../../../../handrail-sdk-chat-flutter/docs/validation/owner-task-24350c4f/media/reply-settings-confirmed-discord-widget.png)
- [Failed save retains effective style](../../../../handrail-sdk-chat-flutter/docs/validation/owner-task-24350c4f/media/reply-settings-failed-save-widget.png)
- [Recovered save](../../../../handrail-sdk-chat-flutter/docs/validation/owner-task-24350c4f/media/reply-settings-recovered-save-widget.png)
