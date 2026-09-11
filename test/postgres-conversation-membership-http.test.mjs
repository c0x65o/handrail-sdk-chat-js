import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import { parseConversationMembershipMutationResult } from "@handrail/chat";
import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_CONVERSATION_MEMBERSHIP_CONFLICT_CODE,
  CHAT_CONVERSATION_MEMBERSHIP_INVALID_REQUEST_CODE,
  CHAT_CONVERSATION_MEMBERSHIP_INVARIANT_CODE,
  CHAT_CONVERSATION_MEMBERSHIP_MEMBER_UNAVAILABLE_CODE,
  MAX_CONVERSATION_MEMBERSHIP_REQUEST_BYTES,
  createChatServer,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const actors = Object.freeze({
  valid: Object.freeze({
    tenantId: "tenant-a",
    userId: "actor-a",
    roles: Object.freeze(["sensitive-host-role"]),
  }),
  member: Object.freeze({
    tenantId: "tenant-a",
    userId: "actor-member",
    roles: Object.freeze(["sensitive-member-role"]),
  }),
});

const input = (suffix, intent, conversationId, overrides = {}) => ({
  operation: "mutate_conversation_membership",
  intent,
  conversationId,
  expectedMemberListRevision: 1,
  idempotencyKey: `membership-http-${suffix}`,
  ...overrides,
});

const targetedInput = (
  suffix,
  intent,
  conversationId,
  targetUserId,
  overrides = {},
) => ({
  ...input(suffix, intent, conversationId),
  targetUserId,
  ...(intent === "add_member" || intent === "change_member_role"
    ? { requestedRole: "member" }
    : {}),
  ...overrides,
});

const withHttpServer = async (runtime, callback) => {
  const server = createServer({ joinDuplicateHeaders: true }, runtime.router);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const rawRequest = (path, { body = "", headers = [] } = {}) =>
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
                text: async () => text,
                json: async () => JSON.parse(text),
              });
            });
          },
        );
        request.on("error", reject);
        request.end(body);
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
  assert.deepEqual(await response.json(), { error: { code, message } });
};

