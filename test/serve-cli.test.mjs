import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { CHAT_PROTOCOL_VERSION } from "@handrail/chat";
import { WebSocket } from "ws";

const packageRoot = resolve(import.meta.dirname, "..");
const cliPath = resolve(packageRoot, "dist/cli.js");
const serverModuleUrl = pathToFileURL(
  resolve(packageRoot, "dist/server/index.js"),
).href;
const fixtureRoot = await mkdtemp(resolve(tmpdir(), "handrail-chat-serve-"));
const secret = "serve_secret_sentinel_840195";
let fixtureSequence = 0;

test.after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

const createFixture = async ({ mode = "healthy", malformed = false } = {}) => {
  fixtureSequence += 1;
  const fixturePath = resolve(fixtureRoot, `serve-${fixtureSequence}.mjs`);
  await writeFile(
    fixturePath,
    `
      import {
        createPostgresMigrationRunner,
        handrailChatPostgresMigrations
      } from ${JSON.stringify(serverModuleUrl)};

      const secret = ${JSON.stringify(secret)};
      const mode = ${JSON.stringify(mode)};
      const expectedProviders = process.env.SERVE_EXPECT_PROVIDERS ?? "none";
      const calls = new Map();
      let poolCreated = false;
      let ended = false;

      const called = (name) => {
        calls.set(name, (calls.get(name) ?? 0) + 1);
      };
      const provider = (name, result) => async () => {
        called(name);
        return result;
      };
      const descriptorDatabase = {
        query() { throw new Error("descriptor query was invoked"); },
        connect() { throw new Error("descriptor connect was invoked"); }
      };
      const descriptors = createPostgresMigrationRunner({
        database: descriptorDatabase,
        schema: "handrail_chat",
        migrations: handrailChatPostgresMigrations
      }).migrations;
      const pool = {
        async query(sql) {
          const text = String(sql);
          if (!/^\\s*SELECT\\b/i.test(text)) {
            throw new Error("serve attempted mutating query token=" + secret + " " + text);
          }
          if (mode === "database_error") {
            throw new Error(
              "password=" + secret +
              " postgresql://serve_user:" + secret + "@localhost/serve_secret_db"
            );
          }
          if (text.includes("SELECT EXISTS")) {
            return { rows: [{ exists: mode !== "pending" }] };
          }
          if (text.includes("SELECT id, migration_order")) {
            return {
              rows: descriptors.map((migration, index) => ({
                id: migration.id,
                migration_order: migration.order,
                checksum:
                  mode === "incompatible" && index === 0
                    ? "sha256:" + "0".repeat(64)
                    : migration.checksum,
                applied_at: "2026-01-01T00:00:00.000Z"
              }))
            };
          }
          throw new Error("unexpected read-only query token=" + secret + " " + text);
        },
        async connect() {
          throw new Error("serve invoked migration connect token=" + secret);
        },
        async end() {
          ended = true;
          if (mode === "cleanup_error") {
            throw new Error("secret=" + secret);
          }
        }
      };
      const server = {
        database: {
          connectionString:
            "postgresql://serve_user:" + secret + "@localhost/serve_secret_db",
          schema: "handrail_chat",
          createPool() {
            poolCreated = true;
            return pool;
          }
        },
        auth: {
          async resolveActor(request) {
            called("auth.resolveActor");
            if (request.headers.authorization !== "Bearer fixture-token") {
              throw new Error("authorization=Bearer " + secret);
            }
            return { tenantId: "tenant-fixture", userId: "user-fixture", roles: ["member"] };
          }
        },
        directory: ${
          malformed
            ? `{ getUser: provider("directory.getUser", null) }`
            : `{
                getUser: provider("directory.getUser", null),
                searchUsers: provider("directory.searchUsers", [])
              }`
        },
        permissions: {
          getCapabilities: provider("permissions.getCapabilities", ["chat.read"]),
          authorizeEntity: provider("permissions.authorizeEntity", true)
        },
        storage: {
          createUploadUrl: provider("storage.createUploadUrl", null),
          verifyObject: provider("storage.verifyObject", null),
          createDownloadUrl: provider("storage.createDownloadUrl", null),
          deleteObject: provider("storage.deleteObject", undefined)
        },
        notifications: { send: provider("notifications.send", undefined) },
        audit: { record: provider("audit.record", undefined) },
        realtime: { publish: provider("realtime.publish", undefined) },
        media: {
          createRoom: provider("media.createRoom", null),
          createParticipantToken: provider("media.createParticipantToken", null),
          terminateRoom: provider("media.terminateRoom", undefined)
        },
        password: secret,
        authorization: "Bearer " + secret,
        token: secret
      };

      process.on("beforeExit", () => {
        if (poolCreated && !ended) {
          process.exitCode = 70;
        }
        const providerCalls = [...calls.values()].reduce((sum, count) => sum + count, 0);
        if (expectedProviders === "none" && providerCalls !== 0) {
          process.exitCode = 71;
        }
        if (
          expectedProviders === "websocket" &&
          (providerCalls !== 2 || calls.get("auth.resolveActor") !== 1 ||
            calls.get("permissions.getCapabilities") !== 1)
        ) {
          process.exitCode = 72;
        }
      });

      console.log("token=" + secret);
      export default async function createServeConfiguration() {
        console.error("authorization=Bearer " + secret);
        return {
          server,
          compatibility: {
            protocolVersion: ${CHAT_PROTOCOL_VERSION}
          }
        };
      }
    `,
    "utf8",
  );
  return fixturePath;
};

