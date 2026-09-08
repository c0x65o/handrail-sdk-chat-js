import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import { createChatServer } from "../src/server/create-chat-server.ts";
import { MESSAGE_CONTEXT_PATH, parseMessageContextResult } from "../src/contracts/message-context.ts";
import { ChatAuthorizationError } from "../src/server/request-context.ts";
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import { handrailChatPostgresMigrations } from "../src/server/postgres-schema-migrations.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";

// Bundle canonical sources into node_modules/.cache (two levels below package.json).
// Use the existing isolated PostgreSQL backend; no database fake or skip fallback.
const actor = { tenantId: "tenant-a", userId: "reader", roles: ["member"] };
const target = { conversationId: "public", messageId: "source" };
const path = (conversation = target.conversationId, message = target.messageId) =>
  `/conversations/${conversation}/messages/${message}/context`;
const unavailable = input => ({ ...input, status: "unavailable" });

async function withHttp(runtime, callback) {
  // Source lookups must be measured independently of normal background maintenance.
  await Promise.all([runtime.outboxPublisher.stop(), runtime.postgresMaintenance.stop()]);
  const server = createServer(runtime.router);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (route, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}${route}`, {
      method: "GET", headers: { ...headers, ...(body === undefined ? {} : { "content-length": Buffer.byteLength(body) }) },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.on("error", reject);
    request.end(body);
  });
  try { await callback(get); }
  finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await runtime.close();
  }
}

function assertError(result, status, code, message) {
  assert.equal(result.status, status);
  assert.equal(result.headers["cache-control"], "private, no-store");
  assert.deepEqual(result.body, { error: { code, message } });
}

test("message context HTTP uses trusted actor and read-only real PostgreSQL", { timeout: 60_000 }, async t => {
  const backend = await createPostgresTestBackend();
  let harness, connection;
  try {
    harness = await backend.createHarness({ schemaPrefix: "chat_context_http" });
    const prefix = `"${harness.schema}"`;
    const sql = (text, values) => harness.pool.query(text, values);
    await createPostgresMigrationRunner({ database: harness.pool, schema: harness.schema,
      migrations: handrailChatPostgresMigrations }).apply();
    t.diagnostic(`Real PostgreSQL ${backend.kind}; isolated schema and canonical migrations`);
    await sql(`INSERT INTO ${prefix}.chat_conversations (tenant_id,id,type,visibility,name,entity_type,entity_id)
      VALUES ('tenant-a','public','channel','public','Public',null,null),
        ('tenant-a','private','channel','private','Private',null,null),
        ('tenant-a','entity','channel','public','Entity','case','secret-case'),
        ('tenant-a','encoded/é','channel','public','Encoded',null,null),
        ('tenant-b','public','channel','public','Other tenant',null,null)`);
    const message = (id, conversation, sequence, tenant = 'tenant-a', content = { format: 'plain', text: id }) => sql(
      `INSERT INTO ${prefix}.chat_messages
        (tenant_id,id,conversation_id,sequence,author_user_id,client_message_id,content,created_at,updated_at)
        VALUES ($1,$2,$3,$4,'author',$2,$5,'2026-01-01','2026-01-01')`, [tenant,id,conversation,sequence,JSON.stringify(content)]);
    await message('source','public',1);
    await message('deleted','public',2,'tenant-a',{ format: 'plain', text: 'deleted secret content' });
    await sql(`UPDATE ${prefix}.chat_messages SET deleted_at='2026-01-02',deleted_by_user_id='author',updated_at='2026-01-02'
      WHERE tenant_id='tenant-a' AND id='deleted'`);
    await message('malformed','public',3,'tenant-a',{ format: 'plain', text: 'bad persisted block', blocks: [{ type: 'text' }] });
    await message('private-root','private',1);
    await message('entity-root','entity',1);
    await message('encoded/ß','encoded/é',1);
    await message('source','public',1,'tenant-b',{ format: 'plain', text: 'other tenant secret' });
    await message('tenant-b-only','public',2,'tenant-b');
    for (const [id,parent,root] of [['private-child','private','private-root'], ['entity-child','entity','entity-root']]) {
      await sql(`INSERT INTO ${prefix}.chat_conversations
        (tenant_id,id,type,visibility,parent_conversation_id,root_message_id)
        VALUES ('tenant-a',$1,'thread','private',$2,$3)`, [id,parent,root]);
      await message(`${id}-reply`,id,1);
    }
    await sql(`INSERT INTO ${prefix}.chat_conversation_members (tenant_id,conversation_id,user_id,role,state)
      VALUES ('tenant-a','private-child','reader','owner','active'),
        ('tenant-a','private','reader','member','active')`);
    await sql(`INSERT INTO ${prefix}.chat_thread_follows
      (tenant_id,conversation_id,user_id,is_following,follow_source,follow_revision)
      VALUES ('tenant-a','private-child','reader',true,'manual',1)`);
    await sql(`INSERT INTO ${prefix}.chat_read_cursors (tenant_id,conversation_id,user_id,last_read_sequence)
      VALUES ('tenant-a','private-child','reader',0)`);
    await sql(`UPDATE ${prefix}.chat_conversation_members SET state='removed'
      WHERE tenant_id='tenant-a' AND conversation_id='private' AND user_id='reader'`);

    const snapshot = async () => {
      const result = {};
      const tables = (await sql('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',[harness.schema])).rows;
      for (const { tablename } of tables) {
        result[tablename] = (await sql(`SELECT COALESCE(jsonb_agg(row ORDER BY row::text),'[]') AS rows
          FROM (SELECT to_jsonb(t) AS row FROM ${prefix}."${tablename}" AS t) AS data`)).rows[0].rows;
      }
      return result;
    };
    let authCalls = 0, connectCalls = 0, admissionAllowed = true, entityAllowed = true, permissionError;
    const queries = [], admissions = [], outcomes = [], entityCalls = [];
    const database = {
      query(text, values) { queries.push({ text, values }); return (connection ?? harness.pool).query(text, values); },
      connect() { connectCalls++; return harness.pool.connect(); },
    };
    const config = {
      database: { pool: database, schema: harness.schema },
      auth: { async resolveActor(request) {
        authCalls++;
        return request.headers.authorization === 'invalid' ? null : actor;
      } },
      directory: { async getUser() { assert.fail('context queried directory'); }, async searchUsers() { assert.fail('context searched directory'); } },
      permissions: { async getCapabilities() { return []; }, async authorizeEntity(input) {
        entityCalls.push(input);
        if (permissionError) throw permissionError;
        return entityAllowed;
      } },
      admission: { async admit(input) {
        admissions.push(input);
        return admissionAllowed ? { decision: 'allow' } : { decision: 'deny', retryAfterSeconds: 12 };
      } },
      httpObservability: { onOutcome: outcome => outcomes.push(outcome) },
    };
    await withHttp(createChatServer(config), async get => {
      const before = await snapshot();
      connection = await harness.pool.connect();
      await connection.query('BEGIN READ ONLY');
      queries.length = 0;
      const initialConnections = connectCalls;
      const lookup = async (input = target) => {
        const result = await get(path(encodeURIComponent(input.conversationId),encodeURIComponent(input.messageId)));
        assert.equal(result.status,200);
        assert.equal(result.headers['cache-control'],'private, no-store');
        assert.deepEqual(parseMessageContextResult(result.body,input),result.body);
        return result.body;
      };
      await t.test('admitted canonical success passes trusted actor and configured schema; decodes both identifiers', async () => {
        const result = await lookup();
        assert.equal(result.status,'available');
        assert.equal(result.sequence,1);
        assert.equal(result.message.tenantId,actor.tenantId);
        assert.equal(result.message.content.text,'source');
        assert.equal(result.message.threadSummary,undefined,'reading an original must not create a thread');
        assert.deepEqual(queries.at(-1).values,['tenant-a','reader','public','source']);
        assert.ok(queries.every(query => query.text.includes(prefix)));
        assert.equal(admissions.at(-1).routeTemplate,MESSAGE_CONTEXT_PATH);
        assert.equal(admissions.at(-1).method,'GET');
        assert.equal(outcomes.at(-1).routeTemplate,MESSAGE_CONTEXT_PATH);
        assert.equal(outcomes.at(-1).tenantId,actor.tenantId);
        assert.equal(outcomes.at(-1).userId,actor.userId);
        assert.equal(outcomes.at(-1).statusCode,200);
        const entityTarget = { conversationId: 'entity', messageId: 'entity-root' };
        assert.equal((await lookup(entityTarget)).status,'available');
        assert.deepEqual(entityCalls.at(-1),{ actor, entity: { type: 'case', id: 'secret-case' }, action: 'conversation.timeline' });
        assert.equal((await lookup({ conversationId: 'encoded/é', messageId: 'encoded/ß' })).status,'available');
      });
      await t.test('malformed encoding and bounded identifiers in either parameter fail before SQL', async () => {
        const beforeQueries = queries.length;
        for (const id of ['%ZZ','%E0%A4%A','%20','%20source','source%20','%00','%1F','%7F','%C2%85','%E2%80%A8','x'.repeat(256),encodeURIComponent('é'.repeat(128))]) {
          for (const route of [path(id),path('public',id)]) {
            assertError(await get(route),400,'chat_message_context_invalid_request','Invalid message context request');
          }
        }
        assert.equal(queries.length,beforeQueries);
      });
      await t.test('query fields, GET bodies and spoofed trusted-context headers are rejected', async () => {
        const beforeQueries = queries.length;
        for (const query of ['tenantId=tenant-b','userId=admin','actor=admin','roles=admin','conversationId=private',
          'messageId=deleted','cursor=1','limit=1','unknown=1','unknown=1&unknown=2','__proto__=spoof']) {
          assertError(await get(`${path()}?${query}`),400,'chat_message_context_invalid_request','Invalid message context request');
        }
        for (const options of [{ body: '{}' }, { body: '{"actor":{"tenantId":"tenant-b","userId":"admin"}}' },
          { headers: { 'transfer-encoding': 'chunked' } },
          ...['x-user-id','x-tenant-id','x-chat-actor','x-handrail-roles','capabilities'].map(header => ({ headers: { [header]: 'spoof' } }))]) {
          assertError(await get(path(),options),400,'chat_message_context_invalid_request','Invalid message context request');
        }
        assert.equal(queries.length,beforeQueries);
      });
      await t.test('missing, tenant-isolated and inaccessible targets share canonical unavailable shape', async () => {
        for (const input of [{ ...target,messageId: 'missing' }, { ...target,messageId: 'tenant-b-only' },
          { ...target,conversationId: 'missing' }, { ...target,conversationId: 'entity' },
          { conversationId: 'private',messageId: 'private-root' },
          { conversationId: 'private-child',messageId: 'private-child-reply' }]) {
          assert.deepEqual(await lookup(input),unavailable(input));
        }
        for (const input of [{ conversationId: 'entity',messageId: 'entity-root' },
          { conversationId: 'entity-child',messageId: 'entity-child-reply' }]) {
          entityAllowed = false;
          const denied = await lookup(input);
          assert.deepEqual(denied,unavailable(input));
          permissionError = new ChatAuthorizationError();
          assert.deepEqual(await lookup(input),denied);
          permissionError = undefined;
        }
        entityAllowed = true;
      });
      await t.test('deleted sources serialize only the canonical redacted shell', async () => {
        const result = await lookup({ ...target,messageId: 'deleted' });
        assert.equal(result.status,'deleted');
        assert.equal(result.sequence,2);
        assert.equal(result.message.content,null);
        assert.equal(result.message.deletedAt,'2026-01-02T00:00:00.000Z');
        assert.equal(result.message.deletedByUserId,'author');
        assert.doesNotMatch(JSON.stringify(result),/deleted secret content|downloadUrl/);
      });
      await t.test('admission denial precedes authentication and validation; unauthenticated stays 401', async () => {
        admissionAllowed = false;
        const counts = [authCalls,queries.length];
        const denied = await get(`${path()}?tenantId=spoof`);
        assertError(denied,429,'chat_request_not_admitted','Chat request temporarily unavailable');
        assert.equal(denied.headers['retry-after'],'12');
        assert.deepEqual([authCalls,queries.length],counts);
        assert.equal(outcomes.at(-1).tenantId,undefined);
        assert.equal(admissions.at(-1).routeTemplate,MESSAGE_CONTEXT_PATH);
        admissionAllowed = true;
        assertError(await get(path(),{ headers: { authorization: 'invalid' } }),401,'CHAT_AUTHENTICATION_FAILED','Chat authentication failed');
        assert.equal(queries.length,counts[1]);
      });
      await t.test('permission outages and malformed canonical results stay sanitized retryable errors', async () => {
        permissionError = new Error('secret permission infrastructure address');
        for (const [conversation,message] of [['entity','entity-root'],['entity-child','entity-child-reply'],['public','malformed']]) {
          assertError(await get(path(conversation,message)),503,'chat_message_context_unavailable','Message context temporarily unavailable');
          assert.equal(outcomes.at(-1).outcomeCode,'chat_message_context_unavailable');
        }
        permissionError = undefined;
      });
      assert.equal(connectCalls,initialConnections,'lookups must not open command transactions');
      assert.ok(queries.length > 0);
      assert.ok(queries.every(query => /^\s*SELECT\b/i.test(query.text)),'only read queries execute');
      await connection.query('COMMIT');
      connection.release(); connection = undefined;
      assert.deepEqual(await snapshot(),before,'all tables remain unchanged, including threads, cursors, follows, membership and outbox');
    });
    await t.test('real database failure returns sanitized 503 rather than unavailable result', async () => {
      await withHttp(createChatServer({ ...config,database: { pool: database,schema: 'uninstalled_context' } }),async get => {
        assertError(await get(path()),503,'chat_message_context_unavailable','Message context temporarily unavailable');
        assert.equal(outcomes.at(-1).outcomeCode,'chat_message_context_unavailable');
      });
    });
  } finally {
    if (connection) { await connection.query('ROLLBACK'); connection.release(); }
    await harness?.teardown();
    await backend.teardown();
  }
});
