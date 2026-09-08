import assert from "node:assert/strict";
import test from "node:test";

import { CHAT_PROTOCOL_VERSION } from "@handrail/chat";
import {
  DEVICE_PUSH_TOKEN_AUDIT_ACTION,
  DEVICE_PUSH_TOKEN_OUTBOX_EVENT_TYPE,
  DevicePushTokenCommandError,
  MAX_CHAT_PUSH_TOKEN_CIPHERTEXT_UTF8_BYTES,
  MAX_CHAT_PUSH_TOKEN_KEY_ID_UTF8_BYTES,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
  updateDevicePushToken,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "push-user-a",
  roles: Object.freeze(["sensitive-host-role"]),
});

const registerInput = (deviceId, suffix, overrides = {}) => ({
  operation: "register",
  deviceId,
  platform: "ios",
  provider: "apns",
  environment: "sandbox",
  token: `SECRET_REGISTER_${suffix}`,
  tokenRevision: 1,
  idempotencyKey: `push-${suffix}`,
  ...overrides,
});

test("device push-token command is transactional, isolated, monotonic, idempotent, and token-safe", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "chat_push_token_cmd",
  });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    tokens: `${schema}.chat_device_push_tokens`,
    audit: `${schema}.chat_audit_events`,
    outbox: `${schema}.chat_outbox_events`,
    idempotency: `${schema}.chat_idempotency_keys`,
  };
  let nextId = 0;
  const protectionCalls = [];
  const envelopeFor = (token) => ({
    ciphertext: `ciphertext:${Buffer.from(token).toString("base64")}`,
    keyId: "kms-key-default",
  });
  const pushTokenProtector = {
    async protect(value) {
      protectionCalls.push(value);
      return envelopeFor(value.token);
    },
    async unprotect() {
      throw new Error("unprotect must not run while updating a token");
    },
  };
  const command = (
    input,
    actorOverride = actor,
    protectorOverride = pushTokenProtector,
    database = harness.pool,
  ) =>
    updateDevicePushToken({
      database,
      pushTokenProtector: protectorOverride,
      schema: harness.schema,
      actor: actorOverride,
      input,
      createId: () => `device-push-command-${++nextId}`,
    });

  const rowsFor = (tenantId, userId, deviceId) =>
    harness.pool.query(
      `SELECT platform, provider, environment, opaque_token,
              token_protection_scheme, token_protection_key_id,
              token_revision::integer AS token_revision,
              revoked_at IS NULL AS active
         FROM ${tables.tokens}
        WHERE tenant_id = $1 AND user_id = $2 AND device_id = $3
        ORDER BY token_revision`,
      [tenantId, userId, deviceId],
    );

  const effectCounts = (tenantId, userId, deviceId) =>
    harness.pool.query(
      `SELECT
         (SELECT count(*)::integer FROM ${tables.audit}
           WHERE tenant_id = $1 AND actor_user_id = $2
             AND target_type = 'device' AND target_id = $3) AS audit,
         (SELECT count(*)::integer FROM ${tables.outbox}
           WHERE tenant_id = $1 AND stream_id = $4
             AND payload->'devicePushToken'->>'deviceId' = $3) AS outbox`,
      [tenantId, userId, deviceId, `user:${userId}`],
    );

  const commandTableCounts = (tenantId, userId, deviceId, idempotencyKey) =>
    harness.pool.query(
      `SELECT
         (SELECT count(*)::integer FROM ${tables.tokens}
           WHERE tenant_id = $1 AND user_id = $2 AND device_id = $3) AS tokens,
         (SELECT count(*)::integer FROM ${tables.audit}
           WHERE tenant_id = $1 AND actor_user_id = $2
             AND target_type = 'device' AND target_id = $3) AS audit,
         (SELECT count(*)::integer FROM ${tables.outbox}
           WHERE tenant_id = $1 AND stream_id = $5
             AND payload->'devicePushToken'->>'deviceId' = $3) AS outbox,
         (SELECT count(*)::integer FROM ${tables.idempotency}
           WHERE tenant_id = $1 AND user_id = $2 AND client_key = $4) AS idempotency`,
      [tenantId, userId, deviceId, idempotencyKey, `user:${userId}`],
    );

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    await t.test("protects and validates the envelope before checkout and BEGIN", async () => {
      const events = [];
      const orderedDatabase = {
        async connect() {
          events.push("connect");
          const connection = await harness.pool.connect();
          return {
            async query(text, values) {
              if (text === "BEGIN") events.push("begin");
              return connection.query(text, values);
            },
            release() {
              connection.release();
            },
          };
        },
      };
      const request = registerInput("ordered-device", "ordered");
      const protector = {
        async protect(value) {
          events.push("protect");
          assert.deepEqual(value, {
            token: request.token,
            tenantId: actor.tenantId,
            userId: actor.userId,
            deviceId: request.deviceId,
          });
          return {
            get ciphertext() {
              events.push("validate-ciphertext");
              return "ORDERED_CIPHERTEXT";
            },
            get keyId() {
              events.push("validate-key-id");
              return "ordered-key";
            },
          };
        },
        async unprotect() {
          throw new Error("unprotect must not run while updating a token");
        },
      };

      await command(request, actor, protector, orderedDatabase);
      assert.ok(
        events.lastIndexOf("validate-ciphertext") < events.indexOf("connect"),
      );
      assert.ok(events.lastIndexOf("validate-key-id") < events.indexOf("connect"));
      assert.ok(events.indexOf("connect") < events.indexOf("begin"));
    });

    await t.test("registers, exactly replays, and rejects conflicting key reuse", async () => {
      const request = registerInput("primary-device", "primary");
      const registered = await command(request);
      assert.deepEqual(registered, {
        operation: "register",
        reconciliationStatus: "applied",
        idempotencyKey: request.idempotencyKey,
        devicePushToken: {
          deviceId: request.deviceId,
          status: "active",
          platform: "ios",
          provider: "apns",
          environment: "sandbox",
          tokenRevision: 1,
          updatedAt: registered.devicePushToken.updatedAt,
        },
      });
      assert.doesNotMatch(JSON.stringify(registered), /SECRET_REGISTER_primary/);
      assert.deepEqual(protectionCalls.at(-1), {
        token: request.token,
        tenantId: actor.tenantId,
        userId: actor.userId,
        deviceId: request.deviceId,
      });
      assert.deepEqual(
        (await rowsFor(actor.tenantId, actor.userId, request.deviceId)).rows[0],
        {
          platform: "ios",
          provider: "apns",
          environment: "sandbox",
          opaque_token: envelopeFor(request.token).ciphertext,
          token_protection_scheme: "host_encrypted",
          token_protection_key_id: envelopeFor(request.token).keyId,
          token_revision: 1,
          active: true,
        },
      );

      const replay = await command(request);
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.deepEqual(replay.devicePushToken, registered.devicePushToken);
      assert.deepEqual(
        (await effectCounts(actor.tenantId, actor.userId, request.deviceId)).rows[0],
        { audit: 1, outbox: 1 },
      );

      await assert.rejects(
        command({ ...request, token: "SECRET_CONFLICTING_REUSE" }),
        (error) =>
          error instanceof DevicePushTokenCommandError &&
          error.code === "idempotency_conflict" &&
          error.statusCode === 409 &&
          !error.message.includes("SECRET_CONFLICTING_REUSE"),
      );
    });

    await t.test("refreshes strictly newer revisions and rejects stale revisions", async () => {
      const refreshedRequest = {
        operation: "refresh",
        deviceId: "primary-device",
        platform: "ios",
        provider: "apns",
        environment: "production",
        token: "SECRET_REFRESH_PRIMARY",
        tokenRevision: 2,
        idempotencyKey: "push-primary-refresh",
      };
      const refreshed = await command(refreshedRequest);
      assert.deepEqual(protectionCalls.at(-1), {
        token: refreshedRequest.token,
        tenantId: actor.tenantId,
        userId: actor.userId,
        deviceId: refreshedRequest.deviceId,
      });
      assert.equal(refreshed.reconciliationStatus, "applied");
      assert.deepEqual(
        {
          status: refreshed.devicePushToken.status,
          environment: refreshed.devicePushToken.environment,
          tokenRevision: refreshed.devicePushToken.tokenRevision,
        },
        { status: "active", environment: "production", tokenRevision: 2 },
      );

      await assert.rejects(
        command({
          ...refreshedRequest,
          token: "SECRET_STALE_REFRESH",
          idempotencyKey: "push-primary-stale",
        }),
        (error) =>
          error instanceof DevicePushTokenCommandError &&
          error.code === "stale_revision" &&
          !error.message.includes("SECRET_STALE_REFRESH"),
      );
      const stored = await rowsFor(actor.tenantId, actor.userId, "primary-device");
      assert.deepEqual(stored.rows, [{
        platform: "ios",
        provider: "apns",
        environment: "production",
        opaque_token: envelopeFor(refreshedRequest.token).ciphertext,
        token_protection_scheme: "host_encrypted",
        token_protection_key_id: envelopeFor(refreshedRequest.token).keyId,
        token_revision: 2,
        active: true,
      }]);
    });

    await t.test("unregisters without replacing provider state and permits later registration", async () => {
      const unregisterRequest = {
        operation: "unregister",
        intent: "unregister",
        deviceId: "primary-device",
        tokenRevision: 3,
        idempotencyKey: "push-primary-unregister",
      };
      const beforeUnregister = (
        await rowsFor(actor.tenantId, actor.userId, "primary-device")
      ).rows[0];
      const protectionCallCount = protectionCalls.length;
      const unregistered = await command(unregisterRequest);
      assert.deepEqual(
        {
          status: unregistered.devicePushToken.status,
          platform: unregistered.devicePushToken.platform,
          provider: unregistered.devicePushToken.provider,
          environment: unregistered.devicePushToken.environment,
          tokenRevision: unregistered.devicePushToken.tokenRevision,
        },
        {
          status: "unregistered",
          platform: "ios",
          provider: "apns",
          environment: "production",
          tokenRevision: 3,
        },
      );
      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT completed_at >= created_at AS completion_not_before_claim,
                    updated_at >= created_at AS update_not_before_claim
               FROM ${tables.idempotency}
              WHERE tenant_id = $1 AND user_id = $2 AND client_key = $3`,
            [
              actor.tenantId,
              actor.userId,
              unregisterRequest.idempotencyKey,
            ],
          )
        ).rows[0],
        {
          completion_not_before_claim: true,
          update_not_before_claim: true,
        },
      );
      const afterUnregister = (
        await rowsFor(actor.tenantId, actor.userId, "primary-device")
      ).rows[0];
      assert.deepEqual(
        {
          opaque_token: afterUnregister.opaque_token,
          token_protection_scheme: afterUnregister.token_protection_scheme,
          token_protection_key_id: afterUnregister.token_protection_key_id,
        },
        {
          opaque_token: null,
          token_protection_scheme: beforeUnregister.token_protection_scheme,
          token_protection_key_id: null,
        },
      );
      assert.equal(afterUnregister.token_revision, 3);
      assert.equal(afterUnregister.active, false);
      assert.equal(protectionCalls.length, protectionCallCount);

      const reregisteredRequest = registerInput("primary-device", "reregister", {
        environment: "production",
        token: "SECRET_REREGISTER_PRIMARY",
        tokenRevision: 4,
      });
      const reregistered = await command(reregisteredRequest);
      assert.equal(reregistered.devicePushToken.status, "active");
      assert.equal(reregistered.devicePushToken.tokenRevision, 4);
      assert.deepEqual(
        (await rowsFor(actor.tenantId, actor.userId, "primary-device")).rows.map(
          ({ token_revision, active }) => ({ token_revision, active }),
        ),
        [
          { token_revision: 3, active: false },
          { token_revision: 4, active: true },
        ],
      );
      const replayedUnregister = await command(unregisterRequest);
      assert.equal(replayedUnregister.reconciliationStatus, "replayed");
      assert.deepEqual(
        replayedUnregister.devicePushToken,
        unregistered.devicePushToken,
      );
      assert.doesNotMatch(
        JSON.stringify({ unregistered, replayedUnregister }),
        /SECRET_REFRESH_PRIMARY|kms-key-default|ciphertext:/,
      );
    });

    await t.test("rejects a stale unregister without clearing active credentials", async () => {
      const request = registerInput("stale-unregister-device", "stale-unregister");
      await command(request);
      const before = (
        await rowsFor(actor.tenantId, actor.userId, request.deviceId)
      ).rows[0];
      const staleUnregister = {
        operation: "unregister",
        intent: "unregister",
        deviceId: request.deviceId,
        tokenRevision: 1,
        idempotencyKey: "push-stale-unregister-conflict",
      };
      const protectionCallCount = protectionCalls.length;

      await assert.rejects(
        command(staleUnregister),
        (error) =>
          error instanceof DevicePushTokenCommandError &&
          error.code === "stale_revision",
      );

      assert.deepEqual(
        (await rowsFor(actor.tenantId, actor.userId, request.deviceId)).rows[0],
        before,
      );
      assert.equal(protectionCalls.length, protectionCallCount);
      assert.deepEqual(
        (await commandTableCounts(
          actor.tenantId,
          actor.userId,
          request.deviceId,
          staleUnregister.idempotencyKey,
        )).rows[0],
        { tokens: 1, audit: 1, outbox: 1, idempotency: 0 },
      );
    });

    await t.test("isolates identical device IDs by tenant and trusted user", async () => {
      const deviceId = "shared-isolated-device";
      const actors = [
        actor,
        { ...actor, tenantId: "tenant-b" },
        { ...actor, userId: "push-user-b" },
      ];
      await Promise.all(
        actors.map((isolatedActor, index) =>
          command(
            registerInput(deviceId, `isolated-${index}`, {
              token: `SECRET_ISOLATED_${index}`,
            }),
            isolatedActor,
          ),
        ),
      );
      const rows = await harness.pool.query(
        `SELECT tenant_id, user_id, count(*)::integer AS count
           FROM ${tables.tokens}
          WHERE device_id = $1 AND revoked_at IS NULL
          GROUP BY tenant_id, user_id
          ORDER BY tenant_id, user_id`,
        [deviceId],
      );
      assert.deepEqual(rows.rows, [
        { tenant_id: "tenant-a", user_id: "push-user-a", count: 1 },
        { tenant_id: "tenant-a", user_id: "push-user-b", count: 1 },
        { tenant_id: "tenant-b", user_id: "push-user-a", count: 1 },
      ]);
    });

    await t.test("serializes concurrent revisions for one actor device", async () => {
      const deviceId = "concurrent-device";
      await command(registerInput(deviceId, "concurrent-register"));
      const refresh = (revision) => command({
        operation: "refresh",
        deviceId,
        platform: "android",
        provider: "fcm",
        environment: "production",
        token: `SECRET_CONCURRENT_${revision}`,
        tokenRevision: revision,
        idempotencyKey: `push-concurrent-${revision}`,
      });
      const outcomes = await Promise.allSettled([refresh(2), refresh(3)]);
      const accepted = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
      assert.ok(accepted.length === 1 || accepted.length === 2);
      for (const outcome of rejected) {
        assert.equal(outcome.reason.code, "stale_revision");
      }
      const rows = await rowsFor(actor.tenantId, actor.userId, deviceId);
      assert.equal(rows.rows.length, 1);
      assert.equal(rows.rows[0].token_revision, 3);
      assert.equal(rows.rows[0].active, true);
      assert.equal(
        rows.rows[0].opaque_token,
        envelopeFor("SECRET_CONCURRENT_3").ciphertext,
      );
      assert.equal(rows.rows[0].token_protection_scheme, "host_encrypted");
      assert.equal(rows.rows[0].token_protection_key_id, "kms-key-default");
    });

    await t.test("writes token-free audit/outbox/idempotency data", async () => {
      const request = registerInput("redaction-device", "redaction", {
        token: "SECRET_MUST_NEVER_ESCAPE",
      });
      const ciphertextSentinel = "CIPHERTEXT_MUST_NEVER_ESCAPE";
      const keySentinel = "KEY_MATERIAL_MUST_NEVER_ESCAPE";
      const result = await command(request, actor, {
        async protect() {
          return { ciphertext: ciphertextSentinel, keyId: keySentinel };
        },
        async unprotect() {
          throw new Error("unprotect must not run while updating a token");
        },
      });
      const durable = await harness.pool.query(
        `SELECT audit.action, audit.metadata,
                event.type, event.protocol_version::integer AS protocol_version,
                event.stream_id, event.payload,
                event.expires_at > event.occurred_at AS bounded_retention,
                idempotency.response_body
           FROM ${tables.audit} AS audit
           INNER JOIN ${tables.outbox} AS event
             ON event.tenant_id = audit.tenant_id
            AND event.occurred_at = audit.occurred_at
            AND event.payload->'devicePushToken'->>'deviceId' = audit.target_id
           INNER JOIN ${tables.idempotency} AS idempotency
             ON idempotency.tenant_id = audit.tenant_id
            AND idempotency.user_id = audit.actor_user_id
            AND idempotency.client_key = $1
          WHERE audit.tenant_id = $2 AND audit.target_id = $3`,
        [request.idempotencyKey, actor.tenantId, request.deviceId],
      );
      assert.equal(durable.rowCount, 1);
      const row = durable.rows[0];
      assert.equal(row.action, DEVICE_PUSH_TOKEN_AUDIT_ACTION);
      assert.equal(row.type, DEVICE_PUSH_TOKEN_OUTBOX_EVENT_TYPE);
      assert.equal(row.protocol_version, CHAT_PROTOCOL_VERSION);
      assert.equal(row.stream_id, `user:${actor.userId}`);
      assert.equal(row.bounded_retention, true);
      assert.deepEqual(row.payload, {
        actorUserId: actor.userId,
        operation: request.operation,
        idempotencyKey: request.idempotencyKey,
        devicePushToken: result.devicePushToken,
      });
      assert.equal(row.response_body.devicePushToken.deviceId, request.deviceId);
      const unregisterRequest = {
        operation: "unregister",
        intent: "unregister",
        deviceId: request.deviceId,
        tokenRevision: 2,
        idempotencyKey: "push-redaction-unregister",
      };
      const unregistered = await command(unregisterRequest);
      const replayed = await command(unregisterRequest);
      assert.equal(replayed.reconciliationStatus, "replayed");
      assert.deepEqual(replayed.devicePushToken, unregistered.devicePushToken);

      const credentialRows = await rowsFor(
        actor.tenantId,
        actor.userId,
        request.deviceId,
      );
      assert.deepEqual(
        credentialRows.rows.map(
          ({ opaque_token, token_protection_key_id, token_revision, active }) => ({
            opaque_token,
            token_protection_key_id,
            token_revision,
            active,
          }),
        ),
        [
          {
            opaque_token: null,
            token_protection_key_id: null,
            token_revision: 2,
            active: false,
          },
        ],
      );
      const durableAfterUnregister = {
        audit: (
          await harness.pool.query(
            `SELECT metadata FROM ${tables.audit}
              WHERE tenant_id = $1 AND actor_user_id = $2
                AND target_type = 'device' AND target_id = $3
              ORDER BY occurred_at`,
            [actor.tenantId, actor.userId, request.deviceId],
          )
        ).rows,
        outbox: (
          await harness.pool.query(
            `SELECT payload FROM ${tables.outbox}
              WHERE tenant_id = $1 AND stream_id = $2
                AND payload->'devicePushToken'->>'deviceId' = $3
              ORDER BY occurred_at`,
            [actor.tenantId, `user:${actor.userId}`, request.deviceId],
          )
        ).rows,
        idempotency: (
          await harness.pool.query(
            `SELECT response_body FROM ${tables.idempotency}
              WHERE tenant_id = $1 AND user_id = $2
                AND client_key = ANY($3::text[])
              ORDER BY client_key`,
            [
              actor.tenantId,
              actor.userId,
              [request.idempotencyKey, unregisterRequest.idempotencyKey],
            ],
          )
        ).rows,
      };
      const durableText = JSON.stringify({
        row,
        result,
        unregistered,
        replayed,
        durableAfterUnregister,
      });
      assert.doesNotMatch(durableText, /SECRET_MUST_NEVER_ESCAPE/);
      assert.doesNotMatch(durableText, /CIPHERTEXT_MUST_NEVER_ESCAPE/);
      assert.doesNotMatch(durableText, /KEY_MATERIAL_MUST_NEVER_ESCAPE/);
      assert.doesNotMatch(durableText, /sensitive-host-role/);
    });

    await t.test("sanitizes throwing and malformed protectors before all database effects", async () => {
      const providerErrorSentinel = "PROVIDER_ERROR_MUST_NEVER_ESCAPE";
      const ciphertextSentinel = "MALFORMED_CIPHERTEXT_MUST_NEVER_ESCAPE";
      const keySentinel = "MALFORMED_KEY_MATERIAL_MUST_NEVER_ESCAPE";
      const failures = [
        async () => { throw new Error(providerErrorSentinel); },
        async () => null,
        async () => ({ ciphertext: "   ", keyId: keySentinel }),
        async () => ({
          ciphertext: "x".repeat(
            MAX_CHAT_PUSH_TOKEN_CIPHERTEXT_UTF8_BYTES + 1,
          ),
          keyId: "valid-key",
        }),
        async () => ({ ciphertext: ciphertextSentinel, keyId: "\t" }),
        async () => ({
          ciphertext: ciphertextSentinel,
          keyId: `k${"é".repeat(MAX_CHAT_PUSH_TOKEN_KEY_ID_UTF8_BYTES)}`,
        }),
        async () => ({ ciphertext: ciphertextSentinel, keyId: 1 }),
      ];

      for (const [index, protect] of failures.entries()) {
        const request = registerInput(
          `protection-failure-${index}`,
          `protection-failure-${index}`,
          { token: `RAW_TOKEN_MUST_NEVER_ESCAPE_${index}` },
        );
        let connectCount = 0;
        const database = {
          async connect() {
            connectCount += 1;
            return harness.pool.connect();
          },
        };
        let observedError;
        await assert.rejects(
          command(request, actor, {
            protect,
            async unprotect() {
              throw new Error("unprotect must not run while updating a token");
            },
          }, database),
          (error) => {
            observedError = error;
            return error instanceof DevicePushTokenCommandError &&
              error.code === "token_protection_failed" &&
              error.statusCode === 503 &&
              error.message === "Device push-token protection is temporarily unavailable";
          },
        );
        assert.equal(connectCount, 0);
        const observableError = JSON.stringify({
          name: observedError.name,
          code: observedError.code,
          statusCode: observedError.statusCode,
          message: observedError.message,
          stack: observedError.stack,
          cause: observedError.cause,
        });
        for (const sentinel of [
          request.token,
          providerErrorSentinel,
          ciphertextSentinel,
          keySentinel,
        ]) {
          assert.equal(observableError.includes(sentinel), false);
        }
        assert.deepEqual(
          (await commandTableCounts(
            actor.tenantId,
            actor.userId,
            request.deviceId,
            request.idempotencyKey,
          )).rows[0],
          { tokens: 0, audit: 0, outbox: 0, idempotency: 0 },
        );
      }
    });

    await t.test("rolls back token, audit, outbox, and idempotency atomically", async () => {
      await harness.pool.query(
        `CREATE FUNCTION ${schema}.reject_push_token_outbox()
           RETURNS trigger LANGUAGE plpgsql AS $function$
           BEGIN
             IF NEW.payload->'devicePushToken'->>'deviceId' = 'rollback-device' THEN
               RAISE EXCEPTION 'injected push-token outbox failure';
             END IF;
             RETURN NEW;
           END;
           $function$`,
      );
      await harness.pool.query(
        `CREATE TRIGGER reject_push_token_outbox
           BEFORE INSERT ON ${tables.outbox}
           FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_push_token_outbox()`,
      );
      const request = registerInput("rollback-device", "rollback", {
        token: "SECRET_ROLLBACK",
      });
      await assert.rejects(command(request), /injected push-token outbox failure/);
      assert.equal(
        (await rowsFor(actor.tenantId, actor.userId, request.deviceId)).rowCount,
        0,
      );
      assert.deepEqual(
        (await effectCounts(actor.tenantId, actor.userId, request.deviceId)).rows[0],
        { audit: 0, outbox: 0 },
      );
      const idempotency = await harness.pool.query(
        `SELECT count(*)::integer AS count FROM ${tables.idempotency}
          WHERE tenant_id = $1 AND user_id = $2 AND client_key = $3`,
        [actor.tenantId, actor.userId, request.idempotencyKey],
      );
      assert.equal(idempotency.rows[0].count, 0);
    });
  } finally {
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});
