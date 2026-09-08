import assert from "node:assert/strict";
import test from "node:test";

// Bundle canonical sources into a private output instead of reading shared dist:
// node_modules/.bin/esbuild test/postgres-reply-style-preference-query.test.mjs --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/reply-style-preference-query-tests.mjs
// node --test --test-concurrency=1 "$PWD/node_modules/.cache/reply-style-preference-query-tests.mjs"
// node_modules/.bin/tsc --project tsconfig.reply-style-preference-query.json
import {
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
  queryReplyStylePreference,
  ReplyStylePreferenceParseError,
} from "../src/server/index.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";

const actor = { tenantId: "tenant-a", userId: "alice", roles: [] };
const optionsWithoutDatabase = {
  actor,
  input: {},
  get database() {
    assert.fail("Validation must finish before accessing the database");
  },
};

test("reply-style query rejects caller identity overrides before database access", async () => {
  for (const input of [
    { tenantId: "tenant-b" },
    { userId: "bob" },
    { tenant_id: "tenant-b", user_id: "bob" },
    { actor: { tenantId: "tenant-b", userId: "bob" } },
    { context: { userId: "bob" } },
    { roles: ["admin"] },
    { conversationId: "channel" },
    { style: "discord" },
    null,
    [],
  ]) {
    await assert.rejects(queryReplyStylePreference({
      actor,
      get database() { return optionsWithoutDatabase.database; },
      input,
    }), ReplyStylePreferenceParseError);
  }
});

test("reply-style query validates trusted actor and schema before database access", async () => {
  for (const invalidActor of [
    null, undefined, {},
    { ...actor, tenantId: " " },
    { ...actor, userId: "" },
    { ...actor, roles: "admin" },
    { ...actor, roles: [""] },
    { ...actor, roles: [1] },
  ]) {
    await assert.rejects(queryReplyStylePreference({
      actor: invalidActor,
      input: {},
      get database() { return optionsWithoutDatabase.database; },
    }), { name: "TypeError", message: "A valid trusted chat actor is required" });
  }
  await assert.rejects(queryReplyStylePreference({
    actor, input: {}, schema: 'public"; DROP TABLE preferences; --',
    get database() { return optionsWithoutDatabase.database; },
  }), TypeError);
});

test("reply-style reads are private, bounded, and do not mutate PostgreSQL", async (t) => {
  const backend = await createPostgresTestBackend();
  t.diagnostic(`PostgreSQL harness: ${backend.kind}`);
  try {
    const harness = await backend.createHarness({ schemaPrefix: "reply_style_query" });
    try {
      await createPostgresMigrationRunner({
        database: harness.pool,
        schema: harness.schema,
        migrations: handrailChatPostgresMigrations,
      }).apply();
      const schema = `"${harness.schema.replaceAll('"', '""')}"`;
      const preferences = `${schema}.chat_user_reply_style_preferences`;
      const rows = async () => (await harness.pool.query(
        `SELECT * FROM ${preferences} ORDER BY tenant_id, user_id`,
      )).rows;
      const calls = [];
      // Capture calls while executing every query against the real Postgres pool.
      const database = {
        query(text, values) {
          calls.push({ text, values });
          return harness.pool.query(text, values);
        },
      };
      const read = (trustedActor = actor) => queryReplyStylePreference({
        database, schema: harness.schema, actor: trustedActor, input: {},
      });

      await t.test("absent reads never insert a default", async () => {
        const before = await rows();
        assert.deepEqual(before, []);
        assert.deepEqual(await read(), { state: "absent", revision: 0 });
        assert.deepEqual(await read(), { state: "absent", revision: 0 });
        assert.deepEqual(await rows(), before);
      });

      await harness.pool.query(`INSERT INTO ${preferences}
        (tenant_id, user_id, style, revision) VALUES
        ('tenant-a', 'alice', 'current', 7),
        ('tenant-b', 'alice', 'discord', 9007199254740991),
        ('tenant-a', 'bob', 'discord', 12)`);
      const before = await rows();
      await t.test("saved Current and Discord retain revisions without conversation membership", async () => {
        assert.equal((await harness.pool.query(`SELECT count(*) FROM ${schema}.chat_conversation_members`)).rows[0].count, "0");
        assert.equal((await harness.pool.query(`SELECT count(*) FROM ${schema}.chat_conversations`)).rows[0].count, "0");
        assert.deepEqual(await read(), { state: "saved", style: "current", revision: 7 });
        assert.deepEqual(await read({ ...actor, userId: "bob" }), { state: "saved", style: "discord", revision: 12 });
      });
      await t.test("same user in another tenant has an independent style and safe bigint revision", async () => {
        assert.deepEqual(await read({ ...actor, tenantId: "tenant-b" }), {
          state: "saved", style: "discord", revision: Number.MAX_SAFE_INTEGER,
        });
        assert.deepEqual(await read({ ...actor, tenantId: "tenant-c" }), { state: "absent", revision: 0 });
      });
      await t.test("another user cannot inherit a saved style", async () => {
        assert.deepEqual(await read({ ...actor, userId: "charlie" }), { state: "absent", revision: 0 });
        assert.deepEqual(await read({ ...actor, tenantId: "tenant-b", userId: "bob" }), { state: "absent", revision: 0 });
      });
      await t.test("SQL-like identities stay parameters and all reads leave storage unchanged", async () => {
        const injectedActor = { ...actor, tenantId: "tenant-a' OR TRUE --", userId: "alice' OR TRUE --" };
        assert.deepEqual(await read(injectedActor), { state: "absent", revision: 0 });
        assert.deepEqual(calls.at(-1).values, [injectedActor.tenantId, injectedActor.userId]);
        for (const call of calls) {
          assert.match(call.text, /^SELECT style, revision\s/);
          assert.match(call.text, /WHERE tenant_id = \$1 AND user_id = \$2\s+LIMIT 1$/);
          assert.equal(call.values.length, 2);
          assert.equal(call.text.includes("OR TRUE"), false);
        }
        assert.deepEqual(await rows(), before);
      });
    } finally {
      await harness.teardown();
      assert.equal(await backend.schemaExists(harness.schema), false);
    }
  } finally {
    await backend.teardown();
  }
});
