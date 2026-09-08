# Dev runtime refresh — 2026-09-05

Work request `9f0776c0-882d-4d40-b396-3fa8d1c617d9`, accepted finding
`19db3c90-26af-419e-928a-f757b91e84a8`, campaign
`4f0da78a-f0b6-4c05-8668-2c664558dc80`.

The failure boundary was independently reproduced before repair: the supervised
service was healthy, but only its loaded `createChatEphemeralSignalController`
hash differed from fresh disk imports. Static backend imports outlived later
builds; client reloads in the dev logs did not replace those imports. Package
0.1.85 was identical on both sides and did not establish code identity. The exact
old source revision remains unknown.

[Before identity](before.json) and [verifier failure](before-verifier.log) capture
the original instance `cdbd6cbe7f4acf741a357b46c4c42c46`, with combined fingerprint
`55d9416b335084a427fb561c795914fdc00bcf9ce9c62d5c34d0b7abe871bcf2`.
The existing verifier exited 1 at its provenance assertion before live sessions.

This approved environment repair used
`handrail_dev_service_action(action="restart", service_id="chat-lab")`.
The existing service command rebuilt the SDK, installed the example dependencies,
and started the supervised runtime. [Restart evidence](restart.json) records
verified listener ownership, health and route registration;
[startup logs](startup.log) record the successful TypeScript build and loaded
provenance. No application source or project configuration edits were needed.
Existing workspace changes from other tasks were preserved.

The refreshed instance is `078f5aaed6edb66b745bedc12cf58466`, captured at
2026-09-05T18:00:28.173Z. Its controller hash is
`a4e453f8cbef00aafe8e4e823a61c5db3bfde13746b654c81e6f51d4efbd0f82`;
its combined fingerprint is
`1718af4125020f27a5723a68be740c7461981cd64f304715c5544b36dd49a473`.
Both match the completed disk build observed before restart. The server and
harness hashes also match individually in [final identity](after.json).
The repo HEAD was `fb3b3ad7b20196f1581708c8a19d8ecf032c0dcb` with existing
uncommitted controller/test changes; HEAD alone does not identify this build.

Validation from the SDK root:

- Managed `npm run build`: passed, including `tsc --project tsconfig.json`.
- `node examples/drop-in-react/scripts/verify-chat-lab-ephemeral.mjs http://127.0.0.1:4167 docs/qa/dev-runtime-refresh-2026-09-05/live-ephemeral.json`:
  passed all nine checks and recorded 40 wire events in [live evidence](live-ephemeral.json).
  Covers both departure orders for explicit offline, disconnect and natural
  60-second expiry, survivor preservation, final cleanup, private audience
  isolation, per-owner timestamps and TTLs. The verifier compares the full
  instance identity before and after its sessions; both are the refreshed
  instance. A separate fresh process afterward also matched every function hash
  and the combined fingerprint. A restart necessarily changes the old instance.
- `node --test --test-concurrency=1 test/websocket-ephemeral-controller.test.mjs test/websocket-ephemeral-signals.test.mjs`:
  28/28 passed; [TAP evidence](regressions.tap). The completed owner-queue tests
  prove stalled publishers cannot block another tenant or another session of the
  same actor, same-owner order is preserved, drain includes newer queue tails,
  and publisher rejection allows queued work and disposal to recover. The live
  transport check above does not inject publisher stalls; these focused tests
  supply that separate regression evidence.

The controller tests use the existing narrow publisher/clock fixtures; the
WebSocket tests use the existing transport fixture. They do not prove database
persistence. Live verification uses the supervised Chat Lab's existing session
and conversation endpoints, real WebSockets and timers, without durable writes
or clock changes.

Startup logs also contain draft/reaction 503 outcomes. These were not produced
by the ephemeral verifier and are outside this provenance repair; they remain
separate evidence for follow-up if those workflows fail. Future SDK rebuilds
still require a supervised restart before provenance-dependent QA.
