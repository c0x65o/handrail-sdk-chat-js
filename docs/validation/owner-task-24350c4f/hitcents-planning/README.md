# Hitcents planning correction — September 11, 2026

Documentation revision `revision-2026-09-11` completes the requested saved
mapping, provenance and ownership corrections for independent management review.
**Not ready for Hitcents adoption.** Planning completion does not require ERP
adapter implementation; future implementation, runtime qualification and adoption
remain separate work. The existing sole accountable lead delivers; independent
management accepts. This worker does not accept its own output or create a new
lead, reviewer, callback or queue record.

Owner task: `24350c4f-985e-4762-ac15-445f69009f18`. Strategy:
`04195e83-6774-46f8-af9e-216d41186860`. Original documentation WR:
`0bb40a03-7913-4993-be3d-d60ef7fcb3cd`; continuation WR:
`fbbb5fd9-1672-413b-84d0-42ae5d06a564`; worker:
`1fa598f9-7da1-40f7-9f20-548365df30e6`. Return this revision through existing
planner action `326c9a8e-a7c9-4871-a314-817741f5d86e` on the same task.

## Reviewable result and provenance

- [Updated integration recipe](../../../hitcents-integration.md).
- [Exact prior recipe bytes](revision-2026-09-11/hitcents-integration.before.md)
  and [exact revised recipe bytes](revision-2026-09-11/hitcents-integration.md).
  These are archival snapshots: interpret their relative links at the original
  `docs/hitcents-integration.md` location.
- [ERP working-file identities](revision-2026-09-11/erp-source-provenance.json):
  all 17 supplied SHA256 values, expanded paths, full documented web/mobile
  checkout roots and reported HEADs. Inspection belongs to September 11 planner
  turn `0b7dc5b6-cc39-4f59-956f-15c446de1e9f`. The worker did not inspect/re-hash
  ERP files or retry previously denied paths. No clean ERP worktree or equality
  to committed blobs is claimed.
- [Documentation verification](revision-2026-09-11/verification.json) records
  checks and exact file hashes. [SHA256SUMS](revision-2026-09-11/SHA256SUMS)
  binds the supplement, snapshots, source record and verification report, using
  paths relative to the JS repository root. Its own SHA256 is the separate
  documentation revision identity returned with delivery; it is not a Git SHA
  or a replacement runtime artifact.

`handrail_current_context` confirmed the continuation WR and the Chat SDK
project, with Hitcents contextual/read-only. All four frozen memories were
fetched and applied within this documentation scope. The visible task brief and
team criteria/feedback are the acceptance context; the top-level success
criteria field contains literal `null`, and the work-request description ends
with truncated `Retain inconclusive history, fresh…`. The full supplied team
feedback explicitly requires the retained limits below; no missing wording or
acceptance decision is invented.

Worker-start synchronization was deferred as `main_workspace_in_use`. Local
inspection found the documented Chat HEADs, prior uncommitted JS/Flutter edits,
and no unresolved index entries, merge/rebase or index lock. No Git repair was
necessary for this additive documentation change. Upstream synchronization was
not performed or claimed resolved; pending edits are preserved. This is an
uncommitted documentation revision, with no PR, push or publication.

## Response to each correction

