import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  PostgresMigrationIncompatibilityError,
  createPostgresMigrationRunner,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const tableExists = async (pool, schema, table) => {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation
       INNER JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = $1
         AND relation.relname = $2
         AND relation.relkind IN ('r', 'p')
     ) AS exists`,
    [schema, table],
  );
  return result.rows[0]?.exists ?? false;
};

const firstMigration = {
  id: "0001-create-effects",
  order: 1,
  statements: [
    `CREATE TABLE migration_effects (
       label text PRIMARY KEY,
       applied_count integer NOT NULL DEFAULT 1
     )`,
    "INSERT INTO migration_effects (label) VALUES ('first')",
  ],
};
const secondMigration = {
  id: "0002-add-second-effect",
  order: 2,
  statements: ["INSERT INTO migration_effects (label) VALUES ('second')"],
};
const thirdMigration = {
  id: "0003-add-third-effect",
  order: 3,
  statements: ["INSERT INTO migration_effects (label) VALUES ('third')"],
};

test("migration definitions validate identifiers, identity, order, and checksums", () => {
  const database = {};
  const create = (migrations, schema = "handrail_chat") =>
    createPostgresMigrationRunner({ database, schema, migrations });

  assert.throws(
    () => create([firstMigration], "unsafe; DROP SCHEMA public"),
    /schema must be a PostgreSQL identifier/,
  );
  assert.throws(
    () => create([firstMigration, { ...secondMigration, id: firstMigration.id }]),
    /duplicate migration id/,
  );
  assert.throws(
    () => create([firstMigration, { ...secondMigration, order: 1 }]),
    /ambiguous migration order/,
  );

  const first = create([secondMigration, firstMigration]);
  const same = create([firstMigration, secondMigration]);
  const changed = create([
    { ...firstMigration, statements: [...firstMigration.statements, "SELECT 1"] },
    secondMigration,
  ]);

  assert.deepEqual(
    first.migrations.map(({ id, order }) => ({ id, order })),
    [
      { id: firstMigration.id, order: 1 },
      { id: secondMigration.id, order: 2 },
    ],
  );
  assert.equal(first.migrations[0].checksum, same.migrations[0].checksum);
  assert.notEqual(first.migrations[0].checksum, changed.migrations[0].checksum);
  assert.match(first.migrations[0].checksum, /^sha256:[a-f0-9]{64}$/);
});

test("migration status and apply are explicit, immutable, isolated, and serialized", async () => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "handrail_migrate" });
  const otherHarness = await backend.createHarness({
    schemaPrefix: "handrail_migrate",
  });
  const targetSchema = `migration_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const qualifiedEffects = `${quoteIdentifier(targetSchema)}.${quoteIdentifier("migration_effects")}`;
  const qualifiedMetadata = `${quoteIdentifier(targetSchema)}.${quoteIdentifier("_handrail_migrations")}`;
  const publicEffectsBefore = await tableExists(
    harness.pool,
    "public",
    "migration_effects",
  );
  const publicMetadataBefore = await tableExists(
    harness.pool,
    "public",
    "_handrail_migrations",
  );

  try {
    const initialRunner = createPostgresMigrationRunner({
      database: harness.pool,
      schema: targetSchema,
      migrations: [firstMigration, secondMigration],
    });

    assert.equal(await backend.schemaExists(targetSchema), false);
    const before = await initialRunner.status();
    assert.deepEqual(before.applied, []);
    assert.deepEqual(
      before.pending.map(({ id }) => id),
      [firstMigration.id, secondMigration.id],
    );
    assert.deepEqual(before.incompatible, []);
    assert.equal(await backend.schemaExists(targetSchema), false);
    assert.equal(
      await tableExists(harness.pool, targetSchema, "_handrail_migrations"),
      false,
    );

    const firstApply = await initialRunner.apply();
    assert.deepEqual(
      firstApply.applied.map(({ id }) => id),
      [firstMigration.id, secondMigration.id],
    );
    assert.ok(firstApply.applied.every(({ appliedAt }) => appliedAt instanceof Date));
    assert.equal(await backend.schemaExists(targetSchema), true);
    assert.equal(
      await tableExists(harness.pool, targetSchema, "_handrail_migrations"),
      true,
    );
    assert.deepEqual(
      (
        await harness.pool.query(
          `SELECT label, applied_count FROM ${qualifiedEffects} ORDER BY label`,
        )
      ).rows,
      [
        { label: "first", applied_count: 1 },
        { label: "second", applied_count: 1 },
      ],
    );
    assert.deepEqual(
      (
        await harness.pool.query(
          `SELECT id, checksum, applied_at FROM ${qualifiedMetadata} ORDER BY migration_order`,
        )
      ).rows.map(({ id, checksum, applied_at }) => ({
        id,
        checksum,
        timestampRecorded: applied_at instanceof Date,
      })),
      firstApply.applied.map(({ id, checksum }) => ({
        id,
        checksum,
        timestampRecorded: true,
      })),
    );

    const secondApply = await initialRunner.apply();
    assert.deepEqual(secondApply.applied, []);
    assert.deepEqual(secondApply.status.pending, []);
    assert.equal(
      (await harness.pool.query(`SELECT count(*)::integer AS count FROM ${qualifiedEffects}`))
        .rows[0]?.count,
      2,
    );

    const laterRunner = createPostgresMigrationRunner({
      database: harness.pool,
      schema: targetSchema,
      migrations: [firstMigration, secondMigration, thirdMigration],
    });
    const laterStatus = await laterRunner.status();
    assert.deepEqual(laterStatus.pending.map(({ id }) => id), [thirdMigration.id]);
    assert.deepEqual(
      (await laterRunner.apply()).applied.map(({ id }) => id),
      [thirdMigration.id],
    );

    const pendingAfterMismatch = {
      id: "0004-must-not-run-after-mismatch",
      order: 4,
      statements: ["INSERT INTO migration_effects (label) VALUES ('fourth')"],
    };
    const incompatibleRunner = createPostgresMigrationRunner({
      database: harness.pool,
      schema: targetSchema,
      migrations: [
        {
          ...firstMigration,
          statements: [...firstMigration.statements, "SELECT 1"],
        },
        secondMigration,
        thirdMigration,
        pendingAfterMismatch,
      ],
    });
    const incompatibleStatus = await incompatibleRunner.status();
    assert.deepEqual(
      incompatibleStatus.incompatible.map(({ id, reason }) => ({ id, reason })),
      [{ id: firstMigration.id, reason: "checksum_mismatch" }],
    );
    const checksumMismatch = incompatibleStatus.incompatible[0];
    assert.equal(checksumMismatch.reason, "checksum_mismatch");
    assert.notEqual(
      checksumMismatch.storedChecksum,
      checksumMismatch.currentChecksum,
    );
    assert.deepEqual(incompatibleStatus.pending.map(({ id }) => id), [
      pendingAfterMismatch.id,
    ]);
    await assert.rejects(
      incompatibleRunner.apply(),
      (error) =>
        error instanceof PostgresMigrationIncompatibilityError &&
        error.status.incompatible[0]?.reason === "checksum_mismatch",
    );
    assert.equal(
      (
        await harness.pool.query(
          `SELECT count(*)::integer AS count FROM ${qualifiedEffects} WHERE label = 'fourth'`,
        )
      ).rows[0]?.count,
      0,
    );

    const concurrentMigration = {
      ...pendingAfterMismatch,
      statements: [
        "SELECT pg_sleep(0.15)",
        "INSERT INTO migration_effects (label) VALUES ('fourth')",
      ],
    };
    const concurrentOptions = {
      database: harness.pool,
      schema: targetSchema,
      migrations: [
        firstMigration,
        secondMigration,
        thirdMigration,
        concurrentMigration,
      ],
    };
    const [concurrentLeft, concurrentRight] = await Promise.all([
      createPostgresMigrationRunner(concurrentOptions).apply(),
      createPostgresMigrationRunner(concurrentOptions).apply(),
    ]);
    assert.deepEqual(
      [concurrentLeft.applied.length, concurrentRight.applied.length].sort(),
      [0, 1],
    );
    assert.equal(
      (
        await harness.pool.query(
          `SELECT count(*)::integer AS count FROM ${qualifiedEffects} WHERE label = 'fourth'`,
        )
      ).rows[0]?.count,
      1,
    );

    const failingMigration = {
      id: "0005-failing-transaction",
      order: 5,
      statements: [
        "INSERT INTO migration_effects (label) VALUES ('rolled-back')",
        "INSERT INTO table_that_does_not_exist (id) VALUES (1)",
      ],
    };
    const failingRunner = createPostgresMigrationRunner({
      ...concurrentOptions,
      migrations: [...concurrentOptions.migrations, failingMigration],
    });
    await assert.rejects(failingRunner.apply(), /table_that_does_not_exist/);
    assert.equal(
      (
        await harness.pool.query(
          `SELECT count(*)::integer AS count FROM ${qualifiedEffects} WHERE label = 'rolled-back'`,
        )
      ).rows[0]?.count,
      0,
    );
    assert.equal(
      (
        await harness.pool.query(
          `SELECT count(*)::integer AS count FROM ${qualifiedMetadata} WHERE id = $1`,
          [failingMigration.id],
        )
      ).rows[0]?.count,
      0,
    );

    assert.equal(
      await tableExists(otherHarness.pool, otherHarness.schema, "migration_effects"),
      false,
    );
    assert.equal(
      await tableExists(
        otherHarness.pool,
        otherHarness.schema,
        "_handrail_migrations",
      ),
      false,
    );
    assert.equal(
      await tableExists(harness.pool, "public", "migration_effects"),
      publicEffectsBefore,
    );
    assert.equal(
      await tableExists(harness.pool, "public", "_handrail_migrations"),
      publicMetadataBefore,
    );
  } finally {
    await harness.pool
      .query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(targetSchema)} CASCADE`)
      .catch(() => undefined);
    await Promise.allSettled([harness.teardown(), otherHarness.teardown()]);
    await backend.teardown();
  }
});
