import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const packageRoot = resolve(import.meta.dirname, "..");
const cliPath = resolve(packageRoot, "dist/cli.js");
const serverModuleUrl = pathToFileURL(
  resolve(packageRoot, "dist/server/index.js"),
).href;
const fixtureRoot = await mkdtemp(resolve(tmpdir(), "handrail-chat-doctor-"));

test.after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

const runCli = (args) =>
  new Promise((resolveCompletion, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: packageRoot,
      env: process.env,
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
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`doctor CLI timed out: ${args.join(" ")}`));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveCompletion({ code, signal, stdout, stderr });
    });
  });

let fixtureSequence = 0;

const createFixture = async ({
  database = "healthy",
  compatibility = {},
  features = {},
  malformedDirectory = false,
  direct = false,
  owned = false,
  secret = "doctor_fixture_password",
} = {}) => {
  fixtureSequence += 1;
  const path = resolve(fixtureRoot, `config-${fixtureSequence}.mjs`);
  const server = `{
    database: ${
      owned
        ? `{ connectionString: "postgresql://owned_user:${secret}@localhost/owned_db", schema: "handrail_chat", createPool: () => pool }`
        : `{ pool, schema: "handrail_chat" }`
    },
    auth: { resolveActor: sentinel("auth.resolveActor") },
    directory: ${
      malformedDirectory
        ? `{ getUser: sentinel("directory.getUser") }`
        : `{ getUser: sentinel("directory.getUser"), searchUsers: sentinel("directory.searchUsers") }`
    },
    permissions: {
      getCapabilities: sentinel("permissions.getCapabilities"),
      authorizeEntity: sentinel("permissions.authorizeEntity")
    },
    storage: {
      createUploadUrl: sentinel("storage.createUploadUrl"),
      verifyObject: sentinel("storage.verifyObject"),
      createDownloadUrl: sentinel("storage.createDownloadUrl"),
      deleteObject: sentinel("storage.deleteObject")
    },
    notifications: { send: sentinel("notifications.send") },
    audit: { record: sentinel("audit.record") },
    realtime: { publish: sentinel("realtime.publish") },
    ${features.media === true ? "" : "media: undefined,"}
    features: ${JSON.stringify(features)},
    webSocket: { onSession: sentinel("webSocket.onSession") },
    password: ${JSON.stringify(secret)}
  }`;

  const moduleSource = `
    import {
      createPostgresMigrationRunner,
      handrailChatPostgresMigrations
    } from ${JSON.stringify(serverModuleUrl)};

    const sentinel = (name) => async () => {
      throw new Error("doctor invoked live operation: " + name);
    };
    const descriptorDatabase = {
      query: sentinel("descriptor.query"),
      connect: sentinel("descriptor.connect")
    };
    const descriptors = createPostgresMigrationRunner({
      database: descriptorDatabase,
      schema: "handrail_chat",
      migrations: handrailChatPostgresMigrations
    }).migrations;
    const databaseMode = ${JSON.stringify(database)};
    const owned = ${JSON.stringify(owned)};
    const secret = ${JSON.stringify(secret)};
    let ended = false;
    const pool = {
      async query(sql) {
        const text = String(sql);
        if (!/^\\s*SELECT\\b/i.test(text)) {
          throw new Error("doctor attempted a mutating database query: " + text);
        }
        if (databaseMode === "unreachable") {
          throw new Error(
            "password=" + secret +
            " postgresql://doctor_user:" + secret + "@127.0.0.1:1/doctor_secret_db"
          );
        }
        if (text.includes("SELECT EXISTS")) {
          return { rows: [{ exists: databaseMode !== "pending" }] };
        }
        if (text.includes("SELECT id, migration_order")) {
          return {
            rows: descriptors.map((migration, index) => ({
              id: migration.id,
              migration_order: migration.order,
              checksum:
                databaseMode === "incompatible" && index === 0
                  ? "sha256:" + "0".repeat(64)
                  : migration.checksum,
              applied_at: "2026-01-01T00:00:00.000Z"
            }))
          };
        }
        throw new Error("unexpected doctor query: " + text);
      },
      connect: sentinel("database.connect"),
      async end() {
        if (!owned) {
          throw new Error("doctor ended a borrowed database");
        }
        ended = true;
      }
    };
    process.on("beforeExit", () => {
      if (owned && !ended) {
        process.exitCode = 70;
      }
    });
    const server = ${server};
    const resolved = ${
      direct
        ? "server"
        : `{ server, compatibility: ${JSON.stringify(compatibility)} }`
    };
    export default async function createDoctorConfiguration() {
      return resolved;
    }
  `;
  await writeFile(path, moduleSource, "utf8");
  return path;
};

const runDoctor = async (fixture, json = true) =>
  runCli(["doctor", "--config", fixture, ...(json ? ["--json"] : [])]);

