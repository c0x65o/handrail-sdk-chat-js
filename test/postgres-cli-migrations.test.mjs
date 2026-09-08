import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { handrailChatPostgresMigrations } from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const packageRoot = resolve(import.meta.dirname, "..");
const cliPath = resolve(packageRoot, "dist/cli.js");

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const withoutCliDatabaseEnvironment = (additionalEnvironment = {}) => {
  const environment = { ...process.env };
  delete environment.HANDRAIL_CHAT_DATABASE_URL;
  delete environment.HANDRAIL_CHAT_SCHEMA;
  return Object.assign(environment, additionalEnvironment);
};

const startCli = (args, options = {}) => {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: packageRoot,
    env: withoutCliDatabaseEnvironment(options.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const completed = new Promise((resolveCompletion, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out: ${args.join(" ")}`));
    }, options.timeout ?? 15_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveCompletion({ code, signal, stdout, stderr });
    });
  });

  return { child, completed };
};

const runCli = (args, options) => startCli(args, options).completed;

test("CLI observes, applies, serializes, and reports real PostgreSQL migrations", async () => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "handrail_cli" });
  const targetSchema = `cli_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const quotedTargetSchema = quoteIdentifier(targetSchema);
  const qualifiedMetadata = `${quotedTargetSchema}.${quoteIdentifier("_handrail_migrations")}`;
  const databaseArgs = [
    "--connection-string",
    harness.connectionString,
    "--schema",
    targetSchema,
  ];
  const migrationCount = handrailChatPostgresMigrations.length;
  const firstMigrationId = handrailChatPostgresMigrations[0].id;
  let lockClient;

  try {
    assert.equal(await backend.schemaExists(targetSchema), false);
    const pending = await runCli(["migrate", "status", ...databaseArgs]);
    assert.equal(pending.code, 0);
    assert.match(
      pending.stdout,
      new RegExp(`status applied=0 pending=${migrationCount} incompatible=0`),
    );
    assert.match(pending.stdout, new RegExp(`pending ${firstMigrationId}`));
    assert.equal(pending.stderr, "");
    assert.equal(await backend.schemaExists(targetSchema), false);

    const metadataBefore = await harness.pool.query(
      `SELECT to_regclass($1)::text AS table_name`,
      [`${targetSchema}._handrail_migrations`],
    );
    assert.equal(metadataBefore.rows[0]?.table_name, null);

    lockClient = await harness.pool.connect();
    const lockKey = `@handrail/chat:migrations:v1:${targetSchema}`;
    await lockClient.query(
      "SELECT pg_advisory_lock(hashtextextended($1, 0))",
      [lockKey],
    );
    const concurrentApply = startCli(
      ["migrate", "apply", ...databaseArgs],
      { timeout: 30_000 },
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));

    const concurrentStatusStartedAt = Date.now();
    const concurrentStatus = await runCli([
      "migrate",
      "status",
      ...databaseArgs,
    ]);
    assert.equal(concurrentStatus.code, 0);
    assert.match(
      concurrentStatus.stdout,
      new RegExp(`status applied=0 pending=${migrationCount} incompatible=0`),
    );
    assert.ok(Date.now() - concurrentStatusStartedAt < 5_000);
    assert.equal(await backend.schemaExists(targetSchema), false);

    await lockClient.query(
      "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
      [lockKey],
    );
    lockClient.release();
    lockClient = undefined;

    const firstApply = await concurrentApply.completed;
    assert.equal(firstApply.code, 0);
    assert.match(
      firstApply.stdout,
      new RegExp(`applied ${migrationCount} ${firstMigrationId}`),
    );
    assert.match(
      firstApply.stdout,
      new RegExp(`status applied=${migrationCount} pending=0 incompatible=0`),
    );
    assert.equal(firstApply.stderr, "");
    assert.equal(await backend.schemaExists(targetSchema), true);

    const clean = await runCli(["migrate", "status", ...databaseArgs]);
    assert.equal(clean.code, 0);
    assert.match(
      clean.stdout,
      new RegExp(`status applied=${migrationCount} pending=0 incompatible=0`),
    );

    const reapplied = await runCli(["migrate", "apply", ...databaseArgs]);
    assert.equal(reapplied.code, 0);
    assert.match(reapplied.stdout, /applied 0\n/);
    assert.match(
      reapplied.stdout,
      new RegExp(`status applied=${migrationCount} pending=0 incompatible=0`),
    );

    const successfulOutput = [
      pending,
      concurrentStatus,
      firstApply,
      clean,
      reapplied,
    ]
      .flatMap(({ stdout, stderr }) => [stdout, stderr])
      .join("");
    const parsedConnection = new URL(harness.connectionString);
    assert.equal(successfulOutput.includes(harness.connectionString), false);
    if (parsedConnection.username) {
      assert.equal(successfulOutput.includes(parsedConnection.username), false);
    }
    if (parsedConnection.password) {
      assert.equal(successfulOutput.includes(parsedConnection.password), false);
    }

    await harness.pool.query(
      `UPDATE ${qualifiedMetadata} SET checksum = $1 WHERE id = $2`,
      ["sha256:" + "0".repeat(64), firstMigrationId],
    );
    const incompatibleStatus = await runCli([
      "migrate",
      "status",
      ...databaseArgs,
    ]);
    assert.equal(incompatibleStatus.code, 3);
    assert.match(incompatibleStatus.stdout, /incompatible=1/);
    assert.match(incompatibleStatus.stdout, /checksum_mismatch/);

    const incompatibleApply = await runCli([
      "migrate",
      "apply",
      ...databaseArgs,
    ]);
    assert.equal(incompatibleApply.code, 3);
    assert.match(incompatibleApply.stderr, /incompatible migration history/);
    assert.match(incompatibleApply.stderr, /checksum_mismatch/);
  } finally {
    if (lockClient) {
      await lockClient
        .query("SELECT pg_advisory_unlock_all()")
        .catch(() => undefined);
      lockClient.release();
    }
    await harness.pool
      .query(`DROP SCHEMA IF EXISTS ${quotedTargetSchema} CASCADE`)
      .catch(() => undefined);
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});
