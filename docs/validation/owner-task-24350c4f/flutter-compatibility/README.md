# Flutter compatibility repair — 2026-09-11

Continuation of owner task `24350c4f-985e-4762-ac15-445f69009f18`, work request
`c8df7449-ae38-4d90-b806-1bc1f8237c1a`, worker run
`00bb50b4-2369-4fb4-a65f-1a65ac6eafd0`. Responds to independent QA request
`c7cbe614-489d-413b-a33a-2f9832910afc`, run
`c718b243-d356-4973-bf05-c8d3394801fa`.

**The advertised Flutter 3.19.0 / Dart 3.3.0 floor is retained. This is
implementation verification, not independent acceptance or adoption readiness.**
The final changed artifact needs subsequent independent QA.

Flutter base `8926839d7467860a738c5526aacb7330a5510483` plus repair-inclusive patch
SHA256 `b0f79227038952d5ba2ceb88b87f327108580009549778cd689edd4ba2edcdd7`.
The JS patch remains `3ead6aa48b22389ed8376caa113013780560ced04075f634c8c67e7ddc25c188`;
preview remains unchanged. Combined artifact ID:
`248f3f7986001f99414f5a149c477177059b1dcfc0a49be7c223a6190a5fc2eb`.
See [patch identities](patch-identities.json) and [evidence hashes](evidence-sha256.json).

## Scope and entry evidence

Handrail current context confirmed this worker's Chat SDK scope and read-only
Hitcents context. All four frozen owner memories and the full saved task brief,
project rules and team criteria were fetched. No extra controller, task, queue
update, database mutation, service/configuration action, identity provisioning,
deployment, external message, commit, push, PR or publication was performed.

The deferred workspace synchronization did not require Git repair: the three
recorded HEADs matched, no merge/rebase/index lock was present, and all existing
source changes matched the historical patches byte for byte. All 80 historical
evidence hashes matched. See `entry-verification.json`. Prior edits and original
evidence files are preserved; this directory is a new evidence generation.

The QA work-request reader supplied its saved validation outcome and registered
evidence references (`qa-review-summary.json`). The referenced full REVIEW.md,
reproduction report and runtime JSON were absent from this worker filesystem.
`get_goal_completed_work_result` failed because this work-request worker has no
owner_goal_id. That is a retrieval limitation, not evidence that the review
contained no additional findings. Main should attach those full records to the
next reviewer; no filesystem or scope restriction was bypassed.

## Repair and audit

Actual Flutter 3.19 analysis of the starting public `lib/` graph found **nine
compile errors** after temporarily fixing development dependency resolution:
`minimum-baseline-analysis.log`. Resolution initially failed on flutter_lints
5.0.0's Dart ^3.5 requirement (`minimum-baseline-resolution.log`).

| Finding | Repair / compatibility impact |
| --- | --- |
| Composer `Color.withValues` unavailable | Use `withAlpha(115)`, the nearest 8-bit representation of 45%. The alpha differs from exact 0.45 by less than 1/255. List/inline-code rich-text colors are asserted in the existing formatting test. This is the deliberate small color-precision tradeoff of the retained floor. |
| Workspace `onPopInvokedWithResult` unavailable | Use `onPopInvoked`; the callback did not consume a route result. Keep `canPop` and discovery Back handling intact. System Back, Escape, focus, retained drafts and canonical thread navigation are exercised. |
| Six newer Material surface-role uses across public widgets | A compatibility extension supplies 3.19 surface/surfaceVariant fallbacks. On newer Flutter, native ColorScheme members take precedence, preserving host colors. No runtime version parsing or second controller. |
| Huddle `DropdownButtonFormField.initialValue` unavailable | Use the supported `value` parameter, retaining selection semantics (current Flutter initializes from `initialValue ?? value`). The browser lab had the same API mismatch and is repaired too. Public graph and lab compile on both SDKs; broader media runtime caveat below. |
| Development dependency floors | flutter_lints ^4.0.0; test ^1.24.9 permits Flutter 3.19's pinned test_api 0.6.1. Public runtime unorm_dart ^0.3.2 resolves unchanged at Dart 3.3. Both complete resolved graphs are retained. |
| Browser lab web ^1.1.1 requires Dart ^3.4 | Permit web >=0.5.1 <2.0.0, use lints 4.x, explicitly declare Flutter >=3.19. Its real Git pin stays frozen; regenerate its lock on 3.19. Both web 0.5.1 and 1.1.1 compile with the repaired artifact. |
| Minimum-SDK composer portal failure exposed by runtime tests | Key the existing editor LayoutBuilder so reply/attachment row insertion/removal preserves its TextField and OverlayPortal state. Previously Flutter 3.19 rejected a controller attached to two portal instances. Existing offline-failure, reply cancellation, retry, attachment and send tests demonstrate the repair. |

