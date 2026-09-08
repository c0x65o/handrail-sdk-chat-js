import assert from "node:assert/strict";
import test from "node:test";

// Bundle canonical sources without overwriting the shared dist directory:
// node_modules/.bin/esbuild test/postgres-message-reply-schema.test.mjs --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/message-reply-schema-tests.mjs
// node --test --test-concurrency=1 "$PWD/node_modules/.cache/message-reply-schema-tests.mjs"
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import {
  chatMessageRepliesMigration,
  handrailChatPostgresMigrations,
} from "../src/server/postgres-schema-migrations.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";

const replyMigrationIndex = handrailChatPostgresMigrations.indexOf(
  chatMessageRepliesMigration,
);
const precedingMigrations = handrailChatPostgresMigrations.slice(0, replyMigrationIndex);
const migrationsThroughReplies = handrailChatPostgresMigrations.slice(0, replyMigrationIndex + 1);

test("reply migration is immutable and registered in order", () => {
  assert.equal(chatMessageRepliesMigration.id, "0039-chat-message-replies");
  assert.equal(chatMessageRepliesMigration.order, 39);
  assert.equal(replyMigrationIndex, 38);
  assert.equal(precedingMigrations.at(-1).id, "0038-chat-huddle-rejoin");
  assert.ok(Object.isFrozen(chatMessageRepliesMigration));
  assert.ok(Object.isFrozen(chatMessageRepliesMigration.statements));
  assert.ok(Object.isFrozen(handrailChatPostgresMigrations));
  const ids = handrailChatPostgresMigrations.map(({ id }) => id);
  const orders = handrailChatPostgresMigrations.map(({ order }) => order);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(orders).size, orders.length);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
});

