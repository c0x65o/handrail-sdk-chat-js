# Unified release v0.1.16 validation

Validated on 2026-08-27 in the queued Codex workspace after synchronizing the
remaining npm example path-dependency lockfile with the canonical npm and
Flutter package version. No package was published, no deployment was performed,
and no release tag was created or moved.

## Version parity

Command: `npm run check:version-sync`

Result: pass.

```text
Version sync OK: npm, Flutter pub, and release references all use 0.1.16.
```

## Unified non-publishing release gate

Command: `npm run check:unified-release -- v0.1.16` with the workspace Flutter
SDK's `dart` and `flutter` binaries on `PATH`.

Result: pass.

```text
Unified release check OK for v0.1.16 (protocol 4, schema 22). No packages were published.
```

This gate covered generated-contract drift checks, cross-language conformance,
`npm pack --dry-run`, and `dart pub publish --dry-run` artifact inspection.
