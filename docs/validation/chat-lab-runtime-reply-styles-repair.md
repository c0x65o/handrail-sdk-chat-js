# Supplied Chat Lab reply-styles runtime repair

Work request `927504f0-aef0-43f6-b0d5-c516c8a24b51`, campaign `f5fa68a1-ab6d-45ec-9a67-92435fc2a4a1`, run `fab4ec11-1bc2-44b8-b879-f13e0e652d86`. Verified 2026-09-07 against SDK HEAD `2ea4ee695809d0a2d934347e54765b9a7bb85419`.

## Failure boundary and correction

This was a Handrail dev environment configuration mismatch. The existing source already implements the opt-in seed in `examples/drop-in-react/scripts/chat-lab-backend.mjs`, exposes `seedProfile` from `chat-lab.mjs`, and renders the mixed-style guidance/settings in `ChatLabApp.tsx`. No product-source repair was necessary.

Independent inspection found the supervised `chat-lab` service running on port 4167 in runtime scope `main`, with both `CHAT_LAB_*` settings absent from the dev env inventory. The natural instance response had instance ID `ecb0e9bb8122481bec11de75138d77d2` and omitted `seedProfile`. Its backend fingerprint matches the corrected runtime, supporting configuration mismatch rather than stale backend code as the cause.

Applied through `handrail_request_configuration_approval` (both automatically approved under the non-production env-var policy):

| SDK dev setting | New value | Approval request |
| --- | --- | --- |
| `CHAT_LAB_DATABASE_URL` | `postgresql://127.0.0.1:34680/handrail_chat_reply_styles_fab4ec11` | `138fa981-94af-4380-9d45-df90287bbded` |
| `CHAT_LAB_SEED_PROFILE` | `reply-styles` | `2b37c4fb-fa89-4921-8dfc-9077ecdb8773` |

Created the dedicated empty test database on the project's existing `handrail-chat-db` dev PostgreSQL resource. The URL uses its already-injected `PGUSER`/`PGPASSWORD`; no credentials were copied into source or tool arguments. The application database was not reset or migrated. The existing production migration/test harness owns a separate schema per lab instance in the new database. No Vault provisioning was needed.

Restarted the existing service through `handrail_dev_service_action`. Its existing startup command successfully ran the SDK build, example dependency install, and `dev:lab`. Preserved the service ID, port, dev proxy and `main_dev` selection. No replacement loopback server, target change, production deployment, commit, push, or PR was used. The build's incidental generated package-version source change was restored; compiled runtime output remains current.

## Verification

- Supervised startup: `npm run build` passed, including `tsc --project tsconfig.json`. Handrail reported listener ownership, route registration, health and readiness successful. Dev logs showed no errors.
- Scoped example compile: `node examples/drop-in-react/node_modules/typescript/bin/tsc -p examples/drop-in-react/tsconfig.reply-styles.json --noEmit` passed.
- Live Chromium scenario: `build/chat-lab-runtime-repair-verify.mjs` passed against **the supplied port 4167 service**, with one browser and no mocks. At 08:44:52–08:44:56 UTC, it checked natural instance metadata, chooser Alice/Bob, guidance, channel/root, saved mixed styles and zero threads. Bob selected Reply, sent **Friday**, and selected Create Thread to create **Launch date decision** without a reload, navigation, actor switch, or style switch between those actions. SQL confirmed Friday's parent destination/source and zero threads after Reply, then one canonical named thread. The panel opened and the parent root remained visible exactly once. No browser exceptions or HTTP 5xx were observed.
- A preliminary browser attempt used the wrong ARIA role for the chooser and stopped before sending. Corrected the verifier to the existing `option` role; the successful sequence above is uninterrupted. Its failure screenshot is kept separately.
- After preserving the flow evidence, restarted once more to supply a fresh initial scenario. Read-only SQL plus separate Alice/Bob browser contexts verified the fresh root, Alice=Current, Bob=Discord-style, guidance, and zero threads. The prior scenario's schema remains in the dedicated test database as historical test data; assertions target the new schema and correlate its root ID with the visible browser root.
- `node --check build/chat-lab-runtime-repair-verify.mjs` and `git diff --check` passed. No Flutter files changed; the suggested Flutter reducer test is unrelated to this runtime configuration correction.