test("doctor JSON reports a healthy config with stable checks and no live calls", async () => {
  const fixture = await createFixture();
  const result = await runDoctor(fixture);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");

  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.command, "doctor");
  assert.equal(report.status, "healthy");
  assert.equal(report.exitCode, 0);
  assert.equal(report.config.module, "config-1.mjs");
  assert.equal(typeof report.package.version, "string");
  assert.equal(typeof report.package.protocolVersion, "number");
  assert.equal(typeof report.package.schemaVersion, "number");

  const ids = report.checks.map(({ id }) => id);
  assert.deepEqual(ids, [
    "config.module",
    "config.validation",
    "compatibility.package",
    "compatibility.protocol",
    "compatibility.schema",
    "feature.attachments",
    "feature.notifications",
    "feature.audit",
    "feature.realtime",
    "feature.media",
    "database.connectivity",
    "database.migrations",
  ]);
  for (const check of report.checks) {
    assert.match(check.id, /^[a-z]+(?:\.[a-z]+)+$/);
    assert.ok(["pass", "warn", "fail"].includes(check.status));
    assert.ok(["info", "warning", "error"].includes(check.severity));
    assert.equal(typeof check.message, "string");
  }
  assert.doesNotMatch(result.stdout, /doctor invoked live operation/);
});

test("doctor distinguishes pending migrations and disabled optional features", async () => {
  const fixture = await createFixture({
    database: "pending",
    direct: true,
    features: { media: false },
  });
  const result = await runDoctor(fixture, false);
  assert.equal(result.code, 4);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /doctor actionable \(exit 4\)/);
  assert.match(result.stdout, /PASS feature\.media media is disabled/);
  assert.match(result.stdout, /WARN database\.migrations/);
  assert.match(result.stdout, /doctor did not apply them/);
});

test("doctor closes a database it creates while leaving borrowed pools open", async () => {
  const fixture = await createFixture({ owned: true });
  const result = await runDoctor(fixture);
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).status, "healthy");
});

test("doctor reports protocol, schema, and migration-history incompatibility", async () => {
  const healthy = await createFixture();
  const healthyResult = JSON.parse((await runDoctor(healthy)).stdout);

  const cases = [
    {
      options: {
        compatibility: {
          packageVersion: `${healthyResult.package.version}-different`,
        },
      },
      checkId: "compatibility.package",
    },
    {
      options: {
        compatibility: {
          protocolVersion: healthyResult.package.protocolVersion + 10,
        },
      },
      checkId: "compatibility.protocol",
    },
    {
      options: {
        compatibility: {
          schemaVersion: healthyResult.package.schemaVersion + 10,
        },
      },
      checkId: "compatibility.schema",
    },
    {
      options: { database: "incompatible" },
      checkId: "database.migrations",
    },
  ];

  for (const { options, checkId } of cases) {
    const fixture = await createFixture(options);
    const result = await runDoctor(fixture);
    assert.equal(result.code, 3);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "incompatible");
    assert.equal(report.exitCode, 3);
    assert.equal(
      report.checks.find(({ id }) => id === checkId)?.status,
      "fail",
    );
  }
});

test("doctor reports malformed required and enabled-feature adapters as actionable", async () => {
  for (const options of [
    { malformedDirectory: true },
    { features: { media: true } },
  ]) {
    const fixture = await createFixture(options);
    const result = await runDoctor(fixture);
    assert.equal(result.code, 4);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "actionable");
    assert.equal(report.exitCode, 4);
    const validation = report.checks.find(
      ({ id }) => id === "config.validation",
    );
    assert.equal(validation.status, "fail");
  }
});

test("doctor reports unreachable databases operationally and redacts all secrets", async () => {
  const secret = "very_secret_doctor_password_8361";
  const fixture = await createFixture({ database: "unreachable", secret });
  const result = await runDoctor(fixture);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "operational_error");
  assert.equal(report.exitCode, 1);
  assert.equal(
    report.checks.find(({ id }) => id === "database.connectivity")?.status,
    "fail",
  );
  assert.doesNotMatch(result.stdout, new RegExp(secret));
  assert.doesNotMatch(result.stdout, /doctor_user|doctor_secret_db|postgresql:\/\//);
  assert.match(result.stdout, /\[REDACTED/);
});

test("doctor redacts secrets from imported-module errors and reserves exit 2 for usage", async () => {
  const secret = "import_failure_secret_9552";
  const fixture = resolve(fixtureRoot, "throwing-config.mjs");
  await writeFile(
    fixture,
    `console.error("token=${secret}");\nthrow new Error("password=${secret} authorization=Bearer-${secret}");`,
    "utf8",
  );
  const failedImport = await runDoctor(fixture);
  assert.equal(failedImport.code, 1);
  assert.equal(failedImport.stderr, "");
  assert.doesNotMatch(failedImport.stdout, new RegExp(secret));
  assert.match(failedImport.stdout, /\[REDACTED\]/);

  const usage = await runCli(["doctor", "--json"]);
  assert.equal(usage.code, 2);
  assert.equal(usage.stdout, "");
  assert.match(usage.stderr, /doctor requires --config/);
  assert.match(usage.stderr, /Usage:/);
});
