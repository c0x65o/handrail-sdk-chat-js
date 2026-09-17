# Huddle real-media reference host

The intended destination is a reviewed drop-in Chat SDK for React and Flutter, before owner-approved Hitcents ERP integration. This bounded change does not declare that destination ready and does not modify ERP.

The React Chat Lab's existing WebRTC/signaling provider is also used by the Flutter backend lab through `examples/drop-in-react/src/chat-lab-flutter-media.ts`. Flutter's host adapter implements the existing provider-neutral `ChatMediaDelegate` and `ChatMediaProviderSession` interfaces. No provider dependency is added to either SDK core. Browser capture and peer audio/video playback are real; the deterministic timeline lab remains a separate in-memory fixture.

The Flutter example and Mobile Preview backend source opt in with `HANDRAIL_CHAT_LAB_BACKEND=true`. Serve the built Flutter lab through the existing same-origin Chat Lab host (`/__flutter-chat-lab/`), which supplies authenticated API, canonical PostgreSQL storage, signaling and the browser bridge module. A standalone Flutter web-server cannot supply those endpoints. The huddle button explicitly names its conversation; changing the timeline selection does not silently move an existing call. Caller-owned media survives closing the controls sheet and closes with the host. Account selectors navigate to a fresh document; native/in-place account replacement requires its own host lifecycle verification.

Media admission and each signal use existing canonical server authorization. Join material remains opaque, short-lived, single-use and absent from persistent state, query strings and reports. No authentication requirement changed: enabled rate limiting remains 10 requests per 60 seconds. Screen-share ownership is a canonical server command; it is not a claim of malicious-peer RTP enforcement. Capture denial and ownership rejection release prepared tracks. Ending or losing signaling releases peer connections and media.

The shared generated event contract accepts the server's existing operation, participant, intent and leave-reason metadata, with bounded validation. It still rejects opaque media join material. Flutter negotiates the canonical server `media` flag while honoring explicit opt-outs and the legacy huddles flag.

Flutter recovery now installs descriptor-free authorized huddle snapshots alongside recovered conversation/timeline state. Because huddle snapshots lack their own cursor, recovery brackets their read with timeline cursor checks and retries inconsistent windows without partial installation. Huddle-only denial preserves separately authorized conversation access. Ordinary HTTP/command responses update the controller without advancing the ordered reducer past queued events. Existing controller watermarks and identity generations reject superseded responses. A foreground join still awaits its private HTTP result when public realtime state arrives first; it accepts that material only for the same identity, session and participation incarnation. Optional retry-queue readiness does not cancel nonpersistent foreground commands, and the queue pump cannot settle an active foreground join as recovered. Conversely, earlier ordered events for an absent or older participant incarnation cannot erase a newly admitted same-session descriptor. Current leave, session replacement, identity reset and unauthorized hydration still release it. Consumed join-material expiry preserves controls for an already-connected, canonically joined actor. Reloaded membership can explicitly leave and join again without restoring any secret.

## Reproduction and release boundary

Use normal public HTTPS Git dependencies pinned to full SHA with matching locks. The hosts are pinned to published `dc377a84f09033d532c455c6891e0085f67ebe23` (0.1.27). During verification, external Handrail Release Bot commits advanced JS to `f01fe8d588745353ae0935efd93da647585009e5` (1.0.46), Flutter to `bdff12af7c746374ef4b06da31fbed961ee52da4` (0.1.28), and preview to `2aebf69a27aacb7a8f6a1a14c7c0d98ed7061945` (0.1.17+1). The worker did not finalize Git. This observation is not independent release approval or proof of a public push. A reviewed consumer pin/lock update and clean installation remain required; the frozen public commit does not acquire these changes. Any disposable verification overlay must be explicitly identified by base revision and per-file hashes and is not an installable release.

From the JS checkout, after version consistency verification and normal `npm run build`:

```sh
npm --prefix examples/drop-in-react run typecheck
npm --prefix examples/drop-in-react run accept:huddle-media -- /absolute/new/evidence-directory
```

The acceptance entry point uses the established disposable native PostgreSQL cluster with private Unix socket, isolated canonical schema, one browser worker and zero retries. It requires installed PostgreSQL, Chromium and the Flutter toolchain with resolved locked dependencies. Keep runtime temp paths short enough for Chromium Unix sockets. Trace capture is disabled because network traces can retain opaque join responses. Inspect bounded screenshots and sanitized SQL/RTP observations instead. Retain original failures, explicit retests, source/runtime identities and teardown receipts.

Scoped Flutter verification (sequential with other heavy checks):

```sh
flutter test --no-pub --concurrency=2 test/durable_resource_event_reducer_test.dart test/realtime_durable_recovery_test.dart test/huddle_controller_test.dart test/huddle_recovery_test.dart test/media_session_test.dart
flutter analyze --no-pub lib/src/handrail_chat_client.dart lib/src/core/huddle_controller.dart lib/src/core/normalized_snapshot_state.dart
```

The retained work-request report is the authority for actual counts, failures, images and final hashes. Commands in this document alone are not passing evidence.

## Remaining acceptance gates

Browser synthetic microphone/display capture with real ICE/DTLS/SRTP proves browser transport only. Physical microphones, native Flutter permission/revocation/background behavior, native screen capture, TURN traversal and external provider delivery remain separate checks. Reuse the existing `examples/flutter-erp` native reference app and approved provider/device handoffs; do not provision production or add a parallel service. Unsupported native screen capture must be disabled explicitly.

The existing Mobile Preview/Chat Lab managed services were observed stopped; this worker did not change their state. The independent SDK broker requires its own read-only validation work-request context (profile=sdk itself needs no enablement). The retained dependency handoff binds the candidate to those established execution paths without replacing them with a persistent raw listener.

Full Discord threads, saved settings, unread/routing, enabled notifications, files, identity/authorization, persistence/realtime and public Git consumer release checks remain in the full readiness matrix. Historical passing evidence is attributed, not silently promoted to the changed candidate. After independent full QA, the owner must approve readiness before any Hitcents ERP installation, configuration or deployment. Main retains the publication/release review boundary.