| Correction | Saved response / acceptance boundary |
| --- | --- |
| Mobile auth mapping was unsaved | Recipe records `SessionClient`, `SessionExpirationSource`, secure cookie storage, authenticated headers/client, browser credentials, unauthorized-state notification and `signOut` cleanup in `finally`. Exchange uses those HTTP seams and returns only a short-lived Chat credential. |
| HTTP cookies were insufficient transport evidence | Recipe separates ERP session authentication from future Chat WebSocket handshake/transport, refresh, reconnect/replay and server upgrade authorization; no ERP cookie as a Chat credential and no token in a URL. |
| Mobile router, lifecycle and persistence were unspecified | Recipe names `NativeAuthClient(config.apiBaseUrl)`, `_PortalRouterDelegate`, `_featureOutlet` and the absent Chat module in `module_access_policy.dart`; plans guarded scope/workspace placement, authorized deep links, resume/reconnect, client ownership/disposal and identity-isolated drafts/cursors. Navigation/theme preferences are not Chat persistence proof. |
| Endpoint/delegate assumptions needed limits | Derive endpoints from trusted `app_runtime_config.dart` without changing configuration. Picker, push, directory and transport delegates stay future host work. |
| Consumer compatibility was overstated or absent | Record mobile Dart ^3.11.5 and web React 19.2.8 / Node >=22.12.0, with neither Chat dependency; source constraints are not ERP consumer-build proof. No installs or compatibility reruns. |
| Working-file identity was missing | Save all 11 web and 6 mobile supplied SHA256 values with planner turn, checkout roots and reported HEADs. Preserve the earlier missing-hash claim as history; no direct worker ERP inspection or clean-worktree claim. |
| Lead incorrectly owned acceptance | Lead owns delivery; independent management reviews/accepts this exact documentation revision. Future adapter implementation/adoption gates do not prevent planning review. No acceptance status is changed by this worker. |
| Separate revision and correction evidence required | Save before/after recipe snapshots, this correction table, source provenance, fresh documentation-only verification and a SHA256 manifest. Existing manifests and prior verification stay byte-identical. |
| Historical QA must not become new proof | Preserve runtime artifact, original inconclusive history, `fresh_capture=false`, low-severity 4px Send-padding clipping and PG16/nonroot/live/cross-client/native/adoption limitations. No evidence import or fresh capture. |

## Preserved history and remaining gates

Runtime artifact remains
`248f3f7986001f99414f5a149c477177059b1dcfc0a49be7c223a6190a5fc2eb`;
see the unchanged [runtime patch manifest](../flutter-compatibility/patch-identities.json).
The [original planning verification](verification.json) and
[original report snapshot](README.before.md) remain historical. Their hashes
describe the earlier revision, not the corrected recipe. The parent evidence
index also retains its earlier missing-mobile/provenance statements; this
separate dated supplement supplies those corrections without rewriting history.
The [retained independent evidence](../retained-independent-review/README.md)
and its original reports/manifests are untouched; its import instructions are
historical and are not actions to repeat in this run.

Per supplied management feedback, all eight registered fixture PNGs were
delivered to Team and independently inspected. This closes the artifact-access
and delivery bottleneck only. The original inconclusive receipt remains valid,
and the fixtures remain `fresh_capture=false`. Compatibility-only success does
not accept the full task. Preserve low-severity **4px Send-padding clipping**:
visible button paint does not prove complete live interaction or accessibility.

Independent review `9fc5fc15-2b7a-4475-bade-e63a87f1e27b` remains
`verification_pending` according to the supplied feedback. Existing QA WR
`57d62709-f258-4f62-ab23-56b4e1101769`, action
`5630b283-1705-4b1e-9fa1-1bd5f584bf22`, is retained review context, not a newly
dispatched or completed review of this supplement.

The next authorized step is independent management inspection of the exact
documentation manifest, correction responses, mobile mapping and supplied
provenance. The lead must return any documentation corrections on this same
task; independent management decides whether planning is accepted. No runtime
test or ERP adapter is required to judge whether these documentation corrections
were saved accurately.

For eventual runtime/adoption acceptance, Main must separately arrange a
permitted nonroot PostgreSQL16 harness and authorized isolated lab/QA route with
the applicable authenticated handoff. Independent QA then needs live save/read,
reconnect/failure recovery, Flutter↔PostgreSQL, cross-client and native
keyboard/touch/screen-reader evidence. Host tenant policy, safe session handle,
directory/entity filtering, storage/push/fanout as applicable, and consumer
Git pins/locks/builds still need implementation and review under later authority.
This documentation does not close those gates or imply deployment/adoption.

Requirements snapshot `cf4c7a5e0f82` is preserved in the recipe. The project
override `qa_admin_provisioning: do_not_manage` takes precedence over conflicting
generic create/update seed boilerplate. No credentials, provisioning, services,
configuration, imports, compatibility reruns, captures, deployments, spending,
commits or publication were used for this supplement. Existing holds remain;
Main monitor `2f329f54-479e-46ab-8ab2-b1c1023d7bdb` retains routine reporting at
September 11 13:00Z. No new callback is claimed.
