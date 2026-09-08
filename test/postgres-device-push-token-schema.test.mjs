import assert from "node:assert/strict";
import test from "node:test";

import {
  chatDevicePushTokenFreeRevocationMigration,
  chatDevicePushTokenLegacyRetirementMigration,
  chatDevicePushTokenProtectionMetadataMigration,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const findIndexes = (plan, indexes = []) => {
  if (plan && typeof plan === "object") {
    if (typeof plan["Index Name"] === "string") {
      indexes.push(plan["Index Name"]);
    }
    for (const value of Object.values(plan)) {
      findIndexes(value, indexes);
    }
  }
  return indexes;
};

const protectionMigrationId =
  "0033-chat-device-push-token-protection-metadata";
const protectionMigrationIndex = handrailChatPostgresMigrations.indexOf(
  chatDevicePushTokenProtectionMetadataMigration,
);
const tokenFreeRevocationMigrationId =
  "0034-chat-device-push-token-free-revocation";
const tokenFreeRevocationMigrationIndex = handrailChatPostgresMigrations.indexOf(
  chatDevicePushTokenFreeRevocationMigration,
);
const legacyRetirementMigrationId =
  "0035-chat-device-push-token-legacy-retirement";
const legacyRetirementMigrationIndex = handrailChatPostgresMigrations.indexOf(
  chatDevicePushTokenLegacyRetirementMigration,
);
const preProtectionMigrations = handrailChatPostgresMigrations.slice(
  0,
  protectionMigrationIndex,
);
const preRetirementMigrations = handrailChatPostgresMigrations.slice(
  0,
  legacyRetirementMigrationIndex,
);

test("device push-token migrations are immutable and ordered", () => {
  assert.equal(Object.isFrozen(handrailChatPostgresMigrations), true);
  assert.equal(
    Object.isFrozen(chatDevicePushTokenProtectionMetadataMigration),
    true,
  );
  assert.equal(
    Object.isFrozen(chatDevicePushTokenProtectionMetadataMigration.statements),
    true,
  );
  assert.equal(
    handrailChatPostgresMigrations.filter(
      ({ id }) => id === protectionMigrationId,
    ).length,
    1,
  );
  assert.equal(
    protectionMigrationIndex,
    handrailChatPostgresMigrations.length - 3,
  );
  assert.deepEqual(
    handrailChatPostgresMigrations[protectionMigrationIndex - 1] && {
      id: handrailChatPostgresMigrations[protectionMigrationIndex - 1].id,
      order: handrailChatPostgresMigrations[protectionMigrationIndex - 1].order,
    },
    { id: "0032-chat-conversation-preference-starred", order: 32 },
  );
  assert.deepEqual(
    {
      id: chatDevicePushTokenProtectionMetadataMigration.id,
      order: chatDevicePushTokenProtectionMetadataMigration.order,
    },
    { id: protectionMigrationId, order: 33 },
  );
  assert.equal(
    Object.isFrozen(chatDevicePushTokenFreeRevocationMigration),
    true,
  );
  assert.equal(
    Object.isFrozen(chatDevicePushTokenFreeRevocationMigration.statements),
    true,
  );
  assert.equal(
    handrailChatPostgresMigrations.filter(
      ({ id }) => id === tokenFreeRevocationMigrationId,
    ).length,
    1,
  );
  assert.equal(
    tokenFreeRevocationMigrationIndex,
    protectionMigrationIndex + 1,
  );
  assert.equal(
    tokenFreeRevocationMigrationIndex,
    handrailChatPostgresMigrations.length - 2,
  );
  assert.deepEqual(
    {
      id: chatDevicePushTokenFreeRevocationMigration.id,
      order: chatDevicePushTokenFreeRevocationMigration.order,
    },
    { id: tokenFreeRevocationMigrationId, order: 34 },
  );
  assert.equal(
    Object.isFrozen(chatDevicePushTokenLegacyRetirementMigration),
    true,
  );
  assert.equal(
    Object.isFrozen(chatDevicePushTokenLegacyRetirementMigration.statements),
    true,
  );
  assert.equal(
    handrailChatPostgresMigrations.filter(
      ({ id }) => id === legacyRetirementMigrationId,
    ).length,
    1,
  );
  assert.equal(
    legacyRetirementMigrationIndex,
    tokenFreeRevocationMigrationIndex + 1,
  );
  assert.equal(
    legacyRetirementMigrationIndex,
    handrailChatPostgresMigrations.length - 1,
  );
  assert.deepEqual(
    {
      id: chatDevicePushTokenLegacyRetirementMigration.id,
      order: chatDevicePushTokenLegacyRetirementMigration.order,
    },
    { id: legacyRetirementMigrationId, order: 35 },
  );

  const runner = createPostgresMigrationRunner({
    database: {},
    migrations: handrailChatPostgresMigrations,
  });
  assert.deepEqual(
    runner.migrations.at(-1) && {
      id: runner.migrations.at(-1).id,
      order: runner.migrations.at(-1).order,
    },
    { id: legacyRetirementMigrationId, order: 35 },
  );
  assert.match(runner.migrations.at(-1)?.checksum ?? "", /^sha256:[a-f0-9]{64}$/);
});

test("device push-token migration retains tenant-safe revocable registrations", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "device_push_token" });
  const schema = quoteIdentifier(harness.schema);
  const tokens = `${schema}.chat_device_push_tokens`;

  const registerLegacy = ({
    tenantId = "tenant-a",
    userId = "user-a",
    deviceId = "device-a",
    platform = "ios",
    provider = "apns",
    environment = "sandbox",
    opaqueToken = `opaque-${tenantId}-${userId}-${deviceId}`,
    tokenRevision = 1,
    timestamp = "2030-01-01T00:00:00Z",
  } = {}) =>
    harness.pool.query(
      `INSERT INTO ${tokens}
         (tenant_id, user_id, device_id, platform, provider, environment,
          opaque_token, token_revision, created_at, activated_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $9)
       RETURNING tenant_id, user_id, device_id, platform, provider,
                 environment, token_revision, revoked_at`,
      [
        tenantId,
        userId,
        deviceId,
        platform,
        provider,
        environment,
        opaqueToken,
        tokenRevision,
        timestamp,
      ],
    );

  const register = ({
    tenantId = "tenant-a",
    userId = "user-a",
    deviceId = "device-a",
    platform = "ios",
    provider = "apns",
    environment = "sandbox",
    opaqueToken = `opaque-${tenantId}-${userId}-${deviceId}`,
    tokenRevision = 1,
    timestamp = "2030-01-01T00:00:00Z",
    tokenProtectionKeyId = `key-${deviceId}`,
  } = {}) =>
    harness.pool.query(
      `INSERT INTO ${tokens}
         (tenant_id, user_id, device_id, platform, provider, environment,
          opaque_token, token_revision, created_at, activated_at, updated_at,
          token_protection_scheme, token_protection_key_id)
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $9,
         'host_encrypted', $10
       )
       RETURNING tenant_id, user_id, device_id, platform, provider,
                 environment, token_revision, revoked_at`,
      [
        tenantId,
        userId,
        deviceId,
        platform,
        provider,
        environment,
        opaqueToken,
        tokenRevision,
        timestamp,
        tokenProtectionKeyId,
      ],
    );

  const registerWithProtection = ({
    deviceId,
    tokenProtectionScheme,
    tokenProtectionKeyId,
    opaqueToken = `protected-envelope-${deviceId}`,
  }) =>
    harness.pool.query(
      `INSERT INTO ${tokens}
         (tenant_id, user_id, device_id, platform, provider, environment,
          opaque_token, token_revision, created_at, activated_at, updated_at,
          token_protection_scheme, token_protection_key_id)
       VALUES (
         'tenant-a', 'user-a', $1, 'ios', 'apns', 'sandbox',
         $2, 1, '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z',
         '2030-01-01T00:00:00Z', $3, $4
       )
       RETURNING token_protection_scheme, token_protection_key_id`,
      [
        deviceId,
        opaqueToken,
        tokenProtectionScheme,
        tokenProtectionKeyId,
      ],
    );

  try {
    const preProtectionRunner = createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: preProtectionMigrations,
    });
    const preProtectionApply = await preProtectionRunner.apply();

    assert.deepEqual(
      preProtectionApply.applied.at(-1) && {
        id: preProtectionApply.applied.at(-1).id,
        order: preProtectionApply.applied.at(-1).order,
      },
      { id: "0032-chat-conversation-preference-starred", order: 32 },
    );
    assert.equal(preProtectionApply.status.pending.length, 0);

    const legacyOpaqueToken = "legacy-plaintext-🙂-preserve-these-bytes";
    await registerLegacy({
      deviceId: "legacy-before-protection",
      opaqueToken: legacyOpaqueToken,
    });
    assert.deepEqual(
      (
        await harness.pool.query(
          `SELECT
             convert_to(opaque_token, 'UTF8') = convert_to($4::text, 'UTF8')
               AS exact_opaque_token
           FROM ${tokens}
           WHERE tenant_id = $1 AND user_id = $2 AND device_id = $3`,
          [
            "tenant-a",
            "user-a",
            "legacy-before-protection",
            legacyOpaqueToken,
          ],
        )
      ).rows,
      [{ exact_opaque_token: true }],
    );

    const preRetirementRunner = createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: preRetirementMigrations,
    });
    const protectionApply = await preRetirementRunner.apply();
    assert.deepEqual(
      protectionApply.applied.map(({ id, order }) => ({ id, order })),
      [
        { id: protectionMigrationId, order: 33 },
        { id: tokenFreeRevocationMigrationId, order: 34 },
      ],
    );
    assert.equal(protectionApply.status.pending.length, 0);
    assert.deepEqual(
      (
        await harness.pool.query(
          `SELECT
             convert_to(opaque_token, 'UTF8') = convert_to($4::text, 'UTF8')
               AS exact_opaque_token,
             token_protection_scheme,
             token_protection_key_id
           FROM ${tokens}
           WHERE tenant_id = $1 AND user_id = $2 AND device_id = $3`,
          [
            "tenant-a",
            "user-a",
            "legacy-before-protection",
            legacyOpaqueToken,
          ],
        )
      ).rows,
      [
        {
          exact_opaque_token: true,
          token_protection_scheme: "legacy_plaintext",
          token_protection_key_id: null,
        },
      ],
    );

    await registerLegacy({
      deviceId: "legacy-old-writer-after-protection",
      opaqueToken: "legacy-active-before-retirement",
    });
    await registerLegacy({
      deviceId: "legacy-already-revoked",
      opaqueToken: "legacy-revoked-before-retirement",
    });
    await registerWithProtection({
      deviceId: "protected-already-revoked",
      tokenProtectionScheme: "host_encrypted",
      tokenProtectionKeyId: "protected-revoked-key",
    });
    await harness.pool.query(
      `UPDATE ${tokens}
       SET revoked_at = '2030-01-01T00:00:01Z',
           token_revision = 2,
           updated_at = '2030-01-01T00:00:01Z'
       WHERE tenant_id = 'tenant-a'
         AND user_id = 'user-a'
         AND device_id IN (
           'legacy-already-revoked',
           'protected-already-revoked'
         )`,
    );
    assert.deepEqual(
      (
        await harness.pool.query(
          `SELECT device_id, opaque_token IS NOT NULL AS retained_token,
                  token_revision, revoked_at IS NULL AS active,
                  token_protection_scheme, token_protection_key_id
           FROM ${tokens}
           WHERE device_id IN (
             'legacy-before-protection',
             'legacy-old-writer-after-protection',
             'legacy-already-revoked'
           )
           ORDER BY device_id`,
        )
      ).rows,
      [
        {
          device_id: "legacy-already-revoked",
          retained_token: true,
          token_revision: 2,
          active: false,
          token_protection_scheme: "legacy_plaintext",
          token_protection_key_id: null,
        },
        {
          device_id: "legacy-before-protection",
          retained_token: true,
          token_revision: 1,
          active: true,
          token_protection_scheme: "legacy_plaintext",
          token_protection_key_id: null,
        },
        {
          device_id: "legacy-old-writer-after-protection",
          retained_token: true,
          token_revision: 1,
          active: true,
          token_protection_scheme: "legacy_plaintext",
          token_protection_key_id: null,
        },
      ],
    );

    const runner = createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    });
    const retirementApply = await runner.apply();
    assert.deepEqual(
      retirementApply.applied.map(({ id, order }) => ({ id, order })),
      [{ id: legacyRetirementMigrationId, order: 35 }],
    );
    assert.equal(retirementApply.status.pending.length, 0);
    const retiredLegacyRows = (
      await harness.pool.query(
        `SELECT device_id, platform, provider, environment, opaque_token,
                token_revision, activated_at, updated_at, revoked_at,
                token_protection_scheme, token_protection_key_id
         FROM ${tokens}
         WHERE token_protection_scheme = 'legacy_plaintext'
         ORDER BY device_id`,
      )
    ).rows.map((row) => ({
      ...row,
      activated_at: row.activated_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
      revoked_at: row.revoked_at.toISOString(),
    }));
    assert.deepEqual(retiredLegacyRows, [
      {
        device_id: "legacy-already-revoked",
        platform: "ios",
        provider: "apns",
        environment: "sandbox",
        opaque_token: null,
        token_revision: 2,
        activated_at: "2030-01-01T00:00:00.000Z",
        updated_at: "2030-01-01T00:00:01.000Z",
        revoked_at: "2030-01-01T00:00:01.000Z",
        token_protection_scheme: "legacy_plaintext",
        token_protection_key_id: null,
      },
      {
        device_id: "legacy-before-protection",
        platform: "ios",
        provider: "apns",
        environment: "sandbox",
        opaque_token: null,
        token_revision: 2,
        activated_at: "2030-01-01T00:00:00.000Z",
        updated_at: "2030-01-01T00:00:00.000Z",
        revoked_at: "2030-01-01T00:00:00.000Z",
        token_protection_scheme: "legacy_plaintext",
        token_protection_key_id: null,
      },
      {
        device_id: "legacy-old-writer-after-protection",
        platform: "ios",
        provider: "apns",
        environment: "sandbox",
        opaque_token: null,
        token_revision: 2,
        activated_at: "2030-01-01T00:00:00.000Z",
        updated_at: "2030-01-01T00:00:00.000Z",
        revoked_at: "2030-01-01T00:00:00.000Z",
        token_protection_scheme: "legacy_plaintext",
        token_protection_key_id: null,
      },
    ]);
    assert.deepEqual(
      (
        await harness.pool.query(
          `SELECT opaque_token, token_revision, revoked_at IS NULL AS active,
                  token_protection_scheme, token_protection_key_id
           FROM ${tokens}
           WHERE tenant_id = 'tenant-a'
             AND user_id = 'user-a'
             AND device_id = 'protected-already-revoked'`,
        )
      ).rows,
      [
        {
          opaque_token: null,
          token_revision: 2,
          active: false,
          token_protection_scheme: "host_encrypted",
          token_protection_key_id: null,
        },
      ],
    );

    const secondApply = await runner.apply();
    assert.deepEqual(secondApply.applied, []);
    assert.deepEqual(secondApply.status.pending, []);
    assert.deepEqual(secondApply.status.incompatible, []);
    for (const [id, order] of [
      [protectionMigrationId, 33],
      [tokenFreeRevocationMigrationId, 34],
      [legacyRetirementMigrationId, 35],
    ]) {
      const checksum = runner.migrations.find(
        (migration) => migration.id === id,
      )?.checksum;
      assert.match(checksum ?? "", /^sha256:[a-f0-9]{64}$/);
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count
             FROM ${schema}._handrail_migrations
             WHERE id = $1 AND migration_order = $2 AND checksum = $3`,
            [id, order, checksum],
          )
        ).rows[0]?.count,
        1,
      );
    }
    const tableComment = (
      await harness.pool.query(
        `SELECT obj_description(relation.oid, 'pg_class') AS comment
         FROM pg_catalog.pg_class AS relation
         INNER JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = $1
           AND relation.relname = 'chat_device_push_tokens'`,
        [harness.schema],
      )
    ).rows[0]?.comment;
    assert.match(tableComment ?? "", /New application writes must use host_encrypted/);
    assert.match(
      tableComment ?? "",
      /must never enter canonical state, diagnostics, or logs/,
    );
    assert.deepEqual(
      (
        await harness.pool.query(
          `SELECT column_default
           FROM information_schema.columns
           WHERE table_schema = $1
             AND table_name = 'chat_device_push_tokens'
             AND column_name = 'token_protection_scheme'`,
          [harness.schema],
        )
      ).rows,
      [{ column_default: null }],
    );
    assert.deepEqual(
      (
        await harness.pool.query(
          `SELECT conname, convalidated
           FROM pg_catalog.pg_constraint AS constraint_definition
           INNER JOIN pg_catalog.pg_class AS relation
             ON relation.oid = constraint_definition.conrelid
           INNER JOIN pg_catalog.pg_namespace AS namespace
             ON namespace.oid = relation.relnamespace
           WHERE namespace.nspname = $1
             AND relation.relname = 'chat_device_push_tokens'
             AND conname IN (
               'chat_device_push_tokens_opaque_token_check',
               'chat_device_push_tokens_protection_coherence_check'
             )
           ORDER BY conname`,
          [harness.schema],
        )
      ).rows,
      [
        {
          conname: "chat_device_push_tokens_opaque_token_check",
          convalidated: true,
        },
        {
          conname: "chat_device_push_tokens_protection_coherence_check",
          convalidated: true,
        },
      ],
    );

    await t.test("enforces coherent protection metadata", async () => {
      const maximumKeyId = "k".repeat(255);
      assert.deepEqual(
        (
          await registerWithProtection({
            deviceId: "protected-coherent",
            tokenProtectionScheme: "host_encrypted",
            tokenProtectionKeyId: maximumKeyId,
          })
        ).rows,
        [
          {
            token_protection_scheme: "host_encrypted",
            token_protection_key_id: maximumKeyId,
          },
        ],
      );

      await assert.rejects(
        registerLegacy({ deviceId: "omitted-protection-metadata" }),
        (error) =>
          error?.code === "23502" &&
          error.column === "token_protection_scheme",
      );

      for (const [deviceId, tokenProtectionScheme, tokenProtectionKeyId] of [
        ["unknown-protection", "unknown_scheme", "key-1"],
        ["legacy-active", "legacy_plaintext", null],
        ["legacy-fabricated-key", "legacy_plaintext", "key-1"],
        ["protected-missing-key", "host_encrypted", null],
        ["protected-empty-key", "host_encrypted", ""],
        ["protected-whitespace-key", "host_encrypted", " \t\n"],
        ["protected-oversized-key", "host_encrypted", "k".repeat(256)],
      ]) {
        await assert.rejects(
          registerWithProtection({
            deviceId,
            tokenProtectionScheme,
            tokenProtectionKeyId,
          }),
          (error) =>
            error?.code === "23514" &&
            error.constraint ===
              "chat_device_push_tokens_protection_coherence_check",
        );
      }
    });

    await t.test("reuses a retired legacy identity only at a higher revision", async () => {
      await assert.rejects(
        register({
          deviceId: "legacy-before-protection",
          opaqueToken: "protected-non-monotonic-reregistration",
          tokenRevision: 2,
          timestamp: "2030-01-01T00:00:02Z",
        }),
        (error) =>
          error?.code === "23514" &&
          error.constraint ===
            "chat_device_push_tokens_revision_monotonic_check",
      );
      await register({
        deviceId: "legacy-before-protection",
        opaqueToken: "protected-reregistered-token",
        tokenRevision: 3,
        timestamp: "2030-01-01T00:00:02Z",
      });
      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT token_revision, revoked_at IS NULL AS active,
                    opaque_token IS NULL AS token_free,
                    token_protection_scheme, token_protection_key_id
             FROM ${tokens}
             WHERE tenant_id = 'tenant-a'
               AND user_id = 'user-a'
               AND device_id = 'legacy-before-protection'
             ORDER BY token_revision`,
          )
        ).rows,
        [
          {
            token_revision: 2,
            active: false,
            token_free: true,
            token_protection_scheme: "legacy_plaintext",
            token_protection_key_id: null,
          },
          {
            token_revision: 3,
            active: true,
            token_free: false,
            token_protection_scheme: "host_encrypted",
            token_protection_key_id: "key-legacy-before-protection",
          },
        ],
      );
    });

    await t.test("isolates active device identities by tenant and host user", async () => {
      await register({ deviceId: "shared-device" });
      await register({ tenantId: "tenant-b", deviceId: "shared-device" });
      await register({ userId: "user-b", deviceId: "shared-device" });

      await assert.rejects(
        register({
          deviceId: "shared-device",
          opaqueToken: "opaque-duplicate-active",
          tokenRevision: 2,
        }),
        (error) =>
          error?.code === "23505" &&
          error.constraint === "chat_device_push_tokens_active_device_idx",
      );

      const rows = await harness.pool.query(
        `SELECT tenant_id, user_id, count(*)::integer AS count
         FROM ${tokens}
         WHERE device_id = 'shared-device' AND revoked_at IS NULL
         GROUP BY tenant_id, user_id
         ORDER BY tenant_id, user_id`,
      );
      assert.deepEqual(rows.rows, [
        { tenant_id: "tenant-a", user_id: "user-a", count: 1 },
        { tenant_id: "tenant-a", user_id: "user-b", count: 1 },
        { tenant_id: "tenant-b", user_id: "user-a", count: 1 },
      ]);
    });

    await t.test("enforces provider targets, opaque-token bytes, and revisions", async () => {
      await register({
        deviceId: "ios-production",
        environment: "production",
      });
      await register({
        deviceId: "android-production",
        platform: "android",
        provider: "fcm",
        environment: "production",
      });
      await register({
        deviceId: "token-byte-limit",
        opaqueToken: "🙂".repeat(1024),
      });
      await register({
        deviceId: "revision-maximum",
        tokenRevision: 2147483647,
      });

      for (const [deviceId, target] of [
        ["ios-fcm", { platform: "ios", provider: "fcm", environment: "production" }],
        ["android-apns", { platform: "android", provider: "apns", environment: "production" }],
        ["android-sandbox", { platform: "android", provider: "fcm", environment: "sandbox" }],
      ]) {
        await assert.rejects(
          register({ deviceId, ...target }),
          (error) =>
            error?.code === "23514" &&
            error.constraint === "chat_device_push_tokens_provider_target_check",
        );
      }

      for (const [deviceId, opaqueToken] of [
        ["token-null", null],
        ["token-empty", ""],
        ["token-whitespace", " \t\n"],
        ["token-too-large", `${"🙂".repeat(1024)}a`],
      ]) {
        await assert.rejects(
          register({ deviceId, opaqueToken }),
          (error) =>
            error?.code === "23514" &&
            error.constraint === "chat_device_push_tokens_opaque_token_check",
        );
      }
      for (const [deviceId, tokenRevision] of [
        ["revision-zero", 0],
        ["revision-too-large", 2147483648],
      ]) {
        await assert.rejects(register({ deviceId, tokenRevision }));
      }
    });

    await t.test("requires monotonic refresh and unregister revisions", async () => {
      const refreshed = (
        await harness.pool.query(
          `UPDATE ${tokens}
           SET environment = 'production',
               opaque_token = 'opaque-refreshed-private-token',
               token_revision = 2,
               updated_at = '2030-01-01T00:00:01Z'
           WHERE tenant_id = 'tenant-a'
             AND user_id = 'user-a'
             AND device_id = 'shared-device'
             AND revoked_at IS NULL
           RETURNING environment, token_revision, revoked_at`,
        )
      ).rows[0];
      assert.deepEqual(refreshed, {
        environment: "production",
        token_revision: 2,
        revoked_at: null,
      });

      for (const opaqueToken of [
        null,
        "",
        " \t\n",
        `${"🙂".repeat(1024)}a`,
      ]) {
        await assert.rejects(
          harness.pool.query(
            `UPDATE ${tokens}
             SET opaque_token = $1,
                 token_revision = 3,
                 updated_at = '2030-01-01T00:00:02Z'
             WHERE tenant_id = 'tenant-a'
               AND user_id = 'user-a'
               AND device_id = 'shared-device'
               AND revoked_at IS NULL`,
            [opaqueToken],
          ),
          (error) =>
            error?.code === "23514" &&
            error.constraint === "chat_device_push_tokens_opaque_token_check",
        );
      }

      for (const tokenRevision of [1, 2]) {
        await assert.rejects(
          harness.pool.query(
            `UPDATE ${tokens}
             SET opaque_token = 'opaque-stale-refresh',
                 token_revision = $1,
                 updated_at = '2030-01-01T00:00:02Z'
             WHERE tenant_id = 'tenant-a'
               AND user_id = 'user-a'
               AND device_id = 'shared-device'
               AND revoked_at IS NULL`,
            [tokenRevision],
          ),
          (error) =>
            error?.code === "23514" &&
            error.constraint ===
              "chat_device_push_tokens_revision_monotonic_check",
        );
      }

      await assert.rejects(
        harness.pool.query(
          `UPDATE ${tokens}
           SET revoked_at = '2030-01-01T00:00:03Z',
               token_revision = 2,
               updated_at = '2030-01-01T00:00:03Z'
           WHERE tenant_id = 'tenant-a'
             AND user_id = 'user-a'
             AND device_id = 'shared-device'
             AND revoked_at IS NULL`,
        ),
        (error) =>
          error?.constraint ===
          "chat_device_push_tokens_revision_monotonic_check",
      );
    });

    await t.test("allows only atomic credential clearing during revocation", async () => {
      await registerWithProtection({
        deviceId: "token-free-revocation",
        tokenProtectionScheme: "host_encrypted",
        tokenProtectionKeyId: "key-1",
      });

      for (const [changedState, expectedError] of [
        [
          "platform = 'android', provider = 'fcm', environment = 'production'",
          /cannot replace provider state/,
        ],
        ["user_id = 'user-b'", /identity and activation timestamps are immutable/],
        [
          "token_protection_scheme = 'legacy_plaintext', token_protection_key_id = NULL",
          /cannot replace provider state/,
        ],
        ["token_protection_key_id = 'key-2'", /cannot replace provider state/],
        ["token_protection_key_id = NULL", /cannot replace provider state/],
        [
          "opaque_token = NULL",
          /chat_device_push_tokens_protection_coherence_check/,
        ],
        ["opaque_token = 'replacement-token'", /cannot replace provider state/],
      ]) {
        await assert.rejects(
          harness.pool.query(
            `UPDATE ${tokens}
             SET ${changedState},
                 revoked_at = '2030-01-01T00:00:01Z',
                 token_revision = 2,
                 updated_at = '2030-01-01T00:00:01Z'
             WHERE tenant_id = 'tenant-a'
               AND user_id = 'user-a'
               AND device_id = 'token-free-revocation'
               AND revoked_at IS NULL`,
          ),
          expectedError,
        );
      }

      const revoked = (
        await harness.pool.query(
          `UPDATE ${tokens}
           SET opaque_token = NULL,
               token_protection_key_id = NULL,
               revoked_at = '2030-01-01T00:00:01Z',
               token_revision = 2,
               updated_at = '2030-01-01T00:00:01Z'
           WHERE tenant_id = 'tenant-a'
             AND user_id = 'user-a'
             AND device_id = 'token-free-revocation'
             AND revoked_at IS NULL
           RETURNING tenant_id, user_id, device_id, platform, provider,
                     environment, opaque_token, token_revision,
                     token_protection_scheme, token_protection_key_id,
                     revoked_at`,
        )
      ).rows[0];
      assert.deepEqual(
        {
          ...revoked,
          revoked_at: revoked.revoked_at.toISOString(),
        },
        {
          tenant_id: "tenant-a",
          user_id: "user-a",
          device_id: "token-free-revocation",
          platform: "ios",
          provider: "apns",
          environment: "sandbox",
          opaque_token: null,
          token_revision: 2,
          token_protection_scheme: "host_encrypted",
          token_protection_key_id: null,
          revoked_at: "2030-01-01T00:00:01.000Z",
        },
      );

      await assert.rejects(
        harness.pool.query(
          `UPDATE ${tokens}
           SET opaque_token = 'restored-token',
               token_revision = 3,
               updated_at = '2030-01-01T00:00:02Z'
           WHERE tenant_id = 'tenant-a'
             AND user_id = 'user-a'
             AND device_id = 'token-free-revocation'
             AND revoked_at IS NOT NULL`,
        ),
        /revoked chat_device_push_tokens are immutable/,
      );
    });

    await t.test("retains revocation and permits a later registration", async () => {
      const revoked = (
        await harness.pool.query(
          `UPDATE ${tokens}
           SET opaque_token = NULL,
               token_protection_key_id = NULL,
               revoked_at = '2030-01-01T00:00:03Z',
               token_revision = 3,
               updated_at = '2030-01-01T00:00:03Z'
           WHERE tenant_id = 'tenant-a'
             AND user_id = 'user-a'
             AND device_id = 'shared-device'
             AND revoked_at IS NULL
           RETURNING token_revision, opaque_token, revoked_at`,
        )
      ).rows[0];
      assert.deepEqual(
        {
          tokenRevision: revoked.token_revision,
          opaqueToken: revoked.opaque_token,
          revokedAt: revoked.revoked_at.toISOString(),
        },
        {
          tokenRevision: 3,
          opaqueToken: null,
          revokedAt: "2030-01-01T00:00:03.000Z",
        },
      );

      await assert.rejects(
        register({
          deviceId: "shared-device",
          opaqueToken: "opaque-non-monotonic-reregistration",
          tokenRevision: 3,
          timestamp: "2030-01-01T00:00:04Z",
        }),
        (error) =>
          error?.code === "23514" &&
          error.constraint ===
            "chat_device_push_tokens_revision_monotonic_check",
      );

      await register({
        deviceId: "shared-device",
        opaqueToken: "opaque-reregistered-private-token",
        tokenRevision: 4,
        timestamp: "2030-01-01T00:00:04Z",
      });
      await assert.rejects(
        register({
          deviceId: "shared-device",
          opaqueToken: "opaque-second-active-token",
          tokenRevision: 5,
          timestamp: "2030-01-01T00:00:05Z",
        }),
        (error) =>
          error?.code === "23505" &&
          error.constraint === "chat_device_push_tokens_active_device_idx",
      );

      const history = await harness.pool.query(
        `SELECT token_revision, opaque_token, revoked_at IS NULL AS active
         FROM ${tokens}
         WHERE tenant_id = 'tenant-a'
           AND user_id = 'user-a'
           AND device_id = 'shared-device'
         ORDER BY token_revision`,
      );
      assert.deepEqual(history.rows, [
        {
          token_revision: 3,
          opaque_token: null,
          active: false,
        },
        {
          token_revision: 4,
          opaque_token: "opaque-reregistered-private-token",
          active: true,
        },
      ]);

      await assert.rejects(
        harness.pool.query(
          `UPDATE ${tokens}
           SET token_revision = 5, updated_at = '2030-01-01T00:00:05Z'
           WHERE tenant_id = 'tenant-a'
             AND user_id = 'user-a'
             AND device_id = 'shared-device'
             AND revoked_at IS NOT NULL`,
        ),
        /revoked chat_device_push_tokens are immutable/,
      );
      await assert.rejects(
        harness.pool.query(
          `DELETE FROM ${tokens}
           WHERE tenant_id = 'tenant-a'
             AND user_id = 'user-a'
             AND device_id = 'shared-device'
             AND revoked_at IS NOT NULL`,
        ),
        /chat_device_push_tokens are retained as history/,
      );
    });

    await t.test("defines and uses tenant lookup and revocation indexes", async () => {
      const indexes = (
        await harness.pool.query(
          `SELECT indexname, indexdef
           FROM pg_catalog.pg_indexes
           WHERE schemaname = $1
             AND tablename = 'chat_device_push_tokens'`,
          [harness.schema],
        )
      ).rows;
      const byName = new Map(indexes.map((index) => [index.indexname, index.indexdef]));

      assert.match(
        byName.get("chat_device_push_tokens_active_device_idx") ?? "",
        /UNIQUE INDEX .* \(tenant_id, user_id, device_id\).*WHERE \(revoked_at IS NULL\)/,
      );
      assert.match(
        byName.get("chat_device_push_tokens_tenant_lookup_idx") ?? "",
        /\(tenant_id, user_id, device_id, token_revision DESC\)/,
      );
      assert.match(
        byName.get("chat_device_push_tokens_revoked_idx") ?? "",
        /\(tenant_id, revoked_at, user_id, device_id\).*WHERE \(revoked_at IS NOT NULL\)/,
      );

      const client = await harness.pool.connect();
      try {
        await client.query(`ANALYZE ${tokens}`);
        await client.query("SET enable_seqscan = off");
        await client.query("SET enable_bitmapscan = off");

        const activePlan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT platform, provider, environment, token_revision, updated_at
           FROM ${tokens}
           WHERE tenant_id = 'tenant-a'
             AND user_id = 'user-a'
             AND device_id = 'shared-device'
             AND revoked_at IS NULL`,
        );
        assert.ok(
          findIndexes(activePlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_device_push_tokens_active_device_idx",
          ),
        );

        const historyPlan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT platform, provider, environment, token_revision, revoked_at
           FROM ${tokens}
           WHERE tenant_id = 'tenant-a'
             AND user_id = 'user-a'
             AND device_id = 'shared-device'
           ORDER BY token_revision DESC`,
        );
        assert.ok(
          findIndexes(historyPlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_device_push_tokens_tenant_lookup_idx",
          ),
        );

        const revokedPlan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT user_id, device_id, token_revision
           FROM ${tokens}
           WHERE tenant_id = 'tenant-a' AND revoked_at IS NOT NULL
           ORDER BY revoked_at, user_id, device_id`,
        );
        assert.ok(
          findIndexes(revokedPlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_device_push_tokens_revoked_idx",
          ),
        );
      } finally {
        await client.query("RESET enable_bitmapscan").catch(() => undefined);
        await client.query("RESET enable_seqscan").catch(() => undefined);
        client.release();
      }
    });

    await harness.teardown();
    assert.equal(await backend.schemaExists(harness.schema), false);
  } finally {
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});

test("device push-token protection metadata migration rolls back partial DDL", async () => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "push_token_rollback",
  });
  const schema = quoteIdentifier(harness.schema);
  const tokens = `${schema}.chat_device_push_tokens`;

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: preProtectionMigrations,
    }).apply();
    await harness.pool.query(
      `INSERT INTO ${tokens}
         (tenant_id, user_id, device_id, platform, provider, environment,
          opaque_token, token_revision, created_at, activated_at, updated_at)
       VALUES (
         'tenant-a', 'user-a', 'legacy-rollback', 'ios', 'apns', 'sandbox',
         'legacy-before-failed-migration', 1,
         '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z',
         '2030-01-01T00:00:00Z'
       )`,
    );

    const failingProtectionMigration = {
      ...chatDevicePushTokenProtectionMetadataMigration,
      statements: [
        ...chatDevicePushTokenProtectionMetadataMigration.statements,
        "SELECT * FROM chat_device_push_token_protection_failure",
      ],
    };
    const failingRunner = createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: [...preProtectionMigrations, failingProtectionMigration],
    });

    await assert.rejects(failingRunner.apply(), /does not exist/);
    assert.equal(
      (
        await harness.pool.query(
          `SELECT count(*)::integer AS count
           FROM information_schema.columns
           WHERE table_schema = $1
             AND table_name = 'chat_device_push_tokens'
             AND column_name IN (
               'token_protection_scheme',
               'token_protection_key_id'
             )`,
          [harness.schema],
        )
      ).rows[0]?.count,
      0,
    );
    assert.equal(
      (
        await harness.pool.query(
          `SELECT count(*)::integer AS count
           FROM pg_catalog.pg_constraint AS constraint_definition
           INNER JOIN pg_catalog.pg_class AS relation
             ON relation.oid = constraint_definition.conrelid
           INNER JOIN pg_catalog.pg_namespace AS namespace
             ON namespace.oid = relation.relnamespace
           WHERE namespace.nspname = $1
             AND relation.relname = 'chat_device_push_tokens'
             AND constraint_definition.conname =
               'chat_device_push_tokens_protection_coherence_check'`,
          [harness.schema],
        )
      ).rows[0]?.count,
      0,
    );
    assert.equal(
      (
        await harness.pool.query(
          `SELECT count(*)::integer AS count
           FROM ${schema}._handrail_migrations
           WHERE id = $1`,
          [protectionMigrationId],
        )
      ).rows[0]?.count,
      0,
    );
    assert.deepEqual(
      (
        await harness.pool.query(
          `SELECT
             convert_to(opaque_token, 'UTF8') =
               convert_to('legacy-before-failed-migration', 'UTF8')
               AS exact_opaque_token
           FROM ${tokens}
           WHERE tenant_id = 'tenant-a'
             AND user_id = 'user-a'
             AND device_id = 'legacy-rollback'`,
        )
      ).rows,
      [{ exact_opaque_token: true }],
    );
  } finally {
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});
