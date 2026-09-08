import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import { parseSetThreadFollowResult } from "@handrail/chat";
import {
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_THREAD_FOLLOW_CONFLICT_CODE,
  SET_THREAD_FOLLOW_AUDIT_ACTION,
  SET_THREAD_FOLLOW_IDEMPOTENCY_OPERATION,
  SET_THREAD_FOLLOW_OUTBOX_EVENT_TYPE,
  THREAD_FOLLOW_ROUTE_SUFFIX,
  createChatServer,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "thread-follower",
  roles: Object.freeze(["sensitive-host-role"]),
});

const input = (threadId, suffix, overrides = {}) => ({
  operation: "set_thread_follow",
  intent: "follow",
  target: { type: "thread", id: threadId },
  expectedFollowRevision: 0,
  idempotencyKey: `thread-follow-http-${suffix}`,
  ...overrides,
});

const route = (threadId) =>
  `/conversations/${threadId}${THREAD_FOLLOW_ROUTE_SUFFIX}`;

const withHttpServer = async (runtime, callback) => {
  const server = createServer({ joinDuplicateHeaders: true }, runtime.router);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${address.port}`;

    const rawRequest = (path, { body = "", chunks, headers = [] } = {}) =>
      new Promise((resolve, reject) => {
        const request = httpRequest(
          `${origin}${path}`,
          {
            method: "PATCH",
            headers: ["host", new URL(origin).host, ...headers],
          },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              resolve({
                status: response.statusCode,
                headers: new Headers(response.headers),
                json: async () => JSON.parse(text),
              });
            });
          },
        );
        request.on("error", reject);
        if (chunks === undefined) {
          request.end(body);
          return;
        }
        const writeChunk = (index) => {
          const chunk = chunks[index];
          if (chunk === undefined) {
            request.end();
            return;
          }
          request.write(chunk);
          setImmediate(() => writeChunk(index + 1));
        };
        writeChunk(0);
      });

    return await callback({
      request(path, requestInput, options = {}) {
        const body = options.body ?? JSON.stringify(requestInput);
        const idempotencyKey =
          options.idempotencyKey === undefined
            ? requestInput?.idempotencyKey
            : options.idempotencyKey;
        return fetch(`${origin}${path}`, {
          method: "PATCH",
          headers: {
            authorization: options.authorization ?? "Bearer valid",
            "content-type": options.contentType ?? "application/json",
            ...(options.omitIdempotencyKey === true ||
            idempotencyKey === undefined
              ? {}
              : { "idempotency-key": idempotencyKey }),
          },
          body,
        });
      },
      rawRequest,
    });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime.close();
  }
};

const assertStableError = async (response, status, code, message) => {
  assert.equal(response.status, status);
  assert.equal(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.deepEqual(body, { error: { code, message } });
  return body;
};

const adapters = (resolveActor) => ({
  auth: { resolveActor },
  directory: {
    async getUser() {
      throw new Error("thread-follow route must not query the directory");
    },
    async searchUsers() {
      throw new Error("thread-follow route must not search the directory");
    },
  },
  permissions: {
    async getCapabilities() {
      return [];
    },
    async authorizeEntity() {
      return true;
    },
  },
});

test("PATCH /conversations/:threadId/follow mounts the private transactional thread-follow command", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "chat_thread_follow_http",
  });
  const quoteIdentifier = (identifier) =>
    `"${identifier.replaceAll('"', '""')}"`;
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    conversations: `${schema}.chat_conversations`,
    members: `${schema}.chat_conversation_members`,
    messages: `${schema}.chat_messages`,
    follows: `${schema}.chat_thread_follows`,
    audits: `${schema}.chat_audit_events`,
    outbox: `${schema}.chat_outbox_events`,
    idempotency: `${schema}.chat_idempotency_keys`,
  };
  let commandConnectCount = 0;

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    await harness.pool.query(
      `INSERT INTO ${tables.conversations}
         (tenant_id, id, type, visibility, name)
       VALUES
         ('tenant-a', 'public-parent', 'channel', 'public', 'Public'),
         ('tenant-a', 'private-parent', 'channel', 'private', 'Private'),
         ('tenant-b', 'cross-parent', 'channel', 'private', 'Cross tenant')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.messages}
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content)
       VALUES
         ('tenant-a', 'public-root', 'public-parent', 1, 'author', 'public-root-client', '{}'),
         ('tenant-a', 'private-root', 'private-parent', 1, 'author', 'private-root-client', '{}'),
         ('tenant-b', 'cross-root', 'cross-parent', 1, 'author', 'cross-root-client', '{}')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.conversations}
         (tenant_id, id, type, visibility, parent_conversation_id, root_message_id)
       VALUES
         ('tenant-a', 'follow-primary', 'thread', 'public', 'public-parent', 'public-root'),
         ('tenant-a', 'follow-retry', 'thread', 'public', 'public-parent', 'public-root'),
         ('tenant-a', 'follow-conflicting-key', 'thread', 'public', 'public-parent', 'public-root'),
         ('tenant-a', 'follow-nonmember', 'thread', 'private', 'private-parent', 'private-root'),
         ('tenant-b', 'follow-cross-tenant', 'thread', 'private', 'cross-parent', 'cross-root')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES
         ('tenant-a', 'private-parent', 'other-user', 'member', 'active'),
         ('tenant-b', 'cross-parent', $1, 'member', 'active')`,
      [actor.userId],
    );

    const instrumentedDatabase = {
      query(...args) {
        return harness.pool.query(...args);
      },
      async connect() {
        commandConnectCount += 1;
        return harness.pool.connect();
      },
    };
    const runtime = createChatServer({
      database: { pool: instrumentedDatabase, schema: harness.schema },
      ...adapters(async (request) => {
        if (request.headers.authorization === "Bearer valid") return actor;
        throw new Error("sensitive authentication-provider detail");
      }),
    });

    const effectCounts = async (threadId, idempotencyKey) =>
      (
        await harness.pool.query(
          `SELECT
             (SELECT count(*)::integer FROM ${tables.follows}
               WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3)
               AS follow_count,
             (SELECT count(*)::integer FROM ${tables.audits}
               WHERE tenant_id = $1 AND target_id = $2 AND action = $4)
               AS audit_count,
             (SELECT count(*)::integer FROM ${tables.outbox}
               WHERE tenant_id = $1 AND stream_id = $5 AND type = $6
                 AND payload->'target'->>'id' = $2) AS outbox_count,
             (SELECT count(*)::integer FROM ${tables.idempotency}
               WHERE tenant_id = $1 AND user_id = $3
                 AND operation_name = $7 AND client_key = $8)
               AS idempotency_count`,
          [
            actor.tenantId,
            threadId,
            actor.userId,
            SET_THREAD_FOLLOW_AUDIT_ACTION,
            `user:${actor.userId}`,
            SET_THREAD_FOLLOW_OUTBOX_EVENT_TYPE,
            SET_THREAD_FOLLOW_IDEMPOTENCY_OPERATION,
            idempotencyKey,
          ],
        )
      ).rows[0];

    await withHttpServer(runtime, async ({ request }) => {
      await t.test("follows, reports already-requested state, rejects stale state, and unfollows", async () => {
        const followInput = input("follow-primary", "primary-follow");
        const before = commandConnectCount;
        const followed = await request(route("follow-primary"), followInput);
        assert.equal(commandConnectCount, before + 1);
        assert.equal(followed.status, 200);
        assert.equal(followed.headers.get("content-type"), "application/json; charset=utf-8");
        assert.equal(followed.headers.get("cache-control"), "private, no-store");
        const followedJson = await followed.json();
        assert.equal(followedJson.reconciliationStatus, "applied");
        assert.equal(followedJson.followRevision, 1);
        assert.equal(followedJson.follow.isFollowing, true);
        assert.deepEqual(parseSetThreadFollowResult(followedJson, followInput), followedJson);

        const alreadyInput = input("follow-primary", "primary-already", {
          expectedFollowRevision: 1,
        });
        const already = await request(route("follow-primary"), alreadyInput);
        const alreadyJson = await already.json();
        assert.equal(already.status, 200);
        assert.equal(alreadyJson.reconciliationStatus, "already_requested_state");
        assert.equal(alreadyJson.followRevision, 1);

        const staleInput = input("follow-primary", "primary-stale", {
          intent: "unfollow",
          expectedFollowRevision: 0,
        });
        const stale = await request(route("follow-primary"), staleInput);
        const staleJson = await stale.json();
        assert.equal(stale.status, 409);
        assert.equal(staleJson.reconciliationStatus, "follow_revision_conflict");
        assert.equal(staleJson.follow.isFollowing, true);
        assert.deepEqual(parseSetThreadFollowResult(staleJson, staleInput), staleJson);

        const unfollowInput = input("follow-primary", "primary-unfollow", {
          intent: "unfollow",
          expectedFollowRevision: 1,
        });
        const unfollowed = await request(route("follow-primary"), unfollowInput);
        const unfollowedJson = await unfollowed.json();
        assert.equal(unfollowed.status, 200);
        assert.equal(unfollowedJson.reconciliationStatus, "applied");
        assert.equal(unfollowedJson.followRevision, 2);
        assert.equal(unfollowedJson.follow.isFollowing, false);
      });

      await t.test("replays exactly without duplicating private durable effects", async () => {
        const retryInput = input("follow-retry", "retry");
        const first = await request(route("follow-retry"), retryInput);
        const firstJson = await first.json();
        const beforeRetry = commandConnectCount;
        const replay = await request(route("follow-retry"), retryInput);
        const replayJson = await replay.json();
        assert.equal(commandConnectCount, beforeRetry + 1);
        assert.equal(replay.status, 200);
        assert.equal(replayJson.reconciliationStatus, "replayed");
        assert.deepEqual(
          { ...replayJson, reconciliationStatus: "applied" },
          firstJson,
        );
        assert.deepEqual(await effectCounts("follow-retry", retryInput.idempotencyKey), {
          follow_count: 1,
          audit_count: 1,
          outbox_count: 1,
          idempotency_count: 1,
        });
      });

      await t.test("maps conflicting idempotency reuse to a stable conflict", async () => {
        const firstInput = input("follow-conflicting-key", "conflicting-key");
        assert.equal((await request(route("follow-conflicting-key"), firstInput)).status, 200);
        await assertStableError(
          await request(route("follow-conflicting-key"), {
            ...firstInput,
            intent: "unfollow",
          }),
          409,
          CHAT_THREAD_FOLLOW_CONFLICT_CODE,
          "Thread-follow request conflicts with current server state",
        );
      });

      await t.test("keeps nonmember and cross-tenant failures indistinguishable", async () => {
        for (const threadId of ["follow-nonmember", "follow-cross-tenant"]) {
          await assertStableError(
            await request(route(threadId), input(threadId, `authorization-${threadId}`)),
            403,
            CHAT_AUTHORIZATION_ERROR_CODE,
            "Chat authorization failed",
          );
        }
      });

      await t.test("serializes only the shared actor-private canonical result", async () => {
        const privacyInput = input("follow-primary", "privacy", {
          expectedFollowRevision: 2,
        });
        const response = await request(route("follow-primary"), privacyInput);
        const json = await response.json();
        assert.deepEqual(Object.keys(json), [
          "operation",
          "intent",
          "reconciliationStatus",
          "target",
          "expectedFollowRevision",
          "idempotencyKey",
          "followRevision",
          "follow",
        ]);
        assert.deepEqual(Object.keys(json.follow), [
          "target",
          "isFollowing",
          "source",
          "updatedAt",
        ]);
        const serialized = JSON.stringify(json);
        for (const forbidden of [
          "tenantId",
          "tenant-a",
          "userId",
          actor.userId,
          "roles",
          "sensitive-host-role",
          "other-user",
        ]) {
          assert.equal(serialized.includes(forbidden), false);
        }
      });
    });
  } finally {
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});
