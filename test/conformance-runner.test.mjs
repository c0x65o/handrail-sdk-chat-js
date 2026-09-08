import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  discoverConformanceSuites,
  parseArguments,
  runConformance,
} from "../scripts/run-conformance.mjs";

const sentinel = "OPAQUE_TOKEN_SENTINEL_DO_NOT_PRINT";

test("discovers declared suites in deterministic id order", async (t) => {
  const root = await temporaryRepository(t);
  await writeSuite(root, "zeta");
  await writeSuite(root, "alpha");
  await mkdir(resolve(root, "conformance-tests", "fixtures-only"), {
    recursive: true,
  });

  const suites = await discoverConformanceSuites({ root });

  assert.deepEqual(
    suites.map((suite) => suite.id),
    ["alpha", "zeta"],
  );
});

test("runs only the suite selected exactly once", async (t) => {
  const root = await temporaryRepository(t);
  await writeSuite(root, "zeta", { generator: true });
  await writeSuite(root, "alpha", { generator: true });
  const calls = [];
  const output = captureOutput();

  const status = await runConformance({
    root,
    suiteId: "zeta",
    execute: async ({ suiteId, role }) => {
      calls.push(`${suiteId}:${role}`);
      return { status: "passed" };
    },
    ...output.streams,
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, ["zeta:generator", "zeta:typescript", "zeta:dart"]);
  assert.match(output.stdout(), /\[zeta\] agreement/u);
  assert.doesNotMatch(output.stdout(), /alpha/u);
  assert.deepEqual(parseArguments(["--suite", "zeta"]), { suiteId: "zeta" });
  assert.throws(
    () => parseArguments(["--suite", "alpha", "--suite=zeta"]),
    /only once/u,
  );
});

test("reports matching TypeScript and Dart success per suite", async (t) => {
  const root = await temporaryRepository(t);
  await writeSuite(root, "zeta");
  await writeSuite(root, "alpha");
  const calls = [];
  const output = captureOutput();

  const status = await runConformance({
    root,
    execute: async ({ suiteId, role }) => {
      calls.push(`${suiteId}:${role}`);
      return { status: "passed", stdout: sentinel, stderr: sentinel };
    },
    ...output.streams,
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [
    "alpha:typescript",
    "alpha:dart",
    "zeta:typescript",
    "zeta:dart",
  ]);
  assert.equal(
    output.stdout(),
    "[alpha] agreement: TypeScript and Dart passed.\n" +
      "[zeta] agreement: TypeScript and Dart passed.\n" +
      "Conformance passed: 2 suite(s).\n",
  );
  assert.equal(output.stderr(), "");
  assertNoSentinel(output);
});

test("fails with a clear suite-specific language disagreement", async (t) => {
  const root = await temporaryRepository(t);
  await writeSuite(root, "shared-contract");
  const output = captureOutput();

  const status = await runConformance({
    root,
    execute: async ({ role }) => ({
      status: role === "typescript" ? "passed" : "failed",
      stdout: sentinel,
      stderr: sentinel,
    }),
    ...output.streams,
  });

  assert.equal(status, 1);
  assert.match(
    output.stderr(),
    /\[shared-contract\] language disagreement: TypeScript passed; Dart failed\./u,
  );
  assert.match(output.stderr(), /Conformance failed: 1 of 1 suite/u);
  assertNoSentinel(output);
});

test("reports generator drift without exposing generator output", async (t) => {
  const root = await temporaryRepository(t);
  await writeSuite(root, "generated-contract", { generator: true });
  const output = captureOutput();

  const status = await runConformance({
    root,
    execute: async ({ role }) => ({
      status: role === "generator" ? "failed" : "passed",
      stdout: sentinel,
      stderr: sentinel,
    }),
    ...output.streams,
  });

  assert.equal(status, 1);
  assert.match(
    output.stderr(),
    /\[generated-contract\] generated-contract drift check failed\. Regenerate with: npm run generate:generated-contract/u,
  );
  assert.match(output.stdout(), /\[generated-contract\] agreement/u);
  assertNoSentinel(output);
});

test("turns a missing Flutter executable into an actionable failure", async (t) => {
  const root = await temporaryRepository(t);
  await writeSuite(root, "missing-flutter", {
    typescriptCommand: [process.execPath, "-e", "process.exit(0)"],
    dartCommand: [resolve(root, "flutter-does-not-exist")],
  });
  const output = captureOutput();

  const status = await runConformance({ root, ...output.streams });

  assert.equal(status, 1);
  assert.match(
    output.stderr(),
    /\[missing-flutter\] Dart\/Flutter unavailable; install Flutter and ensure "flutter" is on PATH\./u,
  );
  assert.doesNotMatch(output.stderr(), /ENOENT|spawn/u);
});

test("suppresses raw child stdout and stderr on process success and failure", async (t) => {
  const root = await temporaryRepository(t);
  await writeSuite(root, "process-output", {
    typescriptCommand: [process.execPath, "-e", `console.log(${JSON.stringify(sentinel)})`],
    dartCommand: [
      process.execPath,
      "-e",
      `console.error(${JSON.stringify(sentinel)}); process.exit(1)`,
    ],
  });
  const output = captureOutput();

  const status = await runConformance({ root, ...output.streams });

  assert.equal(status, 1);
  assert.match(output.stderr(), /\[process-output\] language disagreement/u);
  assertNoSentinel(output);
});

async function temporaryRepository(t) {
  const root = await mkdtemp(join(tmpdir(), "handrail-conformance-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeSuite(
  root,
  id,
  {
    generator = false,
    typescriptCommand = [process.execPath, "-e", "process.exit(0)"],
    dartCommand = [process.execPath, "-e", "process.exit(0)"],
  } = {},
) {
  const directory = resolve(root, "conformance-tests", "manifests");
  await mkdir(directory, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    id,
    typescript: { command: typescriptCommand },
    dart: { command: dartCommand },
    ...(generator
      ? {
          generator: {
            command: [process.execPath, "-e", "process.exit(0)"],
            regenerateScript: `generate:${id}`,
          },
        }
      : {}),
  };
  await writeFile(
    resolve(directory, `${id}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

function captureOutput() {
  let stdout = "";
  let stderr = "";
  return {
    streams: {
      stdout: { write: (value) => (stdout += value) },
      stderr: { write: (value) => (stderr += value) },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function assertNoSentinel(output) {
  assert.doesNotMatch(output.stdout(), new RegExp(sentinel, "u"));
  assert.doesNotMatch(output.stderr(), new RegExp(sentinel, "u"));
}
