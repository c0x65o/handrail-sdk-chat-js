import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

import { createChatClient } from "@handrail/chat/client";
import { sendMessage } from "@handrail/chat/server";
import { createChatTestHarness } from "@handrail/chat/testing";

const tenantId = "reply-summary-tenant";
const parentId = "reply-summary-parent";
const actor = (userId) => ({
  credential: `${userId}-token`,
  actor: { tenantId, userId, roles: ["employee"] },
  capabilities: ["message.send", "thread.create"],
  user: { tenantId, userId, displayName: userId },
});
const sender = actor("sender");
const observer = actor("observer");
const waitFor = async (predicate, label) => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${label}`);
};

// Only the network boundary is controlled; HTTP, WebSockets, PostgreSQL,
// outbox publication, replay, and both client caches use the shipped runtime.
test("reply summaries reach an unopened observer and replay without inflation", { timeout: 30_000 }, async (t) => {
  const harness = await createChatTestHarness({
    actors: [sender, observer],
    schemaPrefix: "reply_summary",
  });
  const schema = `"${harness.schema}"`;
  const clients = [];
  const releases = [];
  const requests = [];
  const frames = [];
  const listeners = new Map();
  let online = true;
  const network = {
    isOnline: () => online,
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
  };
  const setOnline = (value) => {
    online = value;
    listeners.get(value ? "online" : "offline")?.();
  };
  try {
    await harness.pool.query(
      `INSERT INTO ${schema}.chat_conversations (tenant_id, id, type, visibility, name)
       VALUES ($1, $2, 'channel', 'public', 'Reply summaries')`, [tenantId, parentId]);
    for (const userId of [sender.actor.userId, observer.actor.userId]) {
      await harness.pool.query(
        `INSERT INTO ${schema}.chat_conversation_members
         (tenant_id, conversation_id, user_id, role, state)
         VALUES ($1, $2, $3, 'member', 'active')`, [tenantId, parentId, userId]);
      await harness.pool.query(
        `INSERT INTO ${schema}.chat_read_cursors (tenant_id, conversation_id, user_id, last_read_sequence)
         VALUES ($1, $2, $3, 0)`, [tenantId, parentId, userId]);
      await harness.pool.query(
        `INSERT INTO ${schema}.chat_conversation_preferences (tenant_id, conversation_id, user_id)
         VALUES ($1, $2, $3)`, [tenantId, parentId, userId]);
    }
    const senderClient = createChatClient({
      endpoint: harness.endpoint,
      getAccessToken: () => sender.credential,
      realtime: { webSocketFactory: (url, protocols) => new WebSocket(url, [...protocols]) },
    });
    const observerClient = createChatClient({
      endpoint: harness.endpoint,
      getAccessToken: () => observer.credential,
      fetch(url, init) {
        requests.push({ url: String(url), method: init?.method ?? "GET" });
        return fetch(url, init);
      },
      realtime: {
        network,
        webSocketFactory(url, protocols) {
          const socket = new WebSocket(url, [...protocols]);
          socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
          return socket;
        },
      },
    });
    clients.push(senderClient, observerClient);
    for (const client of clients) {
      assert.equal((await client.start()).state, "ready");
      await waitFor(() => client.realtime.state.state === "connected", "connected client");
      const detail = await client.getConversation({ conversationId: parentId });
      assert.equal(detail.status, "success", JSON.stringify(detail));
      releases.push(client.realtime.subscribeConversation(parentId));
    }
    await waitFor(() => frames.some((frame) => frame.type === "chat.subscription.accepted" && frame.streamId === parentId), "parent subscription");
    const root = await senderClient.sendMessage({ conversationId: parentId, content: { format: "plain", text: "summary root" } });
    assert.equal(root.status, "success");
    const rootId = root.value.message.id;
    await waitFor(() => observerClient.cache.getState().entities.messages[rootId], "cached root");
    const opened = await senderClient.openThread(rootId);
    assert.equal(opened.state, "ready");
    const threadId = opened.threadConversationId;
    const summary = () => observerClient.cache.getState().entities.messages[rootId]?.threadSummary;
    const summaries = async () => (await harness.pool.query(
      `SELECT * FROM ${schema}.chat_outbox_events
       WHERE tenant_id = $1 AND stream_id = $2 AND type = 'message.thread_summary.updated'
       ORDER BY replay_position`, [tenantId, parentId])).rows;
    const noHydration = () => {
      assert.equal(observerClient.cache.getState().entities.conversations[threadId], undefined);
      assert.equal(requests.some(({ url }) => url.includes(threadId)), false);
    };
    await waitFor(() => summary()?.replyCount === 0, "creation summary");
    noHydration();
    const replyIds = [];
    for (let count = 1; count <= 2; count += 1) {
      const reply = await senderClient.sendMessage({ conversationId: threadId, content: { format: "plain", text: `reply ${count}` } });
      assert.equal(reply.status, "success");
      replyIds.push(reply.value.message.id);
      await waitFor(() => summary()?.replyCount === count, `live summary ${count}`);
      noHydration();
    }
    const cursorBeforeDisconnect = observerClient.cache.getState().metadata.realtimeCursor;
    const requestsBeforeDisconnect = requests.length;
    setOnline(false);
    assert.equal(observerClient.realtime.state.state, "offline");
    const third = await senderClient.sendMessage({ conversationId: threadId, content: { format: "plain", text: "reply while offline" } });
    assert.equal(third.status, "success");
    replyIds.push(third.value.message.id);
    assert.equal(summary().replyCount, 2);
    setOnline(true);
    await waitFor(() => summary()?.replyCount === 3, "replayed third summary");
    noHydration();
    assert.equal(requests.length, requestsBeforeDisconnect, "reconnect uses durable replay without HTTP recovery");
    assert.ok(frames.some((frame) => frame.type === "chat.session.accepted" && frame.resumeFrom?.eventId === cursorBeforeDisconnect.eventId));
    const rows = await summaries();
    assert.deepEqual(rows.map((row) => row.payload.rootThreadSummary.replyCount), [0, 1, 2, 3]);
    for (const row of rows) {
      assert.equal(row.tenant_id, tenantId);
      assert.equal(row.stream_id, parentId);
      assert.equal(row.payload.parentConversationId, parentId);
      assert.equal(row.payload.rootMessageId, rootId);
      assert.equal(row.payload.rootThreadSummary.threadId, threadId);
      assert.ok(new Date(row.expires_at) > new Date(row.occurred_at));
    }
    for (let index = 0; index < replyIds.length; index += 1) {
      const replyEvent = (await harness.pool.query(
        `SELECT * FROM ${schema}.chat_outbox_events WHERE tenant_id = $1
         AND type = 'message.created' AND payload->'message'->>'id' = $2`, [tenantId, replyIds[index]])).rows[0];
      assert.equal(replyEvent.stream_id, threadId);
      assert.ok(BigInt(replyEvent.replay_position) < BigInt(rows[index + 1].replay_position));
      assert.deepEqual(rows[index + 1].payload.rootThreadSummary.participantIds, [sender.actor.userId]);
      assert.equal(rows[index + 1].payload.rootThreadSummary.lastReplyAt, replyEvent.payload.message.createdAt);
    }
    await waitFor(async () => (await summaries()).every((row) => row.published_at !== null), "published summaries");
    const thirdFrame = frames.find((frame) => frame.eventId === rows[3].event_id);
    assert.ok(thirdFrame);
    const cursorAfterReplay = observerClient.cache.getState().metadata.realtimeCursor;
    observerClient.realtime.applyCanonicalEvent(thirdFrame);
    await harness.runtime.realtimeHub.publish(thirdFrame);
    assert.equal(summary().replyCount, 3);
    assert.deepEqual(observerClient.cache.getState().metadata.realtimeCursor, cursorAfterReplay);
    const acceptedCount = frames.filter((frame) => frame.type === "chat.session.accepted").length;
    setOnline(false);
    setOnline(true);
    await waitFor(() => frames.filter((frame) => frame.type === "chat.session.accepted").length > acceptedCount, "second reconnect");
    assert.equal(summary().replyCount, 3);
    assert.equal(frames.filter((frame) => frame.eventId === thirdFrame.eventId).length, 1);
    noHydration();
    const observerOpened = await observerClient.openThread(rootId);
    assert.equal(observerOpened.state, "ready");
    assert.deepEqual(observerClient.cache.getState().timelines[threadId].messageIds, replyIds);
    assert.equal(summary().replyCount, replyIds.length);

    const commandInput = (suffix) => ({ operation: "send", conversationId: threadId,
      clientMessageId: `client-${suffix}`, idempotencyKey: `send-${suffix}`,
      content: { format: "plain", text: suffix } });
    const command = (input, database = harness.pool) => sendMessage({ database, schema: harness.schema,
      actor: sender.actor, input, directory: harness.adapters.directory, permissions: harness.adapters.permissions });
    await t.test("concurrent replies serialize counts and retries add no summary", async () => {
      const inputs = [commandInput("concurrent-a"), commandInput("concurrent-b")];
      await Promise.all(inputs.map((input) => command(input)));
      assert.deepEqual((await summaries()).map((row) => row.payload.rootThreadSummary.replyCount), [0, 1, 2, 3, 4, 5]);
      await waitFor(() => summary()?.replyCount === 5, "concurrent summaries on the observer");
      assert.equal((await command(inputs[0])).reconciliationStatus, "replayed");
      assert.equal((await summaries()).length, 6);
    });
    await t.test("summary persistence failure rolls back the reply and its side effects", async () => {
      const persistedState = async () => (await harness.pool.query(
        `SELECT current_message_sequence,
           (SELECT count(*) FROM ${schema}.chat_messages) AS messages,
           (SELECT count(*) FROM ${schema}.chat_message_revisions) AS revisions,
           (SELECT count(*) FROM ${schema}.chat_audit_events WHERE action = 'message.created') AS audits,
           (SELECT count(*) FROM ${schema}.chat_outbox_events WHERE type IN ('message.created', 'message.thread_summary.updated')) AS events
         FROM ${schema}.chat_conversations WHERE tenant_id = $1 AND id = $2`,
        [tenantId, threadId])).rows;
      const before = await persistedState();
      const database = {
        async connect() {
          const connection = await harness.pool.connect();
          return {
            query(sql, parameters) {
              if (sql.includes("INSERT INTO") && sql.includes("'message.thread_summary.updated'")) throw new Error("summary persistence failure");
              return connection.query(sql, parameters);
            },
            release: () => connection.release(),
          };
        },
      };
      const failedInput = commandInput("rollback");
      await assert.rejects(command(failedInput, database), /summary persistence failure/);
      assert.deepEqual(await persistedState(), before);
      assert.equal((await summaries()).length, 6);
      assert.equal((await harness.pool.query(`SELECT id FROM ${schema}.chat_messages WHERE client_message_id = $1`, [failedInput.clientMessageId])).rowCount, 0);
      assert.equal((await harness.pool.query(`SELECT client_key FROM ${schema}.chat_idempotency_keys WHERE client_key = $1`, [failedInput.idempotencyKey])).rowCount, 0);
      assert.equal((await command(failedInput)).reconciliationStatus, "applied");
      assert.equal((await summaries()).at(-1).payload.rootThreadSummary.replyCount, 6);
    });
  } finally {
    for (const release of releases) release();
    for (const client of clients) client.close();
    await harness.teardown();
  }
});
