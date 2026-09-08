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
  readForwardMessageDescriptor,
} from "../scripts/generate-forward-message.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(repositoryRoot, "scripts/generate-forward-message.mjs");
const descriptorPath = resolve(repositoryRoot, "contracts/http/forward-message.json");

test("descriptor fixes versioned routing, ownership, snapshot, and attachment policy", async () => {
  const descriptor = await readForwardMessageDescriptor(repositoryRoot);
  assert.equal(descriptor.method, "POST");
  assert.equal(descriptor.path, "/messages/forward");
  assert.equal(descriptor.operation, "forward_message.v1");
  assert.deepEqual(descriptor.inputFields.map(({ name }) => name), [
    "operation",
    "sourceMessageId",
    "destinationConversationId",
    "clientCorrelationId",
    "idempotencyKey",
  ]);
  assert.equal(descriptor.snapshot.snapshotSemantics, "immutable_display_copy");
  assert.equal(descriptor.snapshot.liveSourceResolution, "forbidden");
  assert.equal(descriptor.snapshot.rawHtml, "forbidden");
  assert.equal(descriptor.snapshot.trustedSessionOrPrivateAuthorizationData, "forbidden");
  assert.equal(descriptor.attachmentPolicy.errorCode, "source_attachments_unsupported");
  assert.equal(descriptor.attachmentPolicy.silentDrop, false);
  assert.equal(descriptor.resultConsistency.destinationAuthorComesFromAuthenticatedActor, true);
});

test("descriptor deterministically generates runtime-neutral TypeScript and pure Dart", async () => {
  const descriptor = await readForwardMessageDescriptor(repositoryRoot);
  const typescript = generateTypeScript(descriptor);
  const dart = generateDart(descriptor);
  assert.equal(
    await readFile(resolve(repositoryRoot, "src/contracts/generated/forward-message.ts"), "utf8"),
    typescript,
  );
  assert.equal(
    await readFile(resolve(repositoryRoot, "contracts/generated/dart/forward_message.dart"), "utf8"),
    dart,
  );
  assert.doesNotMatch(typescript, /node:/);
  assert.doesNotMatch(dart, /package:flutter/);
});

test("check mode is clean and detects both generated outputs drifting", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "handrail-forward-message-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const temporaryDescriptor = resolve(root, "contracts/http/forward-message.json");
  await mkdir(dirname(temporaryDescriptor), { recursive: true });
  await writeFile(temporaryDescriptor, await readFile(descriptorPath, "utf8"), "utf8");
  const generate = spawnSync(process.execPath, [generatorPath, "--root", root], { encoding: "utf8" });
  assert.equal(generate.status, 0, generate.stderr);
  const clean = spawnSync(process.execPath, [generatorPath, "--check", "--root", root], { encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /up to date/);
  for (const path of [
    "src/contracts/generated/forward-message.ts",
    "contracts/generated/dart/forward_message.dart",
  ]) {
    await writeFile(resolve(root, path), "// drift\n", { flag: "a" });
  }
  const drift = spawnSync(process.execPath, [generatorPath, "--check", "--root", root], { encoding: "utf8" });
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /forward-message\.ts/);
  assert.match(drift.stderr, /forward_message\.dart/);
});
