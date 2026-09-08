# React ThreadPanel lifecycle controls

Implemented against `main` at `e14618bd39933a7d7ab57240dc460226dcd2eef2` on 2026-09-07. The checkout was clean at inspection; the named-thread and discovery changes from the handoff were already present in HEAD. Only this React lifecycle item was changed. Shared styles, ChatWorkspace, Flutter and preview sources were left untouched.

## Behavior and host contract

Closing the panel dismisses a local view and restores focus to its opener. It never closes the shared discussion. The icon's default accessible label is **Close panel**; `closeLabel` still overrides it. Escape and unmount issue no lifecycle command.

The separate **Close thread**, **Reopen thread**, **Lock thread** and **Unlock thread** buttons observe `useThreadLifecycle(threadId, parentConversationId)` from the public React entry point. Canonical lifecycle changes apply equally to Current and Discord-style presentation. Lock closes and blocks sends; unlock leaves the discussion closed. An authorized send into an unlocked closed thread uses the normal send command, with no preceding explicit reopen. History, follow and unread semantics are preserved.

`ThreadPanelProps.lifecycleAvailability` is a narrow, explicit host authority projection:

```tsx
<ThreadPanel
  rootMessageId={rootMessageId}
  lifecycleAvailability={{ canManage: authorizedToManage, canSend: authorizedToSend }}
  composerAvailability={composerAvailability}
/>
```

Both flags default to unknown for action visibility. Hosts must resolve them for the current thread and parent and update them when authority changes. `canManage` represents the existing thread owner/moderator or host `thread.manage` policy plus access checks; a parent role does not automatically transfer. `canSend` represents the existing message-send authority, including any host thread-send restriction. The runtime's `actionsAvailable` is an additional readiness gate, not permission evidence. Neither reply style nor following grants authority. The server remains final authority.

Omitted authority hides lifecycle mutation controls without removing legacy sending. Explicit `canSend: false`, existing `composerAvailability` restrictions and `readOnly` remain restrictive. Lock and administrative archive of either the thread or parent also disable the composer and inline Reply controls, including pointer and keyboard sends. Missing lifecycle metadata retains legacy open/unlocked sending and hides unsupported controls.

The same composer remains bound to its original destination during lock/archive, style changes, errors and conflicts. On access denial the runtime purges thread history; the panel retains only destination IDs. The existing composer temporarily shows its unavailable renderer when conversation metadata is purged, while retaining its internal draft, reply and attachment state. A later metadata snapshot reveals the retained draft but cannot override the runtime's access denial. Retry uses the runtime retry operation, preserving the original intent, revision and idempotency key.

Lifecycle controls reuse the existing wrapping controls styles and stay in the controls row, preserving the timeline's flexible grid row. Loading, unavailable, pending, denial, conflict and retry feedback use status/alert regions and native buttons.

## Exact verification

`node scripts/test-react-thread-lifecycle.mjs` — passed:

- Fresh production TypeScript compilation using `node node_modules/typescript/bin/tsc -p tsconfig.react-reply-routing.json --outDir <isolated temporary build directory>`.
- **75 tests passed, 0 failed, 0 skipped**: 52 ThreadPanel DOM tests (all 30 existing regressions plus 22 focused lifecycle cases), 22 client lifecycle tests, and the unchanged public-import guard.
- Tests import this invocation's compiled output, not stale `dist`. The runner uses `--test-concurrency=1` and a 15-second test timeout, compiles before testing, and removes its temporary compiled output afterward.
- DOM cases cover dismissal/focus/Escape and custom labels; supported/unsupported and independent manage/send authority; close/reopen/lock/unlock; pending duplicate suppression; transport/read retry and conflicts; exact original retry identity after remote events; remote lock and thread/parent archive; retained text/reply/attachments/destination; eligible restoration; read-only and host restrictions; Current/Discord-style switching; root-linked and discovery-opened panels at a compact viewport.

`git diff --check` — passed. Full test output is in `build/react-thread-lifecycle-results.log`.

## Scoped limits

Verification is deterministic local DOM/runtime testing, using the real lifecycle and reply-style runtimes and normalized cache with narrow snapshot/command boundary stubs. It does not prove PostgreSQL persistence, live server authorization, browser layout, deployed behavior or Flutter. No QA campaign, provider request, external send, deployment, commit, push or PR was performed. Host integrations must supply the explicit authority projection to expose mutation controls; the default hides them. Existing runtime tests emit the pre-existing `react-test-renderer` deprecation notice.
