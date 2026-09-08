# React selected-channel reload hydration

Work request `8dedfe96-de6c-4e78-a080-09b1a59f56ba`, finding
`be9550d1-8671-403a-8300-8225f0d3faa5`, approval
`044df734-b178-4182-8a84-a11e2b05b0f2`. Verified 2026-09-07.

## Failure boundary and change

Application code is the failure boundary. Handrail current context confirmed the
project/work request. Dev service status reported the supervised lab stopped;
validation therefore used the existing isolated PostgreSQL/browser harness.
No deployed configuration change was needed to reproduce or correct the bug.

Before the source change, the new `chat-lab.reload-history.spec.mjs` reproduced
the campaign sequence: Alice caches Launch planning; Bob sends the checkpoint;
HTTP 201, the send confirmation, and a direct SQL query prove it persisted in
the parent conversation. Reload restores Alice but renders zero checkpoint
messages. See [before log](../../build/reload-history-validation/before.log) and
[before screenshot](../../build/reload-history-validation/before.png).

`useMessages` intentionally loads missing timelines and displays cached ones.
The lab's earlier refresh helper depended on its explicit selection state,
which is empty after reload. `ChatWorkspace` selected a channel internally, so
that helper never refreshed it. The earlier actor-history browser test clicked
the channel after reload and masked this failure.

`ChatWorkspace` now refreshes an already cached selected timeline when the
client becomes ready or the resolved selection changes, including automatic
selection. It uses the SDK's authorized snapshot reader and normal cache merge.
Uncached timelines still use the normal message hook. Reads are aborted on
cleanup, and cache updates do not repeatedly trigger refreshes. The redundant
lab-specific read was removed; the lab's parent subscription remains intact.

## Verification

- New reload browser regression: failed before the patch, passed afterward.
  After Alice reports managed realtime connected, the checkpoint and original
  root each appear exactly once without any channel click. The test also checks
  the checkpoint's persisted conversation ID. [Passing log](../../build/reload-history-validation/after.log).
- Existing actor-history and mixed reply-style browser regressions: both passed,
  each with a fresh fixture, one Chromium worker and zero Playwright retries.
  [Actor history](../../build/reload-history-validation/actor-history.log),
  [reply styles](../../build/reload-history-validation/reply-styles.log).
- `npm run build`: passed (SDK TypeScript compilation and stylesheet copy).
- `node examples/drop-in-react/node_modules/typescript/bin/tsc -p
  examples/drop-in-react/tsconfig.reply-styles.json --noEmit`: passed.
- `node --test --test-concurrency=1 test/chat-workspace-default.test.mjs
  test/chat-workspace.test.mjs test/react-query-hooks.test.mjs`: 178 passed,
  14 failed. The new regression passes and checks automatic selection,
  cancellation on selection/actor replacement, and absence of refresh loops.
  All 14 remaining failures also occur with this patch's refresh removed from
  the generated JS; no additional failing tests were introduced. They concern
  existing thread actions, navigation expectations and notification controls.
  [Final log](../../build/reload-history-validation/unit-final.log),
  [baseline log](../../build/reload-history-validation/unit-baseline.log).
- `git diff --check`: passed.

Browser tests used the existing real PostgreSQL migration/seed/schema-per-fixture
harness against an isolated UTF-8 PostgreSQL 15 process on loopback port 35419.
Each schema was torn down and the process stopped. No persistence mocks or
shared database resets were introduced. The first launch against the configured
test DB failed with `ECONNREFUSED 127.0.0.1:34780`; the isolated instance resolved
that harness dependency.

During mixed-style fixture startup, a conversation-creation request logged 503
and then recovered before the test passed. The local PostgreSQL log identifies
the existing `chat_idempotency_keys_timestamp_order_check` failure from separate
`clock_timestamp()` assignments in `create-conversation-command.ts`. MCP log
diagnostics found no matching request in the stopped supervised service, which
is separate from this isolated harness. The local HTTP and PostgreSQL logs are
preserved under `build/reload-history-validation/`; this unrelated timestamp
issue was not changed by the hydration repair.

This is local source validation, not a new deployed QA campaign. Flutter source
was not changed; the suggested Flutter reducer test does not exercise this React
workspace hydration path. Existing workspace changes were preserved. No commit,
push, PR, deployment, or Handrail database/queue update was performed.

## Reviewed and preserved campaign evidence

Campaign `ab6cb21d-834b-4cd7-8a68-fb958924a76f`, environment `dev`, campaign work
request `07e977bc-f964-483b-bb06-fde6848a16a1`, campaign Codex run
`7d605cde-81d4-47ff-9cf6-83bffe5ba7af`.

The three supplied image inputs were reviewed. The resolved attachment paths,
including both JSON files, were unavailable on this runner; the JSON contents
were not independently inspected. Original references and supplied hashes are
preserved below. Names are relative to the campaign directory.

| Artifact | Evidence / original reference |
| --- | --- |
| `48-confirmed-before-reload.png` | Bob displays the checkpoint and “Message sent.” [Original](/api/pm/qa-campaign-artifacts/b6848ae1-1f71-43a8-a166-b14c33ff684a/content) |
| `49-alice-reload-stale-check.png` | Alice's reloaded Launch planning omits the checkpoint. [Original](/api/pm/qa-campaign-artifacts/d0a300b9-dfd0-4a0b-ba57-0df822c38ca8/content) |
| `50-channel-reselection.png` | Alice displays the checkpoint after selecting the channel again. [Original](/api/pm/qa-campaign-artifacts/025303e4-274a-4c34-838e-c05461329002/content) |
| `reload-hydration-proof.json` | Supplied campaign proof reference; contents unavailable locally. [Original](/api/pm/qa-campaign-artifacts/5f426667-4755-477a-99a1-36a0bf1877ef/content) |
| `transport-evidence.json` | Supplied transport reference; contents unavailable locally. [Original](/api/pm/qa-campaign-artifacts/cbf8db3b-3b76-4320-a428-19f24ae31d66/content) |

Supplied SHA-256 hashes, in the same order:

```text
c7d7cde39ffb32174743e71332fabef0208ec73eddbba1d960235d1443a174cf
e11d2eb513f3585796aaeae2d03bc479271bd3e9dbb6160573b80828989aaa84
f764fc926eaabe050c61cc05ab8681b30215f6d14c6b6a4d251906901a2ecda0
39c7bae23eca7f22b282dde85a95974d5f02252e8e310e2fcfc18ba3bd2b2342
eadbfdb36368f18b6cc61a64d6e952f8420f41d889cee4bfee1fae7622ca7f7d
```
