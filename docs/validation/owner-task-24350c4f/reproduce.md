# Reproduction

Apply each source patch to its recorded base HEAD; keep consumer pins frozen.
Checks used existing dependencies and ran sequentially. No install into Hitcents,
publication or deployment is included.

## PostgreSQL16

Provide PostgreSQL16 binaries through `PG_BINDIR`. This worker extracted official
PGDG Debian12 packages privately using `dpkg-deb -x`, without system installation:

- [Server16.15](https://apt.postgresql.org/pub/repos/apt/pool/main/p/postgresql-16/postgresql-16_16.15-1.pgdg12%2B2_amd64.deb): SHA256 `12b7e33dc5b0711c02248816c02e7a08f85d1372835409de66adcd9f808864f4`.
- [Client16.15](https://apt.postgresql.org/pub/repos/apt/pool/main/p/postgresql-16/postgresql-client-16_16.15-1.pgdg12%2B2_amd64.deb): SHA256 `e4c00577ff40b59ccdf115a585a9a4e766539669473d272885325b674731dc53`.

Set `PG_BINDIR` to the extracted `usr/lib/postgresql/16/bin`. Run the test
basenames listed in test-results.json through:

```sh
node scripts/qualify-reply-threads.mjs postgres-react-reply-style-flow postgres-conversation-membership-command postgres-conversation-membership-http
```

The runner builds current source, checks version16, removes inherited PG/database
configuration and creates a private cluster with no TCP listener. Each canonical
test owns an isolated schema. The runner detects leaked schemas, then stops and
deletes only its own cluster, including after failures. It requires writable
`/tmp/handrail-codex-heavy-command-locks` for a short Unix socket path. Final
per-suite logs are retained; aggregate run logs also retain earlier failures.

## JavaScript

```sh
npm run build
node scripts/test-react-reply-routing.mjs
node scripts/test-react-reply-style.mjs
node scripts/test-client-reply-style.mjs
node --test --test-concurrency=1 test/exports.test.mjs test/ui-browser-graph.test.mjs test/server-embedding-docs.test.mjs test/pilot-integration-docs.test.mjs
npm run check:capabilities
npm run check:flutter-contracts
npm run typecheck:conversation-membership
```

UI runners compile current source before mounted React tests. The PG React suite
uses real SQL/HTTP/WebSocket adapters and happy-dom. This is functional UI
evidence, not deployed-browser acceptance. The negative-control log intentionally
fails on baseline behavior; see README for the assertion adjustment limitation.

## Flutter

From the Flutter checkout, set `FLUTTER_ROOT` to the installed SDK and optionally
`HANDRAIL_WIDGET_EVIDENCE_DIR` to the absolute media directory in this package.
Evidence uses already installed material fonts. Normal writable SDKs can use
`flutter`; this worker's shared launcher could not write engine.stamp, so it used:

```sh
FLUTTER_ALREADY_LOCKED=true "$FLUTTER_ROOT/bin/cache/dart-sdk/bin/dart" "$FLUTTER_ROOT/bin/cache/flutter_tools.snapshot" test --no-pub --concurrency=2 test/durable_resource_event_reducer_test.dart
FLUTTER_ALREADY_LOCKED=true "$FLUTTER_ROOT/bin/cache/dart-sdk/bin/dart" "$FLUTTER_ROOT/bin/cache/flutter_tools.snapshot" test --no-pub --concurrency=2 test/handrail_chat_workspace_test.dart --plain-name 'reply routing'
FLUTTER_ALREADY_LOCKED=true "$FLUTTER_ROOT/bin/cache/dart-sdk/bin/dart" "$FLUTTER_ROOT/bin/cache/flutter_tools.snapshot" test --no-pub --concurrency=2 test/handrail_reply_style_settings_test.dart test/reply_style_runtime_test.dart test/reply_style_client_test.dart test/handrail_timeline_reply_reference_test.dart test/handrail_thread_view_test.dart test/thread_list_controller_test.dart test/thread_lifecycle_controller_test.dart
"$FLUTTER_ROOT/bin/cache/dart-sdk/bin/dart" analyze lib/src/handrail_chat_workspace.dart lib/src/handrail_message_composer.dart lib/src/handrail_message_timeline.dart lib/src/handrail_thread_view.dart test/handrail_chat_workspace_test.dart test/handrail_reply_routing_cases.dart test/handrail_reply_style_settings_test.dart test/handrail_timeline_reply_reference_test.dart test/widget_evidence.dart
```

Widget PNGs render transport fixtures. They are neither golden comparisons nor
Flutter-to-PG16 runtime proof. No browser was opened; the authorized runtime route,
final consumer pins and independent QA remain acceptance requirements.
