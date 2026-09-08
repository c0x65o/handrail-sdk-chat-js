# Shared Flutter reply-styles backend repair

Work request `b8fdb104-dc34-4d4c-a01f-00b059f9c1d0`, finding `9c2884db-eb02-4fd9-8f77-50224da54aac`, campaign `ab6cb21d-834b-4cd7-8a68-fb958924a76f`. Implemented and verified 2026-09-07 in run `4d8d22c8-15bb-4573-a7f1-377fd5d58ba3` against SDK HEAD `43b47b93a69523fee5376dfcc1745297b58c6857` plus workspace edits.

## Independently confirmed boundary

This was an example-source/build prerequisite failure. The approved project configuration already supplies `CHAT_LAB_SEED_PROFILE=reply-styles` and its dedicated Chat Lab test database. Handrail MCP confirmed the existing supervised `chat-lab` service on port 4167 was healthy. Its natural `/__chat-lab/instance` response reported `reply-styles`; a Grace session returned 404 while Bob returned 200. Same-environment MCP logs showed successful backend startup, no provider errors, and no Flutter compilation. No env, capability, resource, Vault, deploy-target or Handrail database/queue configuration change was needed.

Before editing, source inspection found two incompatible assumptions: the Flutter backend surface only admitted Ada/Grace/Margaret and selected Chat Lab General, while `chat-lab.mjs` deliberately skipped compilation for the Alice/Bob seed. Before restarting, fresh Chromium reproduction exported Grace with `identity=null`, `clientLifecycle=error`, `clientDiagnostic=access_token_failed`. Served provenance exactly matched the campaign: revision `e14618bd39933a7d7ab57240dc460226dcd2eef2`, built `2026-09-07T08:25:38.737Z`. Evidence: `build/flutter-reply-styles-before.json` and `.png`.

## Changes

- Flutter reads the natural instance profile before actor validation/session acquisition. For `reply-styles`, its chooser offers Alice/Bob, defaults to Alice, and resolves Launch planning from the authenticated conversation list. Other profiles retain the existing default actors and General selection. Explicit conversation IDs, actor cache isolation and instance-restart handling remain supported.
- Runtime evidence includes the selected seed profile and available actors.
- The normal launcher now builds Flutter for every seed and logs its URL after compilation succeeds. Existing asset readiness gating waits for the build and rejects failed builds rather than serving stale output.
- Updated both launcher documents and added `examples/drop-in-react/e2e/flutter-reply-styles-backend.spec.mjs` using the existing PostgreSQL Chat Lab fixture, with an override for the supervised runtime.

## Verification and handoff

- Scoped Flutter analysis of `example/lib/backend_lab/surface.dart`: passed, no issues. The worker's SDK is read-only, so analysis used the installed Dart executable and `flutter_tools.snapshot` with `FLUTTER_ALREADY_LOCKED=true`; the normal wrapper cannot refresh `engine.stamp` in this sandbox.
- Restart through `handrail_dev_service_action`: successful. The configured pipeline ran the TypeScript SDK build and compiled Flutter web in 39.9 seconds. `build/flutter-reply-styles-startup.json` preserves MCP logs. Flutter emitted an existing Cupertino font-family warning; compilation succeeded.
- Live Chromium regression: **passed**, one worker, no retries. The bare Flutter URL opened Alice, the two-option chooser switched to Bob, and an explicit Alice URL reconnected. Both actors had authenticated identities, lifecycle `ready`, realtime `connected`, the same selected Launch planning ID and the same seeded root. The heading and root were visible. No browser exceptions or failed session/API responses occurred. The test creates no messages or threads on the live service.
- The served source digest matched a fresh hash of actual Flutter inputs, including existing sibling edits: `9f1cfd899bee4d16b5ce681cb935478aff13b9e6afcba7d452613cf29271c1dd`. Build time: `2026-09-07T16:01:47.030Z`.
- Suggested `durable_resource_event_reducer_test.dart`: **43 passed**, concurrency 1, `--no-pub`, using the same installed Flutter tool snapshot. Log: `build-flutter-reducer-shared-backend.log`.
- Existing `flutter-backend-lab.spec.mjs`: **2 passed**, one worker, no retries. Used the dedicated project test PostgreSQL database through the existing isolated-schema harness, with teardown. This verified the default Grace/General selection, actor/conversation access, and TS/Flutter parent summaries across reconnect without hydrating the thread. No database fake or alternative persistence harness was added. Artifacts: `build/flutter-default-backend-regression-corrected/`.
- JavaScript syntax checks for the launcher and new browser spec, and `git diff --check`: passed.