The separate native ERP example declares Dart ^3.11.5; its newer lint constraint
is consistent with that host floor and was not changed. The linked preview
checkout is unchanged. Neither example's old committed SDK pin includes this
uncommitted repair. SDK package and browser-lab README files distinguish the
package floor, native-host floor, source testing and publication.

Settings tests now check stable merged semantics and keyboard reachability of
the radio tile, allowing framework differences in internal radio focus and
semantics flags. A composer semantics check settles layout before inspection.
Actual 3.19 execution also exposed a 3px thread overflow when header/root context
and a full draft/reference/attachment stack exceeded the default 600px viewport.
The bounded thread body now constrains and scrolls the existing keyed composer
within the remaining height; the timeline consumes the rest. The original
viewport is retained in the final fixture. Six default/Discord restriction tests
now verify that Send remains reachable inside the panel and no overflow occurs,
while draft, reply reference, attachments and destination remain unchanged.


## Verification

`minimum-final-pass/` and `current-final-pass/` are the final clean package and
consumer runs. Their `results.json` records exact executable paths, arguments,
working directories, environment, exit status, elapsed time and child peak RSS.
`input-sha256.json` binds the initial tested source snapshot;
`layout-input-sha256.json` records the two-file final layout/test overlay, whose
scoped analysis, 33 thread tests, 54 navigation tests and consumer compilation
are separately rerun in `layout-results.json`; package and consumer
lockfiles are retained alongside logs. Expensive checks run sequentially;
Flutter tests use `--concurrency=2`. Worker memory ceilings were disabled in
the supplied environment; no artificial run/time/token budget was introduced.

| Check | Flutter 3.19.0 / Dart 3.3.0 | Installed Flutter 3.41.7 / Dart 3.11.5 |
| --- | --- | --- |
| Clean package and disposable consumer resolution | Pass | Pass |
| Entire public library analysis and scoped typed analysis | Pass (informational lints only) | Pass (informational lints only) |
| Reply/settings/thread/reducer/composer/theme regressions | 314 passed; final 33 thread cases rerun | 314 passed; final 33 thread cases rerun |
| Workspace reply, named-thread and discovery navigation | 54 passed; rerun after layout fix | 54 passed; rerun after layout fix |
| Six public imports plus mounted state widget update | 1 passed | 1 passed |
| Actual browser-lab Git-pin resolution | Pass; `minimum-final-pass/example-pinned-resolution.log` | Pass; `current-final-pass/example-pinned-resolution.log` |
| Browser lab analysis with repaired source | Pass, no issues | Pass, no issues |
| Browser lab release web compilation with repaired source | Pass; `minimum-final-pass/example-web-build.log` | Pass; `current-final-pass/example-web-build.log` |

Both web builds warn about the lab's existing absent Cupertino icon font. These
are compilation checks, not visual acceptance. No browser/listener was opened.
Public/scoped SDK analysis retains informational legacy lints/deprecations; no
new warning or compile error is hidden by relabeling current-SDK results as
minimum proof. JS source did not change; prior independent JS, Node22.0 and
React18.2 evidence remains supporting evidence, not a new rerun here.

Intermediate logs are retained. Early runs exposed the portal and test API
issues described above. Broad, out-of-scope huddle and workspace search runs
were interrupted after failure/stalled fixture work, exit130, and then narrowed
to the requested reply/settings/thread surfaces. Huddle media fixtures failed
before device selection with `descriptorUnavailable`; an attempted fixture-only
identity adjustment also failed/stalled and was removed. The huddle device field
is compiler-verified; media connection/device-change runtime is not claimed.
An initial consumer harness stalled during asynchronous fixture lifetime work;
the final consumer uses the existing narrow scripted state-stream fixture and
verifies mount, actual update and teardown. The SDK's real reply/thread widgets
are exercised separately in the regression suites. The initial web `--debug`
option was unsupported on 3.19; the retained successful command is `--release`.

## Response to QA and remaining dependency actions

