import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { resolve } from "node:path";
import test from "node:test";

import {
  createNodeTestInvocation,
  enumerateNodeTestFiles,
  NODE_TEST_CONCURRENCY,
  NODE_TEST_TIMEOUT_MS,
  selectNodeTestFiles,
} from "../scripts/run-node-tests.mjs";

const root = resolve(import.meta.dirname, "..");
const workflowPath = resolve(root, ".github/workflows/node-tests.yml");
const runnerPath = resolve(root, "scripts/run-node-tests.mjs");
const packagePath = resolve(root, "package.json");

const representativeTests = [
  "test/send-message-http.test.mjs",
  "test/create-chat-client.test.mjs",
  "test/chat-provider.test.mjs",
  "test/chat-workspace.test.mjs",
  "test/message-generation.test.mjs",
  "test/cli.test.mjs",
  "test/exports.test.mjs",
];

test("Node test selection is exhaustive, deterministic, and excludes only PostgreSQL files", async () => {
  const entries = await readdir(resolve(root, "test"), { withFileTypes: true });
  const rootTests = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => `test/${entry.name}`)
    .sort();
  const postgresTests = rootTests.filter((testFile) =>
    /^test\/postgres-.*\.test\.mjs$/u.test(testFile),
  );
  const expectedSelection = rootTests.filter(
    (testFile) => !/^test\/postgres-.*\.test\.mjs$/u.test(testFile),
  );

  assert.ok(expectedSelection.length > 0, "the Node test selection must not be empty");
  assert.ok(postgresTests.length > 0, "the database workflow must retain its tests");

  const selectedTests = await enumerateNodeTestFiles(root);
  assert.deepEqual(selectedTests, expectedSelection);
  assert.deepEqual(selectedTests, [...selectedTests].sort());
  assert.deepEqual(await enumerateNodeTestFiles(root), selectedTests);

  for (const testFile of selectedTests) {
    const source = await readFile(resolve(root, testFile), "utf8");
    assert.doesNotMatch(
      source,
      /from\s*["']@handrail\/chat\/testing["']/u,
      `${testFile} must not import database-backed test helpers`,
    );
  }

  assert.ok(
    postgresTests.includes("test/postgres-cli-migrations.test.mjs"),
    "PostgreSQL CLI coverage must belong to the database suite",
  );
  assert.equal(
    "test/postgres-cli-migrations.test.mjs".endsWith("cli.test.mjs"),
    false,
    "the CLI-only glob must not select PostgreSQL migration coverage",
  );

  for (const testFile of representativeTests) {
    assert.ok(selectedTests.includes(testFile), `${testFile} must be selected`);
  }

  const workflowContractTests = expectedSelection.filter((testFile) =>
    testFile.endsWith("-workflow.test.mjs"),
  );
  assert.ok(workflowContractTests.length > 0);
  for (const testFile of workflowContractTests) {
    assert.ok(selectedTests.includes(testFile), `${testFile} must be selected`);
  }

  for (const testFile of postgresTests) {
    assert.ok(!selectedTests.includes(testFile), `${testFile} must be excluded`);
  }
  assert.deepEqual(
    [...selectedTests, ...postgresTests].sort(),
    rootTests,
    "every root test must be classified into exactly one suite",
  );

  assert.throws(() => selectNodeTestFiles([]), /No non-database root Node tests/u);
  assert.throws(
    () => selectNodeTestFiles(["test/fixtures/unknown.test.mjs"]),
    /Unknown root test selection/u,
  );
  assert.throws(
    () => selectNodeTestFiles(["test/unknown.js"]),
    /Unknown root test selection/u,
  );
  assert.throws(
    () => selectNodeTestFiles([selectedTests[0], selectedTests[0]]),
    /Duplicate root test selection/u,
  );
});

test("runner creates exactly one bounded Node test invocation", async () => {
  const selectedTests = await enumerateNodeTestFiles(root);
  const invocation = createNodeTestInvocation(selectedTests);
  const runner = await readFile(runnerPath, "utf8");

  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.args.filter((argument) => argument === "--test").length, 1);
  assert.equal(
    invocation.args.filter((argument) => argument.startsWith("--test-concurrency=")).length,
    1,
  );
  assert.equal(
    invocation.args.filter((argument) => argument.startsWith("--test-timeout=")).length,
    1,
  );
  assert.ok(Number.isInteger(NODE_TEST_CONCURRENCY) && NODE_TEST_CONCURRENCY > 0);
  assert.ok(Number.isInteger(NODE_TEST_TIMEOUT_MS) && NODE_TEST_TIMEOUT_MS > 0);
  assert.deepEqual(invocation.args.slice(-selectedTests.length), selectedTests);
  assert.equal((runner.match(/\bspawnSync\(/gu) ?? []).length, 1);
  assert.doesNotMatch(runner, /continue-on-error|allowFailure|\.status\s*\?\?/u);
});

