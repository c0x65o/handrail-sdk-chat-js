# Drop-in `ChatWorkspace` React example

This Vite app shows the complete optional Handrail Chat UI in two host-owned layouts:

- an organization-scoped, full-screen `ChatWorkspace`; and
- an entity-scoped `ChatWorkspace` embedded as the side panel for sales order `SO-1042`.

The app installs one Handrail package at one version:

Consume `@handrail/chat` from the public HTTPS Git URL
`https://github.com/c0x65o/handrail-sdk-chat-js.git`, pinned to a full SDK commit
SHA with a matching `package-lock.json`. The inherited example manifest is
awaiting this cutover; follow [migration status](../../docs/sdk-repository-split.md)
before running an install. Do not use a local SDK dependency.

Its browser integration uses only the public client, React, UI, and UI stylesheet entry points. `src/chat-config.ts` deliberately keeps `endpoint` and `getAccessToken` in host code. The SDK owns normalized chat behavior; neither the drop-in UI nor its slot renderers open a realtime connection directly.

## Quick start

Mount the Handrail server routes at `/api/chat`, expose a same-origin host session route at `/api/chat/session`, then run:

```sh
npm install
npm run dev
```

## Real-stack Chat Lab

Use the Chat Lab when a browser change needs interactive evidence against the
real Chat server rather than the populated UI fixture used by this example's
fast DOM tests. From the repository root, build `@handrail/chat` once, then run:

```sh
npm run build
cd examples/drop-in-react
npm install
npm run dev:lab
```

After SDK edits, rerun `npm run build` from the repository root and restart the
Chat Lab Node process before reloading the browser. Vite reloads browser modules,
but the backend retains its imported SDK modules until the process restarts.
For a Handrail-supervised lab, use the dev service restart action; its configured
startup command builds the SDK first. The lab imports JavaScript and CSS from
`dist`; running `tsc` alone does not publish `src/ui/styles.css`.

A successful health check does not prove client/server contract compatibility.
For reminder recovery, also check authenticated
`GET /api/chat/message-reminders?limit=100&includeCancelled=true` and `false`.
Both must return 200; only `true` includes cancelled revision authority.

The reminder browser regression schedules two fixture messages, cancels one,
then checks reload, actor return, private indicators, and first-attempt rescheduling:

```sh
npm run test:browser -- e2e/chat-lab.reminder-hydration.spec.mjs --retries=0
```

It uses an isolated Chat Lab schema by default. Provide `CHAT_LAB_DATABASE_URL`
for a dedicated UTF-8 PostgreSQL validation database. To verify a freshly
restarted supervised lab instead, set
`CHAT_LAB_REMINDER_CHECK_ORIGIN=http://127.0.0.1:4167`. This mode changes reminder
fixtures through the UI and expects their initial revisions to be zero; use a
fresh lab instance for each run.


Before declaring a running dev environment verified, check its naturally loaded
SDK artifacts after rebuilding. From this example directory:

```sh
CHAT_LAB_ADMISSION_CHECK_ORIGIN=http://127.0.0.1:4167 npm run test:browser -- e2e/thread-follow-admission.spec.mjs
```

This opens a thread and imports the exact built client module loaded by the page.
An isolated cache checks equal and decreasing thread-follow event clocks,
canonical follows/revisions, replay deduplication, cursor advancement, and the
retained timestamp high-water. It attaches `served-admission-results.json` to the
Playwright report without injecting synthetic events into the app or server.
Omit the origin override to use the isolated PostgreSQL Chat Lab harness.

The directory fallback browser
regression checks the published CSS against source and exercises real messages
under directory HTTP 429 responses:

```sh
npm run test:browser -- e2e/directory-fallback-layout.spec.mjs
```

This uses the existing isolated PostgreSQL Chat Lab harness by default. Set
`CHAT_LAB_DIRECTORY_CHECK_ORIGIN` to a running dev service's origin to check its
served assets instead. Recovery verification allows the real 60-second retry
cooldown to elapse.

Open the printed `/chat-lab.html` URL for the real-stack React workspace. Its
toolbar switches between Ada, Grace, and Margaret; each selection creates a
fresh public browser client. The workspace's message-search panel uses the
SDK's server-backed search transport, and the private-channel seed remains
invisible to non-member Margaret. The former `/react-chat-lab.html` entry
remains as a compatibility alias.

The deterministic default React message-renderer acceptance fixture is
available at `/reminder-chat-lab.html`. It contains sent, deleted, optimistic
unsent, sending, and failed rows and exposes reminder presets, custom input,
reschedule, cancel, pending, retryable-error, and canonical-conflict flows. Only
the eligible sent message exposes `Remind me`.

The Flutter `HandrailMessageTimeline` fixture remains available at
`/__flutter-chat-lab/` for renderer-specific QA and keeps its semantics tree
active for browser inspection.

