# Configured Mobile Preview availability — approval pending

Work request `4e979270-3d99-4eb7-a512-c4a3cd5f7b59`, finding
`3c1978c7-4a9b-411e-b1ff-08d92b80e197`, campaign
`ab6cb21d-834b-4cd7-8a68-fb958924a76f`. Inspected 2026-09-07 in run
`61949e93-2e02-4088-a0de-5ff0f0e36647`.

## Independently confirmed boundary

This finding reproduces at the Handrail dev runtime/configuration boundary.
`handrail_current_context` confirmed the active project, work request, and Owner
Goal. `handrail_dev_service_status` and `get_project_mobile_config` reported:

- Mobile Preview service `e9735531-9f0c-4db0-8c95-2e388b561cfb` is stopped;
  no supervisor or listener on configured port 4115; authorized QA proxy missing.
- Mobile Preview is enabled for linked repo
  `64eb222b-8334-4446-bc7d-5332d9ff2f71` (`handrail-chat-preview-flutter`), Flutter
  root `.`, default entrypoint, web-server transport, iPhone 17 portrait, rotation
  enabled, and no custom Dart defines. No Kubernetes targets are declared.
- The generated service command still contains app version `0.1.4+1`, whereas
  the launcher pubspec is `0.1.7+1`. This is stale command metadata, not evidence
  that a version mismatch caused the stopped process.
- Launcher `lib/main.dart` creates and retains `TimelineLabReplyStyleScenario`.
  Replies and named threads are explicitly labelled deterministic fixture data.
  Starting this service proves UI availability only, not backend persistence.

The SDK checkout was `43b47b93a69523fee5376dfcc1745297b58c6857` with existing
sibling edits; preview checkout was `06dc62fecd2e6d0f4ecd76eb08551d3d96843c5f`
and clean. No product source, dependency, or existing sibling change was modified.
The sanitized MCP runtime response is preserved in
[mobile-preview-availability-status.json](mobile-preview-availability-status.json);
generated commands are omitted because they can contain injected tokens.

## Concrete configuration request and remaining work

Called the explicitly permitted `handrail_request_configuration_approval` with
`config_change_type=mobile_preview`, `environment=dev`, and
`mobile_preview={enabled:true, ensure_preview_service:true}`. All existing repo,
root, port, entrypoint, defines, and device settings are to be preserved. The
requested delta regenerates the backing service command from the current
launcher metadata, followed by supervised startup and proxy verification.

Approval card: `4724b303-dadf-4617-a052-bd3b9c908926`.
Configuration request: `f1d36adc-a809-4325-aaa9-17fefa3b3fd4`.

Despite the tool description advertising automatic approval for reversible dev
changes, the actual response returned `owner_goal_turn_behavior=approval` and:
"The configuration has not been applied. The owner must approve the card in
Owner Ops; approval will run the typed configuration tool."

No direct configuration write or service start was used to bypass that gate.
After approval, verify the regenerated command, start the existing service using
`handrail_dev_service_action`, and wait for `supervised_running`, an owned listener
on 4115, and `qa_browser_route.status=available`. Use that authorized proxy for
browser handoff and open Replies and named threads for both Alice and Bob.
Use MCP service logs for any startup or HTTP failure. **The requested runtime
acceptance remains incomplete; this report does not claim the issue is fixed.**

Database-backed Flutter QA is separately provided by existing `chat-lab` service
`812c4054-6ced-4616-94fb-13f672b3e897` on port 4167. It reconciled as healthy with
an authorized proxy at inspection. Its Flutter URL is
`https://h-57a5c33bac91a8de.dev.handrail-daas.com/__flutter-chat-lab/?actor=alice`
(or `actor=bob`). Its same-origin backend entrypoint cannot simply be selected on
the standalone Flutter web-server: that server does not provide `/api/chat` and
`/__chat-lab/*`. No cross-origin workaround, new backend, or mock persistence was
introduced. See the sibling repair's
[backend verification](flutter-shared-reply-styles-backend.md); its prior browser
and PostgreSQL results were reviewed but not rerun or claimed as this run's proof.

## Checks executed

Used the installed Dart executable and `flutter_tools.snapshot` with
`FLUTTER_ALREADY_LOCKED=true` because the SDK cache is read-only in this worker.
Flutter warned that two native-device artifact stamp files could not be written;
both test runs proceeded to completion.

- Preview: `flutter test --no-pub --concurrency=1 test/mobile_preview_launcher_test.dart`:
  **6 passed, 1 failed**. Alice and Bob reply configuration, retained scenario
  reselection, launcher restarts, host lifecycle, and non-host denied start passed.
  The existing `non-host leaves coherently after a denied end attempt` test timed
  out at line 402 waiting for `handrail-huddle-join` after leaving. This independent
  huddle failure is outside this configuration task; no test was weakened.
- SDK: `flutter test --no-pub --concurrency=1 test/durable_resource_event_reducer_test.dart`:
  **43 passed**. These are reducer unit tests, not a SQL persistence harness.
- Both test runs compiled their Flutter test targets. No typed source changed.
- No database-backed harness was run, and no persistence claim is made.
- Documentation whitespace and saved JSON parsing checks passed.

## Original campaign artifacts

Reviewed the supplied evidence descriptions and independently reproduced the
runtime and launcher findings above. The runner's resolved `attachments`
directory does not exist, so the original JSON bytes could not be opened or
their supplied hashes independently checked. Preserve these original references
without presenting them as files read during this run:

| Campaign artifact | API reference | Supplied SHA-256 |
| --- | --- | --- |
| `campaigns/ab6cb21d-834b-4cd7-8a68-fb958924a76f/configured-runtime.json` | `/api/pm/qa-campaign-artifacts/40a17253-fb98-410f-9e96-629d4a447817/content` | `fcd6078d9396fe80ed37e5ee76a8092795841d4338bee38c37cd3aaf9e451f29` |
| `campaigns/ab6cb21d-834b-4cd7-8a68-fb958924a76f/checkout-provenance.json` | `/api/pm/qa-campaign-artifacts/8cfd8791-c60f-4fc8-8dfc-873e121ddc7b/content` | `609169d283e254be4976db8e668c77df5c10b02da43cd9c2ae7a10b6b8654631` |

No commit, push, PR, mobile store build, or direct Handrail database/queue mutation
was performed. The only configuration mutation request used the Owner Goal
approval-card tool and remains pending.
