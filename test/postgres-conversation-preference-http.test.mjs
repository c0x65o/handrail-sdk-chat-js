import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import { parseUpdateConversationPreferenceResult } from "@handrail/chat";
import {
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_CONVERSATION_PREFERENCE_CONFLICT_CODE,
  CONVERSATION_PREFERENCE_ROUTE_SUFFIX,
  UPDATE_CONVERSATION_PREFERENCE_IDEMPOTENCY_OPERATION,
  createChatServer,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "preference-user",
  roles: Object.freeze(["sensitive-host-role"]),
});

const input = (conversationId, suffix, overrides = {}) => ({
  operation: "update_conversation_preference",
  conversationId,
  expectedPreferenceRevision: 0,
  idempotencyKey: `preference-http-${suffix}`,
  notificationPreference: "all",
  isStarred: false,
  mute: { muted: false },
  ...overrides,
});

const route = (conversationId) =>
  `/conversations/${conversationId}${CONVERSATION_PREFERENCE_ROUTE_SUFFIX}`;

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
  assert.deepEqual(await response.json(), { error: { code, message } });
};

test("PATCH /conversations/:conversationId/preference mounts the actor-private preference command", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "chat_preference_http",
  });
  const quoteIdentifier = (identifier) =>
    `"${identifier.replaceAll('"', '""')}"`;
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const members = `${schema}.chat_conversation_members`;
  const preferences = `${schema}.chat_conversation_preferences`;
  const audits = `${schema}.chat_audit_events`;
  const outbox = `${schema}.chat_outbox_events`;
  const idempotency = `${schema}.chat_idempotency_keys`;
  let commandConnectCount = 0;

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    const actorConversationIds = [
      ...Array.from({ length: 9 }, (_, index) => `preference-combo-${index}`),
      "preference-primary",
      "preference-retry",
      "preference-idempotency-conflict",
    ];
    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name)
       SELECT 'tenant-a', value, 'channel', 'private', value
         FROM unnest($1::text[]) AS value`,
      [[...actorConversationIds, "preference-nonmember"]],
    );
    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name)
       VALUES
         ('tenant-b', 'preference-cross-tenant', 'channel', 'private', 'Cross tenant')`,
    );
    await harness.pool.query(
      `INSERT INTO ${members}
         (tenant_id, conversation_id, user_id, role, state)
       SELECT 'tenant-a', value, $2, 'member', 'active'
         FROM unnest($1::text[]) AS value`,
      [actorConversationIds, actor.userId],
    );
    await harness.pool.query(
      `INSERT INTO ${members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES
         ('tenant-a', 'preference-primary', 'other-user', 'member', 'active'),
         ('tenant-a', 'preference-nonmember', 'other-user', 'member', 'active'),
         ('tenant-b', 'preference-cross-tenant', $1, 'member', 'active')`,
      [actor.userId],
    );
    await harness.pool.query(
      `INSERT INTO ${preferences}
         (tenant_id, conversation_id, user_id, notification_level,
          is_starred, muted, muted_until, preference_revision)
       VALUES
         ('tenant-a', 'preference-primary', 'other-user', 'none', true, true,
          '2099-12-31T23:59:59.000Z', 7)`,
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
      auth: {
        async resolveActor(request) {
          if (request.headers.authorization === "Bearer valid") return actor;
          throw new Error("sensitive authentication-provider detail");
        },
      },
      directory: {
        async getUser() {
          throw new Error("preference route must not query the directory");
        },
        async searchUsers() {
          throw new Error("preference route must not search the directory");
        },
      },
      permissions: {
        async getCapabilities() {
          return [];
        },
        async authorizeEntity() {
          throw new Error("preference membership is enforced by the command");
        },
      },
    });

    const effectCounts = async (conversationId, idempotencyKey) =>
      (
        await harness.pool.query(
          `SELECT
             (SELECT count(*)::integer FROM ${preferences}
               WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3)
               AS preference_count,
             (SELECT count(*)::integer FROM ${audits}
               WHERE tenant_id = $1 AND target_id = $2
                 AND action = $4) AS audit_count,
             (SELECT count(*)::integer FROM ${outbox}
               WHERE tenant_id = $1 AND stream_id = $5
                 AND type = 'conversation.preference.updated'
                 AND payload->'input'->>'conversationId' = $2)
               AS outbox_count,
             (SELECT count(*)::integer FROM ${idempotency}
               WHERE tenant_id = $1 AND user_id = $3
                 AND operation_name = $4 AND client_key = $6)
               AS idempotency_count`,
          [
            actor.tenantId,
            conversationId,
            actor.userId,
            UPDATE_CONVERSATION_PREFERENCE_IDEMPOTENCY_OPERATION,
            `user:${actor.userId}`,
            idempotencyKey,
          ],
        )
      ).rows[0];

    await withHttpServer(runtime, async ({ request }) => {
      await t.test("supports notification, starred, and mute forms with one command invocation", async () => {
        const notificationPreferences = ["all", "mentions", "none"];
        const muteStates = [
          { muted: false },
          { muted: true },
          { muted: true, mutedUntil: "2030-02-03T04:05:06.000Z" },
        ];
        let index = 0;
        for (const notificationPreference of notificationPreferences) {
          for (const mute of muteStates) {
            const conversationId = `preference-combo-${index}`;
            const isStarred = index % 2 === 1;
            const requestInput = input(conversationId, `combo-${index}`, {
              notificationPreference,
              isStarred,
              mute,
            });
            const before = commandConnectCount;
            const response = await request(route(conversationId), requestInput);
            assert.equal(commandConnectCount, before + 1);
            assert.equal(response.status, 200);
            assert.equal(
              response.headers.get("content-type"),
              "application/json; charset=utf-8",
            );
            assert.equal(
              response.headers.get("cache-control"),
              "private, no-store",
            );
            const json = await response.json();
            assert.equal(json.reconciliationStatus, "applied");
            assert.equal(json.preferenceRevision, 1);
            assert.deepEqual(json.preference, {
              notificationPreference,
              isStarred,
              mute,
              updatedAt: json.preference.updatedAt,
            });
            assert.deepEqual(
              parseUpdateConversationPreferenceResult(json, requestInput),
              json,
            );
            index += 1;
          }
        }
      });

      await t.test("advances revisions, returns already-requested state, and reconciles stale state", async () => {
        const createdInput = input("preference-primary", "primary-create");
        const created = await request(route("preference-primary"), createdInput);
        const createdJson = await created.json();
        assert.equal(createdJson.preferenceRevision, 1);

        const updatedInput = input("preference-primary", "primary-update", {
          expectedPreferenceRevision: 1,
          notificationPreference: "mentions",
          isStarred: true,
          mute: { muted: true },
        });
        const updated = await request(route("preference-primary"), updatedInput);
        const updatedJson = await updated.json();
        assert.equal(updatedJson.reconciliationStatus, "applied");
        assert.equal(updatedJson.preferenceRevision, 2);

        const alreadyInput = input("preference-primary", "primary-already", {
          expectedPreferenceRevision: 2,
          notificationPreference: "mentions",
          isStarred: true,
          mute: { muted: true },
        });
        const already = await request(route("preference-primary"), alreadyInput);
        const alreadyJson = await already.json();
        assert.equal(already.status, 200);
        assert.equal(alreadyJson.reconciliationStatus, "already_requested_state");
        assert.equal(alreadyJson.preferenceRevision, 2);

        const staleInput = input("preference-primary", "primary-stale", {
          expectedPreferenceRevision: 1,
          notificationPreference: "none",
          isStarred: false,
          mute: { muted: false },
        });
        const stale = await request(route("preference-primary"), staleInput);
        const staleJson = await stale.json();
        assert.equal(stale.status, 409);
        assert.equal(
          staleJson.reconciliationStatus,
          "preference_revision_conflict",
        );
        assert.equal(staleJson.preferenceRevision, 2);
        assert.deepEqual(staleJson.preference, updatedJson.preference);
        assert.deepEqual(
          parseUpdateConversationPreferenceResult(staleJson, staleInput),
          staleJson,
        );
      });

      await t.test("replays an identical request without duplicating durable effects", async () => {
        const requestInput = input("preference-retry", "retry", {
          notificationPreference: "none",
          isStarred: true,
          mute: { muted: true },
        });
        const first = await request(route("preference-retry"), requestInput);
        const firstJson = await first.json();
        const beforeRetry = commandConnectCount;
        const retry = await request(route("preference-retry"), requestInput);
        const retryJson = await retry.json();
        assert.equal(commandConnectCount, beforeRetry + 1);
        assert.equal(retry.status, 200);
        assert.equal(retryJson.reconciliationStatus, "replayed");
        assert.deepEqual(
          { ...retryJson, reconciliationStatus: "applied" },
          firstJson,
        );
        assert.deepEqual(
          await effectCounts(
            "preference-retry",
            requestInput.idempotencyKey,
          ),
          {
            preference_count: 1,
            audit_count: 1,
            outbox_count: 1,
            idempotency_count: 1,
          },
        );
      });

      await t.test("returns only the shared private result and omits trusted or other-user state", async () => {
        const requestInput = input("preference-primary", "privacy", {
          expectedPreferenceRevision: 2,
          notificationPreference: "all",
          isStarred: false,
          mute: { muted: false },
        });
        const response = await request(route("preference-primary"), requestInput);
        const json = await response.json();
        assert.deepEqual(Object.keys(json), [
          "operation",
          "reconciliationStatus",
          "conversationId",
          "expectedPreferenceRevision",
          "idempotencyKey",
          "requestedPreference",
          "preferenceRevision",
          "preference",
        ]);
        assert.deepEqual(Object.keys(json.requestedPreference), [
          "notificationPreference",
          "isStarred",
          "mute",
        ]);
        assert.deepEqual(Object.keys(json.preference), [
          "notificationPreference",
          "isStarred",
          "mute",
          "updatedAt",
        ]);
        const serialized = JSON.stringify(json);
        for (const forbidden of [
          "tenantId",
          "tenant-a",
          "userId",
          "actorUserId",
          "preference-user",
          "other-user",
          "roles",
          "sensitive-host-role",
          "2099-12-31T23:59:59.000Z",
        ]) {
          assert.equal(serialized.includes(forbidden), false);
        }
      });

      await t.test("keeps nonmember and cross-tenant authorization failures indistinguishable", async () => {
        for (const conversationId of [
          "preference-nonmember",
          "preference-cross-tenant",
        ]) {
          await assertStableError(
            await request(
              route(conversationId),
              input(conversationId, `authorization-${conversationId}`),
            ),
            403,
            CHAT_AUTHORIZATION_ERROR_CODE,
            "Chat authorization failed",
          );
        }
      });

      await t.test("maps conflicting idempotency-key reuse without changing preference state", async () => {
        const firstInput = input(
          "preference-idempotency-conflict",
          "idempotency-conflict",
          { notificationPreference: "mentions", isStarred: false },
        );
        assert.equal(
          (await request(route("preference-idempotency-conflict"), firstInput))
            .status,
          200,
        );
        await assertStableError(
          await request(route("preference-idempotency-conflict"), {
            ...firstInput,
            isStarred: true,
          }),
          409,
          CHAT_CONVERSATION_PREFERENCE_CONFLICT_CODE,
          "Conversation-preference request conflicts with current server state",
        );
        const stored = (
          await harness.pool.query(
            `SELECT notification_level, is_starred,
                    preference_revision::integer AS preference_revision
               FROM ${preferences}
              WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3`,
            [
              actor.tenantId,
              "preference-idempotency-conflict",
              actor.userId,
            ],
          )
        ).rows[0];
        assert.deepEqual(stored, {
          notification_level: "mentions",
          is_starred: false,
          preference_revision: 1,
        });
      });
    });

  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