test("PATCH /conversations/:conversationId/membership mounts every membership intent safely", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "chat_membership_http",
  });
  const quoteIdentifier = (identifier) =>
    `"${identifier.replaceAll('"', '""')}"`;
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const members = `${schema}.chat_conversation_members`;
  const users = new Map(
    ["actor-a", "actor-member", "owner-b", "user-b", "user-c", "user-d"].map(
      (userId) => [
        userId,
        { tenantId: "tenant-a", userId, displayName: `Display ${userId}` },
      ],
    ),
  );
  let directoryUnavailable = false;
  let directoryCalls = 0;
  let capabilityFailure = false;

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();
    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name)
       VALUES
         ('tenant-a', 'public-join', 'channel', 'public', 'Join'),
         ('tenant-a', 'leave-target', 'channel', 'private', 'Leave'),
         ('tenant-a', 'add-target', 'channel', 'private', 'Add'),
         ('tenant-a', 'remove-target', 'channel', 'private', 'Remove'),
         ('tenant-a', 'role-target', 'channel', 'private', 'Role'),
         ('tenant-a', 'retry-target', 'channel', 'private', 'Retry'),
         ('tenant-a', 'conflict-target', 'channel', 'private', 'Conflict'),
         ('tenant-a', 'last-owner-target', 'channel', 'private', 'Last owner'),
         ('tenant-a', 'last-active-target', 'channel', 'private', 'Last active'),
         ('tenant-a', 'role-conflict-target', 'channel', 'private', 'Role conflict'),
         ('tenant-a', 'direct-target', 'direct', 'private', NULL),
         ('tenant-a', 'unauthorized-target', 'channel', 'private', 'Unauthorized'),
         ('tenant-a', 'directory-target', 'channel', 'private', 'Directory'),
         ('tenant-b', 'cross-tenant-target', 'channel', 'private', 'Cross tenant')`,
    );
    await harness.pool.query(
      `INSERT INTO ${members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES
         ('tenant-a', 'public-join', 'owner-b', 'owner', 'active'),
         ('tenant-a', 'leave-target', 'actor-member', 'member', 'active'),
         ('tenant-a', 'leave-target', 'owner-b', 'owner', 'active'),
         ('tenant-a', 'add-target', 'actor-a', 'owner', 'active'),
         ('tenant-a', 'remove-target', 'actor-a', 'owner', 'active'),
         ('tenant-a', 'remove-target', 'user-b', 'member', 'active'),
         ('tenant-a', 'role-target', 'actor-a', 'owner', 'active'),
         ('tenant-a', 'role-target', 'user-b', 'member', 'active'),
         ('tenant-a', 'retry-target', 'actor-a', 'owner', 'active'),
         ('tenant-a', 'conflict-target', 'actor-a', 'owner', 'active'),
         ('tenant-a', 'last-owner-target', 'actor-a', 'owner', 'active'),
         ('tenant-a', 'last-owner-target', 'user-b', 'member', 'active'),
         ('tenant-a', 'last-active-target', 'actor-member', 'member', 'active'),
         ('tenant-a', 'role-conflict-target', 'actor-a', 'owner', 'active'),
         ('tenant-a', 'role-conflict-target', 'user-b', 'member', 'active'),
         ('tenant-a', 'direct-target', 'actor-a', 'owner', 'active'),
         ('tenant-a', 'direct-target', 'user-b', 'member', 'active'),
         ('tenant-a', 'unauthorized-target', 'actor-member', 'member', 'active'),
         ('tenant-a', 'unauthorized-target', 'owner-b', 'owner', 'active'),
         ('tenant-a', 'directory-target', 'actor-a', 'owner', 'active'),
         ('tenant-b', 'cross-tenant-target', 'actor-a', 'owner', 'active')`,
    );
    await harness.pool.query(
      `UPDATE ${conversations}
          SET member_list_revision = 4
        WHERE tenant_id = 'tenant-a' AND id = 'conflict-target'`,
    );

    const runtime = createChatServer({
      database: { pool: harness.pool, schema: harness.schema },
      auth: {
        async resolveActor(request) {
          const token = request.headers.authorization;
          if (token === "Bearer valid") return actors.valid;
          if (token === "Bearer member") return actors.member;
          throw new Error("sensitive authentication provider detail");
        },
      },
      directory: {
        async getUser({ userId }) {
          directoryCalls += 1;
          if (directoryUnavailable) return null;
          return users.get(userId) ?? null;
        },
        async searchUsers() {
          throw new Error("membership must not search the directory");
        },
      },
      permissions: {
        async getCapabilities() {
          if (capabilityFailure) {
            throw new Error("sensitive capability provider detail");
          }
          return [];
        },
        async authorizeEntity() {
          return true;
        },
      },
    });

    await withHttpServer(runtime, async ({ request, rawRequest }) => {
      await t.test("returns canonical full results for all five intents", async () => {
        const cases = [
          {
            request: input("join", "join", "public-join"),
            authorization: "Bearer valid",
            expectedState: "active",
          },
          {
            request: input("leave", "leave", "leave-target"),
            authorization: "Bearer member",
            expectedState: "left",
          },
          {
            request: targetedInput(
              "add",
              "add_member",
              "add-target",
              "user-b",
              { requestedRole: "moderator" },
            ),
            authorization: "Bearer valid",
            expectedState: "active",
            expectedRole: "moderator",
          },
          {
            request: targetedInput(
              "remove",
              "remove_member",
              "remove-target",
              "user-b",
            ),
            authorization: "Bearer valid",
            expectedState: "removed",
          },
          {
            request: targetedInput(
              "role",
              "change_member_role",
              "role-target",
              "user-b",
              { requestedRole: "moderator" },
            ),
            authorization: "Bearer valid",
            expectedState: "active",
            expectedRole: "moderator",
          },
        ];

        for (const value of cases) {
          const response = await request(
            `/conversations/${value.request.conversationId}/membership`,
            value.request,
            { authorization: value.authorization },
          );
          assert.equal(response.status, 200,
            `${value.request.intent}: ${await response.clone().text()}`);
          assert.equal(response.headers.get("cache-control"), "private, no-store");
          const result = parseConversationMembershipMutationResult(
            await response.json(),
            value.request,
          );
          assert.equal(result.reconciliationStatus, "applied");
          assert.equal(result.memberListRevision, 2);
          const member = result.members.find(
            ({ userId }) => userId === result.memberUserId,
          );
          assert.equal(member?.state, value.expectedState);
          if (value.expectedRole !== undefined) {
            assert.equal(member?.role, value.expectedRole);
          }
        }
      });

      await t.test("preserves canonical retry and revision-conflict outcomes", async () => {
        const retryRequest = targetedInput(
          "retry",
          "add_member",
          "retry-target",
          "user-c",
        );
        const applied = await (
          await request("/conversations/retry-target/membership", retryRequest)
        ).json();
        const replayResponse = await request(
          "/conversations/retry-target/membership",
          retryRequest,
        );
        assert.equal(replayResponse.status, 200);
        const replayed = await replayResponse.json();
        assert.equal(replayed.reconciliationStatus, "replayed");
        assert.deepEqual(
          { ...replayed, reconciliationStatus: "applied" },
          applied,
        );

        const conflictRequest = targetedInput(
          "revision-conflict",
          "add_member",
          "conflict-target",
          "user-b",
        );
        const firstConflict = await request(
          "/conversations/conflict-target/membership",
          conflictRequest,
        );
        assert.equal(firstConflict.status, 409);
        const conflict = await firstConflict.json();
        assert.equal(conflict.reconciliationStatus, "member_list_conflict");
        assert.equal(conflict.memberListRevision, 4);
        assert.deepEqual(
          await (
            await request(
              "/conversations/conflict-target/membership",
              conflictRequest,
            )
          ).json(),
          conflict,
        );

        await assertStableError(
          await request(
            "/conversations/retry-target/membership",
            { ...retryRequest, requestedRole: "moderator" },
          ),
          409,
          CHAT_CONVERSATION_MEMBERSHIP_CONFLICT_CODE,
          "Conversation membership conflicts with current server state",
        );
      });

      await t.test("returns canonical owner and active-member safety conflicts", async () => {
        const lastOwnerRequest = targetedInput(
          "last-owner",
          "change_member_role",
          "last-owner-target",
          "actor-a",
        );
        const lastOwnerResponse = await request(
          "/conversations/last-owner-target/membership",
          lastOwnerRequest,
        );
        assert.equal(lastOwnerResponse.status, 409);
        const lastOwner = await lastOwnerResponse.json();
        assert.equal(lastOwner.reconciliationStatus, "safety_rejected");
        assert.equal(lastOwner.safetyError.code, "last_owner");
        assert.equal(lastOwner.memberListRevision, 1);

        const lastActiveRequest = input(
          "last-active",
          "leave",
          "last-active-target",
        );
        const lastActiveResponse = await request(
          "/conversations/last-active-target/membership",
          lastActiveRequest,
          { authorization: "Bearer member" },
        );
        assert.equal(lastActiveResponse.status, 409);
        const lastActive = await lastActiveResponse.json();
        assert.equal(lastActive.reconciliationStatus, "safety_rejected");
        assert.equal(lastActive.safetyError.code, "last_active_member");
        assert.equal(lastActive.memberListRevision, 1);
      });

      await t.test("maps role and conversation identity invariants", async () => {
        for (const requestInput of [
          targetedInput(
            "role-conflict",
            "add_member",
            "role-conflict-target",
            "user-b",
            { requestedRole: "moderator" },
          ),
          targetedInput(
            "direct-add",
            "add_member",
            "direct-target",
            "user-c",
          ),
        ]) {
          await assertStableError(
            await request(
              `/conversations/${requestInput.conversationId}/membership`,
              requestInput,
            ),
            409,
            CHAT_CONVERSATION_MEMBERSHIP_INVARIANT_CODE,
            "Conversation membership invariants prevent this request",
          );
        }
      });

      await t.test("rejects malformed, ambiguous, oversized, and spoofed input", async () => {
        const valid = targetedInput(
          "invalid",
          "add_member",
          "directory-target",
          "user-d",
        );
        const malformedCases = [
          () => request("/conversations/directory-target/membership", valid, {
            body: "{",
          }),
          () => request("/conversations/directory-target/membership", {
            ...valid,
            unexpected: true,
          }),
          () => request("/conversations/directory-target/membership", {
            ...valid,
            actorUserId: "attacker",
          }),
          () => request("/conversations/directory-target/membership", {
            ...valid,
            tenantId: "tenant-b",
          }),
          () => request("/conversations/directory-target/membership", {
            ...valid,
            roles: ["owner"],
          }),
          () => request("/conversations/different/membership", valid),
          () => request("/conversations/directory-target/membership?intent=add_member", valid),
          () => request("/conversations/directory-target/membership", {
            ...valid,
            targetUserId: " user-d",
          }),
          () => request("/conversations/directory-target/membership", valid, {
            idempotencyKey: "different-key",
          }),
          () => request("/conversations/directory-target/membership", valid, {
            omitIdempotencyKey: true,
          }),
          () => request("/conversations/directory-target/membership", valid, {
            contentType: "text/plain",
          }),
          () => request("/conversations/directory-target/membership", valid, {
            body: JSON.stringify({
              ...valid,
              targetUserId: "x".repeat(
                MAX_CONVERSATION_MEMBERSHIP_REQUEST_BYTES,
              ),
            }),
          }),
        ];
        for (const send of malformedCases) {
          await assertStableError(
            await send(),
            400,
            CHAT_CONVERSATION_MEMBERSHIP_INVALID_REQUEST_CODE,
            "Invalid conversation membership request",
          );
        }

        // An extra path segment never matches the membership route. It must not
        // be treated as a valid membership endpoint with a malformed body.
        const unknownRoute = await request("/conversations/directory-target/extra/membership", valid);
        assert.equal(unknownRoute.status, 404);
        assert.equal(await unknownRoute.text(), "");

        const duplicate = await rawRequest(
          "/conversations/directory-target/membership",
          {
            body: JSON.stringify(valid),
            headers: [
              "authorization",
              "Bearer valid",
              "content-type",
              "application/json",
              "idempotency-key",
              valid.idempotencyKey,
              "idempotency-key",
              valid.idempotencyKey,
            ],
          },
        );
        await assertStableError(
          duplicate,
          400,
          CHAT_CONVERSATION_MEMBERSHIP_INVALID_REQUEST_CODE,
          "Invalid conversation membership request",
        );
      });

      await t.test("target without private parent access receives a stable authorization error", async () => {
        await harness.pool.query(`INSERT INTO ${conversations}
          (tenant_id,id,type,visibility,name,current_message_sequence)
          VALUES ('tenant-a','target-parent','channel','private','Target access lab',1)`);
        await harness.pool.query(`INSERT INTO ${schema}.chat_messages
          (tenant_id,id,conversation_id,sequence,author_user_id,client_message_id,content)
          VALUES ('tenant-a','target-root','target-parent',1,'actor-a','target-root',
            '{"format":"plain","text":"Isolated membership fixture"}')`);
        await harness.pool.query(`INSERT INTO ${conversations}
          (tenant_id,id,type,visibility,parent_conversation_id,root_message_id)
          VALUES ('tenant-a','target-child','thread','private','target-parent','target-root')`);
        await harness.pool.query(`INSERT INTO ${members}
          (tenant_id,conversation_id,user_id,role,state)
          VALUES ('tenant-a','target-parent','actor-a','member','active'),
            ('tenant-a','target-child','actor-a','owner','active')`);
        await assertStableError(await request("/conversations/target-child/membership",
          targetedInput("target-no-parent", "add_member", "target-child", "user-d")),
        403, CHAT_AUTHORIZATION_ERROR_CODE, "Chat authorization failed");
        assert.equal((await harness.pool.query(`SELECT count(*)::int AS n FROM ${members}
          WHERE tenant_id='tenant-a' AND conversation_id='target-child' AND user_id='user-d'`)).rows[0].n, 0);
      });

      await t.test("sanitizes directory, auth, missing, and cross-tenant failures", async () => {
        directoryUnavailable = true;
        await assertStableError(
          await request(
            "/conversations/directory-target/membership",
            targetedInput(
              "directory-unavailable",
              "add_member",
              "directory-target",
              "user-d",
            ),
          ),
          422,
          CHAT_CONVERSATION_MEMBERSHIP_MEMBER_UNAVAILABLE_CODE,
          "The requested conversation member is unavailable",
        );
        directoryUnavailable = false;

        await assertStableError(
          await request(
            "/conversations/unauthorized-target/membership",
            targetedInput(
              "unauthorized",
              "add_member",
              "unauthorized-target",
              "user-d",
            ),
            { authorization: "Bearer member" },
          ),
          403,
          CHAT_AUTHORIZATION_ERROR_CODE,
          "Chat authorization failed",
        );
        for (const conversationId of ["missing-target", "cross-tenant-target"]) {
          await assertStableError(
            await request(
              `/conversations/${conversationId}/membership`,
              targetedInput(
                `safe-${conversationId}`,
                "add_member",
                conversationId,
                "user-d",
              ),
            ),
            403,
            CHAT_AUTHORIZATION_ERROR_CODE,
            "Chat authorization failed",
          );
        }
        await assertStableError(
          await request(
            "/conversations/directory-target/membership",
            targetedInput(
              "authentication",
              "add_member",
              "directory-target",
              "user-d",
            ),
            { authorization: "Bearer invalid" },
          ),
          401,
          CHAT_AUTHENTICATION_ERROR_CODE,
          "Chat authentication failed",
        );

        capabilityFailure = true;
        await assertStableError(
          await request(
            "/conversations/directory-target/membership",
            targetedInput(
              "capability-failure",
              "add_member",
              "directory-target",
              "user-d",
            ),
          ),
          403,
          CHAT_AUTHORIZATION_ERROR_CODE,
          "Chat authorization failed",
        );
        capabilityFailure = false;
        assert.ok(directoryCalls > 0);
      });
    });
  } finally {
    try {
      await harness.teardown();
    } finally {
      await backend.teardown();
    }
  }
});
