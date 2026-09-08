import assert from "node:assert/strict";
import test from "node:test";
import { queryThreadList } from "../src/server/thread-list-query.ts";
import { parseThreadListResult, compareThreadListPositions, ThreadListParseError } from "../src/contracts/thread-list.ts";
import { ChatAuthorizationError } from "../src/server/request-context.ts";
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import { handrailChatPostgresMigrations } from "../src/server/postgres-schema-migrations.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";

// No shared dist and no fake/skip fallback:
// node_modules/.bin/esbuild test/postgres-thread-list-query.test.mjs --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/thread-list-tests.mjs
// node --test --test-concurrency=1 "$PWD/node_modules/.cache/thread-list-tests.mjs"
const actor = { tenantId: "tenant-a", userId: "reader", roles: [] };
const created = "2026-01-01T00:00:00.000Z";
const evaluated = "2026-01-01T01:00:00.000Z";
const denied = error => error instanceof ChatAuthorizationError &&
  error.message === "Chat authorization failed" && error.statusCode === 403 && error.cause === undefined;
const ids = result => result.items.map(item => item.thread.id);

test("channel discovery uses real PostgreSQL and canonical migrations", async t => {
  const backend = await createPostgresTestBackend();
  let harness;
  try {
    harness = await backend.createHarness({ schemaPrefix: "chat_thread_list" });
    const prefix = `"${harness.schema}"`;
    const sql = (text, values) => harness.pool.query(text, values);
    await createPostgresMigrationRunner({ database: harness.pool, schema: harness.schema,
      migrations: handrailChatPostgresMigrations }).apply();
    t.diagnostic(`Real PostgreSQL ${backend.kind}; isolated schema, canonical migrations`);
    const parent = async (id, { tenant = "tenant-a", visibility = "public", type = "channel", entity = false } = {}) => {
      await sql(`INSERT INTO ${prefix}.chat_conversations
        (tenant_id,id,type,visibility,name,entity_type,entity_id,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [tenant,id,type,visibility,type === "channel" ? id : null,entity ? "case" : null,entity ? id : null,created]);
    };
    const thread = async (id, parentId, { tenant = "tenant-a", at = created, name = null } = {}) => {
      const rootId = `${id}-root`;
      await sql(`INSERT INTO ${prefix}.chat_messages
        (tenant_id,id,conversation_id,sequence,author_user_id,client_message_id,content,created_at,updated_at)
        VALUES ($1,$2,$3,(SELECT COALESCE(max(sequence),0)+1 FROM ${prefix}.chat_messages
          WHERE tenant_id=$1 AND conversation_id=$3),'author',$2,'{"format":"plain","text":"root"}',$4,$4)`,
      [tenant,rootId,parentId,created]);
      await sql(`INSERT INTO ${prefix}.chat_conversations
        (tenant_id,id,type,visibility,parent_conversation_id,root_message_id,name,created_at,updated_at)
        VALUES ($1,$2,'thread','private',$3,$4,$5,$6,$6)`, [tenant,id,parentId,rootId,name,at]);
    };
    const member = (id, { tenant = "tenant-a", role = "member", state = "active", user = "reader" } = {}) => sql(
      `INSERT INTO ${prefix}.chat_conversation_members (tenant_id,conversation_id,user_id,role,state)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,conversation_id,user_id)
       DO UPDATE SET role=EXCLUDED.role,state=EXCLUDED.state`, [tenant,id,user,role,state]);
    const message = async (id, conversation, sequence, { at = created, author = "author", reply = null, ping = false, mentions = [] } = {}) => {
      await sql(`INSERT INTO ${prefix}.chat_messages
        (tenant_id,id,conversation_id,sequence,author_user_id,client_message_id,content,
         reply_to_message_id,reply_notify_author,created_at,updated_at)
        VALUES ('tenant-a',$1,$2,$3,$4,$1,$5,$6,$7,$8,$8)`,
      [id,conversation,sequence,author,JSON.stringify({ format:"plain",text:id,mentions }),reply,ping,at]);
      await sql(`UPDATE ${prefix}.chat_conversations SET current_message_sequence=$2
        WHERE tenant_id='tenant-a' AND id=$1`, [conversation,sequence]);
    };
    const archive = id => sql(`UPDATE ${prefix}.chat_conversations SET archived_at=$2,
      archived_by_user_id='admin',updated_at=$2 WHERE tenant_id='tenant-a' AND id=$1`, [id,evaluated]);
    const removeMessage = id => sql(`UPDATE ${prefix}.chat_messages SET deleted_at=$2,
      deleted_by_user_id='admin',updated_at=$2 WHERE tenant_id='tenant-a' AND id=$1`, [id,evaluated]);
    const calls = [];
    let host = "allow";
    const permissions = { async authorizeEntity(input) {
      calls.push(input);
      if (host === "error") throw new Error("private details");
      return host === "allow";
    } };
    const list = async (parentConversationId, request = {}, overrides = {}) => {
      const input = { parentConversationId, ...request };
      const result = await queryThreadList({ database: harness.pool, schema: harness.schema,
        actor, permissions, input, lifecycleSupported: true, now: () => new Date(evaluated), ...overrides });
      assert.deepEqual(parseThreadListResult(result, input), result);
      return result;
    };
    const snapshot = async () => {
      const tables = await sql("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename", [harness.schema]);
      const state = {};
      for (const { tablename } of tables.rows) {
        state[tablename] = (await sql(`SELECT COALESCE(jsonb_agg(row ORDER BY row::text),'[]') AS rows
          FROM (SELECT to_jsonb(t) AS row FROM ${prefix}."${tablename}" AS t) AS data`)).rows[0].rows;
      }
      return state;
    };

    await t.test("public unfollowed discovery preserves canonical names and soft-deleted root links with zero writes", async () => {
      await parent("public");
      await thread("named", "public", { name: "Launch date" });
      await thread("unnamed", "public");
      await removeMessage("named-root");
      const before = await snapshot();
      const connection = await harness.pool.connect();
      try {
        await connection.query("BEGIN READ ONLY");
        const result = await list("public", {}, { database: connection });
        assert.deepEqual(ids(result), ["named", "unnamed"]);
        const item = result.items[0];
        assert.equal(item.thread.name, "Launch date");
        assert.equal(item.thread.rootMessageId, "named-root");
        assert.equal(item.thread.parentConversationId, "public");
        assert.equal(item.thread.tenantId, "tenant-a");
        assert.deepEqual(item.currentThreadFollow, { followRevision: 0, follow: null });
        assert.equal(item.thread.currentReadState.lastReadSequence, 0);
        assert.deepEqual(item.thread.activeMemberUserIds, []);
        assert.equal(item.thread.currentPreference.notificationPreference, "all");
        assert.equal(item.lastActivityAt, created);
        assert.equal(item.hideAt, null);
        assert.equal(result.items[1].thread.name, undefined);
        await connection.query("COMMIT");
      } finally { connection.release(); }
      assert.deepEqual(await snapshot(), before);
    });

    await t.test("private-parent revocation reauthorizes every page despite retained child owners and follows", async () => {
      await parent("private", { visibility:"private" });
      await thread("private-a", "private");
      await thread("private-b", "private");
      await member("private-a", { role:"owner" });
      await member("private");
      await sql(`INSERT INTO ${prefix}.chat_thread_follows
        (tenant_id,conversation_id,user_id,is_following,follow_source,follow_revision)
        VALUES ('tenant-a','private-a','reader',true,'manual',1)`);
      await member("private", { state:"removed" });
      let resolutions = 0;
      const options = { resolveInactivityPolicy: async () => { resolutions++; return false; } };
      await assert.rejects(list("private", {}, options), denied);
      assert.equal(resolutions, 0);
      await member("private");
      const first = await list("private", { limit:1 });
      assert.ok(first.nextCursor);
      for (const state of ["left", "removed"]) {
        await member("private", { state });
        await assert.rejects(list("private", { limit:1, cursor:first.nextCursor }, options), denied);
      }
      await sql(`DELETE FROM ${prefix}.chat_conversation_members WHERE tenant_id='tenant-a' AND conversation_id='private'`);
      await assert.rejects(list("private"), denied);
      await member("private");
      assert.deepEqual(ids(await list("private", { limit:1, cursor:first.nextCursor })), ["private-b"]);
    });

    await t.test("empty channels obey tenant, entity, archive and channel-only authorization before policy resolution", async () => {
      await parent("empty");
      await parent("empty-private", { visibility:"private" });
      await parent("empty-entity", { entity:true });
      await parent("empty-other", { tenant:"tenant-b" });
      await parent("empty", { tenant:"tenant-b", visibility:"private" });
      await member("empty", { tenant:"tenant-b" });
      await parent("direct", { type:"direct", visibility:"private" });
      await parent("group", { type:"group_direct", visibility:"private" });
      await member("direct");
      await member("group");
      await parent("empty-archived");
      await archive("empty-archived");
      assert.deepEqual(ids(await list("empty")), []);
      for (const id of ["empty-private","empty-other","empty-archived","direct","group","named","missing"]) {
        await assert.rejects(list(id, {}, { resolveInactivityPolicy: async () => { assert.fail("unauthorized policy call"); } }), denied);
      }
      await parent("empty-private", { tenant:"tenant-b", visibility:"private" });
      await member("empty-private", { tenant:"tenant-b" });
      await assert.rejects(list("empty-private"), denied);
      for (const mode of ["deny", "error"]) {
        host = mode;
        await assert.rejects(list("empty-entity"), denied);
      }
      host = "allow";
      const scopes = [];
      assert.deepEqual(ids(await list("empty-entity", {}, { resolveInactivityPolicy: async scope => {
        scopes.push(scope); return false;
      } })), []);
      assert.deepEqual(scopes, [{ tenantId:"tenant-a",parentConversationId:"empty-entity" }]);
      assert.deepEqual(calls.at(-1), { actor, entity:{ type:"case",id:"empty-entity" },action:"thread.list" });
      await parent("collision", { visibility:"private" });
      await parent("collision", { tenant:"tenant-b" });
      await thread("collision-thread", "collision", { tenant:"tenant-b" });
      await member("collision", { tenant:"tenant-b" });
      await assert.rejects(list("collision"), denied);
      assert.deepEqual(ids(await list("collision", {}, { actor:{ ...actor,tenantId:"tenant-b" } })), ["collision-thread"]);
      await thread("entity-thread", "empty-entity");
      host = "deny";
      await assert.rejects(list("empty-entity"), denied);
      host = "allow";
      assert.deepEqual(ids(await list("empty-entity")), ["entity-thread"]);
    });

    await t.test("administrative archives exclude children in both views and deny archived parents", async () => {
      await parent("archives");
      await thread("archived-thread", "archives");
      await thread("kept-thread", "archives");
      await archive("archived-thread");
      for (const view of ["active","all"]) assert.deepEqual(ids(await list("archives", { view })), ["kept-thread"]);
      await archive("archives");
      for (const view of ["active","all"]) await assert.rejects(list("archives", { view }), denied);
    });

    await t.test("exclusive millisecond/C pagination handles ties, submilliseconds, Unicode and changing limits without duplicate IDs", async () => {
      await parent("pages");
      const positions = [];
      for (const [id,at] of [
        ["Z","2026-01-01T00:00:00.001001Z"], ["a","2026-01-01T00:00:00.001999Z"],
        ["é","2026-01-01T00:00:00.001500Z"], ["😀","2026-01-01T00:00:00.001100Z"],
        ["A","2026-01-01T00:00:00.002000Z"], ["old",created],
      ]) {
        await thread(id,"pages",{ at });
        positions.push({ threadId:id,createdAt:new Date(at).toISOString() });
      }
      positions.sort(compareThreadListPositions);
      const found = [];
      let cursor;
      let first;
      do {
        const result = await list("pages", { limit: cursor ? 2 : 1, ...(cursor ? { cursor } : {}) });
        first ??= result;
        found.push(...ids(result));
        cursor = result.nextCursor;
        await sql(`UPDATE ${prefix}.chat_conversations SET updated_at=$1,name='renamed'
          WHERE tenant_id='tenant-a' AND parent_conversation_id='pages'`, [evaluated]);
      } while (cursor);
      assert.deepEqual(found,positions.map(p => p.threadId));
      assert.equal(new Set(found).size,6);
      assert.equal((await list("pages",{ limit:100 })).nextCursor,undefined);
      for (const input of [{ view:"all",cursor:first.nextCursor }, { cursor:"broken" }, { limit:0 }, { limit:101 }, { limit:1.5 }, { tenantId:"tenant-b" }]) {
        await assert.rejects(list("pages",input),ThreadListParseError);
      }
      await assert.rejects(list("public", { cursor:first.nextCursor }),ThreadListParseError);
      const connection = await harness.pool.connect();
      try {
        await connection.query("SET TIME ZONE 'Pacific/Auckland'");
        assert.deepEqual(ids(await list("pages",{}, { database:connection })),found);
      } finally { await connection.query("RESET TIME ZONE"); connection.release(); }
    });

    await t.test("follow, retained membership, preferences and read cursors remain independent of authoritative unread pings", async () => {
      await parent("state");
      await thread("state-thread","state");
      await message("source","state-thread",1,{ author:"reader" });
      await message("ping","state-thread",2,{ reply:"source",ping:true });
      await message("both","state-thread",3,{ reply:"source",ping:true,mentions:[{ type:"user",userId:"reader" }] });
      await message("no-ping","state-thread",4,{ reply:"source" });
      await message("self-ping","state-thread",5,{ author:"reader",reply:"source",ping:true });
      await message("deleted-ping","state-thread",6,{ reply:"source",ping:true });
      await removeMessage("deleted-ping");
      let item = (await list("state")).items[0];
      assert.equal(item.thread.unreadMentionCount,2,"OR predicate counts a dual mention once");
      assert.deepEqual(item.currentThreadFollow,{ followRevision:0,follow:null });
      await member("state-thread",{ role:"moderator",state:"left" });
      await member("state-thread",{ user:"participant" });
      await sql(`INSERT INTO ${prefix}.chat_thread_follows
        (tenant_id,conversation_id,user_id,is_following,follow_source,follow_revision)
        VALUES ('tenant-a','state-thread','reader',false,'manual',2)`);
      await sql(`INSERT INTO ${prefix}.chat_conversation_preferences
        (tenant_id,conversation_id,user_id,notification_level,muted,is_starred)
        VALUES ('tenant-a','state-thread','reader','none',true,true)`);
      await sql(`INSERT INTO ${prefix}.chat_read_cursors
        (tenant_id,conversation_id,user_id,last_read_sequence,manual_unread_from_sequence)
        VALUES ('tenant-a','state-thread','reader',6,2)`);
      const before = await snapshot();
      const connection = await harness.pool.connect();
      try {
        await connection.query("BEGIN READ ONLY");
        item = (await list("state",{}, { database:connection })).items[0];
        assert.equal(item.currentThreadFollow.followRevision,2);
        assert.equal(item.currentThreadFollow.follow.isFollowing,false);
        assert.equal(item.currentThreadFollow.follow.source,"manual");
        assert.equal(item.thread.currentMember.state,"left");
        assert.deepEqual(item.thread.activeMemberUserIds,["participant"]);
        assert.equal(item.thread.currentPreference.notificationPreference,"none");
        assert.equal(item.thread.currentPreference.isStarred,true);
        assert.equal(item.thread.currentPreference.mute.muted,true);
        assert.equal(item.thread.currentReadState.lastReadSequence,6);
        assert.equal(item.thread.currentReadState.manualUnreadFromSequence,2);
        assert.equal(item.thread.unreadMentionCount,2);
        await connection.query("COMMIT");
      } finally { connection.release(); }
      assert.deepEqual(await snapshot(),before);
      await sql(`UPDATE ${prefix}.chat_thread_follows SET is_following=true,follow_revision=3
        WHERE tenant_id='tenant-a' AND conversation_id='state-thread'`);
      assert.equal((await list("state")).items[0].thread.unreadMentionCount,2);
      await removeMessage("source");
      assert.equal((await list("state")).items[0].thread.unreadMentionCount,1,"explicit mention survives deleted reply source");
      await sql(`UPDATE ${prefix}.chat_read_cursors SET manual_unread_from_sequence=NULL
        WHERE tenant_id='tenant-a' AND conversation_id='state-thread'`);
      assert.equal((await list("state")).items[0].thread.unreadMentionCount,0);
      assert.equal((await list("state",{}, { actor:{ ...actor,userId:"different" } })).items[0].currentThreadFollow.follow,null);
    });

    await t.test("absent, disabled, invalid and failed policies disable hiding; empty threads use creation", async () => {
      await parent("timer");
      await thread("empty-timer","timer");
      const invalid = [undefined,false,null,{}, { hideAfterMs:0 },{ hideAfterMs:-1 },
        { hideAfterMs:Infinity },{ hideAfterMs:NaN },{ hideAfterMs:"1" },{ hideAfterMs:1,extra:true }];
      for (const value of invalid) {
        const result = await list("timer",{}, { resolveInactivityPolicy:async () => value });
        assert.deepEqual(ids(result),["empty-timer"]);
        assert.equal(result.inactivityPolicy,false);
        assert.equal(result.items[0].hideAt,null);
        assert.equal(result.items[0].lastActivityAt,created);
        assert.equal(result.items[0].thread.activityAt,created);
      }
      for (const resolver of [undefined,false,17,async () => { throw new Error("configuration unavailable"); }]) {
        assert.equal((await list("timer",{}, { resolveInactivityPolicy:resolver })).inactivityPolicy,false);
      }
    });

    await t.test("elapsed timers preserve all-view history; only an actual new message restores activity", async () => {
      const timer = { resolveInactivityPolicy:async () => ({ hideAfterMs:60_000 }) };
      assert.deepEqual(ids(await list("timer",{},timer)),[]);
      const initial = await list("timer",{ view:"all" },timer);
      assert.equal(initial.evaluatedAt,evaluated);
      assert.equal(initial.items[0].hideAt,Date.parse(created)+60_000);
      await message("old-message","empty-timer",1,{ at:"2026-01-01T00:10:00.000Z" });
      await sql(`UPDATE ${prefix}.chat_conversations SET updated_at=$1,name='renamed',locked=true,lifecycle_revision=1,
        closed_at=$1,closed_by_user_id='admin'
        WHERE tenant_id='tenant-a' AND id='empty-timer'`, [evaluated]);
      await sql(`UPDATE ${prefix}.chat_messages SET updated_at=$1,edited_at=$1,edited_by_user_id='author',
        content='{"format":"plain","text":"edited"}' WHERE tenant_id='tenant-a' AND id='old-message'`, [evaluated]);
      await member("empty-timer");
      await sql(`INSERT INTO ${prefix}.chat_thread_follows
        (tenant_id,conversation_id,user_id,is_following,follow_source,follow_revision)
        VALUES ('tenant-a','empty-timer','reader',true,'manual',1)`);
      await sql(`INSERT INTO ${prefix}.chat_read_cursors
        (tenant_id,conversation_id,user_id,last_read_sequence) VALUES ('tenant-a','empty-timer','reader',1)`);
      await sql(`INSERT INTO ${prefix}.chat_conversation_preferences
        (tenant_id,conversation_id,user_id,notification_level) VALUES ('tenant-a','empty-timer','reader','mentions')`);
      for (let retry=0;retry<2;retry++) {
        assert.deepEqual(ids(await list("timer",{},timer)),[]);
        assert.equal((await list("timer",{ view:"all" },timer)).items[0].lastActivityAt,"2026-01-01T00:10:00.000Z");
      }
      await sql(`UPDATE ${prefix}.chat_conversations SET locked=false,closed_at=NULL,closed_by_user_id=NULL,lifecycle_revision=2
        WHERE tenant_id='tenant-a' AND id='empty-timer'`);
      assert.deepEqual(ids(await list("timer",{},timer)),[],"reopening does not refresh inactivity");
      await message("new-message","empty-timer",2,{ at:"2026-01-01T00:59:30.000999Z" });
      const active = await list("timer",{},timer);
      assert.deepEqual(ids(active),["empty-timer"]);
      assert.equal(active.items[0].lastActivityAt,"2026-01-01T00:59:30.000Z");
      await removeMessage("new-message");
      assert.equal((await list("timer",{},timer)).items[0].lastActivityAt,"2026-01-01T00:59:30.000Z",
        "soft-deletion does not replace actual persisted message creation activity");
    });

    await t.test("closed and locked are distinct; capability false preserves legacy eligibility and omits lifecycle", async () => {
      await parent("lifecycle");
      for (const id of ["closed","locked-closed","open"]) await thread(id,"lifecycle");
      await sql(`UPDATE ${prefix}.chat_conversations SET closed_at=$1,closed_by_user_id='admin',
        lifecycle_revision=1,updated_at=$1 WHERE tenant_id='tenant-a' AND id='closed'`, [evaluated]);
      await sql(`UPDATE ${prefix}.chat_conversations SET locked=true,lifecycle_revision=1,closed_at=$1,closed_by_user_id='admin',updated_at=$1
        WHERE tenant_id='tenant-a' AND id='locked-closed'`, [evaluated]);
      assert.deepEqual(ids(await list("lifecycle")),["open"]);
      const all = await list("lifecycle",{ view:"all" });
      assert.deepEqual(ids(all),["closed","locked-closed","open"]);
      assert.equal(all.items[0].thread.threadLifecycle.closedAt,evaluated);
      assert.equal(all.items[0].thread.threadLifecycle.locked,false);
      assert.equal(all.items[1].thread.threadLifecycle.locked,true);
      await sql(`UPDATE ${prefix}.chat_conversations SET locked=false,lifecycle_revision=2
        WHERE tenant_id='tenant-a' AND id='locked-closed'`);
      assert.deepEqual(ids(await list("lifecycle")),["open"],"unlocking leaves the thread closed");
      const legacy = await list("lifecycle",{}, { lifecycleSupported:false });
      assert.deepEqual(ids(legacy),["closed","locked-closed","open"]);
      assert.ok(legacy.items.every(item => item.thread.threadLifecycle === undefined));
      await assert.rejects(list("lifecycle",{}, { lifecycleSupported:undefined }),TypeError);
    });

    await t.test("elapsed comparison respects exact, fractional and sub-ULP durations", async () => {
      await parent("boundary");
      await thread("boundary-thread","boundary",{ at:evaluated });
      for (const [elapsed,duration,visible] of [[0,Number.MIN_VALUE,true],[0,0.000001,true],
        [1,0.5,false],[1,1,false],[1,1.5,true],[2,1.5,false],[60_000,60_000,false]]) {
        const options = { now:() => new Date(Date.parse(evaluated)+elapsed),
          resolveInactivityPolicy:async () => ({ hideAfterMs:duration }) };
        const result = await list("boundary",{},options);
        assert.equal(result.items.length,visible ? 1 : 0,`${elapsed} elapsed / ${duration} duration`);
        const all = await list("boundary",{ view:"all" },options);
        assert.equal(all.items[0].hideAt,Date.parse(evaluated)+duration);
      }
    });

    await t.test("activity uses the latest creation timestamp even when message sequence differs", async () => {
      await parent("message-order");
      await thread("message-order-thread","message-order");
      await message("later-time","message-order-thread",1,{ at:"2026-01-01T00:59:30.000Z" });
      await message("later-sequence","message-order-thread",2,{ at:"2026-01-01T00:10:00.000Z" });
      const result = await list("message-order",{}, {
        resolveInactivityPolicy:async () => ({ hideAfterMs:60_000 }),
      });
      assert.equal(result.items[0].lastActivityAt,"2026-01-01T00:59:30.000Z");
      assert.equal(result.items[0].thread.latestSequence,2);
    });

    await t.test("inspect the existing partial tenant/parent index and explain the actual discovery query", async () => {
      const result = await sql("SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='chat_conversations_parent_thread_idx'",[harness.schema]);
      assert.match(result.rows[0].indexdef,/\(tenant_id, parent_conversation_id\).*WHERE.*thread/);
      // Inspect the actual query with the fixture's selective parent; no forced
      // planner settings and no schema changes for a tiny synthetic workload.
      let plan;
      const database = { async query(text, values) {
        if (text.startsWith("WITH candidates")) {
          plan = (await sql(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`,values)).rows[0]["QUERY PLAN"];
        }
        return sql(text,values);
      } };
      await list("pages",{}, { database });
      assert.ok(plan);
      const indexes = new Set();
      const visit = node => { if (node["Index Name"]) indexes.add(node["Index Name"]); (node.Plans ?? []).forEach(visit); };
      visit(plan[0].Plan);
      t.diagnostic(`Discovery EXPLAIN: rows=${plan[0].Plan["Actual Rows"]}, executionMs=${plan[0]["Execution Time"]}, indexes=${[...indexes].join(",")}`);
    });
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});
