# Huddle real-media reference host

The intended destination is a reviewed drop-in Chat SDK for React and Flutter, before owner-approved Hitcents ERP integration. This bounded change does not declare that destination ready and does not modify ERP.

The React Chat Lab's existing WebRTC/signaling provider is also used by the Flutter backend lab through `examples/drop-in-react/src/chat-lab-flutter-media.ts`. Flutter's host adapter implements the existing provider-neutral `ChatMediaDelegate` and `ChatMediaProviderSession` interfaces. No provider dependency is added to either SDK core. Browser capture and peer audio/video playback are real; the deterministic timeline lab remains a separate in-memory fixture.

The Flutter example and Mobile Preview backend source opt in with `HANDRAIL_CHAT_LAB_BACKEND=true`. Serve the built Flutter lab through the existing same-origin Chat Lab host (`/__flutter-chat-lab/`), which supplies authenticated API, canonical PostgreSQL storage, signaling and the browser bridge module. A standalone Flutter web-server cannot supply those endpoints. The huddle button explicitly names its conversation; changing the timeline selection does not silently move an existing call. Caller-owned media survives closing the controls sheet and closes with the host. Account selectors navigate to a fresh document; native/in-place account replacement requires its own host lifecycle verification.

The real-media Lab opts into `webSocket.leaveHuddlesOnDisconnect=false`. The compatible server default remains true. Chat recovery or closing another device's chat socket must not evict media participation. The reference provider now owns canonical disconnect cleanup as well as explicit Leave/End. It captures the authenticated actor, canonical huddle session and exact PostgreSQL `joined_at` at grant issuance. Admission and subsequent authorization require that incarnation. Last-peer loss releases participation and share ownership through the existing durable leave command, including after access revocation. SQL checks the trusted optional `expectedJoinedAt` under the huddle lock before mutation or idempotent replay. HTTP callers cannot supply this fence or choose the leave reason.

The host serializes room admission, credential issuance and cleanup. Duplicate callbacks reuse one server-generated cleanup identity. Another authenticated media peer for the same user/incarnation preserves that user's canonical participation and ownership; an unrelated chat socket never owns cleanup. Canonical share ownership remains user-scoped, with no claim of per-device share attribution. No client packet names the actor or owner to clean up. A later Leave→Join has a different SQL timestamp, including microseconds, and is protected from old cleanup.

The bounded single-process policy uses a 5-second protocol ping/pong and authorization sweep, a 1-second disconnect grace and 60-second unused-grant expiry. With a responsive event loop and PostgreSQL, observed close is eligible within 6 seconds, silent loss within 15 seconds, permission revocation within 10 seconds, and an unconsumed grant within 65 seconds. A newer outstanding grant defers cleanup until admission or expiry; a surviving peer keeps it alive. Storage errors retain the same cleanup record for retry on the next sweep, so these are healthy-runtime bounds, not an outage SLA. Graceful provider shutdown drains canonical cleanup while storage is still available. There are no unload-dependent writes.

This policy belongs to the disposable reference host, whose schema lifetime belongs to the Lab harness. It does not provide distributed leases or recovery after abrupt loss of the whole signaling host and its in-memory grant registry. A durable/multi-instance production provider must supply and verify that separate policy before adoption. Browser process termination and live-host provider/signaling loss are the bounded checks here.

Media admission and each signal use existing canonical server authorization. Join material remains opaque, short-lived, single-use and absent from persistent state, query strings and reports. No authentication requirement changed: enabled rate limiting remains 10 requests per 60 seconds. Screen-share ownership is a canonical server command; it is not a claim of malicious-peer RTP enforcement. Capture denial and ownership rejection release prepared tracks. Ending or losing signaling releases peer connections and media.

The shared generated event contract accepts the server's existing operation, participant, intent and leave-reason metadata, with bounded validation. It still rejects opaque media join material. Flutter negotiates the canonical server `media` flag while honoring explicit opt-outs and the legacy huddles flag.

The browser reference host first obtains an authorized huddle/timeline snapshot through the existing SDK hydrator and starts realtime from the returned cursor. This avoids first-event recovery interrupting media after account navigation.