Live acceptance artifacts are in `build/flutter-reply-styles-acceptance/flutter-reply-styles-backe-aa497-s-Alice-and-switches-to-Bob-chromium/`: `flutter-reply-styles-evidence.json`, `alice-1.png`, `bob-2.png`, `alice-3.png`, and `actor-options.png`. Two preliminary verifier attempts used text selectors where Flutter exposes accessible group/menuitem labels. Their diagnostic artifacts remain separately under `build/flutter-reply-styles-live/` and `build/flutter-reply-styles-live-pass/`; the corrected role selectors passed without product changes.

The first default-scenario invocation used Node's `--env-file`, which was inherited by Playwright workers and restored `CHAT_LAB_SEED_PROFILE=reply-styles` after it had been deleted in the parent. Those two attempts failed before entering Flutter because General was absent. The corrected invocation loaded env with `process.loadEnvFile`, removed only the seed profile from the test process, and spawned the CLI without inherited Node env-file flags; both tests passed. Project configuration was not edited.

Handoff uses the existing service `812c4054-6ced-4616-94fb-13f672b3e897`, instance `6bd5a3fe65e5cdea077d0a50af8f3538`, conversation `fdf2df69-5fc6-4d6c-989b-df22d8c5f6b3`, root `96d38c43-1838-401d-a09f-6989701c778e`:

- <https://h-57a5c33bac91a8de.dev.handrail-daas.com/__flutter-chat-lab/?actor=alice>
- <https://h-57a5c33bac91a8de.dev.handrail-daas.com/__flutter-chat-lab/?actor=bob>

Browser verification used loopback port 4167 for that same supervised service. The proxy URL is the MCP-reported route. Service TTL was extended by restart to 16:31:41 UTC; later restarts recreate fixture IDs. No commit, push, PR, mobile build, production deployment, or Handrail database/queue mutation was performed. Pre-existing SDK edits and the linked preview checkout were preserved.

## Original campaign evidence

Reviewed the three supplied images: Grace and Ada connection errors and the Ada/Grace/Margaret menu. The runner's resolved attachment directory was absent, so the two original JSON files could not be opened independently. Their reported findings were independently reproduced above; original references and supplied hashes are preserved here without claiming to have read unavailable bytes. All paths below are relative to `campaigns/ab6cb21d-834b-4cd7-8a68-fb958924a76f/`.

| Artifact | API reference | Supplied SHA-256 |
| --- | --- | --- |
| `03-flutter-loaded.png` | `/api/pm/qa-campaign-artifacts/5b69b1f3-af10-488d-ab5d-1965c2810f35/content` | `862e675335049ffe0b734b537db412ac8ebd6aa574fbcf901c3dc4be738b8b97` |
| `05-flutter-actor-error.png` | `/api/pm/qa-campaign-artifacts/a2b46a4b-458b-4508-bef7-533b09dc38d8/content` | `2157ba6f1e21b47452306cb726939a3b0ff9d9daf28a266c637cd7f7a1bbdf04` |
| `06-flutter-actor-options.png` | `/api/pm/qa-campaign-artifacts/96bc4600-c630-40e4-b559-120f3ce8101f/content` | `68c6575680bace86ff5525b11551380444811c51aa42e849788c3a7b3d8806ef` |
| `dev-service-logs.json` | `/api/pm/qa-campaign-artifacts/4ecf8873-d4d4-4461-b55f-a6ce2b683bd6/content` | `759878e3ae2d5b0a4c3a13a4188f44206156aefd4b12e005d8f5a429d2dbecdc` |
| `flutter-runtime-export.json` | `/api/pm/qa-campaign-artifacts/de775a5f-3e50-4918-8f34-8f723e0bd9cc/content` | `1f8218d6bbd416e0bbff1b27099f7138e4ab7fc3d8629097a79c131a2249e583` |

Re-run live acceptance from `examples/drop-in-react` with installed Chromium:

```sh
FLUTTER_CHAT_LAB_ORIGIN=http://127.0.0.1:4167 npx playwright test e2e/flutter-reply-styles-backend.spec.mjs --project=chromium --workers=1 --retries=0
```

Without the origin override, the spec uses the existing isolated PostgreSQL schema fixture with `CHAT_LAB_DATABASE_URL`/`TEST_DATABASE_URL` (or Docker fallback). Build Flutter first with `npm run build:flutter:lab`.
