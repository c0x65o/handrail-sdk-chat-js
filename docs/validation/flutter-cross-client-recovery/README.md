# Flutter cross-client thread recovery

Work request `81aa1a3d-9db4-49af-86e6-316f31f85904`; accepted finding
`0791d064-3e24-4882-b47d-67d8b617f40c` in dev campaign
`40616bf8-6630-4252-bec1-141964ae2028`.

## Failure boundary and repair

This is SDK application recovery state. The current Handrail context confirms the
active work request and no deploy targets or provider capability configuration.
The supervised `chat-lab` service is healthy (health/readiness HTTP 200). The
separate stopped Mobile Preview is not the campaign's Flutter route. Campaign
provenance identifies the compiled workspace inputs; the new browser check
compares executing Flutter input digest with the current source digest.

The supplied screenshots show an open thread with no history, unavailable
preferences, denied lifecycle controls, and disabled composition. The retrieved
status export records repeated `ordering_gap` recovery for private preference,
read, follow and draft events, and finally a lifecycle event. During the early
recoveries only the parent timeline is hydrated. The later export shows history
and controls restored after the campaign's manual retry/reconnect. Same-window
service logs show Vite socket EPIPE at 21:16:50 UTC, before the 21:21–21:22 thread
failure, without a provider credential or HTTP authorization error explaining
this panel. No environment or provider change is indicated.

Source inspection and failing regressions isolated four gaps:

- Private events identify their stream as `user:bob`, but recovery previously
  read only retained conversations. A thread changed in another client could
  therefore remain absent from every recovered snapshot. Gap diagnostics now
  carry the resource ID; recovery reads that resource and its parent through
  the existing authorized snapshot endpoints. Conversation-stream gaps also
  carry their stream's conversation ID.
- The recovery input previously froze subscriptions at its start. A thread
  opened while HTTP reads were pending could be erased by the final atomic
  snapshot replacement. Recovery now rechecks current retains between reads.
- A lifecycle read interrupted before its first successful load was never
  retried on reconnect. Controllers now remember that a load was requested,
  independently of successful completion. Explicit authority revocation still
  clears that intent; identity, cancellation, HTTP denial and capability gates
  remain in force.

- Concurrent writes can produce different replay cursors across snapshot reads.
  Recovery now makes up to three attempts at that uncommitted batch, with cancellation
  checks on each attempt. It still refuses mixed-cursor snapshots and leaves live
  state unchanged if the retry bound is exhausted. The browser replay exposed
  this additional edge; two focused tests fail without this retry and prove both
  eventual success and bounded failure ([cursor-before.log](cursor-before.log)).
  The browser capture before this addition is preserved in
  [browser-cursor-before.log](browser-cursor-before.log).

There are no screen, navigation, database-schema, dependency or mock_html changes.
Prior uncommitted repairs in this workspace were preserved.

## Verification

- Three new deterministic regression cases failed before the repair and passed
  afterward: [before-tests.log](before-tests.log), [after-tests.log](after-tests.log).
- Focused Flutter tests cover durable resources, follow state, managed recovery,
  lifecycle/revocation, host authority binding and the thread widget:
  **126 passed**, [tests.log](tests.log). HTTP, socket and clock fakes use existing test boundaries;
  these tests prove client state transitions, not database persistence.
- Scoped Flutter analysis of all changed Dart source and tests:
  **no issues**, [analyze.log](analyze.log).
- Flutter release web compilation using the existing provenance-aware build
  script: [build.log](build.log). The read-only SDK is invoked through its cached
  Flutter tool; its stamp warnings are nonfatal.
- Live Chromium replay: **passed (11.2s)**, [browser.log](browser.log), with one worker and automatic
  retries disabled. It uses the existing managed, database-backed dev lab and
  normal React UI writes to a uniquely labelled QA thread. It does not reset or
  migrate a database. The scenario opens Flutter Bob at 390×844 before React
  creates the thread, saves mentions notifications, sends history, leaves,
  sends an inline reply, closes/reopens, joins/leaves, and retains a channel
  draft. Assertions require both messages, an enabled composer, lifecycle and
  subscription controls, and no subscription-retry menu item or snapshot failure.
  The channel test draft is cleared after successful validation; labelled QA
  messages/threads remain as evidence.
