# Flutter cached history after HTTP denial

Work request `a7f5239e-a318-42f9-84f7-a709738edbd1`, campaign
`553595d2-8542-4683-a767-eb3e15b05473`, verified locally 2026-09-07.

## Failure boundary

Before editing, Handrail MCP confirmed the active request and project. The
runtime contract has no provider capabilities or Kubernetes deploy targets.
The supervised shared `chat-lab` service was healthy (health/readiness HTTP 200).
Its available 1,000-line log tail contained earlier Vite WebSocket EPIPE errors,
but no matching 401/403 request records or provider credential failures. The
backend only logs HTTP outcomes at 500 or higher. The stopped Mobile Preview
service is separate from the shared Flutter lab route.

Source inspection confirmed an application state-handling error: both Flutter
controllers classified HTTP 403 as access revoked, while 401 retained a general
error state. The timeline widget renders cached messages in general error
states. The lab's HTTP authentication boundary intentionally rejects absent
Bearer credentials; this finding does not call for a credential/config change.
The supplied attachment paths were absent on this runner; the prompt images
were available, but the campaign JSON was not independently re-read.

## Change and verification

Both controllers now treat HTTP 401/403 reads as access denied and retain that
status through pending or failed retries until a successful read restores access.
The existing timeline rendering gate hides the cached content. HTTP 200 after
archived realtime rejection continues to retain history with composition disabled.
Existing workspace changes, including authorized revalidation and draft loading,
were preserved.

- Extended controller regressions failed before the patch for 401 classification
  and 403 retry visibility, then passed afterward.
- **110 tests passed** across `timeline_controller_test.dart`,
  `conversation_controller_test.dart`, `handrail_thread_view_test.dart`, and
  `durable_resource_event_reducer_test.dart`, using `--concurrency=1 --no-pub`.
- Widget tests verify visible archived replies, hidden replies after 401/403 and
  subsequent HTTP 500, and restored replies with disabled composition after 200.
- Scoped Flutter analysis of both controllers and all three changed test files:
  **no issues**. `git diff --check`: **passed**.

Checks used the existing cached Flutter tool wrapper because the installed SDK
is read-only; nonfatal SDK stamp warnings did not prevent compilation or tests.
Logs are in `build/flutter-http-denial-tests.log` and
`build/flutter-http-denial-analyze.log`.

These tests use the existing narrow HTTP/socket fakes and Flutter widget harness;
they prove client state and rendering, not backend authorization or persistence.
The real-server browser campaign was not rerun, and served Flutter assets were
not rebuilt. Rebuild the shared lab's Flutter assets before campaign validation.
No commit, push, PR, or Handrail database/queue mutation was performed.
