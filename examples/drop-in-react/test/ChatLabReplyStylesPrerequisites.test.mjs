import assert from "node:assert/strict";
import test from "node:test";
import { startChatLab } from "../scripts/chat-lab.mjs";

const success = result => {
  assert.equal(result.status, "success", JSON.stringify(result));
  return result.value;
};

test("reply-styles controls and actors are absent from other seed profiles", { timeout: 60_000 }, async t => {
  const lab = await startChatLab({ seedProfile: "direct-message-visual", port: 0 });
  t.after(() => lab.close());
  assert.equal((await fetch(`${lab.origin}/__chat-lab/reply-styles`)).status, 404);
  assert.equal((await fetch(`${lab.origin}/__chat-lab/session?actor=carol`)).status, 404);
  const instance = await (await fetch(`${lab.origin}/__chat-lab/instance`)).json();
  assert.equal(instance.prerequisites, undefined);
});

test("reply-styles acceptance prerequisites use real HTTP and isolated PostgreSQL", { timeout: 60_000 }, async t => {
  const lab = await startChatLab({ seedProfile: "reply-styles", port: 0 });
  t.after(() => lab.close());
  const clients = Object.fromEntries(lab.actors.map(({ id, credential }) => [id, lab.harness.createClient(credential)]));
  await Promise.all(Object.values(clients).map(client => client.start()));
  const { alice, bob, carol, dave } = clients;
  const get = async (path, actor = "bob") => {
    const response = await fetch(`${lab.origin}/api/chat${path}`, {
      headers: { authorization: `Bearer chat-lab-${actor}` },
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const control = async input => {
    const response = await fetch(`${lab.origin}/__chat-lab/reply-styles`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const list = view => get(`/conversations/${lab.conversationId}/threads?view=${view}`);
  const ids = result => result.items.map(item => item.thread.id);
  let threadId;

  await t.test("advertises four selectable sessions and preserves an absent preference", async () => {
    const instance = await (await fetch(`${lab.origin}/__chat-lab/instance`)).json();
    assert.deepEqual(instance.prerequisites.actors.map(actor => actor.id), ["alice", "bob", "carol", "dave"]);
    for (const actor of instance.prerequisites.actors) {
      const session = await fetch(`${lab.origin}/__chat-lab/session?actor=${actor.id}`);
      assert.equal(session.status, 200);
      assert.equal(await session.text(), `chat-lab-${actor.id}`);
    }
    const preference = await carol.replyStyle.load();
    assert.equal(preference.effectiveStyle, "current");
    assert.equal(preference.confirmedPreference.revision, 0);
    assert.equal(preference.origin, "fallback");
    assert.deepEqual((await lab.harness.pool.query(
      "SELECT user_id, style FROM chat_user_reply_style_preferences ORDER BY user_id",
    )).rows, [{ user_id: "alice", style: "current" }, { user_id: "bob", style: "discord" }]);
    assert.equal((await lab.harness.pool.query("SELECT id FROM chat_conversations WHERE type='thread'")).rowCount, 0);
  });

  await t.test("Bob can find two other participants and create a group DM", async () => {
    const directory = success(await bob.searchDirectoryUsers({ query: "a", limit: 25 }));
    assert.ok(directory.users.some(user => user.userId === "alice"));
    assert.ok(directory.users.some(user => user.userId === "carol"));
    const group = success(await bob.createGroupDirect({ intendedMemberUserIds: ["alice", "carol"] }));
    assert.equal(group.conversation.conversation.type, "group_direct");
    const members = await lab.harness.pool.query(
      "SELECT user_id FROM chat_conversation_members WHERE conversation_id=$1 AND state='active' ORDER BY user_id",
      [group.conversation.conversation.id],
    );
    assert.deepEqual(members.rows.map(row => row.user_id), ["alice", "bob", "carol"]);
  });

  await t.test("denied actor reads history but cannot create, send or manage threads", async () => {
    assert.equal((await get(`/conversations/${lab.conversationId}`, "dave")).conversation.id, lab.conversationId);
    for (const client of [alice, dave]) {
      success(await client.getConversation({ conversationId: lab.conversationId }));
      success(await client.getMessageTimeline({ conversationId: lab.conversationId, direction: "backward", limit: 50 }));
    }
    const deniedCreation = await dave.createThread({ rootMessageId: lab.rootMessageId, name: "Denied" });
    assert.notEqual(deniedCreation.state, "ready");
    assert.notEqual(deniedCreation.code, "root_message_unavailable");
    assert.equal((await lab.harness.pool.query("SELECT id FROM chat_conversations WHERE type='thread'")).rowCount, 0);
    const thread = await alice.createThread({ rootMessageId: lab.rootMessageId, name: "Inactivity acceptance" });
    assert.equal(thread.state, "ready", JSON.stringify(thread));
    threadId = thread.threadConversationId;
    assert.notEqual((await dave.sendMessage({ conversationId: threadId,
      content: { format: "plain", text: "Denied send" } })).status, "success");
    const denial = await fetch(`${lab.origin}/api/chat/conversations/${threadId}/lifecycle`, {
      method: "PATCH", headers: { authorization: "Bearer chat-lab-dave", "content-type": "application/json",
        "idempotency-key": "denied-manage" },
      body: JSON.stringify({ operation: "update_thread_lifecycle", intent: "close",
        expectedLifecycleRevision: 1, idempotencyKey: "denied-manage" }),
    });
    assert.equal(denial.status, 403, await denial.text());
    assert.equal((await get(`/conversations/${threadId}`, "dave")).conversation.id, threadId);
  });

  await t.test("inactivity hides only discovery and a new message restores activity", async () => {
    assert.equal((await get("/_meta")).enabledFeatures.threadInactivity, true);
    assert.deepEqual((await list("active")).inactivityPolicy, { hideAfterMs: 86_400_000 });
    assert.ok(ids(await list("active")).includes(threadId));
    await control({ operation: "set_inactivity_policy", hideAfterMs: 1 });
    assert.ok(!ids(await list("active")).includes(threadId));
    assert.ok(ids(await list("all")).includes(threadId));
    assert.equal((await get(`/conversations/${threadId}`)).conversation.threadLifecycle.closedAt, undefined);
    await control({ operation: "set_inactivity_policy", hideAfterMs: 1_000 });
    await new Promise(resolve => setTimeout(resolve, 1_100));
    assert.ok(!ids(await list("active")).includes(threadId));
    success(await carol.sendMessage({ conversationId: threadId, content: { format: "plain", text: "Still active" } }));
    assert.ok(ids(await list("active")).includes(threadId));
    await control({ operation: "set_inactivity_policy", hideAfterMs: null });
    assert.equal((await list("active")).inactivityPolicy, false);
    assert.ok(ids(await list("active")).includes(threadId));
    await control({ operation: "set_inactivity_policy", hideAfterMs: 86_400_000 });
  });

  await t.test("archive control preserves readable history and is idempotent", async () => {
    const input = { operation: "create_archived_thread" };
    const [fixture, duplicate] = await Promise.all([control(input), control(input)]);
    assert.deepEqual(duplicate, fixture);
    assert.equal(fixture.archive.archiveState.status, "archived");
    const detail = await get(`/conversations/${fixture.threadId}`, "dave");
    assert.ok(detail.conversation.archivedAt);
    assert.ok(!ids(await list("all")).includes(fixture.threadId));
    assert.notEqual((await bob.sendMessage({ conversationId: fixture.threadId,
      content: { format: "plain", text: "Denied archived send" } })).status, "success");
    const history = await get(`/conversations/${fixture.threadId}/messages`, "dave");
    assert.ok(JSON.stringify(history).includes("Retained archived launch history"));
    assert.equal((await lab.harness.pool.query("SELECT count(*)::int AS count FROM chat_messages WHERE id=$1",
      [fixture.replyMessageId])).rows[0].count, 1);
  });

  await t.test("controls reject malformed and cross-site mutations without changing policy", async () => {
    for (const input of [{ operation: "set_inactivity_policy", hideAfterMs: -1 },
      { operation: "set_inactivity_policy", hideAfterMs: 0 }, { operation: "reset_database" }, null]) {
      const response = await fetch(`${lab.origin}/__chat-lab/reply-styles`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      });
      assert.equal(response.status, 400);
    }
    const response = await fetch(`${lab.origin}/__chat-lab/reply-styles`, {
      method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ operation: "set_inactivity_policy", hideAfterMs: 1 }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual((await list("all")).inactivityPolicy, { hideAfterMs: 86_400_000 });
  });
});