### Development-only conversation state fixture

For deterministic, read-only browser acceptance of `ChatWorkspace` conversation
detail panels, start the fixture-only Vite server without the PostgreSQL-backed
Chat Lab backend:

```bash
npm run dev:states
```

Use the printed origin with these directly addressable URLs:

- `/conversation-state-chat-lab.html?state=loading` renders the real
  `conversation-loading` status panel and remains loading.
- `/conversation-state-chat-lab.html?state=unavailable` renders the real
  `conversation-unavailable` status panel. This is also the safe default when
  the selector is missing or invalid.
- `/conversation-state-chat-lab.html?state=error` renders the real
  `conversation-error` alert panel.
- `/conversation-state-chat-lab.html?state=no-selection` renders the real
  `conversation-selecting` status with a ready conversation list and no active
  conversation.
- `/conversation-state-chat-lab.html?state=empty` renders the real
  `no-conversation` status with a successful, ready conversation list containing
  zero items.

The page also exposes links for switching among the five states and the same
persisted System/Light/Dark chooser as the main Chat Lab. System mode follows
the operating-system color scheme; explicit choices use the shared
`handrail-chat-lab:theme` preference for both pages. Its client is an in-memory,
read-only state boundary: it performs no HTTP requests and cannot mutate
database records. The HTML entry is deliberately omitted from the Vite
production build inputs, and its bootstrap additionally refuses to run outside
Vite development mode. Normal `/chat-lab.html` behavior is unchanged.

The lab uses `createChatTestHarness` to create an isolated PostgreSQL schema,
apply every shipped migration, start the real HTTP and WebSocket runtime, and
remove that schema during shutdown. It resolves a dedicated dev/test
PostgreSQL URL in this order: `CHAT_LAB_DATABASE_URL`, `TEST_DATABASE_URL`,
then `DATABASE_URL`. When none is set, the harness owns a disposable
`postgres:16-alpine` container, so Docker must be available.

For a dedicated database on Handrail's managed dev PostgreSQL resource, use a
database-only URL such as `CHAT_LAB_DATABASE_URL=postgresql:///chat_lab_test`
(the database must already exist). This preserves the selected database while
letting `pg` resolve `PGHOST`, `PGPORT`, `PGUSER`, and `PGPASSWORD` from Handrail's
injected settings. Do not pin the managed Docker host port in this override:
it can change when the resource restarts and leave Chat Lab connecting to a
stale port even after Handrail refreshes `DATABASE_URL`.

Programmatic `options.databaseUrl` takes precedence over these environment
variables. Blank or malformed explicit selections fail without falling back to
another database or container. Initialization failures report the selecting
variable and a safe error code, never a connection URL or driver credentials.
`ECONNREFUSED` alone does not distinguish a stale override from a stopped managed
resource; inspect both the selected settings and the managed resource status.
The CLI starts Flutter compilation only after the database and lab server start.

For focused database selection/startup/cleanup checks, reuse PostgreSQL 16 binaries
with `PG_BINDIR=/path/to/postgresql/16/bin node scripts/verify-chat-lab-database.mjs
/absolute/path/to/new-evidence-directory` from the SDK root. This runs serially
against an owned private socket cluster, removes only its disposable resources,
and does not launch a browser or start a declared Handrail service.

Persistence, repositories, commands, snapshots, realtime delivery, normalized
browser state, and the React workspace at `/chat-lab.html` are real. The
default-renderer and Flutter acceptance targets use deterministic local
fixtures so mutation feedback and optimistic action eligibility remain stable.
Only the React real-stack host-owned identity, directory, and permission
boundaries use deterministic in-memory actors.
Provider-backed attachments, notifications, audit, and media are disabled. The
fixed credentials are development fixtures and this service must never be
deployed as a staging or production host.

For Handrail dev, the service listens on `CHAT_LAB_HOST` and
`CHAT_LAB_PORT` (falling back to `PORT`, then `4167`). Its readiness endpoint is
`/__chat-lab/health`, and `/chat-lab.html` is the browser QA entry point.

Run the focused real-stack smoke with a dedicated PostgreSQL URL or Docker:

```sh
npm run test:lab
```

### Chromium browser smoke

Install Playwright's Chromium browser once after `npm install`:

```sh
npx playwright install chromium
```

On Linux hosts that do not already provide Chromium's system libraries, install
the browser and those packages with `npx playwright install --with-deps chromium`
where system package installation is permitted. Then run the real-browser smoke:

```sh
npm run test:browser
```

The Playwright worker starts `startChatLab({ port: 0, flutterReady:
Promise.resolve() })` once on an ephemeral port. The server and its isolated
PostgreSQL schema (or disposable fallback container) are always torn down when
the worker finishes, including after a test failure; no Flutter build is needed.

