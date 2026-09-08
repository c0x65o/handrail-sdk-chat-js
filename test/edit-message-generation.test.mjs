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
  readEditMessageDescriptor,
} from "../scripts/generate-edit-message.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(repositoryRoot, "scripts/generate-edit-message.mjs");
const descriptorSourcePath = resolve(
  repositoryRoot,
  "contracts/http/edit-message.json",
);

test("the descriptor defines edit fields and stale-revision reconciliation", async () => {
  const descriptor = await readEditMessageDescriptor(repositoryRoot);

  assert.equal(descriptor.method, "PATCH");
  assert.equal(descriptor.path, "/messages/:messageId");
  assert.equal(descriptor.operation, "edit");
  assert.deepEqual(descriptor.replyTo, {
    request: "forbidden",
    result: "preserveCanonicalMessage",
  });
  assert.deepEqual(
    descriptor.inputFields.map((field) => field.name),
    ["operation", "messageId", "expectedRevision", "content", "idempotencyKey"],
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
  assert.deepEqual(descriptor.staleRevisionConflict, {
    status: "revision_conflict",
    carries: ["message", "canonicalRevision"],
    canonicalRevisionRule: "differentFromExpectedRevision",
  });
});

test("generators reject drift from immutable reply semantics and content-only input", async () => {
  const descriptor = await readEditMessageDescriptor(repositoryRoot);
  for (const generate of [generateTypeScript, generateDart]) {
    for (const replyTo of [undefined, { ...descriptor.replyTo, request: "optional" },
      { ...descriptor.replyTo, result: "omit" }]) {
      assert.throws(() => generate({ ...descriptor, replyTo }), /forbid replyTo edits/);
    }
    assert.throws(() => generate({
      ...descriptor,
      inputFields: [...descriptor.inputFields, { name: "replyTo", type: "MessageReplyReference" }],
    }), /exactly these input fields/);
  }
});

test("the descriptor deterministically drives TypeScript and Dart outputs", async () => {
  const descriptor = await readEditMessageDescriptor(repositoryRoot);

  assert.equal(
    await readFile(
      resolve(repositoryRoot, "src/contracts/generated/edit-message.ts"),
      "utf8",
    ),
    generateTypeScript(descriptor),
  );
  assert.equal(
    await readFile(
      resolve(
        repositoryRoot,
        "contracts/generated/dart/edit_message.dart",
      ),
      "utf8",
    ),
    generateDart(descriptor),
  );
});

test("check mode is clean after generation and reports output drift", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "handrail-edit-message-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const descriptorPath = resolve(
    temporaryRoot,
    "contracts/http/edit-message.json",
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
    "contracts/generated/dart/edit_message.dart",
  );
  await writeFile(driftedDart, "// drift\n", { flag: "a" });
  const drift = spawnSync(
    process.execPath,
    [generatorPath, "--check", "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /edit_message\.dart/);
});