- A follow-up browser attempt opened the popup before the remote follow change
  settled and read its earlier `Leave` item. The test now waits for canonical
  not-following text before opening the popup. That attempt is preserved in
  [browser-menu-timing.log](browser-menu-timing.log). Another evidence-capture
  attempt passed the recovery assertions but could not dismiss the Flutter popup
  using Escape; [browser-dismissal.log](browser-dismissal.log) preserves it.
  The final test photographs the restored panel before opening its menu and
  photographs the enabled menu afterward, without requiring keyboard dismissal.
  Final evidence shows `connected` / `ready`, one recovered preference ordering
  gap, and no `snapshot_hydration_failed`. Executing source digest:
  `05feaab8341faaa6ce7890504885260786436570fb9afb549105da15538e9f75`.
  See [recovered panel](browser/flutter-cross-client-recov-acdab-ates-without-manual-retries-chromium/recovered-thread-390x844.png)
  and [export](browser/flutter-cross-client-recov-acdab-ates-without-manual-retries-chromium/recovery.json).
- `node --check` for the browser regression and `git diff --check`.

Run the browser check from `examples/drop-in-react` with the current built lab:

```sh
FLUTTER_CHAT_LAB_ORIGIN=http://127.0.0.1:4167 npx playwright test e2e/flutter-cross-client-recovery.spec.mjs --project=chromium --retries=0
```

Run the Dart checks from `flutter/handrail_chat`:

```sh
flutter test --no-pub --concurrency=1 test/durable_resource_event_reducer_test.dart test/thread_follow_client_test.dart test/realtime_durable_recovery_test.dart test/thread_lifecycle_controller_test.dart test/backend_lab_thread_lifecycles_test.dart test/handrail_thread_view_test.dart
```

## Preserved campaign evidence

The runner attachment paths were absent. Four redacted JSON artifacts were
retrieved through read-only `get_goal_completed_work_result`, reviewed, saved in
[campaign/](campaign/), and verified byte-for-byte against their supplied SHA-256.
Images were reviewed as supplied visual inputs. Original references remain:

| Artifact | Artifact ID | SHA-256 |
| --- | --- | --- |
| `13-flutter-thread-open.json` | `dab760e6-d117-442c-a783-637db2865806` | `affcde2f00e6ace1af67f34b0262f3b3929414b6f3a8b7b2eb0419f7707aa90b` |
| `13-flutter-thread-open.png` | `fc66cb7e-9abe-4e50-8d60-ae184aa46864` | `528bc60fa491c0895ce0ca2d58c47e8d4ca666adf8ace7ae89b4af9252a3a8b4` |
| `15-flutter-cross-client-thread-failure.png` | `1bbbf876-f792-424a-90e2-b32b8a65cbfb` | `221a9c11493e9e639c15fd767d485f22849e3a29ba864e22f6c638c0da1f2875` |
| `15-flutter-status.json` | `90e9324d-a0ec-49cc-a1a4-57d97c7ce2f7` | `4c0fdda570667b57bb03bcf30ea57a6745082395a1b157a834fc827956058ede` |
| `17-flutter-reconnected-thread.json` | `6b647d48-afb2-44c4-9e5d-a9cc5028c5cb` | `76bbf462d62c6211b5f7b29db4663dd9d032b1eeb11c603e87c1321ada429189` |
| `network.json` | `5d44f893-2603-4ed3-9f19-79b9d73b25e4` | `825d76d897f44187c34e66663ed1824508e0c48a7b23e9d46a067727ca6eb782` |
| `service-log-correlation.json` | `8a1429a2-34f4-4ca7-b568-2f4f41e24184` | `f79376ec06f8b1e14712a4f4ebaacbcbe6484fcbcce2d97d406e7cf89fc89bbd` |

The 7.5 MB network artifact (and the smaller observed-requests artifact) exceeded
the MCP content retrieval limit, so its full contents were not inspected. Its
original campaign reference is preserved above. No commit, push, PR, queue or
Handrail database changes were made.
