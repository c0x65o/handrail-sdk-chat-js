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
  readAttachmentsDescriptor,
} from "../scripts/generate-attachments.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generator = resolve(root, "scripts/generate-attachments.mjs");
const descriptorSource = resolve(root, "contracts/http/attachments.json");

test("descriptor defines bounded provider-neutral lifecycle and operation contracts", async () => {
  const descriptor = await readAttachmentsDescriptor(root);
  assert.deepEqual(Object.keys(descriptor.lifecycle.states), [
    "pending", "finalized", "rejected", "attached", "abandoned",
  ]);
  assert.deepEqual(
    descriptor.lifecycle.allowedTransitions.map(({ from, to }) => [from, to]),
    [[null, "pending"], ["pending", "finalized"], ["pending", "rejected"], ["pending", "abandoned"], ["finalized", "attached"]],
  );
  assert.equal(descriptor.descriptors.opaque, true);
  assert.equal(descriptor.descriptors.providerNeutral, true);
  assert.ok(descriptor.forbiddenPublicFields.providerInternals.includes("objectKey"));
  assert.ok(descriptor.forbiddenPublicFields.secretBearing.includes("signedUrl"));
  assert.equal(descriptor.bounds.sizeMaxBytes, 100 * 1024 * 1024);
});

test("descriptor deterministically drives compatible TypeScript and Dart output", async () => {
  const descriptor = await readAttachmentsDescriptor(root);
  const typescript = generateTypeScript(descriptor);
  const dart = generateDart(descriptor);
  assert.equal(await readFile(resolve(root, "src/contracts/attachment-transport.ts"), "utf8"), typescript);
  assert.equal(await readFile(resolve(root, "contracts/generated/dart/attachment_transport.dart"), "utf8"), dart);
  assert.match(typescript, /parseAttachmentTransportResult/);
  assert.match(dart, /sealed class AttachmentLifecycleState/);
});

test("check mode is clean and detects drift in both generated outputs", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "handrail-attachments-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const descriptorPath = resolve(temporaryRoot, "contracts/http/attachments.json");
  await mkdir(dirname(descriptorPath), { recursive: true });
  await writeFile(descriptorPath, await readFile(descriptorSource, "utf8"));
  const run = (...args) => spawnSync(process.execPath, [generator, ...args, "--root", temporaryRoot], { encoding: "utf8" });
  assert.equal(run().status, 0);
  const clean = run("--check");
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /up to date/);

  const typescript = resolve(temporaryRoot, "src/contracts/attachment-transport.ts");
  await writeFile(typescript, "// drift\n", { flag: "a" });
  const tsDrift = run("--check");
  assert.equal(tsDrift.status, 1);
  assert.match(tsDrift.stderr, /attachment-transport\.ts/);

  assert.equal(run().status, 0);
  const dart = resolve(temporaryRoot, "contracts/generated/dart/attachment_transport.dart");
  await writeFile(dart, "// drift\n", { flag: "a" });
  const dartDrift = run("--check");
  assert.equal(dartDrift.status, 1);
  assert.match(dartDrift.stderr, /attachment_transport\.dart/);
});
