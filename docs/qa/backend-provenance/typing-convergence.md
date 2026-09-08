# Session-specific typing convergence — 2026-09-05

Finding `fdd3ebec-786b-446b-8583-edffb0c60c80`, campaign
`22f4884d-0c94-4386-823a-2273c4ab980e`.

The campaign encountered stale statically imported server code, not a remaining
controller defect. The existing source already emits a stop for the departing
session on explicit stop, socket disposal, and timer expiry. The sibling presence
repair rebuilt and restarted the supervised `chat-lab` service at 17:08 UTC before
this work began. Independent service status, startup logs, and the live instance
endpoint confirmed that restart and healthy listener ownership. No additional
controller, environment, or project configuration change was necessary.

The browser verifier `examples/drop-in-react/scripts/verify-chat-lab-typing.mjs`
checks the loaded backend fingerprint against fresh disk imports before testing,
and requires the same runtime instance at completion. It opens `/chat-lab.html`,
imports the client module URL served to Chat Lab by Vite, and reduces received
browser WebSocket events with that module's `reduceEphemeralSignal`.

Coverage includes Grace A/B sessions, a third Grace observer, authorized Ada,
and an unauthorized Margaret observer. Twelve scenarios cover both departure
orders for explicit stop, disconnect, and natural 10-second server expiry, with
typing alone and with presence active. Expiry keeps both sockets open for 13
seconds and refreshes the surviving session every 2 seconds. Assertions require
an actual departing wire stop and the corresponding reducer entry, unchanged
surviving start, and zero active pair entries after the final departure. Explicit
stop/disconnect must converge before the original TTL. Private audience denial,
no leaked signals, strict per-owner timestamps across signal types, and unchanged
wire TTLs are also checked. Assertions isolate newly created session identities
so other dev users do not contaminate the result.

Run from the SDK repository with an installed Playwright Chromium:

```sh
node examples/drop-in-react/scripts/verify-chat-lab-typing.mjs \
  http://127.0.0.1:4167 docs/qa/backend-provenance/live-typing-convergence.json
```

For an existing compatible Chromium binary, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. This uses the supervised service and its
existing chat fixture data, creates only ephemeral sessions, and never changes
the shared clock or durable data. No persistence behavior is under test.

Validation results:

- Live browser verification: all 12 scenarios passed, with 96 wire events.
  [Wire events and reducer snapshots](live-typing-convergence.json) record instance
  `cdbd6cbe7f4acf741a357b46c4c42c46`, package 0.1.85, and loaded controller SHA-256
  `9ee1cc2b79509f5fcf27a01095f0590d355e147d61ea741b59eab7f67dc37fed`.
- `npm run build`: passed, including package TypeScript compilation.
- `node --test --test-concurrency=1 test/websocket-ephemeral-signals.test.mjs test/ephemeral-signals.test.mjs`:
  36 passed using the existing socket fixture and controlled clock.
- `node --check examples/drop-in-react/scripts/verify-chat-lab-typing.mjs` and
  `git diff --check`: passed.

An initial verifier run exceeded the existing 20-signals/second per-actor bucket
by executing quick cases consecutively. The verifier now spaces cases by 1.1
seconds; the complete rerun passed without changing server rate limits.
