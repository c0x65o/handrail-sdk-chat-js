import assert from "node:assert/strict";
import test from "node:test";
import { createChatClient, createNormalizedChatCache } from "@handrail/chat/client";
import { startChatLab } from "../scripts/chat-lab.mjs";

// Real Vite /api/chat proxy, HTTP router, migrations and isolated PostgreSQL
// schema. Only the lost-response boundary is simulated.
test("Chat Lab initializes follow authority on reload and reconciles stale revisions and lost responses", async () => {
  const lab = await startChatLab({ host: "127.0.0.1", port: 0 });
  const clients = [];
  const requests = [];
  let loseFollowResponses = false;
  let failBeforeDispatch = false;
  const token = await (await fetch(`${lab.origin}/__chat-lab/session?actor=ada`)).text();
  const createClient = () => {
    const client = createChatClient({
      endpoint: `${lab.origin}/api/chat`,
      getAccessToken: () => token,
      cache: createNormalizedChatCache({ tenantId: "chat-lab", userId: "ada", sessionId: crypto.randomUUID() }),
      fetch: async (url, init) => {
        if (failBeforeDispatch && init.method === "PATCH" && url.endsWith("/follow")) {
          return new Response("", { status: 503 });
        }
        const response = await fetch(url, init);
        if (init.method === "PATCH" && url.endsWith("/follow")) {
          requests.push({ input: JSON.parse(init.body), status: response.status });
          if (loseFollowResponses) return new Response("", { status: 503 });
        }
        return response;
      },
      commands: { retry: { backoffMs: () => 0 } },
    });
    clients.push(client);
    return client;
  };
  const open = async () => {
    const client = createClient();
    await client.start();
    assert.equal((await client.getConversation({ conversationId: lab.conversationIds.direct })).status, "success");
    await client.getMessageTimeline({ conversationId: lab.conversationIds.direct, direction: "backward", limit: 50 });
    assert.equal((await client.openThread(lab.rootMessageId)).state, "ready");
    return client;
  };
  const authority = (client) => ({
    revision: client.cache.getState().currentUser.threadFollowRevisions[lab.threadConversationId],
    following: client.cache.getState().currentUser.threadFollows[lab.threadConversationId]?.isFollowing,
  });
  try {
    const first = await open();
    const initial = authority(first);
    assert.equal(initial.following, true);
    assert.ok(initial.revision > 0);
    assert.equal((await first.unfollowThread(lab.threadConversationId)).status, "success");
    assert.equal(requests.at(-1).input.expectedFollowRevision, initial.revision);
    first.close();

    const reopened = await open();
    assert.deepEqual(authority(reopened), { revision: initial.revision + 1, following: false });
    assert.equal((await reopened.followThread(lab.threadConversationId)).status, "success");
    assert.equal(requests.at(-1).input.expectedFollowRevision, initial.revision + 1);
    reopened.close();
    const followed = await open();
    assert.deepEqual(authority(followed), { revision: initial.revision + 2, following: true });

    const stale = { operation: "set_thread_follow", intent: "follow", target: { type: "thread", id: lab.threadConversationId }, expectedFollowRevision: 0, idempotencyKey: crypto.randomUUID() };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${lab.origin}/api/chat/conversations/${lab.threadConversationId}/follow`, {
        method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": stale.idempotencyKey }, body: JSON.stringify(stale),
      });
      const result = await response.json();
      assert.equal(response.status, 409, JSON.stringify(result));
      assert.equal(result.followRevision, initial.revision + 2);
      assert.equal(result.follow.isFollowing, true);
    }

    loseFollowResponses = true;
    const recovered = await followed.unfollowThread(lab.threadConversationId);
    assert.equal(recovered.status, "success", JSON.stringify(recovered));
    assert.deepEqual(authority(followed), { revision: initial.revision + 3, following: false });
    assert.equal(followed.cache.getState().currentUser.pendingThreadFollowUpdates[lab.threadConversationId], undefined);
    assert.ok(requests.every(({ status }) => status === 200), JSON.stringify(requests));

    loseFollowResponses = false;
    failBeforeDispatch = true;
    assert.equal((await followed.followThread(lab.threadConversationId)).status, "transport");
    assert.deepEqual(authority(followed), { revision: initial.revision + 3, following: false });
    assert.equal(followed.cache.getState().currentUser.pendingThreadFollowUpdates[lab.threadConversationId], undefined);
  } finally {
    for (const client of clients) client.close();
    await lab.close();
  }
});
