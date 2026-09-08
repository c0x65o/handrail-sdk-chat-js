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
  readDeleteMessageDescriptor,
} from "../scripts/generate-delete-message.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(repositoryRoot, "scripts/generate-delete-message.mjs");
const descriptorSourcePath = resolve(
  repositoryRoot,
  "contracts/http/delete-message.json",
);

test("the descriptor defines soft-delete fields and canonical tombstones", async () => {
  const descriptor = await readDeleteMessageDescriptor(repositoryRoot);

  assert.equal(descriptor.method, "DELETE");
  assert.equal(descriptor.path, "/messages/:messageId");
  assert.equal(descriptor.operation, "soft_delete");
  assert.deepEqual(
    descriptor.inputFields.map((field) => field.name),
    ["operation", "messageId", "expectedRevision", "idempotencyKey"],
  );
  assert.deepEqual(
    descriptor.resultFields.map((field) => field.name),
    [
      "operation",
      "reconciliationStatus",
      "expectedRevision",
      "message",
      "canonicalRevision",
    ],
  );
  assert.deepEqual(
    descriptor.reconciliationStatuses.map((status) => status.name),
    ["applied", "replayed", "revision_conflict"],
  );
  assert.deepEqual(descriptor.deletedMessageShell, {
    model: "Message",
    content: "null",
    deletionMetadata: "requiredPaired",
  });
  assert.deepEqual(descriptor.staleRevisionConflict, {
    status: "revision_conflict",
    carries: ["message", "canonicalRevision"],
    canonicalRevisionRule: "differentFromExpectedRevision",
  });
});

test("the descriptor deterministically drives TypeScript and Dart outputs", async () => {
  const descriptor = await readDeleteMessageDescriptor(repositoryRoot);

  assert.equal(
    await readFile(
      resolve(repositoryRoot, "src/contracts/generated/delete-message.ts"),
      "utf8",
    ),
    generateTypeScript(descriptor),
  );
  assert.equal(
    await readFile(
      resolve(
        repositoryRoot,
        "contracts/generated/dart/delete_message.dart",
      ),
      "utf8",
    ),
    generateDart(descriptor),
  );
});

test("check mode is clean after generation and reports output drift", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "handrail-delete-message-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const descriptorPath = resolve(
    temporaryRoot,
    "contracts/http/delete-message.json",
  );
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

  const driftedDart = resolve(
    temporaryRoot,
    "contracts/generated/dart/delete_message.dart",
  );
  await writeFile(driftedDart, "// drift\n", { flag: "a" });
  const drift = spawnSync(
    process.execPath,
    [generatorPath, "--check", "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /delete_message\.dart/);
});

test("generation keeps replyTo in the shared Message result contract only", async () => {
  const descriptor = await readDeleteMessageDescriptor(repositoryRoot);
  assert.equal(descriptor.resultFields.find((field) => field.name === "message").type, "Message");

  const invalid = structuredClone(descriptor);
  invalid.inputFields.push({ name: "replyTo", type: "MessageReplyReference", presence: "optional" });
  for (const generate of [generateTypeScript, generateDart]) {
    assert.equal(generate(descriptor), generate(structuredClone(descriptor)));
    assert.throws(() => generate(invalid), /must define exactly these input fields/);
  }
});
