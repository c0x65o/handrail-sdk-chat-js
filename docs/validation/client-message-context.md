# TypeScript source-context runtime

Implemented selected Owner Task item `d9158264-ac1b-423b-86f7-f7aec9fa7f42` under goal `0175981e-9e78-4a38-900a-e1148040c0a2`. Inspected SDK HEAD `509e29fa68e6257a583b859588832984e326dced` before editing.

The existing `openThread` behavior is unchanged. The new headless `client.messageContext` resolves a reply source and selects its surrounding messages in the **same conversation**, including when that conversation is already a thread. It does not create/open threads or change reply composition, settings, drafts, or send destinations.

## API and behavior

The client entry point exports `ChatMessageContext`, `ChatMessageContextState`, and the canonical context contract. Given a `MessageContextRequest` containing only `conversationId` and `messageId`:

- `resolve(target)` shares in-flight work and caches a strictly parsed result for the current session/authorization generation.
- `loadSourceWindow(target)` shares the lookup, then fetches one backward/before page and one forward/after page with exclusive source-sequence cursors and a fixed limit of 25 each. The canonical source is inserted once between the pages. Attachment sources require one additional bounded `after: sequence - 1, limit: 1` read for attachment transport metadata; the row must still match the source identity and revision. No scan or cross-conversation fallback occurs.
- `getState(target)` and `subscribe(target, listener)` expose idle, loading, loading_window, available, deleted, unavailable, and error states. `retry(target)` repeats the last requested operation with the same IDs.
- Successful deleted/unavailable responses remain redacted and do not load adjacent pages. HTTP, authentication, network, malformed body, and stale-source failures remain errors. Only a parsed HTTP 200 body establishes unavailable.
- A jump atomically selects a contiguous cache timeline window using the older page's older cursor and the newer page's newer cursor. This avoids merging extrema across an unloaded gap to the latest timeline. Other canonical entities remain cached, and pending sends remain visible. A subsequent source jump supersedes a delayed previous window in that conversation.
- Context and window admission check actor, tenant, session identity, authorization generation, and source generation before hydration. Canonical edit/deletion events cancel pending work even for uncached neighbours. Cache changes, membership changes, parent revocation, identity boundaries, reconnect, and client close are wired into actual client paths, including canonical events received through cross-tab coordination.
- Reconnect purges prior context/window content and sequentially revalidates requested targets. Actor/tenant switches reset requested targets instead of automatically reading the previous account's selections. Explicit revocation remains denied until a new identity/cache boundary; when conversation ancestry is unknown, revocation conservatively invalidates that target.
- Source previews live only in runtime state and the existing normalized message cache. No preview fields are added to `replyTo`, drafts, queued intents, or persistence schemas.

## Deterministic checks

Checks ran sequentially, with one Node test worker, using local HTTP/WebSocket boundary doubles and the production client/cache/transport implementations. No SQL or fake database was used.

| Exact command | Result |
| --- | --- |
| `node scripts/test-client-message-context.mjs` | **42 passed**. Compiles `tsconfig.client-message-context.json` into a unique fresh directory, typechecks `tsconfig.client-message-context-type-tests.json`, runs the focused suite with `--test-concurrency=1`, and removes its compiled output. |
| `node scripts/test-client-thread-lifecycle.mjs` | **55 passed**, including legacy thread-opening regression tests; fresh production compilation and existing public API typechecks passed. |
| `git diff --check -- src/client/create-chat-client.ts src/client/index.ts src/client/normalized-cache.ts src/client/snapshot-reader.ts` | Passed. |

The scoped compile includes all five production files changed through the public client entry point and its imported production graph. Tests cover old-source lookup outside the loaded window; request sharing; bounded exclusive cursors; source inclusion once; disjoint navigation; source edit/deletion and parent revocation before late context/page responses; actor/tenant isolation; stale revisions; attachment enrichment; reconnect and retry; redacted deleted/unavailable bodies; malformed/failed responses; actual client WebSocket lifecycle paths; and draft/queued reply destination preservation. Public type tests reject copied preview input and thread-opening calls on this API.

An added malformed-page test initially exposed the existing timeline parser accepting null content without deletion metadata. The source runtime now additionally validates each canonical row using the strict context parser before cache admission; the final 42-test run passed. No unrelated failures were encountered in the scoped checks.

## Files and limits

Owned files:

- `src/client/message-context.ts`
- `src/client/create-chat-client.ts` (additive wiring)
- `src/client/index.ts` (additive exports)
- `src/client/snapshot-reader.ts` (authenticated context read)
- `src/client/normalized-cache.ts` (window selection and context purge actions)
- `scripts/test-client-message-context.mjs`
- `test/client-message-context.test.mjs`
- `type-tests/client-message-context.test.ts`
- `tsconfig.client-message-context.json`
- `tsconfig.client-message-context-type-tests.json`
- `docs/validation/client-message-context.md`

