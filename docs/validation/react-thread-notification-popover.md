# Thread notification popover repair

Work request `ca8af181-add1-49b6-829e-a29904293484`, validated 2026-09-07 in run `9191d7e7-c4b9-4241-b7d3-5340650db5fc`.

## Failure boundary and change

Application CSS is the failure boundary. Before editing product code, the existing PostgreSQL/Playwright Chat Lab harness reproduced the popover extending outside the thread at 1440×1000. The notification component was positioned relative to its bell, with an end-aligned 22rem panel. In thread controls, that bell is near the left edge, so the panel extended into the parent timeline and was clipped by the thread's overflow boundary.

`src/ui/styles.css` now positions the thread controls and makes the nested notification wrapper static. The panel aligns to the controls' inline end with an inset, and its width is capped by the controls' width. Header notifications retain their existing positioning. Existing thread scrolling, keyboard dismissal, focus restoration, preferences and lifecycle behavior are preserved. No runtime/env or provider configuration change was indicated.

The workspace already contained a separate thread composer/scrolling repair in `src/ui/styles.css` and `src/ui/thread-panel.ts`, along with unrelated changes. Those were preserved; this repair adds only the thread notification positioning rules, its browser regression and this note.

## Verification

- `npm run build`: passed (SDK TypeScript compilation and stylesheet copy). After the CSS edit, `node scripts/copy-ui-styles.mjs` refreshed the browser stylesheet.
- `node --test --test-concurrency=1 test/notification-preferences.test.mjs test/ui-styles.test.mjs`: **35 passed**, zero failures. [Log](../../build/thread-notification-unit.log).
- `npm --prefix examples/drop-in-react run test:browser -- e2e/chat-lab.thread-notification-layout.spec.mjs --workers=1 --retries=0 --reporter=list --output=../../build/thread-notification-final`: **1 passed**. Checks 1440×1000, 1280×720 and 390×844, ordinary Close clicks, center hit testing, horizontal containment within the thread, Escape, restored trigger focus and retained thread visibility. The 1440×1000 scenario also checks the taller authoritative preference-conflict message and enabled Retry save. The conflict comes from the real API; no persistence mocks were introduced.
- Existing `chat-lab.notification-layer.spec.mjs` and `chat-lab.thread-layout.spec.mjs`: **both passed**, confirming header layering and thread Send/history/draft behavior. They were run with the new test during its development; the new test's setup was subsequently corrected for worker-shared named threads and the preference API's matching idempotency header.
- `git diff --check`: passed.

At 1440×1000 the test reveals the whole dialog through the existing scroll container and asserts a full intersection ratio. At compact sizes it scrolls to Close. The taller conflict dialog needs a small vertical scroll to reveal its bottom padding; the repair addresses the horizontal clipping and intercepted clicks, without disabling thread overflow or moving the composer. No force clicks or CSS/DOM layout overrides are used.

Browser runs used the existing harness, normal migrations and seed path against an isolated local PostgreSQL 15 database (UTF-8, loopback port 35929), with per-harness schemas and teardown. The temporary server was started/stopped in the same command. No shared project data or Handrail database/queue state was changed. Chromium was installed into the run's temporary directory.

Handrail current context confirmed this project/work request. Dev service status reported a stopped supervisor, an unrelated listener on port 4167 and no scoped browser route, so validation used isolated rebuilt source. Some harness startups logged a transient `CHAT_CONVERSATION_CREATION_UNAVAILABLE` 503 and recovered; the final focused run had no such error. Handrail log diagnostics found no matching supervised-service error and confirmed the unrelated listener. This result does not claim a deployed campaign rerun. Flutter source was not changed, so the suggested Flutter reducer test was not relevant.

## Evidence

The pre-fix browser regression failed its horizontal containment assertion; its [screenshot](../../build/thread-notification-before/chat-lab.thread-notificati-2bfdf-d-and-Close-receives-clicks-chromium/preferences-1440x1000.png) is preserved.

Final evidence:

- [1440×1000 popover](../../build/thread-notification-final/chat-lab.thread-notificati-2bfdf-d-and-Close-receives-clicks-chromium/preferences-1440x1000.png)
- [1440×1000 conflict state](../../build/thread-notification-final/chat-lab.thread-notificati-2bfdf-d-and-Close-receives-clicks-chromium/preferences-1440x1000-conflict.png) and [Close hit test](../../build/thread-notification-final/chat-lab.thread-notificati-2bfdf-d-and-Close-receives-clicks-chromium/hit-test-1440x1000-conflict.json)
- [1280×720](../../build/thread-notification-final/chat-lab.thread-notificati-2bfdf-d-and-Close-receives-clicks-chromium/preferences-1280x720.png)
- [390×844](../../build/thread-notification-final/chat-lab.thread-notificati-2bfdf-d-and-Close-receives-clicks-chromium/preferences-390x844.png)

Campaign `ab6cb21d-834b-4cd7-8a68-fb958924a76f`, dev, campaign work request `07e977bc-f964-483b-bb06-fde6848a16a1`, campaign run `7d605cde-81d4-47ff-9cf6-83bffe5ba7af`, finding `14ed87b9-25f1-4cf7-827e-b319f13d5559`, approval `51e99df4-9838-4dc8-a978-6c9dd5d1d52e`.

Both supplied image inputs were reviewed: the retry image shows the panel clipped at the left thread boundary; the conflict image shows the same clipping with taller feedback and a covered Close control. Original campaign artifacts remain unchanged. The supplied runner attachment directory was absent, so the JSON payload could not be independently read; the work request's hit-test finding was treated as reported evidence and independently checked by the browser regression above.

Original paths are relative to `campaigns/ab6cb21d-834b-4cd7-8a68-fb958924a76f/`:

| Artifact | Preserved original link | Supplied SHA-256 |
| --- | --- | --- |
| `32-notification-retry.png` | [Original](/api/pm/qa-campaign-artifacts/ec30166c-27d0-486e-92cb-af5d0c62dc60/content) | `a24b4dd762e12d82b5b7a751b4d57e01f67aba7e06136b3fd760683756c82788` |
| `46-alice-first-preference-conflict.png` | [Original](/api/pm/qa-campaign-artifacts/de5e7551-83ac-4299-b7f3-3bba8eac4fff/content) | `a50859222889839c96f66c59879d0e95f76badd27526cdd72615a6cbb4f84217` |
| `notification-close-hit.json` | [Original](/api/pm/qa-campaign-artifacts/e89cfe24-48a9-49cc-a1e7-6d73b451e8dc/content) | `687dccdb4892bd4fdd760ea83307377a9eece521c98d1998e7a3aaf15d651d99` |

No commit, push, PR or deployment was performed.
