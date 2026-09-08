# Unified release v0.1.15 validation

Validated on 2026-08-27 in the queued Codex workspace after synchronizing the
npm manifest, Flutter pubspec, JavaScript client handshake, path-dependency
lockfiles, and release documentation. `HEAD` is tagged `v0.1.15`.

## Version parity

Command: `npm run check:version-sync`

Result: pass.

```text
Version sync OK: npm, Flutter pub, and release references all use 0.1.15.
```

## Unified non-publishing release gate

Command: `npm run check:unified-release -- v0.1.15` with the workspace Flutter
SDK's `dart` and `flutter` binaries on `PATH`.

Result: pass.

```text
Unified release check OK for v0.1.15 (protocol 4, schema 22). No packages were published.
```

This gate covered generated-contract drift checks, cross-language conformance,
`npm pack --dry-run`, and `dart pub publish --dry-run` artifact inspection.

## Cross-language conformance

Command: `npm run check:conformance`

Result: pass.

```text
[device-push-token] agreement: TypeScript and Dart passed.
[durable-events] agreement: TypeScript and Dart passed.
[realtime-metadata] agreement: TypeScript and Dart passed.
Conformance passed: 3 suite(s).
```

## Unified-release checker regression tests

Command: `node --test test/unified-release.test.mjs`

Result: pass (7 tests). The fixture mirrors Dart's Unicode artifact tree output
and verifies that a missing public Dart library still fails validation.
