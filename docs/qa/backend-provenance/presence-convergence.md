# Session-specific presence convergence — 2026-09-05

Finding `3c404967-ad90-4bac-a309-9ca33f83b376`, campaign
`22f4884d-0c94-4386-823a-2273c4ab980e`.

Independent inspection confirmed stale runtime loading: the live instance
`b4f7f29d592e794ecd5d1d3120239450` reported controller hash
`ed1f948c7fb8b5bff408ee016df0351c4642b40ea0923ae957877430d1ddf129`.
The workspace already contained the session-specific typing/presence cleanup
patch and its regression tests. Recent service logs showed client reloads and
no service errors; client reloads do not reload statically imported server code.
No additional production controller change was needed.

The existing live verifier still asserted aggregate cleanup (survivor away,
no departing typing stop). It now exercises the actual client ephemeral reducer
and requires departing-owner offline, an unchanged surviving entry, and zero
active entries after final removal. It covers A online/B away in both orders,
explicit offline, combined typing/presence disconnect, and independent natural
60-second expiry with peer refreshes every 15 seconds. Expiry sockets stay open
for 63 seconds. It also checks private audience denial/isolation, per-owner
strict timestamp order across signal types, wire TTLs, and stable runtime identity.

After the package build and focused tests, the supervised `chat-lab` service was
restarted using `handrail_dev_service_action`. Its configured startup rebuilt the
SDK and loaded controller hash
`9ee1cc2b79509f5fcf27a01095f0590d355e147d61ea741b59eab7f67dc37fed`.
The build also synchronized generated client package metadata to package.json's
existing version 0.1.85. No environment or project configuration change was needed.

Validation:

- `npm run build`: passed, including package TypeScript compilation.
- `node --test --test-concurrency=1 test/websocket-ephemeral-signals.test.mjs test/ephemeral-signals.test.mjs`: 36 passed.
- Live verification: all six departure/expiry scenarios plus fingerprint, privacy,
  and timestamp checks passed (40 wire events). Report: [live-presence-convergence.json](live-presence-convergence.json).

Repeat from the SDK repository after rebuilding and restarting the supervised service:

```sh
node examples/drop-in-react/scripts/verify-chat-lab-ephemeral.mjs \
  http://127.0.0.1:4167 docs/qa/backend-provenance/live-presence-convergence.json grace
```

This takes slightly over two minutes and uses real WebSockets and server timers.
It creates ephemeral sessions only; it does not write durable chat data or change
the shared clock. The focused regression tests use the existing WebSocket fixture
and controlled clock; they do not attempt to prove database persistence behavior.