| QA finding / criterion | Response and next action |
| --- | --- |
| package_readiness: false Flutter floor | Repaired and exercised at the exact declared minimum and installed SDK. Review `patch-identities.json`, final result logs and fresh locks. Independent QA must inspect the changed artifact; package/adoption acceptance is not asserted here. |
| Clean uncommitted consumer verification was possible | Correct. Fresh disposable local artifact consumers resolve, import all public entry points, analyze and compile/test. Local path overrides exist only in scratch fixtures; actual package/example SDK installations retain full public HTTPS Git pins and matching locks. No publication receipt is implied. |
| discord_setting: end-to-end unverified | Package/widget regressions cover default/Discord, saved preference failures/retry, reload/rebind, reply destination/context/mention opt-out, drafts, canonical threads and discovery. Flutter-to-PostgreSQL and cross-client live flow still need the authorized runtime below. |
| pilot_quality: overall unverified | Preserve prior server/membership fixes and evidence. Real device keyboard/screen-reader/browser/mobile acceptance remains review work; the reproduced smaller-viewport overflow is repaired and fixture-tested. Optional huddle harness needs a valid join-descriptor lifecycle before device controls can be independently exercised. |
| Independent PostgreSQL rerun failed | Unchanged environment was not retried. Main must provide the reviewer a permitted non-root PostgreSQL16 harness (initdb rejected root UID; container fallback unavailable), then run the existing isolated schema suites and verify teardown. Prior implementation PostgreSQL passes remain supporting evidence only. |
| Services stopped; no authorized route or Vault profile | No services/configuration/identity changes attempted. Main must arrange an authorized isolated lab/Mobile Preview route serving the final approved artifact and applicable authenticated QA handoff. Respect `do_not_manage`; no raw listener. Then independently verify Flutter↔PostgreSQL, multi-client propagation, reload/reconnect/failure recovery and registered UI media. |
| hitcents_fit: supplied ERP paths absent | Do not retry unchanged inaccessible paths. Main must expose read-only web/mobile source to the reviewer (auth, tenant, directory, storage, realtime and UI seams). No ERP installation, modification or deployment. |
| independent_acceptance: withheld | Return this package to the same owner task and existing planner action `6bf7dd87-c656-4763-b690-5c426890cd1c`. Main schedules subsequent independent QA against the new artifact identity, supplies the full prior review records, and owns any later commit/pin/publication decision. No competing controller or queue/callback row was created. |

## Reproduction

1. Reconstruct each checkout from the base HEAD and corresponding patch in this
   directory's `patch-identities.json`. `capture_artifacts.py` verifies patch
   applicability and byte correspondence. The original evidence generation is
   untouched; this directory's `evidence-sha256.json` checksums both generations.
2. Obtain the official minimum SDK archive at
   `https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_3.19.0-stable.tar.xz`.
   Verify SHA256 `4cc1706fbd6e2a5c0ee34a6f8de875aae20904c9f47e18c88d2fcb25d9ea1a79`
   and extract into a writable private tooling directory. `toolchain-provenance.json`
   retains release metadata. Use an isolated copy of current 3.41.7 too, never
   change the shared SDK/cache. Here each SDK came from that release or the
   installed read-only 3.41.7 copy; “current” does not mean latest upstream stable.
3. From this evidence directory, sequentially run with absolute paths and new
   scratch directories (choose unused LABEL output names):

   ```sh
   python3 verify.py /private/minimum/flutter LABEL_MIN /private/check-min /path/to/handrail-sdk-chat-flutter
   python3 verify.py /private/current/flutter LABEL_CURRENT /private/check-current /path/to/handrail-sdk-chat-flutter
   python3 verify_example.py /private/minimum/flutter LABEL_MIN /private/check-min /path/to/handrail-sdk-chat-flutter
   python3 verify_example.py /private/current/flutter LABEL_CURRENT /private/check-current /path/to/handrail-sdk-chat-flutter
   ```

   Each package snapshot omits existing `.dart_tool`, build and lock state;
   each run uses its own PUB_CACHE. Example validation first resolves the actual
   frozen Git pin, then applies a scratch-only source override to compile the
   repaired uncommitted artifact. `verify_followup.py` and `verify_layout.py` retain the narrower
   fixture/layout rerun procedures; it is not needed for final reproduction.

4. Keep final independent PostgreSQL/live/ERP and publication gates explicit.
   These scripts cannot satisfy them and do not attempt to start services.
