import assert from "node:assert/strict";
import test from "node:test";
import { queryMessageContext } from "../src/server/message-context-query.ts";
import { queryMessageTimeline } from "../src/server/message-timeline-query.ts";
import { MessageContextParseError, parseMessageContextResult } from "../src/contracts/message-context.ts";
import { ChatAuthorizationError } from "../src/server/request-context.ts";
import { createChatTestHarness, createPostgresTestBackend } from "../src/testing/index.ts";

// Bundle current source directly; no shared dist build or fake database fallback:
// GOMAXPROCS=2 node_modules/.bin/esbuild test/postgres-message-context-query.test.mjs --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/postgres-message-context-query.test.mjs
// TEST_DATABASE_URL=<isolated PostgreSQL URL> node --test --test-concurrency=1 "$PWD/node_modules/.cache/postgres-message-context-query.test.mjs"
const actor = { tenantId: "tenant-a", userId: "reader", roles: [] };
const created = "2030-01-01T00:00:00.000Z";
const updated = "2030-01-01T01:00:00.000Z";
const target = { conversationId: "parent", messageId: "source" };
const unavailable = input => ({ ...input, status: "unavailable" });
const canonical = ({ isThreadRoot, reactions, attachmentMetadata, ...message }) => message;

test("exact reply context uses canonical source and isolated real PostgreSQL", async t => {
  const backend = await createPostgresTestBackend();
  let harness;
  try {
    harness = await createChatTestHarness({ backend, schemaPrefix: "chat_message_context",
      actors: [{ credential: "context-reader", actor }] });
    const prefix = `"${harness.schema}"`;
    const sql = (text, values) => harness.pool.query(text, values);
    const parent = (id, { tenant = actor.tenantId, type = "channel", visibility = "public", entity = false } = {}) => sql(
      `INSERT INTO ${prefix}.chat_conversations
       (tenant_id,id,type,visibility,name,entity_type,entity_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [tenant,id,type,visibility,type === "channel" ? id : null,entity ? "case" : null,entity ? id : null,created]);
    const member = (conversation, state = "active") => sql(
      `INSERT INTO ${prefix}.chat_conversation_members (tenant_id,conversation_id,user_id,role,state)
       VALUES ('tenant-a',$1,'reader','member',$2)
       ON CONFLICT (tenant_id,conversation_id,user_id) DO UPDATE SET state=EXCLUDED.state`, [conversation,state]);
    const message = (id, conversation, sequence, { tenant = actor.tenantId, content = { format: "plain", text: id }, reply = null } = {}) => sql(
      `INSERT INTO ${prefix}.chat_messages
       (tenant_id,id,conversation_id,sequence,author_user_id,client_message_id,content,
        reply_to_message_id,reply_notify_author,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'author',$2,$5,$6,false,$7,$7)`,
      [tenant,id,conversation,sequence,JSON.stringify(content),reply,created]);
    const thread = async (id, parentId, rootId) => {
      await sql(`INSERT INTO ${prefix}.chat_conversations
        (tenant_id,id,type,visibility,parent_conversation_id,root_message_id,created_at,updated_at)
        VALUES ('tenant-a',$1,'thread','private',$2,$3,$4,$4)`, [id,parentId,rootId,created]);
    };
    const attachment = async (id, messageId) => {
      await sql(`INSERT INTO ${prefix}.chat_attachments
        (tenant_id,id,uploader_user_id,storage_key,file_name,content_type,size_bytes,created_at,updated_at,expires_at)
        VALUES ('tenant-a',$1,'author',$1,$1,'text/plain',12,$2,$2,'2030-01-02T00:00:00Z')`, [id,created]);
      await sql(`UPDATE ${prefix}.chat_attachments SET state='attached',attached_message_id=$2,
        checksum=$3,attached_at=$4,updated_at=$4 WHERE tenant_id='tenant-a' AND id=$1`,
        [id,messageId,`sha256:${"a".repeat(64)}`,created]);
    };
    const options = { database: harness.pool, schema: harness.schema, actor,
      permissions: harness.adapters.permissions, storage: harness.adapters.storage };
    const lookup = async (input = target, overrides = {}) => {
      const result = await queryMessageContext({ ...options, input, ...overrides });
      assert.deepEqual(parseMessageContextResult(result,input),result);
      return result;
    };
    const recorded = (executor = harness.pool) => {
      const calls = [];
      return { calls, database: { async query(text, values) {
        const result = await executor.query(text, values);
        calls.push({ text, values, rows: result.rows.length });
        return result;
      } } };
    };
    const snapshot = async () => {
      const result = {};
      for (const table of ["chat_read_cursors","chat_thread_follows","chat_conversation_members",
        "chat_conversation_preferences","chat_messages","chat_conversations","chat_outbox_events"]) {
        result[table] = (await sql(`SELECT COALESCE(jsonb_agg(value ORDER BY value::text),'[]'::jsonb) AS rows
          FROM (SELECT to_jsonb(row) AS value FROM ${prefix}.${table} AS row) AS snapshot`)).rows[0].rows;
      }
      return result;
    };

    await parent("parent", { visibility: "private", entity: true });
    await member("parent");
    await message("original", "parent", 1);
    await message("source", "parent", 2, { content: { format: "plain", text: "before edit",
      attachments: [{ attachmentId: "source-file" }] }, reply: "original" });
    await attachment("source-file", "source");
    await sql(`INSERT INTO ${prefix}.chat_messages
      (tenant_id,id,conversation_id,sequence,author_user_id,client_message_id,content,created_at,updated_at)
      SELECT 'tenant-a','new-' || n,'parent',n,'author','new-' || n,
        '{"format":"plain","text":"newer unrelated source"}'::jsonb,$1,$1
      FROM generate_series(3,202) AS n`, [created]);
    await thread("discussion", "parent", "source");
    await member("discussion");
    await message("thread-one", "discussion", 1);
    await message("thread-two", "discussion", 2);
    await sql(`INSERT INTO ${prefix}.chat_read_cursors
      (tenant_id,conversation_id,user_id,last_read_sequence,manual_unread_from_sequence)
      VALUES ('tenant-a','parent','reader',202,100),('tenant-a','discussion','reader',2,2)`);
    await sql(`INSERT INTO ${prefix}.chat_thread_follows
      (tenant_id,conversation_id,user_id,is_following,follow_source,follow_revision)
      VALUES ('tenant-a','discussion','reader',true,'manual',1)`);
    await sql(`INSERT INTO ${prefix}.chat_conversation_preferences
      (tenant_id,conversation_id,user_id,notification_level,muted,is_starred)
      VALUES ('tenant-a','discussion','reader','none',true,true)`);
    await parent("other");
    await parent("parent", { tenant: "tenant-b" });
    await parent("other", { tenant: "tenant-b" });
    await message("source", "parent", 1, { tenant: "tenant-b", content: { format: "plain", text: "other tenant content" } });
    await message("tenant-b-only", "parent", 2, { tenant: "tenant-b" });

    await t.test("old source resolves directly with current canonical edit, reply and thread enrichment", async () => {
      const latest = await queryMessageTimeline({ ...options,
        input: { conversationId: "parent", direction: "backward", limit: 100 } });
      assert.equal(latest.messages.length,100);
      assert.ok(latest.messages.every(m => m.id !== "source"));
      assert.equal((await lookup()).message.content.text,"before edit");
      await sql(`UPDATE ${prefix}.chat_messages SET content=jsonb_set(content,'{text}','"current edited source"'),
        current_revision=2,edited_at=$1,edited_by_user_id='author',updated_at=$1
        WHERE tenant_id='tenant-a' AND id='source'`, [updated]);
      const expected = await queryMessageTimeline({ ...options,
        input: { conversationId: "parent", direction: "backward", cursor: 3, limit: 1 } });
      assert.equal(expected.messages[0].attachmentMetadata.length,1,"real attached fixture hydrates on timeline");
      harness.calls.reset();
      const trace = recorded();
      const result = await lookup(target,trace);
      assert.equal(result.status,"available");
      assert.equal(result.sequence,2);
      assert.equal(result.message.tenantId,"tenant-a");
      assert.deepEqual(result.message,canonical(expected.messages[0]));
      assert.equal(result.message.content.text,"current edited source");
      assert.deepEqual(result.message.replyTo,{ messageId: "original", notifyAuthor: false });
      assert.deepEqual(result.message.threadSummary,{ threadId: "discussion", replyCount: 2,
        participantIds: ["author"], unreadCount: 1, lastReplyAt: created });
      assert.deepEqual(result.message.revision,{ revision: 2, editedAt: updated, editedByUserId: "author" });
      assert.equal(harness.calls.count("storage.createDownloadUrl"),0,"canonical context has no download metadata");
      assert.equal(trace.calls.length,2);
      assert.ok(trace.calls.every(call => call.rows <= 1));
      const exact = trace.calls[1];
      assert.deepEqual(exact.values,["tenant-a","reader","parent","source"]);
      assert.match(exact.text,/message\.tenant_id = \$1 AND message\.conversation_id = \$3 AND message\.id = \$4/);
      assert.doesNotMatch(exact.text,/chat_outbox|page_|replay|OFFSET|chat_reactions|chat_attachments/i);
      const plan = (await sql(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${exact.text}`,exact.values)).rows[0]["QUERY PLAN"][0];
      const nodes = [];
      const visit = node => { nodes.push(node); (node.Plans ?? []).forEach(visit); };
      visit(plan.Plan);
      const sourceScan = nodes.find(node => node.Alias === "message");
      assert.ok(sourceScan);
      assert.match(sourceScan["Node Type"],/Index/);
      assert.equal(sourceScan["Actual Rows"],1);
      assert.equal(sourceScan["Actual Loops"],1);
      assert.match(sourceScan["Index Cond"],/tenant_id.*tenant-a/);
      assert.match(sourceScan["Index Cond"],/id.*source/);
      t.diagnostic(`Exact-source EXPLAIN: ${sourceScan["Index Name"]}; one row, one loop; ${plan["Execution Time"]} ms`);
    });

    await t.test("reads leave cursors, follows, preferences, membership, messages and outbox unchanged", async () => {
      const before = await snapshot();
      const connection = await harness.pool.connect();
      try {
        await connection.query("BEGIN READ ONLY");
        const trace = recorded(connection);
        assert.equal((await lookup(target,trace)).status,"available");
        assert.equal(trace.calls.length,2);
        trace.calls.length = 0;
        assert.equal((await lookup({ conversationId: "discussion", messageId: "thread-one" },trace)).status,"available");
        assert.equal(trace.calls.length,3);
        await lookup({ ...target, messageId: "missing" },trace);
        await connection.query("COMMIT");
      } finally { connection.release(); }
      assert.deepEqual(await snapshot(),before);
    });

    await t.test("missing, wrong conversation, tenant and denied targets expose only requested identity", async () => {
      harness.calls.reset();
      for (const input of [{ ...target, messageId: "missing" }, { ...target, conversationId: "other" },
        { ...target, messageId: "tenant-b-only" }, { ...target, conversationId: "missing" }]) {
        assert.deepEqual(await lookup(input),unavailable(input));
      }
      // The identical request has the identical serialized result across denial,
      // absent tenant, wrong conversation and missing source conditions.
      const denied = await lookup(target,{ permissions: { authorizeEntity: async () => false } });
      assert.deepEqual(denied,unavailable(target));
      assert.equal(JSON.stringify(await lookup(target,{ actor: { ...actor, tenantId: "absent-tenant" } })),JSON.stringify(denied));
      await sql(`UPDATE ${prefix}.chat_messages SET conversation_id='other'
        WHERE tenant_id='tenant-b' AND id='source'`);
      assert.equal(JSON.stringify(await lookup(target,{ actor: { ...actor, tenantId: "tenant-b" } })),JSON.stringify(denied));
      await sql(`DELETE FROM ${prefix}.chat_messages WHERE tenant_id='tenant-b' AND id='source'`);
      assert.equal(JSON.stringify(await lookup(target,{ actor: { ...actor, tenantId: "tenant-b" } })),JSON.stringify(denied));
      assert.equal(harness.calls.count("storage.createDownloadUrl"),0);
    });

    await t.test("private parent and entity checks precede source hydration despite retained child participation", async () => {
      const input = { conversationId: "discussion", messageId: "thread-one" };
      assert.equal((await lookup(input)).status,"available");
      for (const state of ["left","removed"]) {
        await member("parent",state);
        const trace = recorded();
        harness.calls.reset();
        assert.deepEqual(await lookup(input,trace),unavailable(input));
        assert.equal(trace.calls.length,2,"admission and shared parent authorization only");
        assert.ok(trace.calls.every(call => !call.text.includes("AS message")));
        assert.equal(harness.calls.count("storage.createDownloadUrl"),0);
        assert.equal((await sql(`SELECT state FROM ${prefix}.chat_conversation_members
          WHERE tenant_id='tenant-a' AND conversation_id='discussion' AND user_id='reader'`)).rows[0].state,"active");
      }
      await member("parent");
      for (const request of [target,input]) {
        const trace = recorded();
        const calls = [];
        assert.deepEqual(await lookup(request,{ ...trace, permissions: { async authorizeEntity(value) {
          calls.push(value); return false;
        } } }),unavailable(request));
        assert.deepEqual(calls,[{ actor, entity: { type: "case", id: "parent" }, action: "conversation.timeline" }]);
        assert.ok(trace.calls.every(call => !call.text.includes("AS message")));
      }
      await sql(`UPDATE ${prefix}.chat_conversations SET archived_at=$1,archived_by_user_id='admin'
        WHERE tenant_id='tenant-a' AND id='discussion'`,[updated]);
      assert.equal((await lookup(input)).status,"available","archived child history follows shared read policy");
      await member("parent","removed");
      assert.deepEqual(await lookup(input),unavailable(input));
      await member("parent");
    });

    await t.test("direct and group conversations require current membership; public reads require none", async () => {
      for (const type of ["direct","group_direct"]) {
        await parent(type,{ type,visibility: "private" });
        await message(`${type}-source`,type,1);
        const input = { conversationId: type, messageId: `${type}-source` };
        assert.deepEqual(await lookup(input),unavailable(input));
        await member(type);
        assert.equal((await lookup(input)).status,"available");
        await member(type,"left");
        assert.deepEqual(await lookup(input),unavailable(input));
      }
      await message("public-source","other",1);
      assert.equal((await lookup({ conversationId: "other", messageId: "public-source" })).status,"available");
    });

    await t.test("deleted source returns canonical content-free shell without attachment downloads", async () => {
      await sql(`UPDATE ${prefix}.chat_messages SET deleted_at=$1,deleted_by_user_id='author',updated_at=$1
        WHERE tenant_id='tenant-a' AND id='source'`,[updated]);
      harness.calls.reset();
      const before = await snapshot();
      const result = await lookup();
      assert.equal(result.status,"deleted");
      assert.equal(result.message.content,null);
      assert.equal(result.message.deletedAt,updated);
      assert.equal(result.message.deletedByUserId,"author");
      assert.equal(result.sequence,2);
      assert.doesNotMatch(JSON.stringify(result),/current edited source|source-file|downloadUrl/);
      assert.equal(harness.calls.count("storage.createDownloadUrl"),0);
      assert.deepEqual(await snapshot(),before);
      await member("parent","removed");
      assert.deepEqual(await lookup(),unavailable(target),"deletion status also requires current access");
      await member("parent");
    });

    await t.test("validation and genuine database/permission failures remain errors", async () => {
      const trace = recorded();
      for (const input of [null,{}, { ...target,tenantId: "tenant-b" }, { ...target,messageId: " source" },
        { ...target,cursor: 1 }, { ...target,messageId: "x".repeat(256) }]) {
        await assert.rejects(lookup(input,trace),MessageContextParseError);
      }
      await assert.rejects(lookup(target,{ ...trace,schema: "bad;schema" }),TypeError);
      await assert.rejects(lookup(target,{ ...trace,actor: { ...actor,tenantId: "" } }),TypeError);
      assert.equal(trace.calls.length,0);
      const failure = new Error("temporary infrastructure outage");
      for (const input of [target,{ conversationId: "discussion",messageId: "thread-one" }]) {
        await assert.rejects(lookup(input,{ permissions: { authorizeEntity: async () => { throw failure; } } }),e => e === failure);
        assert.deepEqual(await lookup(input,{ permissions: { authorizeEntity: async () => { throw new ChatAuthorizationError(); } } }),unavailable(input));
        for (let failedQuery = 1; failedQuery <= (input === target ? 2 : 3); failedQuery++) {
          let calls = 0;
          const database = { query(text,values) {
            if (++calls === failedQuery) throw failure;
            return sql(text,values);
          } };
          await assert.rejects(lookup(input,{ database }),e => e === failure);
        }
      }
      // A malformed persisted custom block must fail canonical validation, never
      // turn into a successful unavailable result.
      await message("invalid-canonical","other",2,{ content: { format: "plain",text: "bad",blocks: [{ type: "text" }] } });
      await assert.rejects(lookup({ conversationId: "other",messageId: "invalid-canonical" }),MessageContextParseError);
    });
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});
