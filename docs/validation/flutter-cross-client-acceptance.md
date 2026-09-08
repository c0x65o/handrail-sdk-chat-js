# Self-contained Flutter cross-client thread recovery acceptance

Finding: `0791d064-3e24-4882-b47d-67d8b617f40c`  
Work request: `63a7e01e-a749-4482-8e37-535b97d6f5df`

From `handrail-sdk-chat`:

```sh
npm --prefix examples/drop-in-react run test:cross-client-harness
npm --prefix examples/drop-in-react run accept:flutter-cross-client-recovery -- "$PWD/build/NEW-cross-client-evidence"
```

The evidence directory must not exist. The optional directory defaults to a timestamped directory under `build`. Prerequisites are installed root/example npm dependencies, Playwright Chromium, Flutter with the example's resolved Dart dependencies, and native PostgreSQL server binaries (`pg_config --bindir`, or `PG_BINDIR`) under a non-root user. `FLUTTER_BIN` or `FLUTTER_ROOT` can select the installed Flutter tool. No package installations or dependency revisions are changed by the entry point.

The dedicated command compiles the current SDK with the existing TypeScript compiler and stylesheet helper, provisions an owned PostgreSQL cluster with a private Unix socket and TCP disabled, then runs only `flutter-cross-client-recovery.spec.mjs` through the existing Chat Lab fixture. The fixture uses the existing PostgreSQL harness/migrations and `reply-styles` seed profile, a random schema and loopback port, and the existing Flutter builder with a run-specific web output directory. It awaits the build before serving Flutter. The browser checks the digest embedded in executing Dart against the current source bytes; the runner also matches the build timestamp and runtime instance. SDK source/build and harness digests prevent accepting changing inputs during the run.

Inherited application/test database URLs, Chat Lab origins, seed profiles and web asset overrides are discarded. The command never connects to or resets the managed shared Chat Lab database. No campaign record or pre-existing named thread is an input. Directly invoking this regression without the entry point fails fixture setup instead of skipping.

## Authorized test scope

Within this isolated, disposable runtime, acceptance explicitly permits fixture message writes, root and named-thread creation, reply-style and follow/join/leave changes, notification preference changes, channel/thread drafts, and lifecycle close/reopen transitions. These are part of the test, not mutations to an external campaign. The test runs Bob in both clients so per-user participation and preferences can converge across clients.

Flutter stays open at **390×844** while React creates retained history, sends a new inline reply, changes notification preference and follow state, and closes/reopens the thread. Assertions require retained and new history, observed lifecycle changes, the correct participation/notification state, enabled controls, an operable subscriptions menu, and a Flutter-composed send visible in React after recovery. No manual Retry or reload is used; navigation count is checked. Root and thread IDs are captured from the test's own schema.

This scope does not include populated DM/group discovery, shared runtime configuration, QA campaign launches, deployments, commits, pushes, or queue/Owner Goal state changes. Previous archive-recovery evidence remains separate and unchanged.

## Validation result contract

`acceptance.json` records the exact executed command and phases, finding identity, fixture origin/instance/schema/conversation, executing Flutter and backend provenance, thread/root identity, screenshot paths, and cleanup. `fixture.json`, `recovery.json`, `playwright.json`, phase logs and browser traces/screenshots retain details. The two mobile screenshots show recovered history and the final composer result. The Flutter build directory, web/backend services, isolated schema, private PostgreSQL cluster and temporary files are torn down; the runner verifies schema removal and PostgreSQL shutdown before accepting.

Only **one passing execution, zero skips, zero retries, verified provenance, screenshots and successful teardown** yields `accepted: true`, `result: passed`, exit 0. Missing tools, setup failures, missing/malformed reports, skipped/empty execution, assertion failures and cleanup failures yield incomplete acceptance and a nonzero exit. A failed/incomplete attempt must not be reported as successful browser acceptance.

Attach the command, manifest, logs and screenshots to the normal work-request validation evidence. Settlement and the Owner Goal runner's subsequent wake remain platform responsibilities; this command does not modify Handrail's database or queue.

## Worker verification

