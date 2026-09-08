# React Chat Lab mixed reply styles — completed local validation

Owner Task item `3a7cd26c-0aff-419a-ba39-1de48fee05a1`, 2026-09-07. Inspected `main` at `e14618bd39933a7d7ab57240dc460226dcd2eef2`. The patch is uncommitted. Existing React lifecycle/subscription and Flutter sibling changes were preserved; the Flutter preview checkout was not modified.

**Status: selected React demonstration acceptance passed on 2026-09-07.** Fresh Chromium execution used one worker, zero retries and real isolated PostgreSQL. This establishes the selected repository-local item, not completion of the wider convergence goal.

## Implementation

The opt-in `reply-styles` backend seed uses the existing `createChatTestHarness`, production client commands and real PostgreSQL migrations. It seeds only Alice, Bob, one public **Launch planning** channel, Alice's **Which launch date?**, and saved preferences Alice=Current/Bob=Discord-style. It creates zero threads. Existing seed profiles and default actors remain available.

The launcher exposes the profile through its existing instance metadata. `ChatLabRuntime` passes that information to `ChatLabApp`. The existing actor chooser selects Alice/Bob; production `ReplyStyleSettings` sits alongside theme settings. Production `ChatProvider`, `ChatWorkspace`, timeline, composer, creation dialog, discovery, ThreadPanel and subscription/notification controls own the behavior. A public managed conversation subscription retains the selected channel without depending on the huddle session used by other demos.

Visible guidance explains that Current Reply opens a separate thread, Discord-style Reply stays in the current conversation with a source reference, explicit named threads remain separate discussions, and switching style does not convert history. It distinguishes shared close/reopen lifecycle from the user's Join/Leave subscription, retained authorized history and independent notification preferences.

The example integration adds optional `ChatWorkspaceProps.threadLifecycleAvailability` forwarding to `ThreadPanel`. Omission still leaves authority unknown and lifecycle mutation controls hidden. Both seeded actors explicitly have `thread.manage` and `message.send` host grants; style/following do not grant permissions. The server still authorizes each operation.

An example-only sessionStorage adapter uses `createApplicationChatStorage` for SDK-validated records and the existing durable send queue. Storage is private to the browser tab and keyed by actor plus lab instance; no cross-tab writer is elected for this profile. Synchronous tab-local compare/exchange is atomic within the tab. This is a browser storage boundary, not a SQL substitute. Saved reply preferences remain server-side. Closing the tab discards its local queued/draft records; reload retains them.

Launch against an available **test** database with fresh SDK output:

```sh
CHAT_LAB_SEED_PROFILE=reply-styles CHAT_LAB_DATABASE_URL=<test-postgres-url> npm --prefix examples/drop-in-react run dev:lab
```

Open `/chat-lab.html?actor=alice` and `/chat-lab.html?actor=bob`, or use the actor chooser. The launcher also compiles the shared Flutter surface at `/__flutter-chat-lab/`, where the same Alice/Bob seed opens Launch planning. It does not start QA, contact a live messaging provider or deploy anything.

Files changed:

- `examples/drop-in-react/src/ChatLabApp.tsx`, `ChatLabRuntime.tsx`, `chat-lab-config.ts`, `chat-lab.css`; new `chat-lab-reply-storage.ts`.
- `examples/drop-in-react/scripts/chat-lab-backend.mjs`, `chat-lab.mjs`.
- `examples/drop-in-react/e2e/chat-lab.fixture.mjs`; new `chat-lab.reply-styles.spec.mjs`.
- `examples/drop-in-react/tsconfig.reply-styles.json` and this note.
- `src/ui/chat-workspace.ts` (optional authority forwarding only).

No canonical descriptors/templates changed and no generated contract outputs were edited.

## Repair reconciliation and newly reproduced dependencies

Fresh MCP context confirmed this work request `8b624624-d92b-4128-83a7-27971a2f6c48`, the selected running item and no Change Lane. The existing checkout needed no provisioning or recovery. Proposal `5649b94f-8a26-4507-913a-00639c18eef1` had already produced completed repair item `a5be9d03-f0b5-4e76-90cf-9be73bebe964`, work request `e53e2872-9ad0-4f51-bfc5-3ce2d8c08004`. Its uncommitted `message-context.ts` and focused tests were present at inspection and were reused without duplicate edits.

That repair separates ordinary canonical refresh from destructive source invalidation. Updating the root's `threadSummary` cancels derived context and stale requests without evicting the authorized parent message. Deletion, unavailable sources, access revocation, identity boundaries and reconnect retain their explicit cleanup and generation safeguards. Its regression suite verifies root inclusion exactly once, canonical opening, stale-response cancellation and content removal after access loss. See [runtime repair evidence](client-message-context.md).

