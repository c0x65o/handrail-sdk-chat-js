import { expect, test } from "./chat-lab.fixture.mjs";

if (process.env.CHAT_LAB_ADMISSION_CHECK_ORIGIN) {
  test.use({ chatLabOrigin: process.env.CHAT_LAB_ADMISSION_CHECK_ORIGIN });
}

test("naturally loaded SDK admits independently clocked thread follows", async ({ page, chatLabOrigin }, testInfo) => {
  const loaded = [];
  page.on("response", (response) => loaded.push(response.url()));
  await page.goto(new URL("/chat-lab.html", chatLabOrigin).href);
  await page.getByRole("button", { name: "Open thread with 1 reply", exact: true }).click();
  await expect(page.locator(".handrail-chat__thread-panel")).toBeVisible();
  const sdkUrl = loaded.find((url) => new URL(url).pathname.endsWith("/dist/client/index.js"));
  expect(sdkUrl, "Chat Lab must load the built SDK client").toBeTruthy();
  const reducerUrl = loaded.find((url) => new URL(url).pathname.endsWith("/dist/client/durable-event-reducer.js"));
  expect(reducerUrl).toBeTruthy();
  const reducer = await page.request.get(reducerUrl);
  expect(reducer.ok()).toBe(true);
  expect(await reducer.text()).toContain("event.type !== CHAT_DURABLE_EVENT_TYPES.threadFollowUpdated");

  // Synthetic entities stay in a separate cache; no events reach the app or server.
  const results = await page.evaluate(async (url) => {
    const { createNormalizedChatCache, CHAT_DURABLE_EVENT_TYPES } = await import(url);
    const tenantId = "qa-admission-tenant";
    const userId = "qa-admission-user";
    const highWater = "2026-08-26T06:00:01.123Z";
    return [highWater, "2026-08-26T06:00:01.122Z"].map((occurredAt) => {
      const cache = createNormalizedChatCache({ tenantId, userId, sessionId: "qa-admission-session" });
      for (const id of ["qa-parent", "qa-thread-a", "qa-thread-b"]) {
        cache.hydrateConversationDetail({
          kind: "conversation_detail",
          conversation: {
            id, tenantId, visibility: "public",
            ...(id === "qa-parent" ? { type: "channel", name: "QA parent" } : {
              type: "thread", parentConversationId: "qa-parent", rootMessageId: "qa-root",
            }),
            createdAt: highWater, updatedAt: highWater, activityAt: highWater, latestSequence: 0,
            currentMember: { tenantId, conversationId: id, userId, role: "member", state: "active", joinedAt: highWater, updatedAt: highWater },
            currentReadState: { conversationId: id, userId, lastReadSequence: 0, updatedAt: highWater },
            memberUserIds: [userId],
            currentPreference: { conversationId: id, userId, notificationPreference: "all", mute: { muted: false }, updatedAt: highWater },
          },
          _meta: { packageVersion: "0.1.87", protocolVersion: 4, schemaVersion: 1, enabledFeatures: {}, supportedProtocolRange: { minimumVersion: 4, maximumVersion: 4 }, feature: { name: "conversation_snapshots", version: 1 } },
        });
      }
      cache.hydrateMessageTimeline({
        conversationId: "qa-parent",
        messages: [{ id: "qa-root", tenantId, conversationId: "qa-parent",
          author: { type: "user", userId }, sequence: 1, createdAt: highWater, updatedAt: highWater,
          revision: { revision: 1 }, content: { format: "plain", text: "QA root" },
          isThreadRoot: true, reactions: [], attachmentMetadata: [] }],
        pagination: { older: { available: false }, newer: { available: false } },
        replay: { resumeFrom: { eventId: "qa-snapshot" } },
      });
      const events = ["a", "b"].map((suffix) => {
        const target = { type: "thread", id: `qa-thread-${suffix}` };
        return {
          eventId: `qa-${suffix}`, protocolVersion: 4, tenantId, streamId: `user:${userId}`,
          type: CHAT_DURABLE_EVENT_TYPES.threadFollowUpdated,
          occurredAt: suffix === "a" ? highWater : occurredAt,
          payload: { operation: "set_thread_follow", target, followRevision: 1,
            follow: { target, isFollowing: true, source: "manual", updatedAt: highWater } },
        };
      });
      const statuses = [...events, ...events].map((event) => cache.applyDurableEvent(event).status);
      const state = cache.getState();
      return { occurredAt, statuses, follows: state.currentUser.threadFollows,
        revisions: state.currentUser.threadFollowRevisions, cursor: state.metadata.realtimeCursor,
        stream: state.metadata.durableStreams[`user:${userId}`] };
    });
  }, sdkUrl);
  await testInfo.attach("served-admission-results.json", {
    body: JSON.stringify({ sdkUrl, reducerUrl, results }, null, 2), contentType: "application/json",
  });
  for (const result of results) {
    expect(result.statuses).toEqual(["applied", "applied", "duplicate", "duplicate"]);
    expect(result.revisions).toEqual({ "qa-thread-a": 1, "qa-thread-b": 1 });
    expect(Object.keys(result.follows).sort()).toEqual(["qa-thread-a", "qa-thread-b"]);
    for (const [id, follow] of Object.entries(result.follows)) {
      expect(follow).toEqual({ target: { type: "thread", id }, isFollowing: true, source: "manual", updatedAt: "2026-08-26T06:00:01.123Z" });
    }
    expect(result.cursor).toEqual({ eventId: "qa-b" });
    expect(result.stream).toEqual({ lastEventId: "qa-b", lastOccurredAt: "2026-08-26T06:00:01.123Z", recentEventIds: ["qa-a", "qa-b"] });
  }
});