test("reply storage supports fresh installation and legacy upgrade", async (t) => {
  const backend = await createPostgresTestBackend();
  try {
    for (const upgrade of [false, true]) {
      await t.test(upgrade ? "upgrade with existing messages" : "fresh installation", async (scenario) => {
        const harness = await backend.createHarness({ schemaPrefix: "message_replies" });
        try {
          const schema = `"${harness.schema.replaceAll('"', '""')}"`;
          const messages = `${schema}.chat_messages`;
          const runner = createPostgresMigrationRunner({
            database: harness.pool,
            schema: harness.schema,
            migrations: upgrade ? migrationsThroughReplies : handrailChatPostgresMigrations,
          });
          const insertLegacyFixtures = async () => {
            await harness.pool.query(`INSERT INTO ${schema}.chat_conversations
              (tenant_id, id, type, visibility, name) VALUES
              ('tenant-a', 'channel', 'channel', 'public', 'Channel A'),
              ('tenant-a', 'other-channel', 'channel', 'public', 'Other'),
              ('tenant-b', 'channel', 'channel', 'public', 'Channel B')`);
            await harness.pool.query(`INSERT INTO ${messages}
              (tenant_id, conversation_id, id, sequence, author_user_id, client_message_id, content)
              VALUES
              ('tenant-a', 'channel', 'source', 1, 'alice', 'source', '{"format":"plain","text":"Which launch date?"}'),
              ('tenant-a', 'other-channel', 'other-source', 1, 'alice', 'other-source', '{"format":"plain","text":"Other channel"}'),
              ('tenant-b', 'channel', 'tenant-b-source', 1, 'alice', 'tenant-b-source', '{"format":"plain","text":"Other tenant"}'),
              ('tenant-b', 'channel', 'source', 2, 'alice', 'source', '{"format":"plain","text":"Same ID, different tenant"}')`);
          };

          if (upgrade) {
            await createPostgresMigrationRunner({
              database: harness.pool,
              schema: harness.schema,
              migrations: precedingMigrations,
            }).apply();
            await insertLegacyFixtures();
          }
          const before = await runner.status();
          assert.deepEqual(before.incompatible, []);
          assert.deepEqual(before.pending.map(({ id }) => id),
            (upgrade ? [chatMessageRepliesMigration] : handrailChatPostgresMigrations).map(({ id }) => id));
          const applied = await runner.apply();
          assert.deepEqual(applied.applied.map(({ id }) => id), before.pending.map(({ id }) => id));
          assert.deepEqual(applied.status.pending, []);
          assert.deepEqual(applied.status.incompatible, []);
          if (!upgrade) await insertLegacyFixtures();

          await scenario.test("existing rows and legacy inserts default to no reply or ping", async () => {
            const rows = (await harness.pool.query(`SELECT reply_to_message_id, reply_notify_author FROM ${messages}`)).rows;
            assert.equal(rows.length, 4);
            assert.ok(rows.every((row) => row.reply_to_message_id === null && row.reply_notify_author === false));
            await harness.pool.query(`INSERT INTO ${messages}
              (tenant_id, conversation_id, id, sequence, author_user_id, client_message_id, content)
              VALUES ('tenant-a', 'channel', 'legacy-after', 2, 'bob', 'legacy-after', '{"format":"plain","text":"Legacy insert"}')`);
            assert.deepEqual((await harness.pool.query(`SELECT reply_to_message_id, reply_notify_author FROM ${messages} WHERE id = 'legacy-after'`)).rows,
              [{ reply_to_message_id: null, reply_notify_author: false }]);
          });

          let sequence = 2;
          const insertReply = (id, target, notifyAuthor, tenant = "tenant-a") => harness.pool.query(
            `INSERT INTO ${messages}
              (tenant_id, conversation_id, id, sequence, author_user_id, client_message_id,
               content, reply_to_message_id, reply_notify_author)
              VALUES ($1, 'channel', $2, $3, 'bob', $2, '{"format":"plain","text":"Friday"}', $4, $5)
              RETURNING reply_to_message_id, reply_notify_author`,
            [tenant, id, ++sequence, target, notifyAuthor],
          );
          await scenario.test("same-conversation replies allow either ping choice", async () => {
            for (const notifyAuthor of [false, true]) {
              assert.deepEqual((await insertReply(`reply-${notifyAuthor}`, "source", notifyAuthor)).rows,
                [{ reply_to_message_id: "source", reply_notify_author: notifyAuthor }]);
            }
            await insertReply("tenant-b-reply", "source", false, "tenant-b");
          });

          for (const [name, id, target, notify, code, constraint] of [
            ["missing source", "missing", "absent", false, "23503", "chat_messages_reply_source_fkey"],
            ["cross-conversation source", "cross-conversation", "other-source", false, "23503", "chat_messages_reply_source_fkey"],
            ["cross-tenant source", "cross-tenant", "tenant-b-source", false, "23503", "chat_messages_reply_source_fkey"],
            ["self reference", "self", "self", false, "23514", "chat_messages_reply_not_self_check"],
            ["ping without a reference", "orphan-ping", null, true, "23514", "chat_messages_reply_notify_author_check"],
            ["null notification with a reference", "null-ping", "source", null, "23502", undefined],
            ["null notification without a reference", "null-both", null, null, "23502", undefined],
          ]) {
            await scenario.test(`rejects ${name}`, async () => {
              await assert.rejects(insertReply(id, target, notify), (error) =>
                error.code === code && (constraint ? error.constraint === constraint : error.column === "reply_notify_author"));
            });
          }

          const readReferences = async () => (await harness.pool.query(`SELECT id, reply_to_message_id, reply_notify_author
            FROM ${messages} WHERE tenant_id = 'tenant-a' AND id IN ('reply-false', 'reply-true') ORDER BY id`)).rows;
          const expectedReferences = [false, true].map((notify) => ({
            id: `reply-${notify}`, reply_to_message_id: "source", reply_notify_author: notify,
          }));
          await scenario.test("content edits preserve reply metadata", async () => {
            await harness.pool.query(`UPDATE ${messages}
              SET content = '{"format":"plain","text":"Next Friday"}',
                  edited_at = CURRENT_TIMESTAMP, edited_by_user_id = 'bob',
                  updated_at = CURRENT_TIMESTAMP, current_revision = current_revision + 1
              WHERE tenant_id = 'tenant-a' AND id IN ('reply-false', 'reply-true')`);
            assert.deepEqual(await readReferences(), expectedReferences);
          });
          await scenario.test("source soft deletion preserves shells and replies; hard deletion cannot cascade", async () => {
            await harness.pool.query(`UPDATE ${messages}
              SET content = NULL, deleted_at = CURRENT_TIMESTAMP,
                  deleted_by_user_id = 'alice', updated_at = CURRENT_TIMESTAMP
              WHERE tenant_id = 'tenant-a' AND id = 'source'`);
            const source = (await harness.pool.query(`SELECT content, deleted_at FROM ${messages} WHERE tenant_id = 'tenant-a' AND id = 'source'`)).rows;
            assert.equal(source.length, 1);
            assert.equal(source[0].content, null);
            assert.ok(source[0].deleted_at instanceof Date);
            assert.deepEqual(await readReferences(), expectedReferences);
            await assert.rejects(harness.pool.query(`DELETE FROM ${messages} WHERE tenant_id = 'tenant-a' AND id = 'source'`),
              { code: "23503", constraint: "chat_messages_reply_source_fkey" });
            assert.deepEqual(await readReferences(), expectedReferences);
            assert.equal((await harness.pool.query(`SELECT count(*)::integer AS count FROM ${messages} WHERE tenant_id = 'tenant-a' AND id = 'source'`)).rows[0].count, 1);
          });
          await scenario.test("reverse-reference index has tenant, conversation, source keys and excludes nulls", async () => {
            const indexes = (await harness.pool.query(`SELECT indexdef FROM pg_indexes
              WHERE schemaname = $1 AND tablename = 'chat_messages' AND indexname = 'chat_messages_reply_source_idx'`, [harness.schema])).rows;
            assert.equal(indexes.length, 1);
            assert.match(indexes[0].indexdef, /USING btree \(tenant_id, conversation_id, reply_to_message_id\) WHERE \(reply_to_message_id IS NOT NULL\)$/);
          });
          await scenario.test("repeat migration application leaves history and reply metadata unchanged", async () => {
            const repeated = await runner.apply();
            assert.deepEqual(repeated.applied, []);
            assert.deepEqual(repeated.status, applied.status);
            assert.deepEqual(await readReferences(), expectedReferences);
          });
        } finally {
          await harness.teardown();
          assert.equal(await backend.schemaExists(harness.schema), false);
        }
      });
    }
  } finally {
    await backend.teardown();
  }
});