Browser command used from the SDK root (requires the configured dev env file and installed Chromium):

```sh
PLAYWRIGHT_BROWSERS_PATH=/opt/handrail/.handrail/codex-runs/fab4ec11-1bc2-44b8-b879-f13e0e652d86/tmp/playwright node --env-file=.env build/chat-lab-runtime-repair-verify.mjs
```

The retained verifier captures this run's original single-schema fixture. It deliberately rejects reused/multiple schemas; do not blindly rerun it against the handoff database's historical schemas. The handoff JSON below identifies the current schema explicitly.

## Fresh browser handoff

- Target: `main_dev` / service `chat-lab` (`812c4054-6ced-4616-94fb-13f672b3e897`).
- Loopback: <http://127.0.0.1:4167/chat-lab.html?actor=bob>.
- Existing Handrail browser proxy: <https://h-57a5c33bac91a8de.dev.handrail-daas.com/chat-lab.html?actor=bob>.
- Natural instance: `a76c8ed1e87191f2f8bc7668eb2d629a`, `seedProfile=reply-styles`, backend captured at `2026-09-07T08:45:35.259Z`.
- Schema: `handrail_chat_lab_0d5d8faccdb64f55b0278efb1d24193c`.
- Channel: `3142dec4-d0d7-4c9a-aa09-c024ed989f1b`; Alice root: `f68384db-d165-491e-b06c-396aaf97c5b7`.
- Verified at `2026-09-07T08:46:58.858Z`: exactly one seeded message, zero threads, saved mixed styles. No reply or thread was created in this fresh instance.
- Existing service TTL expires at `2026-09-07T09:15:29.031Z` unless Handrail keeps it alive. Configuration persists; a supervised restart recreates the fixture with new IDs.

## Preserved evidence

Fresh evidence is under `build/chat-lab-runtime-repair-`: `proof.json`, `browser.log`, `trace.zip`, `actor-chooser.png`, `initial.png`, `inline-reply.png`, `named-thread.png`, `failure.png`, `handoff.json`, `handoff-alice.png`, `handoff-bob.png`, and the verifier source. The uninterrupted-flow instance and final clean handoff have distinct IDs; do not merge their records.

Reviewed both campaign screenshots supplied in the work request: default channels/root and the Ada/Grace/Margaret chooser confirm the scenario mismatch, and do not establish a root-retention product regression. Original campaign references are preserved below. The runner's resolved attachment directory does not exist, so the JSON attachment bytes could not be independently opened; their summaries were supplied by the work request. New live HTTP, SQL and browser evidence independently confirm and verify the corrected failure boundary.

| Original campaign artifact | API artifact reference | Supplied SHA-256 |
| --- | --- | --- |
| `01-target-initial.png` | `/api/pm/qa-campaign-artifacts/8fbe9e96-3060-4f00-bf23-981a8be95d30/content` | `8c06c36f998c0423b6c0b4ccd8d49c61bf5ae6b28ef874c6ba0b7525fba72db9` |
| `02-actor-chooser.png` | `/api/pm/qa-campaign-artifacts/c4aead56-3240-41cb-b046-15fb20ddb0f0/content` | `dca9d6d0e9afcb159d02c713a34f16810a4f5bead09c300e1ff121d8e4feaaa6` |
| `browser-assertions.json` | `/api/pm/qa-campaign-artifacts/545acd30-9f32-4e93-877a-0fd81ceb7875/content` | `12721036f7d2c45a39ada7fab8df3ab215164a4361f373556462373d176eaef3` |
| `runtime-provenance.json` | `/api/pm/qa-campaign-artifacts/5d4e348e-7808-4525-bf7f-63f9fc6b24e8/content` | `6a6a6bc5fd5fddbc6f796e2cdf66fc4a74e62c6fd6bc940e2767ffa863394d4a` |

All four original artifact names are relative to `campaigns/f5fa68a1-ab6d-45ec-9a67-92435fc2a4a1/`. Original campaign outcome remains historically blocked; this work ran direct acceptance verification and did not alter its database/queue records or launch a replacement QA campaign.
