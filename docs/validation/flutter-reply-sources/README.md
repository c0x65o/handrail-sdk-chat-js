# Flutter accessible reply sources

Work request: `64ec63e1-207e-4eb9-99af-54a03afcc6e2`.
Finding: `4c252fac-9fea-4d16-8ef5-e762e31b9e1d`.
Campaign: `298e20b4-4faf-4283-949d-3801cf437aa8` (dev).
Source work request: `8ff41fa4-8f28-4ee9-b884-7e87614c7db5`.
Source run: `fee77ab0-0d2f-42ba-825f-82575519ddf8`.

## Confirmed boundary

The shared-backend Flutter host omitted the trusted authority configuration
required by `client.messageContexts`. The SDK intentionally performs no source
read without it. The deterministic reply-style fixture configured each source,
masking the missing real-host integration. Existing reply previews and jump
controls become usable once the authorized context resolves. No SDK authorization
rule, endpoint, backend data, env variable, or deployment setting needed changing.

Before editing, source inspection established this missing call. Handrail current
context confirmed this work request and dev-service-status reported the shared
`chat-lab` service healthy on port 4167. The separately configured Mobile Preview
was stopped; it is not the campaign's `/__flutter-chat-lab/` surface. After editing
but before rebuilding, an independent browser check reproduced Bob's two Friday
rows as `Original message unavailable` while Alice's `Which launch date?` was
visible. That executing build had already received the prior provenance repair:
digest `75fe5ee344916ace8db563339c9df7a1cd42f64fd9926aa6cd9228dd2c2e0084`,
revision `c82abe8d19a81ec599a9771e0c449ee0605c3242`, built at
`2026-09-07T18:15:24.901Z`. Thus a stale pre-repair deploy alone did not explain
this finding.

The host now configures shared source controllers from the accepted realtime
tenant/user/device identity as messages and restored drafts arrive, including
references outside the loaded page. Configuration is deduplicated within that
identity, preserving shared reads and revocations. A new authenticated device
reconfigures authority because SDK storage activation clears it, even when the
user is unchanged. This matters because the real lab assigns new device IDs on
reconnect. The SDK still checks source and conversation access on the server,
clears content on disconnect/revocation, and owns controller disposal.

## Original campaign evidence

The three supplied screenshots were reviewed directly. They show unavailable
channel references for both actors and an unavailable DM composer reference.
Preserved artifact references under `campaigns/298e20b4-4faf-4283-949d-3801cf437aa8/`:

| Artifact | Artifact ID | SHA-256 |
| --- | --- | --- |
| `10-flutter-initial.png` | `a27996c8-6537-4994-bddc-3d133b51dd4a` | `cb8825a8dcb66472ff648b685bbef71aa29061f06c4bb8aeaca2acf3e3ee2aa6` |
| `28-flutter-mobile-bob.png` | `7e6fcf89-351a-4459-8d8b-cfb4bf89ff9c` | `f3586762f12e0e92065a79804bfe28bc2d1e72b7334b1027da7c24cbd8f8fabd` |
| `45-flutter-dm-inline.png` | `71b7e9a8-e7f4-4c5c-8712-2765876a01d0` | `310f4ced011dce68fe4402ff6ee670bd35e1b785b82cb3aa1234f5e31c512a41` |
| `canonical-final.json` | `5d0390d1-c414-4afb-a981-0e37faef9d72` | `fa6e7a2dd32213fc53302379c999898b0a9a8ca76c66db9d05c148a21e279831` |
| `flutter-bob-reply.json` | `853f2c38-b70e-46ce-bed7-d1e3616fef18` | `87bd9c3001597a0c5cc14f6dd6b8c95702be93306792901334eabf777135266e` |
| `flutter-dm-inline.json` | `0a37af4b-bf9e-4426-a9a7-cd36e9968726` | `43e30abce0cca7b29476cd6b0a288dba63234102653e89262d7895703a27c2ac` |

Each original artifact is addressed by
`/api/pm/qa-campaign-artifacts/<artifact-ID>/content`. The provided local attachment
directory is absent in this worker, so the original JSON payloads could not be
read or rehashed. Their IDs/hashes above preserve the work request's provenance;
fresh runtime exports below provide independent evidence.

## Verification

- Browser: all four cases passed in Chromium, one worker, retries disabled.
  Both actors resolve the channel and DM references and focus the original
  message. Bob's composer recovers through Retry after one deliberately aborted
  context request in each case; subsequent reads reach the real backend with
  HTTP 200. Fresh screenshots: [Alice channel](alice-channel.png),
  [Alice DM](alice-direct.png), [Bob channel](bob-channel.png),
  [Bob DM](bob-direct.png). Matching JSON files retain semantics and SDK exports;
  [browser-summary.json](browser-summary.json) records source reads and provenance.
  All cases executed digest
  `5cac9517fd50f36e670d21607634a8bc5f64c90d659333260fedf93847ee3e0f`,
  built at `2026-09-07T18:31:33.721Z`, matching the current Flutter inputs.
- `backend_lab_reply_contexts_test.dart`: six passing widget regressions for
  channel/direct/thread sources, loaded and unloaded, retry, focus/jump, new-device
  reconnect, and preservation of revocation across unrelated commits.
- `durable_resource_event_reducer_test.dart`: all 43 tests passed.
- Existing context-controller, timeline-reference and composer suites: 88 passed,
  one unchanged failure. `narrow large text wraps reference and source window
  without overflow` taps at `(160, -21)` outside its 320×720 viewport, then expects
  a dialog. These tests do not import the changed host. See `reply-regressions.log`.
- Scoped Dart analysis: no issues. Web release compilation succeeded using the
  existing cached Flutter tool invocation documented in the sibling
  `flutter-served-provenance/README.md`; the standard launcher cannot write
  `engine.stamp` in the read-only SDK. Nonfatal native-tool stamp warnings remain.
- `node --check` on the browser regression and `git diff --check`: passed.

The widget tests use the existing narrow HTTP/socket fixtures; the browser checks
use the campaign's existing PostgreSQL-backed dev service. No persistence/query
code changed, and no reset or migration was run. Existing replies supply the
browser evidence; the send contract remains covered by the existing composer
tests rather than adding duplicate campaign messages. No commit or push was made.

The focused browser regression can be repeated against the campaign backend:

```sh
cd examples/drop-in-react
FLUTTER_CHAT_LAB_ORIGIN=http://127.0.0.1:4167 npx playwright test e2e/flutter-reply-sources.spec.mjs --project=chromium --retries=0
```

It reuses existing channel/DM reply pairs rather than resetting the database.
It checks Alice on desktop and Bob at 390×844, context HTTP success, visible
author/excerpts, jump focus, Bob's Reply/Retry composer behavior, and executing
Flutter input provenance. Each case exports state, semantics and a screenshot.
The backend instance remains `09cc43d02b2911e0ff91788be8ae55ae`.