Flutter recovery now installs descriptor-free authorized huddle snapshots alongside recovered conversation/timeline state. Because huddle snapshots lack their own cursor, recovery brackets their read with timeline cursor checks and retries inconsistent windows without partial installation. Huddle-only denial preserves separately authorized conversation access. Ordinary HTTP/command responses update the controller without advancing the ordered reducer past queued events. Existing controller watermarks and identity generations reject superseded responses. A foreground join still awaits its private HTTP result when public realtime state arrives first; it accepts that material only for the same identity, session and participation incarnation. Optional retry-queue readiness does not cancel nonpersistent foreground commands, and the queue pump cannot settle an active foreground join as recovered. Conversely, earlier ordered events for an absent or older participant incarnation cannot erase a newly admitted same-session descriptor. Current leave, session replacement, identity reset and unauthorized hydration still release it. Consumed join-material expiry preserves controls for an already-connected, canonically joined actor. Reloaded membership can explicitly leave and join again without restoring any secret.

## Reproduction and release boundary

Use normal public HTTPS Git dependencies pinned to full SHA with matching locks. The hosts are pinned to published `dc377a84f09033d532c455c6891e0085f67ebe23` (0.1.27). During verification, external Handrail Release Bot commits advanced JS to `f01fe8d588745353ae0935efd93da647585009e5` (1.0.46), Flutter to `bdff12af7c746374ef4b06da31fbed961ee52da4` (0.1.28), and preview to `2aebf69a27aacb7a8f6a1a14c7c0d98ed7061945` (0.1.17+1). A second external JS commit, `572a2fc4d6db68a7881502935dd8b94cd2904e4b` (1.0.47), finalized intermediate test corrections. The worker did not finalize Git. This observation is not independent release approval or proof of a public push. A reviewed consumer pin/lock update and clean installation remain required; the frozen public commit does not acquire these changes. Any disposable verification overlay must be explicitly identified by base revision and per-file hashes and is not an installable release.

From the JS checkout, after version consistency verification and normal `npm run build`:

```sh
npm --prefix examples/drop-in-react run typecheck
npm --prefix examples/drop-in-react run accept:huddle-media -- /absolute/new/evidence-directory
node examples/drop-in-react/scripts/accept-huddle-lifecycle.mjs /absolute/new/lifecycle-evidence-directory
```

The acceptance entry point uses the established disposable native PostgreSQL cluster with private Unix socket, isolated canonical schema, one browser worker and zero retries. It requires installed PostgreSQL, Chromium and the Flutter toolchain with resolved locked dependencies. Keep runtime temp paths short enough for Chromium Unix sockets. Trace capture is disabled because network traces can retain opaque join responses. Inspect bounded screenshots and sanitized SQL/RTP observations instead. Retain original failures, explicit retests, source/runtime identities and teardown receipts.

Scoped Flutter verification (sequential with other heavy checks):

```sh
flutter test --no-pub --concurrency=2 test/durable_resource_event_reducer_test.dart test/realtime_durable_recovery_test.dart test/huddle_controller_test.dart test/huddle_recovery_test.dart test/media_session_test.dart
flutter analyze --no-pub lib/src/handrail_chat_client.dart lib/src/core/huddle_controller.dart lib/src/core/normalized_snapshot_state.dart
```

The retained work-request report is the authority for actual counts, failures, images and final hashes. Commands in this document alone are not passing evidence.

The lifecycle regression preserves the original failures for active-share tab termination, signaling close and account navigation, then checks real SQL/outbox/realtime convergence, released ownership, another authorized sharer and continued surviving RTP. Separate PostgreSQL/provider cases cover delayed old-incarnation callbacks, duplicate cleanup, same-user media survival, silent no-pong loss, unused admission and provider shutdown. Accelerated protocol timers in those cases are labeled separately from production-interval browser observations.

## Remaining acceptance gates

Browser synthetic microphone/display capture with real ICE/DTLS/SRTP proves browser transport only. Physical microphones, native Flutter permission/revocation/background behavior, native screen capture, TURN traversal and external provider delivery remain separate checks. Reuse the existing `examples/flutter-erp` native reference app and approved provider/device handoffs; do not provision production or add a parallel service. Unsupported native screen capture must be disabled explicitly.

The existing Mobile Preview/Chat Lab managed services were observed stopped; this worker did not change their state. The independent SDK broker requires its own read-only validation work-request context (profile=sdk itself needs no enablement). The retained dependency handoff binds the candidate to those established execution paths without replacing them with a persistent raw listener.

Full Discord threads, saved settings, unread/routing, enabled notifications, files, identity/authorization, persistence/realtime and public Git consumer release checks remain in the full readiness matrix. Historical passing evidence is attributed, not silently promoted to the changed candidate. After independent full QA, the owner must approve readiness before any Hitcents ERP installation, configuration or deployment. Main retains the publication/release review boundary.
