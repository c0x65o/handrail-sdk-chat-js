# Unified release v0.1.17 validation

Validated on 2026-08-27 in the queued Codex workspace after reconciling the npm,
Flutter, example lockfile, browser metadata, README, and release-guide versions
with the committed canonical npm version. No package was published, no deployment
was performed, and no release tag was created or moved.

## Flutter toolchain preparation

The workspace Flutter SDK supplied both `flutter` and `dart`. Because the clean
worker did not yet have the ignored `.dart_tool/package_config.json` required by
the conformance commands' `--no-pub` mode, dependencies were restored first.

Command: `flutter pub get` in `flutter/handrail_chat`

Result: pass (`Got dependencies!`). This created the ignored local package
configuration and did not add any tracked dependency changes.

## Version parity

Command: `npm run check:version-sync`

Result: pass.

```text
Version sync OK: npm, Flutter pub, and release references all use 0.1.17.
```

## Unified non-publishing release gate

Command: `npm run check:unified-release -- v0.1.17` with the workspace Flutter
SDK's `dart` and `flutter` binaries on `PATH`.

Result: pass.

```text
Unified release check OK for v0.1.17 (protocol 4, schema 22). No packages were published.
```

This gate covered generated-contract drift checks, cross-language conformance,
`npm pack --dry-run`, and `dart pub publish --dry-run` artifact inspection.
