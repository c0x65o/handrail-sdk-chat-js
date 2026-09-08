# Flutter draft restoration after reload

Work request: `2359ef04-cc6f-42e7-a00d-6146f202157f`.
Finding: `079d82db-daa2-49a3-8337-0a88ea0f0ea9`.
Campaign: `298e20b4-4faf-4283-949d-3801cf437aa8` (dev).
Campaign work request: `8ff41fa4-8f28-4ee9-b884-7e87614c7db5`.
Campaign run: `fee77ab0-0d2f-42ba-825f-82575519ddf8`.

## Failure boundary

Handrail current context confirmed this work request. Dev-service status reported
both configured services stopped, with no listeners. The chat-lab log read returned
no captured logs. No Kubernetes targets or managed capability requirements were
declared. No project configuration, credentials, shared database, or queue state
was changed.

The supplied screenshots show `QA 298e20b4 durable draft` before and after the
style switch, then an empty composer after reload. The before JSON independently
records the actual input value; the after JSON records an empty input. The switch
JSON's unfocused native input is empty even though the screenshot retains the
draft, so that DOM value alone is not evidence of loss.

Source inspection independently identifies an application-code gap: Flutter's
composer PATCHes the existing actor-private draft endpoint, but its conversation
controller reads only conversation detail when reopening. That detail excludes
private drafts. The Flutter client had no GET draft hydration path, whereas React
already reads `/conversations/:id/draft`. The lab has no local storage adapter and
its replay cursor intentionally starts fresh on reload. Changing the cursor or
adding a parallel browser draft store would not repair the missing canonical read.

The new fresh-client regression failed before the repair: expected draft revision
4, received null. See [before-tests.log](before-tests.log). The browser regression
uses real PostgreSQL to establish server storage and restoration independently of
the original campaign's unproven persistence boundary.

## Change

`HandrailChatClient.loadDraft` reads and validates the existing private snapshot,
including its conversation, privacy markers, revision, timestamp, and generated
draft-content contract. Conversation loading restores it before making the
composer ready. The existing draft runtime preserves pending local edits and
newer canonical revisions. Identity-generation and disposal guards reject late
private responses. Cleared and never-authored drafts restore as empty composers.

Failed reads retain query diagnostics and do not prevent access to conversation
history. The lab still uses its existing server synchronization debounce; this
change does not promise reload recovery for offline edits or keystrokes lost
before the server accepts the draft.

## Verification

- [Flutter tests](tests.log): 145 passed across conversation-controller,
  draft-runtime, composer, snapshot-query, and durable-resource-reducer suites.
  Includes absent/cleared drafts, malformed responses, stale revisions, pending
  local edits, actor changes, and disposal.
- [Scoped Dart analysis](analysis.log): client, controller, query, draft runtime,
  and controller tests; no issues found.
- [Release web compilation](build.log): passed using the existing provenance-aware
  `build-flutter-chat-lab.mjs`; no dependency changes.
- [Chromium regression](browser.log): one worker, retries disabled, real PostgreSQL
  15 with the existing schema-per-test migration/seed harness. Alice types the
  campaign text in a DM, switches Current → Discord-style → Current, reloads,
  uses Back to conversations, and reopens the same DM. The actual textarea and
  screenshot retain the text. The other conversation and Bob's composer remain
  empty; clearing Alice's draft stays cleared after another reload. SQL verifies
  the Alice-only draft and subsequent clear tombstone. The executing Flutter
  digest matches the current source digest.
- [Browser evidence](browser/flutter-draft-reload-Flutt-19efb-er-style-changes-and-reload-chromium/draft-reload-evidence.json)
  preserves SQL rows, authenticated identity, source provenance, and completed
  checks; screenshots and accessible snapshots are alongside it.
- `node --check` for the browser test, `git diff --check`, and original JSON
  SHA-256 checks pass.

The temporary PostgreSQL cluster lives under ignored `build/flutter-draft-reload`
and is stopped after each browser run. No shared operator database was used.
Initial harness attempts exposed worker process cleanup between commands, the
temporary cluster's default SQL_ASCII encoding, and Flutter semantics selectors;
the final run uses a single supervised command, an explicit UTF8 test database,
and the actual native textarea. No product workaround was made for those issues.

The SDK is read-only on this worker. Flutter checks use its cached tool:
`FLUTTER_ALREADY_LOCKED=true /opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart /opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot --no-version-check --suppress-analytics`.
The nonfatal native-tool stamp warnings remain in the logs. The stopped managed
dev service was not deployed or restarted; browser validation served the rebuilt
lab through the isolated repository harness.

## Preserved campaign evidence

All original artifact paths start with
`campaigns/298e20b4-4faf-4283-949d-3801cf437aa8/`.
Original content URLs are `/api/pm/qa-campaign-artifacts/<artifact-id>/content`.
The attached image inputs were reviewed. The runner attachment paths were absent;
the three JSON files were recovered through the read-only
`get_goal_completed_work_result` tool and preserved byte-for-byte in [campaign/](campaign/).

| Artifact | Artifact ID | SHA-256 |
| --- | --- | --- |
| `56-flutter-verified-draft-before.png` | `c7240a4a-b808-4570-80b3-d62422dcb793` | `41bc002fb5c9f51e0b22e7c390b21f485f5878546ef81e8c3107c1b2b84bbec8` |
| `57-flutter-draft-after-style-switch.png` | `bd6a1641-d6a1-4063-a740-5b4c940926b5` | `dc63951f5e78b6f6cfa27dae4df635f7156f51adba7b58087b31b168cf06f6a0` |
| `58-flutter-verified-draft-after-reload.png` | `d603fa24-4f3e-4db5-9182-778bf25bb6d2` | `704753d20084730c292f73ed57e67bd7908551c59fb97b40fb78af6bec6b9517` |
| [flutter-verified-draft-before.json](campaign/flutter-verified-draft-before.json) | `44319a3f-2d6c-46c4-9ab5-556af90ed69a` | `3cbc0eaaf6d207cbeb8bd3744c90c0989371fa20128d0b45a5173894e66f5ca8` |
| [flutter-verified-draft-switch.json](campaign/flutter-verified-draft-switch.json) | `ca2c1030-86ea-486d-a773-1365bcdd8c7c` | `f1e1cd4885b748617f16c918b695210b3b64552ec4f019b5e8a50ec9a7530bd9` |
| [flutter-verified-draft-after.json](campaign/flutter-verified-draft-after.json) | `5cd60d88-2e31-49cf-b6d8-d06812f0421d` | `7b13a3ffd7dae88646bfbfad4502d158b46d67e7bd4768e845554141deddbbdb` |
