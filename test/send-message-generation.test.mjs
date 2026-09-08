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
  readSendMessageDescriptor,
} from "../scripts/generate-send-message.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(repositoryRoot, "scripts/generate-send-message.mjs");
const descriptorSourcePath = resolve(
  repositoryRoot,
  "contracts/http/send-message.json",
);

test("the descriptor defines the send route, exact fields, and reconciliation states", async () => {
  const descriptor = await readSendMessageDescriptor(repositoryRoot);

  assert.equal(descriptor.method, "POST");
  assert.equal(descriptor.path, "/conversations/:conversationId/messages");
  assert.equal(descriptor.operation, "send");
  assert.deepEqual(
    descriptor.inputFields.map((field) => field.name),
    [
      "operation",
      "conversationId",
      "content",
      "replyTo",
      "clientMessageId",
      "idempotencyKey",
    ],
  );
  assert.deepEqual(
    descriptor.resultFields.map((field) => field.name),
    [
      "operation",
      "reconciliationStatus",
      "clientMessageId",
      "message",
      "canonicalRevision",
    ],
  );
  assert.deepEqual(
    descriptor.reconciliationStatuses.map((status) => status.name),
    ["applied", "replayed"],
  );
});

test("the descriptor deterministically drives TypeScript and Dart outputs", async () => {
  const descriptor = await readSendMessageDescriptor(repositoryRoot);

  assert.equal(
    await readFile(
      resolve(repositoryRoot, "src/contracts/generated/send-message.ts"),
      "utf8",
    ),
    generateTypeScript(descriptor),
  );
  assert.equal(
    await readFile(
      resolve(
        repositoryRoot,
        "contracts/generated/dart/send_message.dart",
      ),
      "utf8",
    ),
    generateDart(descriptor),
  );
});

test("check mode is clean after generation and reports output drift", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "handrail-send-message-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const descriptorPath = resolve(
    temporaryRoot,
    "contracts/http/send-message.json",
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

  const driftedTypeScript = resolve(
    temporaryRoot,
    "src/contracts/generated/send-message.ts",
  );
  await writeFile(driftedTypeScript, "// drift\n", { flag: "a" });
  const drift = spawnSync(
    process.execPath,
    [generatorPath, "--check", "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /send-message\.ts/);
});


test("replyTo must retain its optional shared-model descriptor", async () => {
  const descriptor = await readSendMessageDescriptor(repositoryRoot);
  assert.deepEqual(descriptor.inputFields.find((field) => field.name === "replyTo"), {
    name: "replyTo", type: "MessageReplyReference", presence: "optional",
  });
  for (const override of [{ type: "MessageContent" }, { presence: "required" }]) {
    const invalid = structuredClone(descriptor);
    Object.assign(invalid.inputFields.find((field) => field.name === "replyTo"), override);
    assert.throws(() => generateTypeScript(invalid), /optional MessageReplyReference/);
    assert.throws(() => generateDart(invalid), /optional MessageReplyReference/);
  }
});
