# Unified release v0.1.18 validation

Validated on 2026-08-27 in the queued Codex workspace after reconciling the npm,
Flutter, example lockfile, browser metadata, README, release-guide, and validation
references with the canonical npm version. This record establishes repository
version parity only; no package was published, no deployment was performed, and
no release tag was created or moved.

## Version parity

Command: `node scripts/check-version-sync.mjs`

Result: pass.

```text
Version sync OK: npm, Flutter pub, and release references all use 0.1.18.
```

## Focused regression coverage

Command: `node --test test/version-sync.test.mjs test/unified-release.test.mjs`

Result: pass (12 tests).

This covers repository-reference parity, isolated version-sync fixtures, and
the unified-release checker's non-publishing fixture behavior.

## Release status

The existing `v0.1.18` tag resolves to commit
`5287aa4d65d19476974c06314b44e7fc39ef6438`. At that commit, the npm manifest is
at the tagged version but the Flutter manifest remains at the prior patch
version. Consequently, this record does not validate that tag or claim it was
repaired.

The full non-publishing unified-release gate was not run for this record because
the existing tag does not identify the repaired source state. Tag correction,
publication, deployment, commit, and push were not performed.