Validated 2026-09-08 UTC in the queued worker. Exact successful command from the SDK repository:

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/build/cross-client-browsers" \
FLUTTER_BIN="$PWD/build/flutter-cross-client-tool" \
npm --prefix examples/drop-in-react run accept:flutter-cross-client-recovery -- "$PWD/build/flutter-cross-client-self-contained-4"
```

The worker installed Chromium into that local cache using `PLAYWRIGHT_BROWSERS_PATH="$PWD/../../build/cross-client-browsers" node node_modules/@playwright/test/cli.js install chromium` from `examples/drop-in-react`, then removed the downloaded cache after verification. Recreate it before repeating the worker command. The worker's Flutter wrapper uses its preinstalled tool snapshot because the SDK installation is read-only:

```sh
#!/bin/bash
export FLUTTER_ALREADY_LOCKED=true
exec /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics "$@" --no-pub
```

- `npm --prefix examples/drop-in-react run test:cross-client-harness`: **3 passed**, zero skipped. Covers skipped/empty/failed/retried report rejection, inherited runtime/DB isolation, and a missing-PostgreSQL CLI execution producing a nonzero incomplete result.
- SDK TypeScript compile and stylesheet helper: **passed** within the entry point. All changed JavaScript modules also passed `node --check`; scoped `git diff --check` passed.
- Dedicated browser acceptance: **1 passed**, zero skipped, zero flaky, zero retries; Playwright duration **54.1 seconds**, including fixture build/setup. Actual PostgreSQL 15 and the current Flutter release web build were used, with real HTTP/WebSocket traffic and the repository migrations (no database mock).
- Cleanup: fixture closed, schema dropped, no remaining unexpected schemas, native cluster stopped and run-specific Flutter web assets removed.

Successful fixture identity:

| Field | Value |
| --- | --- |
| Instance | `09b6486e633efca344526692e650215e` |
| Disposed origin | `http://127.0.0.1:40815` |
| Disposed schema | `handrail_chat_lab_771aacb5c22e404899bef25fa6f2faa0` |
| Parent conversation | `a313f7a4-7938-4fad-a00e-7a5ff668addc` |
| Named thread | `QA thread recovery 1788827648103` |
| Thread ID | `ac8071cb-6aa0-44d0-8bce-cd57e2d73061` |
| Root message ID | `1092e7b1-9e33-44f4-84e4-e756b6ec592a` |
| Executing Flutter input SHA-256 | `e766cbd885cc890a25a45b118476120a46a7f3d1dd4a007ef168f160cd599118` |
| Flutter build time | `2026-09-08T00:33:25.532Z` |
| SDK revision (with working-tree input digests) | `c82abe8d19a81ec599a9771e0c449ee0605c3242` |

[Acceptance manifest](../../build/flutter-cross-client-self-contained-4/acceptance.json) contains exact phase commands, SDK source/build digests, harness digest, loaded backend function fingerprints, executing Flutter provenance and cleanup. [Browser log](../../build/flutter-cross-client-self-contained-4/browser.log), [Playwright result](../../build/flutter-cross-client-self-contained-4/playwright.json), and [full recovery export](../../build/flutter-cross-client-self-contained-4/recovery.json) retain the proof.

Screenshots, both 390×844: [recovered retained/new history and preferences](../../build/flutter-cross-client-self-contained-4/browser/flutter-cross-client-recov-acdab-ates-without-manual-retries-chromium/recovered-thread-390x844.png), [Flutter-composed message after recovery](../../build/flutter-cross-client-self-contained-4/browser/flutter-cross-client-recov-acdab-ates-without-manual-retries-chromium/recovery-390x844.png).

Earlier attempts `flutter-cross-client-self-contained-1`, `-2`, and `-3` remain incomplete evidence: respectively a corrected config import, missing browser prerequisite, and a corrected reload assertion that had counted Flutter same-document history updates. None was accepted; their disposable clusters were stopped. The final assertion counts document requests and observed exactly one initial load. No manual Retry or reload was used.

No blocker remains for this harness repair. Populated DM/group discovery remains the separately scoped follow-up; existing archive-recovery evidence was not changed.
