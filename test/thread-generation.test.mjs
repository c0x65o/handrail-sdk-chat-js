import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  generateDart,
  generateTypeScript,
  readThreadDescriptor,
} from "../scripts/generate-thread.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(repositoryRoot, "scripts/generate-thread.mjs");
const descriptorSourcePath = resolve(
  repositoryRoot,
  "contracts/http/thread.json",
);

test("thread.json defines the root route and canonical reconciliation states", async () => {
  const descriptor = await readThreadDescriptor(repositoryRoot);

  assert.equal(descriptor.method, "POST");
  assert.equal(descriptor.path, "/messages/:rootMessageId/thread");
  assert.equal(descriptor.operation, "create_thread");
  assert.deepEqual(
    descriptor.reconciliationStatuses.map((status) => status.name),
    ["created", "existing_for_root", "replayed"],
  );
  assert.deepEqual(descriptor.inputFields[3], {
    name: "name", type: "ThreadConversationName", optional: true,
  });
  assert.equal(descriptor.inputFields[4].name, "initialFollow");
  assert.equal(descriptor.inputFields[4].optional, true);
  assert.equal(descriptor.inputFields[5].name, "idempotencyKey");
  assert.equal(
    descriptor.coherenceRules.rootThreadSummaryThreadIdMatchesConversation,
    true,
  );
  assert.ok(descriptor.trustedIdentityAliases.includes("authorization"));
  assert.ok(descriptor.trustedIdentityAliases.includes("capabilities"));
});

test("thread.json deterministically drives TypeScript and Dart outputs", async () => {
  const descriptor = await readThreadDescriptor(repositoryRoot);

  assert.equal(
    await readFile(
      resolve(repositoryRoot, "src/contracts/thread-creation.ts"),
      "utf8",
    ),
    generateTypeScript(descriptor),
  );
  assert.equal(
    await readFile(
      resolve(
        repositoryRoot,
        "contracts/generated/dart/thread_creation.dart",
      ),
      "utf8",
    ),
    generateDart(descriptor),
  );
});

test("thread generator check mode detects output drift", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "handrail-thread-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const descriptorPath = resolve(temporaryRoot, "contracts/http/thread.json");
  await mkdir(dirname(descriptorPath), { recursive: true });
  await writeFile(
    descriptorPath,
    await readFile(descriptorSourcePath, "utf8"),
    "utf8",
  );

  const generate = spawnSync(
    process.execPath,
    [generatorPath, "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(generate.status, 0, generate.stderr);

  const clean = spawnSync(
    process.execPath,
    [generatorPath, "--check", "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /up to date/);

  const dartOutput = resolve(
    temporaryRoot,
    "contracts/generated/dart/thread_creation.dart",
  );
  await writeFile(dartOutput, "// drift\n", { flag: "a" });
  const drift = spawnSync(
    process.execPath,
    [generatorPath, "--check", "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /thread_creation\.dart/);
});

test("thread generator rejects missing, required, or differently validated name fields", async () => {
  const descriptor = await readThreadDescriptor(repositoryRoot);
  for (const change of [
    (value) => value.inputFields.splice(3, 1),
    (value) => { value.inputFields[3].optional = false; },
    (value) => { value.inputFields[3].type = "nonBlankString"; },
  ]) {
    const invalid = structuredClone(descriptor);
    change(invalid);
    for (const generate of [generateTypeScript, generateDart]) {
      assert.throws(() => generate(invalid), /unsupported input fields/);
    }
  }
});
