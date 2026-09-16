# Reproduce and independently review this candidate

Inspect all three checkout heads and dirty patches against identities.json. Do
not run npm ci/build before retaining package/lock/generated source hashes and
running `node scripts/generate-package-version.mjs --check`. Dependencies in this
worker were already installed. New SDK installations must use reviewed full
public HTTPS Git SHAs with matching locks; this procedure does not publish or
select a new consumer pin.

Run expensive checks sequentially. The full Node runner configures two workers
and a 120-second test timeout. PostgreSQL tests use one worker. Flutter tests use
two workers; use a per-test 30-second timeout for the focused media/panel regression
to expose hanging fixtures rather than waiting on the framework's long default.
A timeout is a failed/unverified check, never a pass.

From handrail-sdk-chat-js:

```sh
node scripts/generate-package-version.mjs --check
npm run build
npm run typecheck
npm run typecheck:reply-style-preference
node --test --test-concurrency=1 test/package-version-generation.test.mjs test/browser-state-regressions-workflow.test.mjs test/cross-runtime-conformance-workflow.test.mjs test/drop-in-react-playwright-workflow.test.mjs test/node-tests-workflow.test.mjs test/postgres-integration-workflow.test.mjs
npm run test:reply-style-preference
npm run test:thread-lifecycle
npm run test:thread-list
npm run test:huddle-contract
npm run test:ui-huddle
node --test --test-concurrency=1 test/client-huddle-media-session.test.mjs test/client-huddle-state.test.mjs test/client-durable-huddle-recovery.test.mjs
node --test --test-concurrency=2 test/chat-workspace.test.mjs test/chat-workspace-default.test.mjs test/chat-workspace-message-search.test.mjs
node scripts/test-client-reply-style.mjs
node scripts/test-react-reply-style.mjs
node scripts/test-client-thread-list.mjs
node scripts/test-client-message-context.mjs
npm run test:node
```

The four scoped runners compile their own output and set the test-specific build
location. The aggregate Node runner currently omits those locations; direct
execution of these tests is not equivalent to their scoped runner. Retain both
results until that aggregate harness is repaired.

Use the existing [native PostgreSQL recipe](../../integration-testing.md) with
PG16 and `npm run test:postgres` as the test command. This run privately extracted
PostgreSQL16.15 using the exact URLs/SHA256 values in
[the retained recipe](../owner-task-24350c4f/reproduce.md). Set PG_BINDIR to the
extracted `usr/lib/postgresql/16/bin`, remove inherited DATABASE_URL/TEST_DATABASE_URL
and PG connection variables, and use `mktemp -d
/tmp/handrail-codex-heavy-command-locks/sdk-pg.XXXXXX` for a short private socket
path. Do not point the harness at a shared project database. Save initdb/start
receipts separately from TAP and verify zero remaining custom schemas before
stopping/removing only the owned cluster. No permanent backend is required.

For Flutter, the normal commands below work with a writable installed SDK. This
worker's read-only shared SDK uses the equivalent installed snapshot invocation:

```sh
export FLUTTER_ROOT=/opt/handrail/.handrail/flutter-sdk
export FLUTTER_ALREADY_LOCKED=true
"$FLUTTER_ROOT/bin/cache/dart-sdk/bin/dart" analyze lib test/media_session_test.dart test/handrail_huddle_panel_test.dart
"$FLUTTER_ROOT/bin/cache/dart-sdk/bin/dart" "$FLUTTER_ROOT/bin/cache/flutter_tools.snapshot" test --no-pub --concurrency=2 --timeout=30s test/media_session_test.dart test/handrail_huddle_panel_test.dart
"$FLUTTER_ROOT/bin/cache/dart-sdk/bin/dart" "$FLUTTER_ROOT/bin/cache/flutter_tools.snapshot" test --no-pub --concurrency=2 test/durable_resource_event_reducer_test.dart test/handrail_reply_style_settings_test.dart test/reply_style_runtime_test.dart test/reply_style_client_test.dart test/handrail_thread_view_test.dart test/thread_list_controller_test.dart test/thread_lifecycle_controller_test.dart test/handrail_chat_workspace_test.dart
```

Run `npm run check:conformance` from JS with the sibling Flutter checkout set via
HANDRAIL_CHAT_FLUTTER_ROOT. On this worker, temporary flutter/dart PATH shims point
to the above installed snapshot/binary (no download/install or dependency override).
Unset FLUTTER_ROOT for the Node runner so its resolver uses the PATH shim; the
shim exports the real FLUTTER_ROOT for Flutter itself. Optional native-tool cache
updates may warn because the shared SDK is read-only. Preview analysis/build uses
its existing Git-pinned transitive SDK and must be labelled accordingly.

## Later handrail_run_read_only_tests profile=sdk

Independent QA should call `action=inspect`, `profile=sdk`, with the exact JS
candidate_path, then `action=run` using the returned candidate_sha256 and a unique
request_key. Record the inspection identity and all command receipts. Supply
explicit commands, for example:

```json
[
  {"runtime":"node","args":["scripts/generate-package-version.mjs","--check"],"kind":"check"},
  {"runtime":"npm","args":["run","build"],"kind":"check"},
  {"runtime":"npm","args":["run","typecheck"],"kind":"check"},
  {"runtime":"node","args":["--test","--test-concurrency=1","test/package-version-generation.test.mjs","test/client-huddle-media-session.test.mjs","test/huddle-controls.test.mjs"],"kind":"test"},
  {"runtime":"node","args":["--test","--test-concurrency=2","test/chat-workspace.test.mjs","test/chat-workspace-default.test.mjs","test/chat-workspace-message-search.test.mjs"],"kind":"test"}
]
```

Use frozen git_references only when a test needs exact Git objects. The isolated
sdk executor does not expose host databases/credentials or dependency downloads;
do not pass a live SQL URL. Flutter/native/provider and PG16 checks need their
supported dedicated test execution handoffs. Cross-client tests require both
candidate checkouts, not just the JS copy; inspect visibility before selecting
those commands. This file prepares independent review; it is not its receipt.

## Preview host preparation and checks

An old `.dart_tool/package_config.json` referenced a removed earlier worker SDK.
Do not edit package_config paths manually or replace Git dependencies with local
paths. Regenerate through the normal pipeline, preserving the lock:

```sh
# From handrail-chat-preview-flutter, with the same installed SDK invocation:
export PUB_CACHE="$TMPDIR/preview-pub-cache"
"$FLUTTER_ROOT/bin/cache/dart-sdk/bin/dart" "$FLUTTER_ROOT/bin/cache/flutter_tools.snapshot" pub get --enforce-lockfile
"$FLUTTER_ROOT/bin/cache/dart-sdk/bin/dart" analyze lib test
"$FLUTTER_ROOT/bin/cache/dart-sdk/bin/dart" "$FLUTTER_ROOT/bin/cache/flutter_tools.snapshot" test --no-pub --concurrency=2 --timeout=30s test/mobile_preview_launcher_test.dart
"$FLUTTER_ROOT/bin/cache/dart-sdk/bin/dart" "$FLUTTER_ROOT/bin/cache/flutter_tools.snapshot" build web --no-pub
```

This run seeded that owned cache with exact existing hosted-package directories
and their SHA256 cache metadata, then used `pub get --enforce-lockfile` for normal
resolution of the unchanged public HTTPS Git pins. The preview lockfile remained
unchanged. A fresh writable cache also works with normal authorized network
access. Keep these preparation receipts separate from test/build results.
