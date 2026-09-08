import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { handrailChatPostgresMigrations } from "@handrail/chat/server";

const packageRoot = resolve(import.meta.dirname, "..");
const cliPath = resolve(packageRoot, "dist/cli.js");

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

test("built package bin provides deterministic help, version, and usage exits", async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8"),
  );
  assert.equal(packageJson.bin["handrail-chat"], "./dist/cli.js");
  await access(cliPath);
  assert.match(await readFile(cliPath, "utf8"), /^#!\/usr\/bin\/env node/);

  const help = await runCli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /migrate status/);
  assert.match(help.stdout, /migrate apply/);
  assert.match(help.stdout, /serve --config <module\.mjs>/);
  assert.match(help.stdout, /127\.0\.0\.1:3000/);
  assert.match(help.stdout, /Port 0 selects an/);
  assert.match(help.stdout, /Exit codes:/);
  assert.equal(help.stderr, "");

  const migrateHelp = await runCli(["migrate", "--help"]);
  assert.equal(migrateHelp.code, 0);
  assert.equal(migrateHelp.stdout, help.stdout);

  const serveHelp = await runCli(["serve", "--help"]);
  assert.equal(serveHelp.code, 0);
  assert.equal(serveHelp.stdout, help.stdout);

  for (const args of [
    [],
    ["unknown"],
    ["migrate"],
    ["migrate", "unknown"],
    ["serve"],
    ["serve", "--config", "unused.mjs", "--port", "-1"],
    ["serve", "--config", "unused.mjs", "--port", "65536"],
  ]) {
    const result = await runCli(args);
    assert.equal(result.code, 2, `unexpected exit for ${args.join(" ")}`);
    assert.match(result.stderr, /Usage:/);
  }

  const version = await runCli(["--version"]);
  assert.equal(version.code, 0);
  assert.equal(
    version.stdout,
    `${packageJson.name} ${packageJson.version} migrations ${handrailChatPostgresMigrations.at(-1).id}\n`,
  );
  assert.equal(version.stderr, "");
});

test("CLI rejects invalid schema and connection inputs and redacts credentials", async () => {
  const secretInvalidUrl = "not-a-postgres-url-secret-value";
  const invalidConnection = await runCli([
    "migrate",
    "status",
    "--connection-string",
    secretInvalidUrl,
  ]);
  assert.equal(invalidConnection.code, 2);
  assert.doesNotMatch(
    `${invalidConnection.stdout}${invalidConnection.stderr}`,
    new RegExp(secretInvalidUrl),
  );

  const invalidSchema = await runCli([
    "migrate",
    "status",
    "--connection-string",
    "postgresql://127.0.0.1:1/unused",
    "--schema",
    "unsafe; DROP SCHEMA public",
  ]);
  assert.equal(invalidSchema.code, 2);
  assert.match(invalidSchema.stderr, /schema must be a PostgreSQL identifier/);

  const username = "cli_secret_user";
  const password = "cli_secret_password";
  const unreachableUrl = `postgresql://${username}:${password}@127.0.0.1:1/cli_secret_database?connect_timeout=1`;
  const unreachable = await runCli([
    "migrate",
    "status",
    "--connection-string",
    unreachableUrl,
  ]);
  assert.equal(unreachable.code, 1);
  const unreachableOutput = `${unreachable.stdout}${unreachable.stderr}`;
  assert.doesNotMatch(unreachableOutput, new RegExp(username));
  assert.doesNotMatch(unreachableOutput, new RegExp(password));
  assert.doesNotMatch(unreachableOutput, /postgresql:\/\//);
  assert.doesNotMatch(unreachableOutput, /cli_secret_database/);
});