Per-run test output, including the explicitly named
`chat-lab-workspace-smoke.png` attachment, is written beneath
`test-results/playwright/`. The HTML report is written to
`playwright-report/`; failed tests also retain a screenshot, and the first retry
retains a trace.

Run the responsive theme shell and empty-channel visual coverage with the
existing real Chat Lab browser harness:

```sh
npm run test:browser -- e2e/chat-lab.responsive-theme.spec.mjs
```

The focused spec covers explicit light and dark themes at 1440×900, 1600×900,
and 1920×1080 desktop viewports, dark theme at the 768×900 tablet viewport, and
explicit light and dark themes at the 390×844 compact viewport. The three dark
desktop cases also compare the full visible Chat Lab stage with committed
Chromium-on-Linux baselines. One additional dark 1440×900 assertion selects the
seeded, message-free `Chat Lab Empty Room` public channel and preserves its
introduction, header, empty timeline, and composer in the capture. The
assertions wait for document fonts, the managed realtime connection, decoded
images, and their conversation-specific content; they disable motion and clear
hover/focus state before capture. Because PostgreSQL-generated message
timestamps use the test run's wall clock, populated-baseline labels are
normalized to the fixture's fixed review instant while the surrounding
timestamp UI remains visible.
Development diagnostics outside the stage are excluded without masking product
UI. The pixel comparison uses a 0.1 per-pixel threshold and permits at most 100
changed pixels rather than a broad image ratio.

Update only the affected snapshots after reviewing an intentional visual
change:

```sh
npm run test:browser -- e2e/chat-lab.responsive-theme.spec.mjs --update-snapshots
```

The platform-qualified assets live in
`e2e/chat-lab.responsive-theme.spec.mjs-snapshots/`. Populated snapshot updates
must show the seeded public conversation and should be reviewed at all three
desktop sizes for surface hierarchy, compact navigation density, conversation
identity, grouped timeline content, and the anchored composer. The empty-room
snapshot must retain the quiet, left-aligned public-channel introduction in the
normal timeline column with the header and composer visible. Review that case
alone with `--grep "empty public channel"`; append `--update-snapshots` only
when intentionally replacing its baseline. Do not approve baseline changes
caused by missing seed data, disconnected realtime, undecoded images,
focus/hover state, or a different browser/platform. Light, tablet, and compact
cases intentionally remain geometry/theme checks plus review attachments rather
than screenshot baselines.

The nine review attachments are named `chat-lab-shell-light-desktop.png`,
`chat-lab-shell-dark-desktop.png`,
`chat-lab-shell-light-desktop-1600x900.png`,
`chat-lab-shell-dark-desktop-1600x900.png`,
`chat-lab-shell-light-desktop-1920x1080.png`,
`chat-lab-shell-dark-desktop-1920x1080.png`,
`chat-lab-shell-dark-tablet.png`, `chat-lab-shell-light-compact.png`, and
`chat-lab-shell-dark-compact.png` beneath their per-test folders in
`test-results/playwright/`. They remain readable review artifacts separate from
the four assertions; a failed first attempt retains its trace in the same
results tree.

Run only the focused conversation-state panel coverage with:

```sh
npm run test:browser:states
```

This command starts a narrowly scoped Vite worker on an ephemeral loopback port
and opens the five stable `/conversation-state-chat-lab.html?state=...` URLs
directly. It does not start the real Chat Lab backend and requires no PostgreSQL,
Docker, credentials, or Flutter. The database-backed `npm run test:browser`
harness remains unchanged for the other browser specs.

The focused run covers every state in both explicit light and dark themes and
alternates representative 1280×800 desktop and 390×844 compact viewports so
each state is exercised in both viewport classes. Each case attaches a PNG named
`conversation-state-<state>-<theme>-<viewport>.png` beneath its per-test folder
in `test-results/playwright/`; these are review artifacts, not pixel baselines.
Failed cases retain a Playwright trace in the same results tree, and the HTML
report remains in `playwright-report/`.

Copy `DropInChatExample.tsx`, `company-slots.tsx`, and the scoped token rules from `styles.css` into a host React app as needed. The `components` prop demonstrates all nine public slot contracts while retaining the default workspace shell. `customization-contract.tsx` is a compile fixture for all four layout modes, body renderer composition, `ThreadPanel`/`HuddleControls`, and a fully headless replacement using only public entry points; it is not a second runtime app.

See the package's focused
[ChatWorkspace customization contract](../../docs/chat-workspace-customization.md)
for the exact normalized props/actions, complete token table, modal ownership,
and accessibility responsibilities.

Run all focused acceptance checks with:

```sh
npm run check
```

That command performs a TypeScript no-emit check, Vite production build, emitted browser module-graph assertion, DOM smoke tests for both layouts and every override, and static public-boundary checks.
