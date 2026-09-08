import assert from "node:assert/strict";
import test from "node:test";
import { createChatTestHarness } from "@handrail/chat/testing";

test("repeated existing-thread POSTs complete atomically and preserve authoritative follow state", async () => {
  const outcomes = [];
  const harness = await createChatTestHarness({
    schemaPrefix: "chat_reopen_http",
    actors: [{
      credential: "reopen-actor",
      actor: { tenantId: "tenant", userId: "actor", roles: [] },
      capabilities: ["thread.create"],
    }],
    httpObservability: { onOutcome: (outcome) => { outcomes.push(outcome); } },
  });
  const schema = `"${harness.schema}"`;
  const request = (path, method, body) => fetch(`${harness.endpoint}${path}`, {
    method,
    headers: {
      authorization: "Bearer reopen-actor",
      "content-type": "application/json",
      "idempotency-key": body.idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  const open = (key) => request("/messages/root/thread", "POST", {
    operation: "create_thread", parentConversationId: "parent",
    rootMessageId: "root", initialFollow: true, idempotencyKey: key,
  });
  try {
    await harness.pool.query(`INSERT INTO ${schema}.chat_conversations
      (tenant_id, id, type, visibility, name, current_message_sequence)
      VALUES ('tenant', 'parent', 'channel', 'public', 'Parent', 1)`);
    await harness.pool.query(`INSERT INTO ${schema}.chat_messages
      (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content)
      VALUES ('tenant', 'root', 'parent', 1, 'actor', 'root-client',
        '{"format":"plain","text":"Root"}')`);
    const created = await open("create");
    assert.equal(created.status, 201);
    const canonical = await created.json();
    const threadId = canonical.conversation.conversation.id;
    const followBefore = await harness.pool.query(`SELECT follow_revision FROM
      ${schema}.chat_thread_follows WHERE conversation_id = $1`, [threadId]);
    const unfollowed = await request(`/conversations/${threadId}/follow`, "PATCH", {
      operation: "set_thread_follow", intent: "unfollow",
      target: { type: "thread", id: threadId },
      expectedFollowRevision: Number(followBefore.rows[0].follow_revision),
      idempotencyKey: "unfollow",
    });
    assert.equal(unfollowed.status, 200, await unfollowed.text());
    const follow = await harness.pool.query(`SELECT is_following, follow_revision, updated_at
      FROM ${schema}.chat_thread_follows WHERE conversation_id = $1`, [threadId]);
    assert.equal(follow.rows[0].is_following, false);

    for (let index = 0; index < 200; index++) {
      const response = await open(`reopen-${index}`);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.reconciliationStatus, "existing_for_root");
      assert.equal(body.conversation.conversation.id, threadId);
      const requestId = response.headers.get("x-handrail-request-id");
      assert.ok(requestId);
      assert.ok(outcomes.some((outcome) =>
        outcome.requestId === requestId && outcome.statusCode === 200));
    }
    const replay = await open("reopen-199");
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).reconciliationStatus, "replayed");
    assert.deepEqual((await harness.pool.query(`SELECT is_following, follow_revision, updated_at
      FROM ${schema}.chat_thread_follows WHERE conversation_id = $1`, [threadId])).rows, follow.rows);
    const detail = await fetch(`${harness.endpoint}/conversations/${threadId}`, {
      headers: { authorization: "Bearer reopen-actor" },
    });
    assert.equal(detail.status, 200);
    const authority = (await detail.json()).conversation.currentThreadFollow;
    assert.equal(authority.followRevision, Number(follow.rows[0].follow_revision));
    assert.equal(authority.follow.isFollowing, false);
    // Compare at PostgreSQL precision: JavaScript Dates lose the microseconds
    // that caused the intermittent completion constraint violation.
    assert.equal((await harness.pool.query(`SELECT count(*)::integer AS count
      FROM ${schema}.chat_idempotency_keys WHERE operation_name = 'thread.create'
        AND state = 'completed' AND completed_at = updated_at`)).rows[0].count, 201);
  } finally {
    await harness.teardown();
  }
});
