# Flutter in the shared Chat Lab

`npm --prefix examples/drop-in-react run dev:lab` builds and serves Flutter at
`/__flutter-chat-lab/` alongside the TS lab at `/chat-lab.html`. Both use the
same `/api/chat` backend, tenant, fixture actor session endpoint, and managed
realtime protocol. No production credentials or separate Flutter backend are
required. Rebuild an already running host's Flutter assets with
`npm --prefix examples/drop-in-react run build:flutter:lab`, then reload the tab.
The running host does not watch Dart inputs: source edits alone do not refresh
the compiled Flutter implementation. Before attributing acceptance results to
the current checkout, check the executing program's embedded input digest:

```sh
cd examples/drop-in-react
FLUTTER_CHAT_LAB_ORIGIN=http://127.0.0.1:4167 npx playwright test e2e/flutter-provenance.spec.mjs --project=chromium
```

This check only exports runtime evidence through the existing lab bridge. It
attaches the export and current input fingerprints even when they differ, and
fails on stale builds or inputs changing during verification. A different Git
revision alone does not fail the check when the Flutter input digest matches.

Flutter reads the backend's seed profile before choosing an actor or conversation.
The default seed selects Grace and resolves **Chat Lab General** from her authenticated
conversation list. Select Ada, Grace, or Margaret in the actor control, or use
`?actor=grace&conversation=<backend-conversation-id>` to select an exact parent.
An unknown actor or inaccessible conversation fails visibly. Actor changes reload
the engine, discarding the previous actor's cache and cursor. Backend instance
changes also reload the engine, matching the TS lab's instance isolation.

With `CHAT_LAB_SEED_PROFILE=reply-styles`, the same launcher also builds Flutter;
Flutter defaults to Alice and opens **Launch planning**. The chooser offers Alice,
Bob, Carol (absent reply preference), and Dave (observer with denied thread actions).
Direct links use `/__flutter-chat-lab/?actor=alice` (or `bob`, `carol`, `dave`).
The profile comes from `/__chat-lab/instance`,
so no separate Flutter seed define is needed. Requests wait for compilation;
a failed build reports unavailable assets instead of serving an older build.

See [reply-style campaign prerequisites](validation/reply-style-seed-prerequisites/README.md)
for group participants, the inactivity-policy control and the on-demand archived
history fixture shared by both clients.

The existing deterministic timeline fixture remains at `?fixture=1`; the storage
harness remains at `?sharedStorage=1`. Running the example without the build
script's `HANDRAIL_CHAT_LAB_BACKEND=true` define also retains the timeline fixture.
The new mode is a browser dev entry point, not a native deployment configuration.

## Capture thread-summary evidence

Keep Flutter on the parent while the TS actor creates a thread and sends replies.
**Capture state** reads the normalized cache without issuing snapshot requests or
opening the thread. **Disconnect** and **Reconnect** exercise the public managed
session lifecycle while retaining its cache, subscriptions, and replay cursor.
**Export evidence** downloads the last 100 captures and current state as JSON.
Managed snapshot recovery also captures state automatically before hydration.

The dev-only `window.handrailBackendLab` bridge accepts a JSON string and returns
a promise of JSON text. Browser QA can use:

```js
const call = async (operation, args = {}) => JSON.parse(
  await window.handrailBackendLab(JSON.stringify({ operation, ...args })),
);
await call('capture', { label: 'before-thread-hydration' });
await call('suspend');
// Send more replies from TS while Flutter remains on the parent.
await call('reconnect');
await call('capture', { label: 'after-reconnect-before-hydration' });
await call('hydrate', { conversationId: parentId }); // Explicit GET comparison.
const evidence = await call('export');
```

Captures include authenticated identity when connected, backend instance and
conversation IDs, hydrated timeline IDs, canonical and projected summaries for
the selected parent, accepted replay cursor, snapshot timeline cursor, durable
stream metadata, sanitized SDK diagnostics, and compiled source provenance.
The snapshot timeline cursor is the last GET baseline; the accepted replay cursor
advances with managed realtime. Cursors are engine-local, so page reload never
resumes a cursor against an empty normalized cache. Explicit hydration uses the
SDK timeline controller without navigating away from the parent. Hydrating the
parent provides a fresh canonical summary without joining or opening its thread;
directly hydrating an unauthorized thread ID correctly fails authorization.
The hydration result includes the public SDK `hydrationStatus` and
`hydrationError`, retaining failed reconciliation attempts as evidence too.

Real-backend startup also exercises two compatibility fixes: Dart snapshot
parsing preserves the list's boolean `hasActiveHuddle` enrichment, and same-actor
reconnects retain in-memory snapshots when the server assigns a new ephemeral
device ID. Tenant/user switches and persisted device boundaries still clear the
previous cache.

## Verification

After building Flutter, run:

```sh
cd examples/drop-in-react
npx playwright test e2e/flutter-backend-lab.spec.mjs --project=chromium
```

This uses the existing Chat Lab PostgreSQL harness with an isolated schema and
cleanup (`TEST_DATABASE_URL`/`CHAT_LAB_DATABASE_URL`, or its Docker fallback).
To capture an already served campaign environment instead, prefix the command
with `FLUTTER_CHAT_LAB_ORIGIN=http://127.0.0.1:4167`. That mode adds test messages
to the selected dev General conversation.

The test requires canonical and projected reply counts of one after a live
reply and two after a reply during disconnect, while Flutter never hydrates the
thread. Explicit parent hydration must return `ready` with no normalization error
and leave the summaries unchanged. Repeated reconnect/hydration must be
idempotent. JSON/screenshot evidence is exported even when an assertion fails.
See [parent reconciliation evidence](parent-timeline-reconciliation.md) for the
focused snapshot/replay regression and source provenance.
