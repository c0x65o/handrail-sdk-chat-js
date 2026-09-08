# Flutter thread-view lifecycle controls

Selected Owner Task: `f8a23c14-6e9c-4216-8254-271636a1d2b5`.
Scope: SDK source and deterministic local tests; no QA campaign or broader
Convergence completion claim.

## Behavior and host integration

Panel navigation now says **Close panel** and calls only `onClose`. Shared
close/reopen/lock/unlock live in the separately labelled **Shared thread
controls** popup. Only supported, authorized, state-appropriate transitions
appear. Lock closes; unlock leaves closed. An authorized send to a closed,
unlocked, unarchived thread reopens it atomically; opening the panel does not.
Administrative thread/parent archive disables sending and these controls do
not reverse it. These shared facts apply equally in Current and Discord-style
reply modes; reply routing and preference storage are unchanged.

Configure the existing client-owned controller with current trusted host
authority and load it. The view observes the registry controller by default;
`lifecycleController` optionally accepts that configured caller-owned controller:

```dart
final lifecycle = client.threadLifecycles.forThread(threadId);
lifecycle.setAuthority(ChatThreadLifecycleAuthority(
  tenantId: tenantId,
  userId: userId,
  canRead: hostCanRead,
  canSend: hostCanSend,
  canManage: hostCanManage,
  parentArchived: hostParentArchived,
));
await lifecycle.load();
// Pass lifecycleController: lifecycle to HandrailThreadView if desired.
```

Hosts must refresh authority/load on actor or access changes. The view never
sets authority, infers management permission from membership/follow state,
initializes capabilities, or disposes shared controllers. A small
supporting controller change exposes `state.isParentArchived`, including trusted
host restrictions and the existing live parent snapshot projection.
`composerEnabled` continues to carry other host send restrictions. Missing
authority/capability hides actions with explanatory status while preserving
legacy composition and existing composer access checks. The backend's lifecycle
capability advertisement remains unchanged; enabled scenarios use HTTP fixtures.

The view observes current normalized thread and parent snapshots even without
lifecycle management configured. Lock/archive/denial gates the existing mounted
composer instead of replacing it. Text, reply reference, false ping choice,
attachments and thread destination survive. No composer, send queue or pending
send implementation changed. Existing named titles, access-aware root rendering,
custom builders, inline-reply routing and handle lifetime rules are retained.

Loading/saving, denial, conflict and generic errors use sanitized live status.
The compact status is limited to two visible lines; its complete description
remains available to assistive technology and through a tooltip. The Material
popup supports keyboard navigation and retains its button during saving so
focus can return. Ambiguous writes offer `controller.retry()` with the original
intent/revision/key/destination. Conflicts and denials are not automatically
resubmitted. Failed initial detail loads offer a distinct loading retry.
Menu callbacks recheck their binding and state before dispatch.

## Verification

The existing thread-view HTTP harness is extended by
`test/handrail_thread_lifecycle_cases.dart`. Durable lifecycle/archive event
fixtures exercise the real normalized reducer; draft fixtures exercise the
existing private draft runtime. No fake database is introduced. SQL and
TypeScript checks are unnecessary for this Dart-only patch.

Run sequentially from `flutter/handrail_chat`:

```sh
FLUTTER_ALREADY_LOCKED=true /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics test --no-pub --concurrency=1 test/handrail_thread_view_test.dart test/thread_lifecycle_controller_test.dart test/handrail_message_composer_test.dart > ../../build/flutter-thread-view-test.log 2>&1
/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart analyze lib/src/handrail_thread_view.dart lib/src/core/thread_lifecycle_controller.dart
```

Results: **73 tests passed, exit 0** (22 thread-view widget tests, 22 lifecycle
controller/reducer tests, 29 composer tests, including existing pending-send
regressions). Scoped production analysis: **no issues, exit 0**.
The first analysis reported six brace-style informational lints in new view
code; they were corrected before the final clean analysis.

The 16 added widget tests cover state-appropriate authorized transitions,
navigation without writes, missing support/authority, send-only authority,
closed-thread composition, all three remote restrictions in both styles,
retained draft/reference/false ping/attachments/destination, host parent archive,
stale menu rejection, denied/conflicted transitions, compact keyboard navigation
and focus return, exact-request retry, initial loading retry, and scope
replacement/unmount with a late result. Existing opening tests cover stale
opening handles and caller-owned retain behavior. The scope replacement test
checks that a late old-client snapshot cannot gate the new client's composer;
controller disposal and stale command reconciliation have separate controller
regression coverage.

From repository root:

```sh
git diff --check -- flutter/handrail_chat/lib/src/handrail_thread_view.dart flutter/handrail_chat/lib/src/core/thread_lifecycle_controller.dart flutter/handrail_chat/test/handrail_thread_view_test.dart flutter/handrail_chat/test/handrail_thread_lifecycle_cases.dart docs/validation/flutter-thread-view-lifecycle.md
git diff --no-index --check -- /dev/null flutter/handrail_chat/test/handrail_thread_lifecycle_cases.dart
git diff --no-index --check -- /dev/null docs/validation/flutter-thread-view-lifecycle.md
```

Results: tracked diff check **exit 0, no whitespace errors**. Both no-index
checks returned **exit 1 with no whitespace diagnostics** because the new files
differ from `/dev/null`.
Flutter emitted non-fatal read-only `libimobiledevice.stamp` and
`libusbmuxd.stamp` warnings; the installed tooling completed successfully.
No unrelated failures remained in these final scoped checks. Backend SQL,
live service behavior, preview/device QA and capability rollout were not tested
or performed by this item.

The pre-existing root test expected cached root text without parent access.
Its assertion now preserves the existing access-aware renderer's unavailable
state. Client replacement tests use ChatScope's documented new-key contract.
Test teardown pumps stream cancellation, following the existing composer test
harness. Initial fixture timing/assertion issues and newly exposed compact
overflow/focus issues were corrected during verification.

No preview repository, generated contracts, backend capabilities, deployment,
provider calls, external sends, commit, push, PR or CI/CD state was changed.
Sibling workspace/discovery and React edits remain outside this patch.