test("Node test workflow preserves its install, build, and safety contract", async () => {
  const [workflow, packageJson] = await Promise.all([
    readFile(workflowPath, "utf8"),
    readFile(packagePath, "utf8").then(JSON.parse),
  ]);

  assert.equal(packageJson.scripts["test:node"], "node scripts/run-node-tests.mjs");
  assert.match(
    workflow,
    /^on:\n  push:\n    branches:\n      - main\n  pull_request:\n\npermissions:/mu,
  );
  assert.match(workflow, /^permissions:\n  contents: read\n\nconcurrency:/mu);
  assert.match(
    workflow,
    /^concurrency:\n  group: node-tests-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true\n\njobs:/mu,
  );

  assert.match(workflow, /^    runs-on: ubuntu-latest$/mu);
  const timeout = workflow.match(/^    timeout-minutes: (\d+)$/mu);
  assert.ok(timeout, "the Node test job must declare a timeout");
  assert.ok(Number(timeout[1]) > 0 && Number(timeout[1]) <= 30);

  const actions = [...workflow.matchAll(/^        uses: (.+)$/gmu)].map(
    (match) => match[1],
  );
  assert.deepEqual(actions, ["actions/checkout@v4", "actions/setup-node@v4", "dart-lang/setup-dart@v1"]);
  assert.match(workflow, /^          node-version: 22$/mu);
  assert.match(workflow, /^          cache: npm$/mu);
  assert.match(workflow, /^          cache-dependency-path: package-lock\.json$/mu);

  const commands = [...workflow.matchAll(/^        run: (.+)$/gmu)].map(
    (match) => match[1],
  );
  assert.match(workflow, /^          sdk: "3\.11\.5"$/mu);
  assert.deepEqual(commands, ["dart --version", "node scripts/generate-package-version.mjs --check", "npm ci --engine-strict", "npm run build", "npm run test:node"]);
  assert.equal(commands.filter((command) => command === "npm run build").length, 1);
  assert.equal(commands.filter((command) => command === "npm run test:node").length, 1);

  assert.doesNotMatch(workflow, /^\s*(?:services|env):$/mu);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./iu);
  assert.doesNotMatch(workflow, /^\s*continue-on-error:/mu);
  assert.doesNotMatch(
    workflow,
    /\b(?:postgres(?:ql)?|mysql|mariadb|sqlite|database|docker|flutter|provider|publish(?:ing)?|release|migrate|migration|deploy(?:ment)?|production|staging|kubectl|helm|terraform|pulumi|serverless|flyctl|vercel|netlify)\b|uses:\s*(?:aws-actions|azure|google-github-actions|cloudflare)\//iu,
  );
});

// Exercise the runner from a clean checkout without compiling the entire SDK
// recursively inside its own suite. The build fixture writes a fresh module;
// each focused-suite environment variable must resolve that module.
test("runner builds scoped prerequisites and rejects version drift before generation", async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "chat-node-runner-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(resolve(fixture, "scripts"));
  await mkdir(resolve(fixture, "src/client/generated"), { recursive: true });
  await mkdir(resolve(fixture, "test"));
  await copyFile(runnerPath, resolve(fixture, "scripts/run-node-tests.mjs"));
  await copyFile(resolve(root, "scripts/generate-package-version.mjs"), resolve(fixture, "scripts/generate-package-version.mjs"));
  await writeFile(resolve(fixture, "package.json"), JSON.stringify({
    type: "module", version: "1.2.3", scripts: { build: "node build.mjs" },
  }));
  await writeFile(resolve(fixture, "package-lock.json"), JSON.stringify({
    version: "1.2.3", packages: { "": { version: "1.2.3" } },
  }));
  await writeFile(resolve(fixture, "build.mjs"), `
    import { mkdir, writeFile } from "node:fs/promises";
    await mkdir("dist", { recursive: true });
    await writeFile("dist/fresh.mjs", "export const built = true;");
    await writeFile("build-ran", "yes");
  `);
  await writeFile(resolve(fixture, "test/prerequisites.test.mjs"), `
    import assert from "node:assert/strict";
    import test from "node:test";
    test("all scoped modules exist after preparation", async () => {
      for (const name of ["REPLY_STYLE", "THREAD_LIST", "THREAD_LIFECYCLE", "MESSAGE_CONTEXT"]) {
        const location = process.env["HANDRAIL_" + name + "_BUILD"];
        assert.ok(location.startsWith("file:"));
        assert.equal((await import(location + "/fresh.mjs")).built, true);
      }
    });
  `);
  const execute = promisify(execFile);
  const options = { cwd: fixture, env: { ...process.env, HANDRAIL_REPLY_STYLE_BUILD: "file:///stale" } };
  await execute(process.execPath, ["scripts/generate-package-version.mjs"], options);
  await execute(process.execPath, ["scripts/run-node-tests.mjs"], options);
  assert.equal(await readFile(resolve(fixture, "build-ran"), "utf8"), "yes");
  await rm(resolve(fixture, "build-ran"));
  const generated = resolve(fixture, "src/client/generated/package-version.ts");
  await writeFile(generated, "stale version metadata");
  await assert.rejects(execute(process.execPath, ["scripts/run-node-tests.mjs"], options),
    (error) => error.code === 1 && error.stderr.includes("out of date"));
  await assert.rejects(readFile(resolve(fixture, "build-ran")), { code: "ENOENT" });
  assert.equal(await readFile(generated, "utf8"), "stale version metadata");
});


test("minimum Node workflow installs with engine checks and exercises emitted consumers", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/node-minimum.yml"), "utf8");
  assert.match(workflow, /node-version: "22\.0\.0"/);
  const commands = [...workflow.matchAll(/^        run: (.+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(commands, [
    "node scripts/generate-package-version.mjs --check",
    "npm ci --include=dev --engine-strict",
    "node --test --test-concurrency=1 test/public-declaration-dependencies.test.mjs test/exports.test.mjs test/postgres-container-startup-cleanup.test.mjs",
  ]);
  assert.doesNotMatch(workflow, /continue-on-error|ignore-scripts|engine-strict=false/);
});