No canonical descriptors/templates or generated outputs changed. Existing and newly appearing Flutter discovery/source-context sibling work was preserved. No other TypeScript writer modified the shared integration files during this item.

This verifies repository-local runtime behavior, not server authorization or deployed end-to-end behavior. UI, saved style policy, Flutter parity, discovery, and thread creation remain separate checklist items. Source context itself does not include reaction aggregates; non-attachment source rows use empty reaction metadata, so this lookup alone does not establish their reaction counts. No full-project suite, QA campaign, external provider call, deployment, commit, push, or PR was performed.

## Canonical root retention repair — 2026-09-07

Selected item `a5be9d03-f0b5-4e76-90cf-9be73bebe964`, work request `e53e2872-9ad0-4f51-bfc5-3ce2d8c08004`, inspected HEAD `e14618bd39933a7d7ab57240dc460226dcd2eef2`.

Previously, resolving an inline reply source registered its message ID for context cleanup even when the source came from the ordinary channel timeline. Named-thread reconciliation replaced the root object with its current `threadSummary`; context invalidation then dispatched `messages/forget-context`, deleting that authorized root. Fresh deterministic reproduction failed three new retention assertions before the production patch, while all original 42 tests passed.

Ordinary source/membership refresh, canonical edits, retry, and source-window navigation now discard derived context results/windows and abort their request generation without evicting authorized canonical messages. Destructive cleanup remains explicit for deletion/removal, deleted/unavailable lookup results, access loss, identity/private-state boundaries, connection revalidation and close. Existing failure cleanup, including authentication failure, remains in place. An older source revision is rejected without deleting a newer cached source. Tracked source/window IDs survive harmless invalidation and accumulate across window reloads so subsequent revocation also purges content from earlier windows.

The production change is confined to `src/client/message-context.ts`; `normalized-cache.ts` and `create-chat-client.ts` were inspected and need no change. The cache reducer continues protecting optimistic messages and retaining equal/newer canonical revisions. Existing Current-mode `openThread` behavior remains available; inline source lookup still creates no thread, while explicit named creation reconciles and reopens the same canonical thread.

Fresh checks ran sequentially with bounded workers:

| Exact command | Result |
| --- | --- |
| `node scripts/test-client-message-context.mjs > build/client-message-context-root-retention-before.log 2>&1` | Before production patch: compilation and public typechecks passed; 43/46 tests passed, three new tests reproduced root eviction. |
| `node scripts/test-client-message-context.mjs > build/client-message-context-root-retention-after.log 2>&1` | Final: fresh production compilation and public typechecks passed; **55/55 tests passed**, one Node test worker. |
| `node scripts/test-client-thread-lifecycle.mjs > build/client-message-context-thread-opening-check.log 2>&1` | Fresh production compilation, public typechecks, lifecycle and existing thread-opening regressions: **55/55 passed**, one Node test worker. |
| `git diff --check -- src/client/message-context.ts test/client-message-context.test.mjs docs/validation/client-message-context.md` | Passed. |

Added tests use production normalized cache notifications, snapshot readers and client thread opening with HTTP boundary doubles. They cover ordinary channel root resolution and loaded windows followed by named creation, root inclusion exactly once with the reconciled summary, reopening without another creation request, delayed lookup/page cancellation across refresh, deletion/unavailable/authentication/actor/tenant purges after refresh, parent revocation after membership refresh and window reload, and rejection of older revisions without root eviction. Existing draft and queued destination assertions remain and now also run immediately after canonical refresh. The existing edit-event fixture was corrected to place edit metadata in `revision`, as required by the canonical contract; its HTTP context response now reflects the refreshed revision. No unrelated failures remained in these scoped checks. No SQL persistence was exercised by this patch's tests.

Historical artifacts were read, not changed or treated as fresh QA: `build/chat-lab-reply-styles-root-eviction.log` records `reconcileThreadOpening -> invalidate -> purge`; `build/chat-lab-reply-styles-postgres-proof.json` records one thread for root `52fdaa78-745a-43b6-8b08-d4ef0061186a`; `build/chat-lab-reply-styles-thread-response.json` reports `created` for a different root, `ca078c05-54b1-4b1e-9259-b6449c787778`. Those fixtures are separate runs and must not be joined by ID.

**Browser acceptance remains required.** The dispatcher should request fresh dev QA after this patch is available: Alice posts “Which launch date?”; Bob replies inline “Friday” in the same channel, then explicitly creates “Launch date decision.” Verify the root stays visible once, the named panel opens, and closing/reopening uses the same canonical thread. Capture the creation response, root/thread identities, visible parent root and opened panel; link the resulting QA campaign to this repair. Deterministic passes and historical SQL/browser artifacts do not establish browser acceptance. This worker did not run browser QA or mutate runtime/configuration.

Only the runtime, focused test, and this validation document were edited, with uniquely named validation logs under `build/`. Sibling Chat Lab, UI, notification and Flutter work was preserved. No commit, push, PR or deployment was performed.
