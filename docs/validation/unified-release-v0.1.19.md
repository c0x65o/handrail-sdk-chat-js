# Unified release v0.1.19 convergence validation

This working-tree record covers the non-publishing convergence of the npm and
Flutter distributions. No package was published, no deployment was performed,
and no commit, push, or Git-tag change was made.

## Canonical version

The npm manifest, browser handshake metadata, Flutter pubspec and package
metadata, example path-dependency lockfiles, README examples, and release guide
all use `0.1.19`.

## Evidence

All commands below completed successfully on 2026-08-27, sequentially under
the Handrail worker limits:

| Boundary | Evidence |
| --- | --- |
| Version/release | `test/unified-release.test.mjs`: 7 passed; `check-version-sync.mjs`: `0.1.19`; `check-unified-release.mjs v0.1.19`: protocol 4, schema 22, no publication. |
| npm artifact | `npm pack --dry-run --json`: `@handrail/chat@0.1.19`, 439 entries, no tarball written. |
| Dart artifact | `dart pub publish --dry-run --ignore-warnings`: archive validated as `handrail_chat 0.1.19`; no publication. Expected dirty-worktree and missing public repository metadata warnings remain. |
| Drop-in React/Vite | TypeScript, Vite production build, 80-module browser graph, 3 DOM smoke tests, and static boundary check passed. |
| Headless React/Vite | TypeScript, Vite production build, 72-module browser graph, 1 DOM smoke test, and static boundary check passed. |
| Embedded Node | TypeScript, build, authenticated HTTP/WebSocket smoke, and static boundary check passed. |
| Root behavior/docs | Default workspace 4 tests, server embedding 5 tests, pilot guide 2 tests, and integration-testing guide 4 tests passed. |
| PostgreSQL | Create-conversation command 7 tests passed, including direct/group convergence. The documented two-actor direct-message smoke applied all migrations, sent/read text, authenticated realtime, and tore down. |
| Flutter ERP | Focused analyze reported no issues; 6 widget tests passed. Flutter package core/import and application-connectivity suites passed 9 tests. |

The Vite builds report advisory chunk-size warnings (approximately 634 KB
drop-in and 582 KB headless before gzip). They are not correctness failures but
are a production optimization target.

## Pilot readiness

The repository is ready to begin a controlled first React/Vite and Flutter
text-chat pilot from local workspace/path dependencies. The pilot has a trusted
Node embedding contract, explicit PostgreSQL migration workflow, HTTP and
WebSocket lifecycle, a real two-actor database smoke, React drop-in and headless
paths, scoped themes and four layouts, Flutter HTTP/realtime/lifecycle
composition, and explicit host ownership for providers and window/modal
behavior.

Broad production adoption is not claimed. npm/pub publication, message search,
default creation/membership/saved/typing navigation surfaces, provider-backed
storage/push/notifications/media, voice/video/screen sharing, malware scanning,
retention/eDiscovery, moderation, analytics, federation, bundle optimization,
load/chaos testing, and production SLO evidence remain deferred or host-owned
as detailed in the [pilot guide](../pilot-integration.md).
