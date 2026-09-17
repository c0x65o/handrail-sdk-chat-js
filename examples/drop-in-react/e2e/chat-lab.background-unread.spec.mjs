import { readFile } from "node:fs/promises";
import { expect, test } from "./chat-lab.fixture.mjs";

// QA-1041-UNREAD: the selected timeline does not own offscreen navigation freshness.
test("offscreen unread and mentions converge in both tabs before reconnect or reload", async ({ page, context, chatLab }, testInfo) => {
  const pages = [page, await context.newPage()];
  const conversationId = chatLab.conversationIds.direct;
  const row = target => target.getByRole("navigation", { name: "Conversations" })
    .locator(`button[data-conversation-id="${conversationId}"]`);
  const proof = { origin: chatLab.origin, schema: chatLab.harness.schema, conversationId, http: [], ui: [], frames: [] };
  const cursor = async (operation, sequence, key) => {
    const response = await fetch(`${chatLab.origin}/api/chat/conversations/${conversationId}/read-cursor`, {
      method: "PATCH",
      headers: { authorization: "Bearer chat-lab-grace", "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ operation, conversationId, [operation === "mark_read" ? "throughSequence" : "fromSequence"]: sequence, idempotencyKey: key }),
    });
    const body = await response.json();
    proof.http.push({ operation, status: response.status, body });
    expect(response.status).toBe(200);
    return body;
  };
  for (const [index, target] of pages.entries()) {
    await target.setViewportSize({ width: 1440, height: 1000 });
    await target.addInitScript(() => {
      const Original = window.WebSocket;
      window.__unreadSockets = [];
      window.WebSocket = class extends Original {
        constructor(...args) { super(...args); window.__unreadSockets.push(this); }
      };
    });
    target.on("websocket", socket => socket.on("framereceived", frame => {
      try { proof.frames.push({ page: index, data: JSON.parse(frame.payload.toString()) }); } catch { /* Non-JSON Vite frames. */ }
    }));
  }
  const ada = chatLab.harness.createClient("chat-lab-ada");
  try {
    proof.candidate = JSON.parse(await readFile(new URL("../../../dist/candidate.json", import.meta.url), "utf8"));
    expect((await ada.start()).state).toBe("ready");
    const detail = await ada.getConversation({ conversationId });
    expect(detail.status).toBe("success");
    expect(detail.value.conversation.latestSequence).toBe(2);
    await cursor("mark_read", 2, "background-initial-read");
    for (const target of pages) {
      await target.goto(`${chatLab.origin}/chat-lab.html?actor=grace`);
      if (target === page) await expect(target.locator(".chat-lab__realtime-announcement")).toHaveAttribute("data-realtime-state", "connected");
      await target.getByRole("navigation", { name: "Conversations" }).getByRole("button", { name: /^Chat Lab General(?:,|$)/ }).click();
    }
    const sent = await ada.sendMessage({ conversationId, content: {
      format: "plain", text: "Background unread mention regression", mentions: [{ type: "user", userId: "grace" }],
    } });
    expect(sent.status).toBe("success");
    expect(sent.value.message.sequence).toBe(3);
    await chatLab.harness.runtime.outboxPublisher.runOnce();
    const response = await fetch(`${chatLab.origin}/api/chat/conversations/${conversationId}`, { headers: { authorization: "Bearer chat-lab-grace" } });
    expect(response.status).toBe(200);
    proof.authoritative = await response.json();
    expect(proof.authoritative.conversation.latestSequence).toBe(3);
    expect(proof.authoritative.conversation.currentReadState.lastReadSequence).toBe(2);
    expect(proof.authoritative.conversation.unreadMentionCount).toBe(1);
    // Both assertions precede any reconnect, reload or selection of the DM.
    for (const [index, target] of pages.entries()) {
      await expect.soft(row(target)).toHaveAttribute("aria-label", /1 unread message, 1 unread mention/);
      proof.ui.push({ phase: "before-reconnect", page: index, label: await row(target).getAttribute("aria-label") });
      await testInfo.attach(`background-unread-tab-${index}`, { body: await target.screenshot(), contentType: "image/png" });
    }
    const first = await cursor("mark_read", 3, "background-read-once");
    const count = async () => Number((await chatLab.harness.pool.query("SELECT count(*) AS count FROM chat_outbox_events WHERE type='conversation.read_cursor_updated' AND stream_id='user:grace'")).rows[0].count);
    const before = await count();
    expect(await cursor("mark_read", 3, "background-read-once")).toEqual(first);
    expect(await count()).toBe(before);
    await chatLab.harness.runtime.outboxPublisher.runOnce();
    for (const target of pages) await expect(row(target)).not.toHaveAttribute("aria-label", /unread message|unread mention/);
    await cursor("mark_unread", 3, "background-manual-unread");
    await chatLab.harness.runtime.outboxPublisher.runOnce();
    for (const target of pages) await expect(row(target)).toHaveAttribute("aria-label", /1 unread message/);
    const sockets = await page.evaluate(() => window.__unreadSockets.length);
    await page.evaluate(() => window.__unreadSockets.filter(socket => new URL(socket.url).pathname.startsWith("/api/chat")).forEach(socket => socket.close(4000, "unread regression reconnect")));
    await expect.poll(() => page.evaluate(() => window.__unreadSockets.length)).toBeGreaterThan(sockets);
    await expect(row(page)).toHaveAttribute("aria-label", /1 unread message/);
    await pages[1].reload();
    await expect(row(pages[1])).toHaveAttribute("aria-label", /1 unread message/);
    await cursor("mark_read", 3, "background-final-read");
    await chatLab.harness.runtime.outboxPublisher.runOnce();
    for (const target of pages) await expect(row(target)).not.toHaveAttribute("aria-label", /unread message|unread mention/);
  } finally {
    proof.sql = (await chatLab.harness.pool.query("SELECT user_id,last_read_sequence,manual_unread_from_sequence FROM chat_read_cursors WHERE conversation_id=$1 ORDER BY user_id", [conversationId])).rows;
    ada.close();
    await testInfo.attach("background-unread-proof", { body: JSON.stringify(proof, null, 2), contentType: "application/json" });
  }
});

test("offscreen access removal clears both tabs and releases read-state refresh", async ({ page, context, chatLab }, testInfo) => {
  const pages = [page, await context.newPage()];
  const conversationId = chatLab.conversationIds.privateChannel;
  const row = target => target.locator(`button[data-conversation-id="${conversationId}"]`);
  const proof = { conversationId, requests: [], frames: [] };
  const ada = chatLab.harness.createClient("chat-lab-ada");
  try {
    expect((await ada.start()).state).toBe("ready");
    expect((await ada.getConversation({ conversationId })).status).toBe("success");
    for (const [index, target] of pages.entries()) {
      target.on("request", request => {
        if (new URL(request.url()).pathname === `/api/chat/conversations/${conversationId}`) proof.requests.push({ page: index, method: request.method() });
      });
      target.on("websocket", socket => socket.on("framereceived", frame => {
        try { proof.frames.push({ page: index, data: JSON.parse(frame.payload.toString()) }); } catch { /* Non-JSON Vite frames. */ }
      }));
      await target.goto(`${chatLab.origin}/chat-lab.html?actor=grace`);
      await expect(row(target)).toBeVisible();
      await target.getByRole("navigation", { name: "Conversations" }).getByRole("button", { name: /^Chat Lab General(?:,|$)/ }).click();
    }
    const removed = await ada.removeConversationMember({ conversationId, expectedMemberListRevision: 2, targetUserId: "grace" });
    proof.removal = removed;
    expect(removed.status).toBe("success");
    await chatLab.harness.runtime.outboxPublisher.runOnce();
    const denied = await fetch(`${chatLab.origin}/api/chat/conversations/${conversationId}`, { headers: { authorization: "Bearer chat-lab-grace" } });
    proof.deniedStatus = denied.status;
    expect(denied.status).toBe(403);
    for (const target of pages) await expect(row(target)).toHaveCount(0);
    const sent = await ada.sendMessage({ conversationId, content: { format: "plain", text: "Private after removal must not leak", mentions: [{ type: "user", userId: "grace" }] } });
    expect(sent.status).toBe("success");
    await chatLab.harness.runtime.outboxPublisher.runOnce();
    // Two reconciliation periods prove that unmounted rows release their poll ownership.
    const requestsAfterRemoval = proof.requests.length;
    await page.waitForTimeout(11_000);
    expect(proof.requests).toHaveLength(requestsAfterRemoval);
    for (const target of pages) {
      await expect(row(target)).toHaveCount(0);
      await expect(target.getByText("Private after removal must not leak", { exact: true })).toHaveCount(0);
    }
    expect(JSON.stringify(proof.frames)).not.toContain(sent.value.message.id);
  } finally {
    ada.close();
    await testInfo.attach("background-access-removal-proof", { body: JSON.stringify(proof, null, 2), contentType: "application/json" });
  }
});