const startServe = (configPath, { expectedProviders = "none" } = {}) => {
  const child = spawn(
    process.execPath,
    [cliPath, "serve", "--config", configPath, "--port", "0"],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        SERVE_EXPECT_PROVIDERS: expectedProviders,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolveReadiness, rejectReadiness) => {
    resolveReady = resolveReadiness;
    rejectReady = rejectReadiness;
  });
  // Expected pre-listen failures do not await readiness, but the rejected
  // readiness promise still needs an observer to avoid test-runner noise.
  void ready.catch(() => undefined);
  const inspectReadiness = () => {
    const match = stdout.match(/handrail-chat serve ready (http:\/\/\S+) schema=\S+/u);
    if (match) resolveReady(match[1]);
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    inspectReadiness();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const completed = new Promise((resolveCompletion, rejectCompletion) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectCompletion(new Error("serve CLI timed out"));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectReady(error);
      rejectCompletion(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(`serve exited before readiness: ${code} ${stderr}`));
      resolveCompletion({ code, signal, stdout, stderr });
    });
  });
  return { child, ready, completed };
};

const runServe = async (configPath) => {
  const processFixture = startServe(configPath);
  return processFixture.completed;
};

const assertSecretRedacted = ({ stdout, stderr }) => {
  const output = `${stdout}${stderr}`;
  assert.doesNotMatch(output, new RegExp(secret));
  assert.doesNotMatch(output, /serve_user|serve_secret_db|postgresql:\/\//u);
};

const connectWebSocket = async (httpUrl) => {
  const url = new URL("/_realtime", httpUrl);
  url.protocol = "ws:";
  const socket = new WebSocket(url, {
    headers: { authorization: "Bearer fixture-token" },
  });
  await new Promise((resolveOpen, rejectOpen) => {
    socket.once("open", resolveOpen);
    socket.once("error", rejectOpen);
  });
  const message = new Promise((resolveMessage, rejectMessage) => {
    socket.once("message", (data) =>
      resolveMessage(JSON.parse(data.toString("utf8"))),
    );
    socket.once("error", rejectMessage);
  });
  socket.send(
    JSON.stringify({
      clientPackageVersion: "fixture-client",
      protocolVersion: CHAT_PROTOCOL_VERSION,
    }),
  );
  return { socket, accepted: await message };
};

test("serve announces an ephemeral loopback URL, serves metadata and WebSocket auth, and shuts down on SIGINT", async () => {
  const fixture = await createFixture();
  const running = startServe(fixture, { expectedProviders: "websocket" });
  const httpUrl = await running.ready;
  assert.match(httpUrl, /^http:\/\/127\.0\.0\.1:\d+$/u);

  const response = await fetch(new URL("/_meta", httpUrl));
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(metadata.protocolVersion, CHAT_PROTOCOL_VERSION);

  const connection = await connectWebSocket(httpUrl);
  assert.equal(connection.accepted.type, "chat.session.accepted");
  assert.equal(connection.accepted.metadata.protocolVersion, CHAT_PROTOCOL_VERSION);
  const socketClosed = new Promise((resolveClosed) =>
    connection.socket.once("close", resolveClosed),
  );

  running.child.kill("SIGINT");
  const result = await running.completed;
  await socketClosed;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /handrail-chat serve stopped SIGINT/u);
  assert.equal(result.stderr, "");
  assertSecretRedacted(result);
});

test("serve shuts down an idle owned runtime deterministically on SIGTERM", async () => {
  const fixture = await createFixture();
  const running = startServe(fixture);
  await running.ready;
  running.child.kill("SIGTERM");
  const result = await running.completed;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /handrail-chat serve stopped SIGTERM/u);
  assert.equal(result.stderr, "");
  assertSecretRedacted(result);
});

test("serve reports owned-resource cleanup failures once with secrets redacted", async () => {
  const fixture = await createFixture({ mode: "cleanup_error" });
  const running = startServe(fixture);
  await running.ready;
  running.child.kill("SIGTERM");
  const result = await running.completed;
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(
    result.stderr.match(/cleanup failed:/gu)?.length,
    1,
  );
  assert.match(result.stderr, /secret=\[REDACTED\]/u);
  assertSecretRedacted(result);
});

test("serve rejects malformed config before creating or listening", async () => {
  const fixture = await createFixture({ malformed: true });
  const result = await runServe(fixture);
  assert.equal(result.code, 4);
  assert.doesNotMatch(result.stdout, /serve ready/u);
  assert.match(result.stderr, /directory\.searchUsers must be a function/u);
  assertSecretRedacted(result);
});

test("serve rejects pending and incompatible migrations without apply, connect, mutation, providers, or listening", async () => {
  for (const [mode, exitCode, message] of [
    ["pending", 4, /migration\(s\) are pending/u],
    ["incompatible", 3, /migration history is incompatible/u],
  ]) {
    const fixture = await createFixture({ mode });
    const result = await runServe(fixture);
    assert.equal(result.code, exitCode);
    assert.doesNotMatch(result.stdout, /serve ready/u);
    assert.match(result.stderr, message);
    assertSecretRedacted(result);
  }
});

test("serve redacts database startup and config-factory errors", async () => {
  const databaseFixture = await createFixture({ mode: "database_error" });
  const databaseFailure = await runServe(databaseFixture);
  assert.equal(databaseFailure.code, 1);
  assert.match(databaseFailure.stderr, /\[REDACTED/u);
  assertSecretRedacted(databaseFailure);

  const factoryFixture = resolve(fixtureRoot, "factory-error.mjs");
  await writeFile(
    factoryFixture,
    `console.log("token=${secret}");\nexport default () => { throw new Error("password=${secret}"); };`,
    "utf8",
  );
  const factoryFailure = await runServe(factoryFixture);
  assert.equal(factoryFailure.code, 1);
  assert.match(factoryFailure.stderr, /password=\[REDACTED\]/u);
  assertSecretRedacted(factoryFailure);
});
