# Thread composer overlap repair

Work request: `2777614b-ad12-4194-b28c-e6919a8e8154` — Thread content overlaps the composer at 1280×720.
Validated 2026-09-07 in Codex run `d72785ba-579e-480b-92cb-652b01a8254a`.

## Failure boundary and repair

Application layout was the failure boundary. Handrail current context confirmed this work request and project; dev service status reported Chat Lab supervised, running, healthy and ready. Before editing product code, the existing Chat Lab PostgreSQL/browser harness independently reproduced a visible Send button whose center was covered at 1280×720. This did not require shared campaign data or deployed environment changes.

The thread conversation grid reserved space for controls and the composer while allowing the timeline to shrink to zero. The timeline's viewport retained its minimum height and could paint outside that row. On narrow screens, splitting the body between the channel and thread, alongside the parent composer, further reduced usable space.

`src/ui/thread-panel.ts` now groups summary, controls and history in a scrollable content area. `src/ui/styles.css` keeps that area separate from the composer and contains the timeline's overflow. History retains a minimum usable area and controls remain reachable by scrolling. Below 64rem, the open thread/discovery occupies the conversation body; the parent timeline and composer remain mounted but hidden until returning to the channel. This responsive adjustment preserves the existing thread, close, discovery and draft workflows.

## Verification

- `npm run build`: passed (SDK TypeScript compilation and stylesheet copy).
- `node --test --test-concurrency=1 test/thread-panel.test.mjs test/thread-panel-import-guard.test.mjs test/ui-styles.test.mjs`: **89 passed**, zero failures. Log: [thread-layout-unit.log](../../build/thread-layout-unit.log).
- `npm --prefix examples/drop-in-react run test:browser -- e2e/chat-lab.thread-layout.spec.mjs --workers=1 --retries=0 --reporter=list`: **1 passed**. Checks empty threads at 1280×720 and 390×844; ordinary Send clicks and center hit testing at 1280×720, 390×844 and 1440×1000; readable sent history, reachable controls, no horizontal document overflow, and restoration of the unsent channel draft after closing the mobile panel. No force clicks or layout mutations.
- `npm --prefix examples/drop-in-react run test:browser -- e2e/chat-lab.reply-styles.spec.mjs --workers=1 --retries=0 --reporter=list`: **1 passed**. Existing mixed-style scenario covers canonical named threads, retained history, shared lifecycle, subscription and discovery flows.
- `git diff --check`: passed.

Both browser runs used the existing real PostgreSQL harness and its normal migrations/seed path, pointed through `CHAT_LAB_DATABASE_URL` at an isolated local PostgreSQL 15 instance (UTF-8, loopback port 35927). Each run created and tore down its own test schema. The regression queries `chat_messages` to prove each sent message persisted to the canonical thread conversation. Shared project data and Handrail queue/database state were not changed. No persistence mocks were introduced. Chromium was installed into this run's temporary directory via `PLAYWRIGHT_BROWSERS_PATH`.

Initial harness setup attempts failed because the worker cleaned up a PostgreSQL process between commands, and then because `initdb --no-locale` defaulted to SQL_ASCII. The final runs start/stop PostgreSQL in the same command and explicitly use UTF-8. Neither was an application failure.

The original failing regression screenshot remains in [thread-layout-before](../../build/thread-layout-before/). Final screenshots remain in [thread-layout-after](../../build/thread-layout-after/), including:

- [1280×720 empty thread](../../build/thread-layout-after/chat-lab.thread-layout-emp-d0ca3--reachable-at-compact-sizes-chromium/thread-empty-1280x720.png)
- [390×844 empty thread](../../build/thread-layout-after/chat-lab.thread-layout-emp-d0ca3--reachable-at-compact-sizes-chromium/thread-empty-390x844.png)
- [1280×720 sent history](../../build/thread-layout-after/chat-lab.thread-layout-emp-d0ca3--reachable-at-compact-sizes-chromium/thread-history-1280x720.png)
- [390×844 sent history](../../build/thread-layout-after/chat-lab.thread-layout-emp-d0ca3--reachable-at-compact-sizes-chromium/thread-history-390x844.png)
- [1440×1000 sent history](../../build/thread-layout-after/chat-lab.thread-layout-emp-d0ca3--reachable-at-compact-sizes-chromium/thread-history-1440x1000.png)

Browser validation used rebuilt local application source, not a new deployed campaign. Flutter was not changed by this repair; the suggested Flutter reducer test is unrelated to this React layout finding. Existing unrelated workspace changes were preserved. No commit, push, PR or deployment was performed.

## Reviewed campaign evidence

Campaign `ab6cb21d-834b-4cd7-8a68-fb958924a76f`, environment `dev`, campaign work request `07e977bc-f964-483b-bb06-fde6848a16a1`, campaign Codex run `7d605cde-81d4-47ff-9cf6-83bffe5ba7af`.
Finding `0563537b-9a41-4773-a271-d4621a695e63`, approval `9766e56f-c9d6-4fcc-8c2a-a71e9ef13606`.

The four supplied screenshots were reviewed. Original artifact names below are relative to `campaigns/ab6cb21d-834b-4cd7-8a68-fb958924a76f/`; the original attachments remain unchanged.

| Artifact | Review and preserved content link |
| --- | --- |
| `21-thread-send-overlap.png` | Empty text overlaps the composer at 1280×720. Campaign hit testing at Send center `(1207.625, 514.625)` returned `<p>Start the conversation when you are ready.</p>`. [Original](/api/pm/qa-campaign-artifacts/c2fcd409-6f26-4bc9-b72f-3485162de725/content) |
| `22-thread-history-desktop.png` | Successful send with readable history at 1440×1000. [Original](/api/pm/qa-campaign-artifacts/967ee18c-105d-4563-b1b1-a6d2e5998d9a/content) |
| `34-mobile-thread.png` | Channel, thread and parent composer compete for space; thread controls/history are clipped at 390×844. [Original](/api/pm/qa-campaign-artifacts/f460f220-0ac4-4486-8307-efeaa4851705/content) |
| `45-mobile-send.png` | Mobile send succeeded after scrolling the thread composer into view. [Original](/api/pm/qa-campaign-artifacts/ab3f8d95-3d86-4a62-b4eb-f4e0d6622ce0/content) |

Original SHA-256 hashes, in the same order:

```text
04c2b3eb66d4538f5b8838473bd11daf543f08c4cc730bfdd28c4921768fd5d8
de5cea19ba1e66761355958e788e688c6a7f3e422b520aa51a701f9f32f6b762
8d78bae9cffb28840868823e3e8bbd3d04788df970dd2040554d3b8353d25ab7
74203f397f6ce55ef3cb9e370dc7bf27a66653de9a463ba2991405bf0fff31bc
```
