# Browser huddle lab

The React `/chat-lab.html` entry point uses real WebRTC audio and screen video.
The existing PostgreSQL huddle API supplies lifecycle, membership and screen
ownership. The lab signaling server creates rooms and issues single-use
credentials valid for 60 seconds, then checks active membership on admission,
on signaling, and every five seconds. Media travels directly between browsers.
The room limit is three simultaneous participants.

When bound to loopback, the lab accepts Handrail's HTTPS preview origin from
the proxy's forwarded host/protocol headers. This accounts for Handrail rewriting
the WebSocket Host header to the local upstream address. Forwarded origins from
other domains, mismatched headers, and non-loopback peers are not trusted.

## Owner test

Open the project’s Dev Preview through Handrail in each browser (the registered
preview route requires a Handrail browser session), then use these paths:

- `/chat-lab.html?actor=ada`
- `/chat-lab.html?actor=grace`
- `/chat-lab.html?actor=margaret`

Select **Chat Lab General** in each browser. Ada starts the huddle, then all
three participants join. Each starts muted: select **Unmute microphone** and
allow microphone access. Use headphones or mute the other browsers while
checking each speaker to avoid feedback. If autoplay is blocked, use the visible
**Play** button for that participant.

Ada or Grace can select **Start screen sharing** and choose a tab, window or
screen in the browser picker. Margaret can view a share but her existing lab
permissions do not allow starting one. Verify the other two browsers display
the shared content. Stop with **Stop screen sharing** or the browser's sharing
indicator; verify both remote views disappear. Also test leaving while sharing,
rejoining, microphone mute/unmute, denying capture permission, and Ada's
**End huddle** action in huddle details. Ending should disconnect everyone and
release local capture.

## Runtime and browser requirements

Run the existing `npm run dev:lab` command from this example after building the
root SDK. The lab uses its declared PostgreSQL configuration. Capture needs
HTTPS or localhost. Display capture requires a user gesture and a new browser
picker permission each time. This slice shares screen video; it does not
capture system/tab audio or provide camera video. Available capture surfaces
vary by browser and operating system.

No media provider has been provisioned for this project. The lab uses a small
peer mesh with authenticated same-origin WebSocket signaling. With the default
empty ICE-server list, test browsers must have a directly reachable network
path (for example, three browsers on one machine). For networks that block
direct peer traffic, provision a TURN relay and set `CHAT_LAB_ICE_SERVERS` to a
JSON array of standard RTCIceServer entries before starting the lab. Relay
credentials are delivered to authenticated participants; use narrowly scoped,
short-lived credentials. The lab does not provision or renew a TURN service.

Rooms and admission credentials are in memory; restarting the lab invalidates
them. Chat Lab itself recreates an isolated test database schema on startup.
This is the bounded development-lab integration, not a production media service.

## Validation

From the example directory:

- `node --test test/ChatLabWebRtcServer.test.mjs`
- `npx tsc --project tsconfig.huddle.json --noEmit`
- `npx playwright test e2e/chat-lab.real-media.spec.mjs --project=chromium --workers=1`

The browser test uses independent Chromium sessions and synthetic capture input,
checking actual received audio RTP bytes and decoded remote screen video. It
also checks denied display capture, stopping sharing, leaving while sharing,
rejoining with retained visit history, and ending the huddle. The browser-ended
notification is explicitly dispatched in one callback test; this does not
claim a manual click on the browser sharing indicator. These tests require an
available test PostgreSQL database, or the harness can launch its own PostgreSQL
container when database URL environment variables are unset. Automated Chromium evidence does not establish manual
three-browser compatibility or physical audio quality.

Automated three-session Chromium media exchange passed on 2026-09-04 using
an isolated PostgreSQL test container. The SDK build and focused client/server
tests were also exercised. Manual cross-browser testing remains for the owner.
