#!/usr/bin/env bash
set -euo pipefail
# Run from the JS repository root. Expensive checks stay sequential.
npm run build
npm run typecheck
npm run check:read-cursor
python3 docs/validation/read-cursor-ack-20261007/prepare-flutter32.py
READ_CURSOR_DART=/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart \
READ_CURSOR_DART_PACKAGES="$PWD/build/read-cursor-ack/flutter32/.dart_tool/package_config.json" \
READ_CURSOR_FLUTTER32_PROOF="$PWD/docs/validation/read-cursor-ack-20261007/flutter32-live.dart" \
bash docs/validation/read-cursor-ack-20261007/run-postgres.sh \
 test/postgres-read-cursor-outcome.test.mjs test/postgres-read-cursor-http.test.mjs \
 test/postgres-update-read-cursor-command.test.mjs test/postgres-thread-read-cursor-command.test.mjs \
 test/postgres-read-cursor-schema.test.mjs
node --test --test-concurrency=1 test/client-read-state.test.mjs \
 test/client-durable-read-state.test.mjs test/client-retained-read-state-recovery.test.mjs \
 test/client-read-state-atomic-concurrency.test.mjs test/client-background-read-state.test.mjs \
 test/read-cursor-http.test.mjs test/read-cursor-mutation.test.mjs \
 test/read-cursor-mutation-browser.test.mjs test/read-cursor-generation.test.mjs \
 test/exports.test.mjs test/client-command-dispatcher.test.mjs \
 test/package-version-generation.test.mjs test/command-retry-after.test.mjs
/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart \
 --packages=build/read-cursor-ack/flutter32/.dart_tool/package_config.json \
 /opt/handrail/.handrail/flutter-sdk/bin/cache/pub-cache/hosted/pub.dev/test-1.31.2/bin/test.dart \
 --concurrency=2 --reporter expanded \
 build/read-cursor-ack/flutter32/test/generated_read_cursor_mutation_test.dart \
 build/read-cursor-ack/flutter32/test/read_cursor_runtime_test.dart \
 build/read-cursor-ack/flutter32/test/read_visibility_coordinator_test.dart \
 build/read-cursor-ack/flutter32/test/durable_resource_event_reducer_test.dart
# Expected existing unrelated drift is a failure, never treated as a pass.
npm run check:flutter-contracts
