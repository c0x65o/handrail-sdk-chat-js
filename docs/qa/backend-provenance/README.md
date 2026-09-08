# Dev backend provenance verification — 2026-09-05

The original report below records the earlier aggregate behavior and is historical.
For session-specific cleanup acceptance, see
[presence convergence](presence-convergence.md) and
[browser typing convergence](typing-convergence.md).

Finding: `7b76bb04-714b-4ba0-bd52-8e908bd92304` from campaign
`205b1fce-2ca4-4484-a545-0d52b165e05d`.

The failure boundary was stale runtime loading. Handrail still reported startup
at 2026-09-04T23:19:22.701Z; the repaired controller source and build were modified
at 2026-09-05T00:13:20.482Z and 00:13:36.294Z. The old live conversation API's
`_meta.packageVersion` was 0.1.75 despite the campaign's browser version 0.1.76.
The harness imports the Node server statically, so a browser reload cannot prove
that a rebuilt server module is loaded.

`handrail_dev_service_action(action="restart", service_id="chat-lab")` ran the
existing configured build/install/start command successfully. No project env,
queue, clock, or database configuration changed. See [runtime.json](runtime.json)
for startup, compile command, listener ownership, health, and logs.

The refreshed instance is `a4837bb57f0527273a805ad3c3ff7c88`, with backend code
fingerprint `79cee7fa07697b75b0c233affc00f11329cca29ed7ff803f231006720b33bbe4`,
captured at 2026-09-05T00:31:43.782Z after the build. The existing
`GET /__chat-lab/instance` endpoint now reports this provenance and startup logs
record it. SHA-256 hashes cover the actual loaded `createChatTestHarness`,
`createChatServer`, and `createChatEphemeralSignalController` function text.
The controller includes the shared per-owner timestamp allocator. This is scoped
loaded-code evidence, not a whole-artifact or dependency fingerprint; it excludes
closed-over module constants. It is captured once from imported functions and
cannot silently update to newer disk bytes while the process remains loaded.

[live-ephemeral.json](live-ephemeral.json) captures 13 real WebSocket events through
the supervised service's `/api/chat/_realtime` proxy. A fresh verification process
matched its disk-build imports to the live fingerprint and checked the instance
again afterward. Two Margaret sessions alternated typing and presence starts and
refreshes; a third, observing session supplied no signal support. The first
disconnect retained away presence without stopping typing. The remaining session
could still refresh both signals; its disconnect emitted typing stop and presence
offline. Across both types, each owner's `sentAt` strictly increased,
`occurredAt === sentAt`, and TTLs remained 10,000 ms / 60,000 ms. The final two
cleanup events are one millisecond apart. No shared runtime clock was changed.

An initial Ada attempt encountered another existing browser session's presence
support. The assertion correctly rejected treating that as the last supporting
session. Margaret provided an uncontaminated run without closing someone else's
browser or resetting shared data.

Checks:

- Managed `npm run build` (including TypeScript compilation): passed.
- `node --test test/websocket-ephemeral-signals.test.mjs`: 13/13 passed, including
  frozen/backward-clock cleanup regressions; [TAP output](regression-harness.tap).
- `node --test --test-name-pattern='Chat Lab serves the browser' examples/drop-in-react/test/ChatLabServer.test.mjs`:
  1/1 passed, using the existing PostgreSQL harness and isolated schema through
  `DATABASE_URL`; verifies the instance endpoint plus persisted HTTP/realtime and
  actor switching. No fake database was introduced.
- Live combined verification: all five assertions passed, 13 events recorded.
- Chromium smoke on `/chat-lab.html`: workspace visible, backend handshake version
  0.1.76, same fingerprinted instance, no page errors; [browser evidence](browser.json).
  The worker initially lacked Chromium; its matching headless shell was installed
  in run-local temporary storage before this successful check.

To repeat after another SDK build, restart the supervised service through
Handrail, then run from the SDK repo:

```sh
node examples/drop-in-react/scripts/verify-chat-lab-ephemeral.mjs \
  http://127.0.0.1:4167 /path/to/live-ephemeral.json
```

The optional fourth argument selects a fixture actor (default `grace`). Assertions are scoped to each newly created session pair. The verifier checks
the live backend fingerprint against fresh imports and fails if they differ.
It does not start a replacement server or modify the shared clock.
