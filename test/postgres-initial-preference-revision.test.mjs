import assert from "node:assert/strict";
import test from "node:test";
import { createChatClient, createNormalizedChatCache } from "../dist/client/index.js";
import {
  createThread, queryConversationDetail,
  updateConversationPreference, createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "../dist/server/index.js";
import { queryThreadList } from "../dist/server/thread-list-query.js";
import { createPostgresTestBackend } from "../dist/testing/index.js";

test("Bob and Alice each save their first thread notification choice using the initial stored revision", async (t) => {
  const backend = await createPostgresTestBackend();
  let harness;
  try {
    harness = await backend.createHarness({ schemaPrefix: "chat_initial_preference" });
    const database = harness.pool;
    const schema = harness.schema;
    const prefix = `"${schema}"`;
    await createPostgresMigrationRunner({ database, schema, migrations: handrailChatPostgresMigrations }).apply();
    await database.query(`INSERT INTO ${prefix}.chat_conversations
      (tenant_id, id, type, visibility, name, current_message_sequence)
      VALUES ('tenant-a', 'launch', 'channel', 'public', 'Launch planning', 1)`);
    await database.query(`INSERT INTO ${prefix}.chat_messages
      (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content)
      VALUES ('tenant-a', 'root', 'launch', 1, 'alice', 'root', '{"format":"plain","text":"Which launch date?"}')`);
    const permissions = {
      async getCapabilities() { return ["thread.create"]; },
      async authorizeEntity() { return true; },
    };
    let threadId;
    for (const userId of ["bob", "alice"]) {
      await t.test(`${userId}: initialized preference, first save, reopen, genuine stale conflict`, async () => {
        const actor = { tenantId: "tenant-a", userId, roles: [] };
        const common = { database, schema, actor, permissions };
        const created = await createThread({ ...common, input: {
          operation: "create_thread", parentConversationId: "launch", rootMessageId: "root",
          name: "Launch date decision", initialFollow: true, idempotencyKey: `create-${userId}`,
        } });
        const creationSnapshot = created.conversation;
        const id = creationSnapshot.conversation.id;
        if (threadId !== undefined) assert.equal(id, threadId);
        threadId = id;
        assert.equal(creationSnapshot.conversation.currentPreference.preferenceRevision, 1);
        const detail = await queryConversationDetail({ ...common, input: { conversationId: id } });
        assert.equal(detail.currentPreference.preferenceRevision, 1);
        const list = await queryThreadList({ ...common, lifecycleSupported: true, input: { parentConversationId: "launch" } });
        assert.equal(list.items[0].thread.currentPreference.preferenceRevision, 1);
        const cache = createNormalizedChatCache({ tenantId: actor.tenantId, userId, sessionId: `session-${userId}` });
        // Creator hydrates the creation response; the other actor opens a detail snapshot.
        cache.hydrateConversationDetail(userId === "bob" ? creationSnapshot : {
          ...creationSnapshot, conversation: detail,
        });
        const requests = [];
        const client = createChatClient({
          endpoint: "/chat", cache, getAccessToken: () => "test-token",
          async fetch(_url, init) {
            const input = JSON.parse(init.body);
            requests.push(input);
            const body = await updateConversationPreference({ ...common, input });
            const status = body.reconciliationStatus === "preference_revision_conflict" ? 409 : 200;
            return { ok: status === 200, status, async json() { return body; } };
          },
        });
        try {
          const saved = await client.updateConversationPreference({
            conversationId: id, notificationPreference: "mentions", isStarred: false, mute: { muted: false },
          });
          assert.equal(saved.status, "success");
          assert.equal(saved.value.reconciliationStatus, "applied");
          assert.equal(requests.length, 1);
          assert.equal(requests[0].expectedPreferenceRevision, 1);
          const reopened = await queryConversationDetail({ ...common, input: { conversationId: id } });
          assert.equal(reopened.currentPreference.preferenceRevision, 2);
          assert.equal(reopened.currentPreference.notificationPreference, "mentions");
          const stale = await updateConversationPreference({ ...common, input: {
            ...requests[0], idempotencyKey: `stale-${userId}`, notificationPreference: "none",
          } });
          assert.equal(stale.reconciliationStatus, "preference_revision_conflict");
          assert.equal(stale.preferenceRevision, 2);
        } finally { client.close(); }
      });
    }
    const visitor = await queryConversationDetail({ database, schema, permissions,
      actor: { tenantId: "tenant-a", userId: "visitor", roles: [] }, input: { conversationId: threadId } });
    assert.equal(visitor.currentPreference.preferenceRevision, 0, "no stored row uses zero");
    t.diagnostic("Real PostgreSQL, isolated schema, canonical migrations, creation/query/client/command serialization; no persistence mocks.");
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});
