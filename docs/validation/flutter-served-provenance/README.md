# Served Flutter provenance repair

Work request: `f6a4fa06-dbf2-4060-ba93-074f36801d13`.
Campaign: `298e20b4-4faf-4283-949d-3801cf437aa8`.
Finding: `9fd9d0d0-d507-4998-a692-647d739a8fec`.
Verified on 2026-09-07 against the campaign's shared-backend route,
`http://127.0.0.1:4167/__flutter-chat-lab/`.

## Failure boundary and repair

The failure was stale compiled Flutter assets. Before making changes, Handrail
current-context and dev-service-status confirmed the intended project and the
supervised `chat-lab` service on port 4167. The service command builds Flutter at
startup through `examples/drop-in-react/scripts/chat-lab.mjs`; it does not watch
subsequent Dart edits. Its asset handler reads the existing `build/web` directory
and sets `Cache-Control: no-store`. No project env/configuration delta was needed.

The live browser export independently reproduced the campaign's exact mismatch.
The existing input-fingerprint function still returned the newer campaign digest.
The service logs recorded a successful startup build and later WebSocket EPIPE
errors; these did not explain a compiled-input mismatch. No application behavior
change was needed for this finding.

Rebuilt with the existing `build:flutter:lab` script, which embeds the actual
input digest and rejects input changes during compilation. The refreshed browser
export now matches current inputs. The backend instance and its loaded-function
fingerprint remained unchanged, preserving the campaign backend state.

| Evidence | Before | After |
| --- | --- | --- |
| Source revision | `43b47b93a69523fee5376dfcc1745297b58c6857` | `c82abe8d19a81ec599a9771e0c449ee0605c3242` |
| Compiled source digest | `f5c932a70abde412965137aa0ed4872624273bfb913aa179f86ec7ceefa308a1` | `75fe5ee344916ace8db563339c9df7a1cd42f64fd9926aa6cd9228dd2c2e0084` |
| Build timestamp | `2026-09-07T17:01:10.989Z` | `2026-09-07T18:15:24.901Z` |
| Browser digest check | Failed: served inputs differ | Passed: served inputs match |

The current input digest was unchanged throughout verification. The fingerprint
function's `builtAt` in `inputsBefore`/`inputsAfter` is its observation time;
`exported.current.provenance.builtAt` is the embedded compilation timestamp.

Added `examples/drop-in-react/e2e/flutter-provenance.spec.mjs` and documented it in
`docs/flutter-backend-lab.md`. The check uses only the existing export bridge,
waits for initialization, records evidence before asserting equality, and compares
input digests rather than requiring HEAD equality. It detects stale assets in
future acceptance runs; it does not add automatic Dart rebuilds.

## Verification

- Browser check: failed on the exact campaign digest mismatch before rebuilding;
  passed afterward, Chromium, one worker, retries disabled.
- Flutter release web compilation: passed in 40.3 seconds, including the existing
  stable-input check. See [build.log](build.log).
- Suggested `durable_resource_event_reducer_test.dart`: all 43 tests passed with
  `--no-pub --concurrency=1`. See [reducer-test.log](reducer-test.log).
- `node --check examples/drop-in-react/e2e/flutter-provenance.spec.mjs` and
  `git diff --check`: passed.
- HTTP asset check: status 200, `no-store`, served and rebuilt `main.dart.js`
  SHA-256 both `7397489077d4962beebccb7bc051bc244e21c30961de304d280392a4dc980582`.
  See [served-asset-after.json](served-asset-after.json).

Repeat the browser check from `examples/drop-in-react`:

```sh
FLUTTER_CHAT_LAB_ORIGIN=http://127.0.0.1:4167 npx playwright test e2e/flutter-provenance.spec.mjs --project=chromium --retries=0
```

The standard Flutter launcher failed before compilation because the worker mounts
the SDK read-only (`engine.stamp: Read-only file system`). The successful build
used `FLUTTER_BIN` pointing to a temporary wrapper around the existing cached
Flutter tool, following the repository's established worker invocation:

```sh
#!/bin/bash
export FLUTTER_ALREADY_LOCKED=true
exec /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics "$@" --no-pub
```

That invocation emitted nonfatal read-only stamp warnings for `libimobiledevice`
and `libusbmuxd`; the web compiler completed successfully. The build also retained
the existing missing Cupertino font warning. Chromium was installed in this run's
writable temporary directory using `PLAYWRIGHT_BROWSERS_PATH`.

The browser used the same loopback route recorded by the campaign. A separate
unauthenticated HTTP probe to the configured Handrail dev-proxy hostname returned
404; authenticated proxy access was not verified. This task verifies executing
Flutter provenance, not the campaign's broader reply/thread behavior. The browser
check does not issue message, thread, preference, or explicit hydration commands.
It uses the existing live lab; no new database harness or fixture data was added.

## Preserved evidence

[before.json](before.json) and [after.json](after.json) contain fresh browser
exports and current input fingerprints from this repair.

The supplied attachment paths were absent in this runner. All five original
artifacts were recovered through `get_goal_completed_work_result`, reviewed, and
preserved byte-for-byte in [campaign/](campaign/). Their SHA-256 hashes were
verified against the work request:

| Artifact | SHA-256 |
| --- | --- |
| [current-flutter-input-digest.json](campaign/current-flutter-input-digest.json) | `d76cc371e1b6f740b00ac11349b5973187be0d8153363c0a8246f5038e94c6ab` |
| [flutter-initial-export.json](campaign/flutter-initial-export.json) | `238d27638acc9efc7e6accd8ec89cc2607cef9a5cf56acddfa37649d94e7633d` |
| [runtime-instance.json](campaign/runtime-instance.json) | `ea0284964f058c6239e84b91cda43040e54fd0be42f2f9ed578f8b86323ea23d` |
| [served-asset-provenance.json](campaign/served-asset-provenance.json) | `7fa41cee8eed652f23e61c806d4d4737d68c45d73a6b1d0cf3d5a73449f95e74` |
| [service-log-correlation.json](campaign/service-log-correlation.json) | `f3e26086aa0125bb8cc63c01db8d9c6a1de5cd07b2026d1da0216407bf1ef75d` |
