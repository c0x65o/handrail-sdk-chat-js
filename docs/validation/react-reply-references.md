# React reply-reference rendering

Owner item: `afd29dd1-533e-4fa4-80a6-df1bfcf405ec`  
Owner goal: `0175981e-9e78-4a38-900a-e1148040c0a2`  
Verified locally on 2026-09-06 against SDK HEAD `509e29fa68e6257a583b859588832984e326dced` plus the existing prerequisite working-tree changes.

Messages with `replyTo` now show their immediate source in the timeline. This is a same-conversation reference, including within an existing thread; it does not open or create a separate thread. The existing Reply action still opens a thread, and existing thread-summary entry points remain unchanged. Selecting inline Reply by style remains the separate routing item.

## Implementation

- `src/ui/message-timeline.ts`: subscribe to the public `client.messageContext` runtime with `useSyncExternalStore`; resolve idle sources; render accessible loading, window-loading, retryable error, deleted and unavailable states. Accessible author labels are capped at 80 UTF-16 code units and source text at 240, including truncation marks. React renders both as text. No recursive source-chain lookup, raw canonical source/window data, forward snapshot, or settings dependency.
- `src/ui/slots.ts`: optional readonly `ChatReplyContextViewModel` on the message view model, exported through the existing UI wildcard export. Only `available` exposes author/preview and a bound `jump(): Promise<boolean>`; only `error` exposes `retry(): Promise<void>`. Other states expose no source author/content or jump action. Legacy slot inputs remain valid.
- `src/ui/styles.css`: bounded reference containers and wrapping buttons for narrow layouts.
- Jumps first reuse an already-loaded row. Otherwise the source runtime hydrates its bounded window; a layout effect waits for the selected rows and uses `revealMessage` and `pendingFocusMessageIdRef` to mount, reveal and focus the source. Runtime invalidation cancels pending navigation. Conversation/client scope changes, unmounts and retained host callbacks cannot focus another timeline. Escape restores the trigger or its row; deleted/unavailable references disable jumping.

## Fresh verification

Command run from the SDK repository:

```sh
node scripts/test-reply-reference-ui.mjs
```

The harness executes these sequentially, with a unique temporary output directory and no reuse or mutation of `dist`:

```sh
node node_modules/typescript/bin/tsc -p tsconfig.reply-reference-ui.json --outDir <temporary-output>
node node_modules/typescript/bin/tsc -p tsconfig.reply-reference-ui-type-tests.json
HANDRAIL_REPLY_UI_BUILD=<temporary-output-file-URL>/ node --test --test-concurrency=1 test/message-timeline-ui.test.mjs test/ui-slots.test.mjs
```

Results: production compile passed; slot typecheck passed; **61 tests passed, 0 failed, 0 skipped**. `git diff --check` also passed.

The DOM tests use happy-dom, React DOM, the real normalized cache and source runtime, and a controlled snapshot-reader boundary. Coverage includes immediate-source-only resolution, literal/long content and author labels, legacy rows and Reply/thread-summary regressions, source edits/deletion/revocation, reconnect refresh, late revoked responses, retry, safe custom-slot data/actions, bounded old-source hydration and virtual row focus, navigation failure/Escape/scope changes, retained host callbacks, and a source jump inside an existing thread. Existing timeline tests also cover mutation actions, saved messages, unread state and virtualization. Type tests verify that inaccessible states have neither source text nor jumping and that private runtime data is absent.

The new host-style test switches a host-owned Current/Discord-style configuration through the existing Message slot interface and verifies identical reference rendering without refetching. The saved SDK style runtime and settings/routing UI do not exist in these inspected interfaces yet; integration tests for those later items are not claimed here.

Existing non-reply timeline tests emit React `act(...)` warnings but pass. No unrelated failing checks were encountered in this scoped run. No global build, browser QA campaign, provider request or persistence test was run; this patch changes no SQL behavior.

The source runtime has no per-navigation abort API. Escape cancels reveal/focus; an already-started window hydration may finish. If that removes the restored trigger, focus falls back to the current timeline viewport only when focus would otherwise be lost, without focusing the source or stealing focus from another control/conversation. The cancellation-success regression covers this behavior.

## Patch and ownership

Changed for this item only:

- `src/ui/message-timeline.ts`
- `src/ui/slots.ts`
- `src/ui/styles.css`
- `test/message-timeline-ui.test.mjs`
- `test/ui-slots.test.mjs`
- `type-tests/ui-slots.test.ts`
- `scripts/test-reply-reference-ui.mjs`
- `tsconfig.reply-reference-ui.json`
- `tsconfig.reply-reference-ui-type-tests.json`
- `docs/validation/react-reply-references.md`

Preserved pre-existing client/runtime and Flutter working-tree changes. No edits to the linked preview repository. The concrete overlap with waiting Reply-routing item `5068e48e-f6ac-4337-814d-8397341787b6` is `src/ui/message-timeline.ts`; this rendering patch leaves that item's controls/routing scope intact for sequential work. No generated contracts changed. No commits, pushes, PRs, deployment, queue/database mutations, or external sends; only the explicitly requested Owner Task ledger updates. This verifies the selected rendering item, not the entire Convergence goal.
