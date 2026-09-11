import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import { handrailChatPostgresMigrations } from "../src/server/postgres-schema-migrations.ts";
import { synchronizeDraft } from "../src/server/synchronize-draft-command.ts";
import { queryConversationDraftSnapshot } from "../src/server/conversation-draft-snapshot-query.ts";
import { ChatAuthorizationError } from "../src/server/request-context.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";

const actor = { tenantId: "tenant-a", userId: "drafter", roles: [] };
const inputFor = (conversationId, suffix, notifyAuthor = false, baseRevision = 0) => ({
  operation: "synchronize_draft", intent: "replace", conversationId, baseRevision,
  deviceMutationId: `device-${suffix}`, idempotencyKey: `draft-${suffix}`,
  content: { format: "plain", text: "Friday", attachments: [],
    replyTo: { messageId: "unavailable-source", notifyAuthor } },
});

test("reply drafts upgrade safely and use current parent authority", async (t) => {
  const backend = await createPostgresTestBackend();
  let harness;
  try {
    harness = await backend.createHarness({ schemaPrefix: "chat_reply_drafts" });
    const prefix = `"${harness.schema}"`;
    const sql = (query, values) => harness.pool.query(query, values);
    const migrate = (migrations) => createPostgresMigrationRunner({
      database: harness.pool, schema: harness.schema, migrations,
    }).apply();
    const legacy = handrailChatPostgresMigrations.filter(({ order }) => order < 42);
    await migrate(legacy);
    t.diagnostic(`Real PostgreSQL ${backend.kind}, isolated schema, canonical migrations`);
    await sql(`INSERT INTO ${prefix}.chat_conversations
      (tenant_id, id, type, visibility, name) VALUES ('tenant-a', 'legacy', 'channel', 'private', 'Legacy')`);
    await sql(`INSERT INTO ${prefix}.chat_conversation_members
      (tenant_id, conversation_id, user_id, role, state)
      VALUES ('tenant-a', 'legacy', 'drafter', 'member', 'active')`);
    const legacyContent = { format: "markdown", text: "legacy draft",
      mentions: [{ type: "user", userId: "alice" }, { type: "conversation", conversationId: "legacy" },
        { type: "entity", entity: { type: "case", id: "42" } }],
      attachments: [{ attachmentId: "old-upload" }], blocks: [{ type: "legacy", data: { retained: true } }] };
    await sql(`INSERT INTO ${prefix}.chat_drafts
      (tenant_id, conversation_id, user_id, content, revision)
      VALUES ('tenant-a', 'legacy', 'drafter', $1, 7)`, [legacyContent]);
    const legacyRow = () => sql(`SELECT * FROM ${prefix}.chat_drafts WHERE conversation_id = 'legacy'`);
    const before = (await legacyRow()).rows;
    const applied = await migrate(handrailChatPostgresMigrations);
    assert.deepEqual(applied.applied.map(({ id }) => id),
      handrailChatPostgresMigrations.filter(({ order }) => order >= 42).map(({ id }) => id));
    assert.ok(applied.applied.some(({ id }) => id === "0042-chat-draft-replies"));
    assert.deepEqual((await legacyRow()).rows, before);

    await t.test("database retains legacy rules and strictly validates optional reply metadata", async () => {
      let revision = 8;
      const write = (content) => sql(`UPDATE ${prefix}.chat_drafts
        SET content = $1, revision = $2, updated_at = clock_timestamp()
        WHERE conversation_id = 'legacy' RETURNING content`, [JSON.stringify(content), revision++]);
      const validIds = ["missing", "é", "a".repeat(255), "é".repeat(127), "😀", "inside space"];
      for (const notifyAuthor of [true, false]) {
        for (const messageId of validIds) {
          const content = { ...legacyContent, replyTo: { messageId, notifyAuthor } };
          assert.deepEqual((await write(content)).rows[0].content, content);
        }
      }
      const invalidReplies = [null, [], "id", true, 1, {}, { messageId: "id" },
        { notifyAuthor: false }, { messageId: "id", notifyAuthor: false, extra: 1 },
        ...[null, "false", "true", 0, 1, [], {}].map((notifyAuthor) => ({ messageId: "id", notifyAuthor })),
        ...[null, 1, [], {}, "", " ", " id", "id ", "\u00a0id", "id\ufeff", "e\u0301",
          "a".repeat(256), "é".repeat(128), "😀".repeat(64), "a\tZ", "a\nZ", "a\rZ",
          "a\u001fZ", "a\u007fZ", "a\u0085Z", "a\u009fZ", "a\u2028Z", "a\u2029Z"]
          .map((messageId) => ({ messageId, notifyAuthor: false }))];
      for (const replyTo of invalidReplies) {
        await assert.rejects(write({ ...legacyContent, replyTo }),
          (error) => error.code === "23514" && error.constraint === "chat_drafts_content_check",
          JSON.stringify(replyTo));
      }
      for (const messageId of ["a\u0000b", "\ud800", "\udc00"]) {
        await assert.rejects(write({ ...legacyContent, replyTo: { messageId, notifyAuthor: false } }),
          (error) => ["22P02", "22P05"].includes(error.code));
      }
      for (const bad of [null, [], { format: "other", text: "x" }, { format: "plain" },
        { format: "plain", text: 1 }, { ...legacyContent, mentions: null },
        { ...legacyContent, mentions: [{ type: "unknown" }] },
        { ...legacyContent, mentions: [{ type: "user" }] },
        { ...legacyContent, mentions: [{ type: "conversation" }] },
        { ...legacyContent, mentions: [{ type: "entity", entity: {} }] },
        { ...legacyContent, attachments: {} }, { ...legacyContent, attachments: [{}] },
        { ...legacyContent, blocks: {} }, { ...legacyContent, blocks: [{}] },
        { ...legacyContent, blocks: [{ type: "block" }] }]) {
        await assert.rejects(write(bad), (error) => error.code === "23514");
      }
      assert.deepEqual((await write(legacyContent)).rows[0].content, legacyContent);
    });

    let hostAllowed = true;
    const calls = [];
    const permissions = { async authorizeEntity(request) { calls.push(request); return hostAllowed; } };
    const sync = (input, overrides = {}) => synchronizeDraft({
      database: harness.pool, schema: harness.schema, actor, permissions, input, ...overrides,
    });
    const read = (id, overrides = {}) => queryConversationDraftSnapshot({
      database: harness.pool, schema: harness.schema, actor, permissions,
      input: { conversationId: id }, ...overrides,
    });
    const seed = async (id, { visibility = "public", entity = false, parentType = "channel" } = {}) => {
      await sql(`INSERT INTO ${prefix}.chat_conversations
        (tenant_id, id, type, visibility, name, entity_type, entity_id)
        VALUES ('tenant-a', $1, $2, $3, $4, $5, $6)`,
      [`${id}-parent`, parentType, visibility, parentType === "channel" ? id : null,
        entity ? "case" : null, entity ? "42" : null]);
      await sql(`INSERT INTO ${prefix}.chat_messages
        (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content)
        VALUES ('tenant-a', $1, $2, 1, 'author', $1, '{"format":"plain","text":"root"}')`,
      [`${id}-root`, `${id}-parent`]);
      await sql(`INSERT INTO ${prefix}.chat_conversations
        (tenant_id, id, type, visibility, parent_conversation_id, root_message_id)
        VALUES ('tenant-a', $1, 'thread', $2, $3, $4)`, [id, visibility, `${id}-parent`, `${id}-root`]);
    };
    const member = (id, state = "active") => sql(`INSERT INTO ${prefix}.chat_conversation_members
      (tenant_id, conversation_id, user_id, role, state)
      VALUES ('tenant-a', $1, 'drafter', 'moderator', $2)
      ON CONFLICT (tenant_id, conversation_id, user_id) DO UPDATE SET state = EXCLUDED.state`, [id, state]);
    const state = async (id) => {
      const result = {};
      for (const table of ["chat_conversation_members", "chat_read_cursors", "chat_conversation_preferences",
        "chat_thread_follows", "chat_drafts"]) {
        result[table] = (await sql(`SELECT * FROM ${prefix}.${table}
          WHERE tenant_id = 'tenant-a' AND conversation_id = $1 AND user_id = 'drafter'`, [id])).rows;
      }
      result.events = (await sql(`SELECT * FROM ${prefix}.chat_outbox_events ORDER BY event_id`)).rows;
      result.keys = (await sql(`SELECT * FROM ${prefix}.chat_idempotency_keys ORDER BY client_key`)).rows;
      return result;
    };
    await t.test("unfollowed unenrolled thread persists target and both ping choices, replays and conflicts", async () => {
      await seed("first");
      assert.equal((await read("first")).state, "absent");
      assert.deepEqual((await state("first")).chat_conversation_members, []);
      for (const [revision, notify] of [false, true].entries()) {
        const input = inputFor("first", `first-${revision}`, notify, revision);
        const result = await sync(input);
        assert.deepEqual(result.draft.content, input.content);
        assert.deepEqual((await read("first")).content.value, input.content);
        assert.equal(result.canonicalRevision, revision + 1);
        const saved = await state("first");
        assert.equal(saved.chat_conversation_members[0].state, "active");
        assert.deepEqual(saved.chat_thread_follows, []);
        assert.deepEqual(await sync(input), { ...result, reconciliationStatus: "replayed" });
        assert.deepEqual(await state("first"), saved);
        for (const replyTo of [{ messageId: "changed", notifyAuthor: notify },
          { messageId: "unavailable-source", notifyAuthor: !notify }]) {
          await assert.rejects(sync({ ...input, content: { ...input.content, replyTo } }),
            (error) => error.code === "idempotency_conflict");
        }
        assert.deepEqual(await state("first"), saved);
        const event = saved.events.find(({ payload }) => payload.input?.idempotencyKey === input.idempotencyKey);
        assert.equal(event.stream_id, "user:drafter");
        assert.deepEqual(event.payload.input.content.replyTo, input.content.replyTo);
        assert.deepEqual(event.payload.result.draft.content.replyTo, input.content.replyTo);
      }
      const stale = await sync(inputFor("first", "stale"));
      assert.equal(stale.reconciliationStatus, "stale_base");
      assert.deepEqual(stale.draft.content.replyTo, { messageId: "unavailable-source", notifyAuthor: true });
      const clear = { ...inputFor("first", "clear", false, 2), intent: "clear" };
      delete clear.content;
      assert.equal((await sync(clear)).draft.kind, "clear_tombstone");
      assert.equal((await read("first")).canonicalRevision, 3);
      assert.equal((await read("first")).state, "absent");
      assert.equal((await sync(inputFor("first", "stale-after-clear"))).draft.kind, "clear_tombstone");
    });

    await t.test("deleted and mismatched source identities remain recoverable drafts", async () => {
      await seed("deleted-source");
      await sql(`INSERT INTO ${prefix}.chat_messages
        (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content, deleted_at, deleted_by_user_id)
        VALUES ('tenant-a', 'deleted-target', 'deleted-source', 1, 'author', 'deleted-target',
          '{"format":"plain","text":"deleted"}', clock_timestamp(), 'author')`);
      for (const [revision, messageId] of ["deleted-target", "deleted-source-root"].entries()) {
        const input = inputFor("deleted-source", `source-${revision}`, false, revision);
        input.content.replyTo.messageId = messageId;
        assert.deepEqual((await sync(input)).draft.content.replyTo, input.content.replyTo);
        assert.deepEqual((await read("deleted-source")).content.value.replyTo, input.content.replyTo);
      }
    });

    for (const parentType of ["channel", "direct", "group_direct"]) {
      await t.test(`${parentType} parent revocation denies save, read and replay despite child state`, async () => {
        const id = `private-${parentType}`;
        await seed(id, { visibility: "private", parentType });
        await member(`${id}-parent`);
        const input = inputFor(id, id);
        await sync(input);
        await member(id); // Retained moderator role cannot grant parent access.
        await member(`${id}-parent`, "left");
        const saved = await state(id);
        await assert.rejects(read(id), ChatAuthorizationError);
        await assert.rejects(sync(input), ChatAuthorizationError);
        await assert.rejects(sync(inputFor(id, `${id}-denied`, true, 1)), ChatAuthorizationError);
        assert.deepEqual(await state(id), saved);
      });
    }

    await t.test("host policy is refreshed for save/read/replay and missing or throwing adapters fail closed", async () => {
      await seed("entity", { entity: true });
      const input = inputFor("entity", "entity");
      await sync(input);
      await read("entity");
      assert.deepEqual(calls.map(({ action }) => action), ["conversation.draft.synchronize", "conversation.draft.snapshot"]);
      for (const call of calls) {
        assert.deepEqual(call.actor, actor);
        assert.deepEqual(call.entity, { type: "case", id: "42" });
      }
      const saved = await state("entity");
      hostAllowed = false;
      await assert.rejects(sync(input), ChatAuthorizationError);
      await assert.rejects(sync(inputFor("entity", "entity-denied", true, 1)), ChatAuthorizationError);
      await assert.rejects(read("entity"), ChatAuthorizationError);
      hostAllowed = true;
      for (const deniedPermissions of [undefined, { async authorizeEntity() { throw new Error("host secret"); } }]) {
        await assert.rejects(sync(input, { permissions: deniedPermissions }), ChatAuthorizationError);
        await assert.rejects(sync(inputFor("entity", "entity-unavailable", true, 1), { permissions: deniedPermissions }), ChatAuthorizationError);
        await assert.rejects(read("entity", { permissions: deniedPermissions }), ChatAuthorizationError);
      }
      assert.deepEqual(await state("entity"), saved);
      // A non-entity thread needs no host entity decision.
      await seed("no-adapter");
      await sync(inputFor("no-adapter", "no-adapter"), { permissions: undefined });
    });

    await t.test("reactivation preserves role, join time, cursors, preferences and follow state", async () => {
      for (const following of [true, false]) {
        const id = `retained-${following}`;
        await seed(id);
        await sync(inputFor(id, `${id}-first`));
        await sql(`UPDATE ${prefix}.chat_conversation_members SET role = 'moderator', state = 'left' WHERE conversation_id = $1`, [id]);
        await sql(`UPDATE ${prefix}.chat_read_cursors SET last_read_sequence = 9, manual_unread_from_sequence = 4 WHERE conversation_id = $1`, [id]);
        await sql(`UPDATE ${prefix}.chat_conversation_preferences SET notification_level = 'mentions', muted = true,
          muted_until = '2099-01-01', is_starred = true, preference_revision = 7 WHERE conversation_id = $1`, [id]);
        await sql(`INSERT INTO ${prefix}.chat_thread_follows
          (tenant_id, conversation_id, user_id, is_following, follow_source, follow_revision)
          VALUES ('tenant-a', $1, 'drafter', $2, 'manual', 8)`, [id, following]);
        const saved = await state(id);
        await sync(inputFor(id, `${id}-second`, true, 1));
        const after = await state(id);
        for (const table of ["chat_read_cursors", "chat_conversation_preferences", "chat_thread_follows"]) {
          assert.deepEqual(after[table], saved[table]);
        }
        const { state: oldState, updated_at: oldTime, ...oldMember } = saved.chat_conversation_members[0];
        const { state: newState, updated_at: newTime, ...newMember } = after.chat_conversation_members[0];
        assert.deepEqual(newMember, oldMember);
        assert.equal(newState, "active");
        assert.equal(after.chat_drafts[0].revision, "2");
        assert.deepEqual(after.chat_drafts[0].created_at, saved.chat_drafts[0].created_at);
      }
    });

    await t.test("late outbox failure rolls back enrollment and established state with idempotency", async () => {
      for (const id of ["rollback-new", "retained-false"]) {
        if (id === "rollback-new") await seed(id);
        const before = await state(id);
        // Only inject a failure at the outbox boundary; all persistence is real PostgreSQL.
        const database = { query: harness.pool.query.bind(harness.pool), async connect() {
          const connection = await harness.pool.connect();
          return { release: () => connection.release(), async query(query, values) {
            if (query.includes("INSERT INTO") && query.includes("chat_outbox_events")) throw new Error("injected outbox failure");
            return connection.query(query, values);
          } };
        } };
        const input = inputFor(id, `${id}-rollback`, true, id === "rollback-new" ? 0 : 2);
        await assert.rejects(sync(input, { database }), /injected outbox failure/);
        assert.deepEqual(await state(id), before);
        assert.equal((await sync(input)).reconciliationStatus, "applied");
      }
    });

    await t.test("archive policy and tenant/actor isolation remain enforced", async () => {
      await seed("archived");
      const input = inputFor("archived", "archived");
      await sync(input);
      for (const other of [{ ...actor, tenantId: "other-tenant" }, { ...actor, userId: "other-user" }]) {
        if (other.tenantId !== actor.tenantId) await assert.rejects(read("archived", { actor: other }), ChatAuthorizationError);
        else assert.equal((await read("archived", { actor: other })).state, "absent");
      }
      await sql(`UPDATE ${prefix}.chat_conversations SET archived_at = clock_timestamp(), archived_by_user_id = 'admin' WHERE id = 'archived'`);
      assert.deepEqual((await read("archived")).content.value, input.content);
      await assert.rejects(sync(input), ChatAuthorizationError);
      await assert.rejects(sync(inputFor("archived", "archived-new", true, 1)), ChatAuthorizationError);
      await sql(`UPDATE ${prefix}.chat_conversations SET archived_at = clock_timestamp(), archived_by_user_id = 'admin' WHERE id = 'archived-parent'`);
      await assert.rejects(read("archived"), ChatAuthorizationError);
    });
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});