Fresh browser execution then reproduced three downstream SDK integration omissions, fixed here:

- `src/server/create-chat-server.ts`: the detail query returned the name/lifecycle, but `projectConversationSummary` omitted both from the HTTP response. Preserve these optional canonical fields. The browser now asserts the actual detail response, not just SQL creation.
- `src/client/durable-event-reducer.ts`: thread creation parsing dropped optional metadata. Preserve it through canonical validators and retain a known lifecycle when a creation replay omits it or carries an older/equal revision. Unknown legacy metadata remains absent; malformed metadata rejects atomically. New `test/reply-thread-metadata.test.mjs` reproduced failures before this fix.
- `src/client/thread-lifecycle.ts`: check generated handshake capability `CHAT_REPLY_THREAD_FEATURES.threadLifecycle`. The former `thread_lifecycle_v1` identifies a contract family, not the advertised capability. Test fixtures now use the server's actual flag; missing/false support still disables actions. Only that fixture key changed in the existing dirty `test/thread-panel.test.mjs`; its sibling implementation was preserved.

No `normalized-cache.ts` change was needed. No descriptor/template changed; JavaScript was freshly compiled from TypeScript, with no generated contract edits.

## Browser/fixture evidence

Final command result: **1 passed in 10.0 seconds** (scenario 7.8 seconds), Chromium, one worker, zero retries. Earlier diagnostic runs each used those same worker/retry limits and are recorded separately; the passing result is `build/react-reply-resume-browser-capability.log`.

All of these assertions ran in the final single scenario:

1. Alice=Current and Bob=Discord-style remain independent saved choices. Bob sends **Friday** in the channel, and both browsers render Alice's accessible source reference through live delivery. Zero threads exist.
2. Switching with **Queued launch confirmation** retains draft text and source. A barrier holds the real HTTP POST while the production SDK's durable queue record is inspected. Switching again and releasing the real request retains the original channel/source; no implicit thread is created. Bob's preference survives reload.
3. Explicit creation opens **Launch date decision**, using the canonical SQL ID. The HTTP detail response retains name, parent/root IDs and lifecycle. Alice's original message remains visible exactly once in the parent timeline.
4. Alice's Current **Reply** opens that same canonical ID and its independently posted **Keep this discussion history** message. No second discussion is created.
5. Bob closes the thread; Alice sees the shared closed state and reopens it once. Bob sees it open. Bob selects **Leave**, then sees **Join** and the retained authorized history.
6. Channel discovery opens the same canonical thread and history. Returning to the channel preserves exactly one visible source root, and SQL still contains exactly one named thread.

The POST barrier controls timing only: it neither replaces server responses nor simulates SQL. Browser presentation and transport evidence are in `build/react-reply-resume-browser-proof.json`; its completed checkpoints are assertions, not inferred acceptance from worker status. `detailResponses` are actual HTTP reads.

Retained artifacts:

- `build/react-reply-resume-trace.zip`: successful Playwright trace (copied from the fixture's test-results directory).
- `build/react-reply-resume-mixed-replies-before-named-thread.png`: Bob's channel replies before creation.
- `build/react-reply-resume-named-thread-retained-history.png`: Alice's named panel, canonical root, shared open lifecycle and history after reopen/Leave.
- `build/react-reply-resume-browser-proof.json`: browser checkpoints and actual HTTP detail responses.
- `build/react-reply-resume-postgres-proof.json`: separate direct SQL evidence.

## PostgreSQL proof and environment

The previous run's temporary cluster/browser installation no longer existed. This run used a fresh temporary PostgreSQL **15.19**, UTF8, under `/opt/handrail/.handrail/codex-runs/314fcfaa-b33f-4f94-80bf-0521bf9a09db/tmp/reply-postgres`, loopback port **35917**, database `reply_styles`. The existing `createChatTestHarness` applied production migrations and created/dropped one isolated schema per run. No fake database or shared operator data was used. Chromium headless shell was installed with Playwright's normal installer into this run's writable temp directory.

Final schema: `handrail_chat_lab_10678dd8caf34d4cac6beaefe1d55979`.

| Identity | Final run value |
| --- | --- |
| Parent channel | `754a1ff5-d784-4a33-ba95-270662e0ed91` |
| Alice's root | `eb50540e-b9c8-4ce3-a10c-f752761bcf93` |
| Canonical named thread | `3e2c7eeb-b688-4210-aa7f-c4fd7316f72b` |

Direct queries prove Friday and the queued confirmation each persisted once in the parent channel with Alice's root reference; one thread exists with that root/name; closure became non-null and then null for the same thread; its history message remains; Bob's follow row is false while Alice's is true; saved styles remain Alice=Current/Bob=Discord. SQL snapshots are separate from the visible panel/discovery proof.

Handrail dev-service status confirmed the supervised Chat Lab was stopped. Browser tests used only their isolated loopback fixture, which closed its browsers/server and dropped its schemas. An end-of-run namespace query found no remaining `handrail_chat_lab_*` schemas. The temporary PostgreSQL server was stopped after verification. No configured dev service was restarted or modified.

## Fresh commands and results

Commands run sequentially from the SDK root unless noted; expensive tests use one worker:

| Command | Result |
| --- | --- |
| `node scripts/test-client-message-context.mjs` | Scoped production compilation, public types and **55/55** source-context regressions passed. |
| `node node_modules/typescript/bin/tsc -p tsconfig.react-reply-routing.json` | Passed; fresh UI/client/reducer output. |
| `node node_modules/typescript/bin/tsc -p tsconfig.thread-lifecycle-http.json --noEmit false` | Passed; fresh server output. |
| `node examples/drop-in-react/node_modules/typescript/bin/tsc -p examples/drop-in-react/tsconfig.reply-styles.json --noEmit` | Passed. |
| `node --test --test-concurrency=1 test/reply-thread-metadata.test.mjs test/durable-event-reducer.test.mjs` | **118/118 passed**; new metadata regressions reproduced failure before the patch. |
| `node scripts/test-client-thread-lifecycle.mjs` | Scoped compilation/public types, lifecycle and thread opening: **55/55 passed**. |
| `node scripts/test-react-thread-lifecycle.mjs` | Fresh scoped compilation and lifecycle/subscription/notification/import checks: **90/90 passed**. |
| `NODE_ENV=test node node_modules/vitest/vitest.mjs run test/ChatLabRuntime.test.tsx test/ChatLabActorSelection.test.tsx test/ChatLabShell.test.tsx --maxWorkers=1 --minWorkers=1` (example directory) | **19/19 passed**. |
| `node --check examples/drop-in-react/e2e/chat-lab.reply-styles.spec.mjs` and scoped `git diff --check` | Passed. |

Final browser command:

```sh
PLAYWRIGHT_BROWSERS_PATH=/opt/handrail/.handrail/codex-runs/314fcfaa-b33f-4f94-80bf-0521bf9a09db/tmp/playwright CHAT_LAB_DATABASE_URL=postgresql://handrail@127.0.0.1:35917/reply_styles npm --prefix examples/drop-in-react run test:browser -- e2e/chat-lab.reply-styles.spec.mjs --workers=1 --retries=0
```

Logs use the `build/react-reply-resume-*` prefix. Initial cluster launch required a persistent foreground tool session; the first fixture attempt preceded database creation. These setup failures are recorded in the initial log, not counted as application failures. Subsequent browser runs reproduced the projection, reducer and capability omissions above before the final pass.

**Separate pre-existing compile diagnostic:** the temporary harness-emission config extended `tsconfig.react-reply-routing.json` and added `src/testing/index.ts`. It emitted fresh harness JS but returned `src/testing/create-chat-test-harness.ts:193 TS2739`: `ALL_FEATURES: Required<ChatServerFeatures>` lacks `reply_style_preference_v1`, `inlineReplies`, `namedThreads`, `threadInactivity`, and `threadLifecycle`. See `build/react-reply-resume-harness-compile.log`. This unrelated typing defect remains; all touched production scopes compile cleanly. It is not this item's blocker.

## Limits and dispatcher status

The selected React demonstration is complete. This is local desktop Chromium and real PostgreSQL evidence, not mobile/deployed QA or proof of the full permissions, notifications, unread, reconnect and retry matrices. Dedicated runtime/widget tasks own those matrices; source deletion/revocation and stale asynchronous admission were checked in the focused runtime suite, not added to this small browser flow. Browser tab storage remains sessionStorage as documented above. No global checks were run.

Historical `build/chat-lab-reply-styles-*` artifacts remain unchanged and belong to earlier failed runs; do not join their IDs with this run. The canonical-root repair's own earlier evidence is preserved. No QA campaign, provider call, external send, Handrail database/queue mutation outside the authorized Owner Task ledger, deployment, commit, push or PR was performed. No Flutter preview files were modified. All source changes remain uncommitted for dispatcher review.
