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
  readMessageContextDescriptor,
} from "../scripts/generate-message-context.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generator = resolve(root, "scripts/generate-message-context.mjs");
const descriptorSource = resolve(root, "contracts/http/message-context.json");

test("descriptor bounds lookup and separates authorization and transport failures", async () => {
  const d = await readMessageContextDescriptor(root);
  assert.equal(d.endpoint.method, "GET");
  assert.equal(d.response.maxMessages, 1);
  assert.equal(d.authorization.identifiersGrantAccess, false);
  assert.equal(d.transport.unavailableIsTransportFailure, false);
  assert.equal(d.pagination.changesExistingRoutes, false);
});
test("unsupported semantic descriptor edits fail generation", async () => {
  const descriptor = await readMessageContextDescriptor(root);
  for (const mutate of [
    d => { d.endpoint.path = "/messages/:messageId"; },
    d => { d.response.maxMessages = 100; },
    d => { d.response.statuses[2].fields.push("reason"); },
    d => { d.response.sequence.minimum = 0; },
    d => { d.authorization.identifiersGrantAccess = true; },
    d => { d.transport.unavailableIsTransportFailure = true; },
    d => { d.pagination.changesExistingRoutes = true; },
  ]) {
    const changed = structuredClone(descriptor);
    mutate(changed);
    assert.throws(() => generateTypeScript(changed));
    assert.throws(() => generateDart(changed));
  }
});

test("descriptor deterministically drives TypeScript and Dart output", async () => {
  const descriptor = await readMessageContextDescriptor(root);
  const typescript = generateTypeScript(descriptor);
  const dart = generateDart(descriptor);
  assert.equal(generateTypeScript(descriptor), typescript);
  assert.equal(generateDart(descriptor), dart);
  assert.equal(await readFile(resolve(root, "src/contracts/message-context.ts"), "utf8"), typescript);
  assert.equal(await readFile(resolve(root, "contracts/generated/dart/message_context.dart"), "utf8"), dart);
  assert.match(typescript, /parseCanonicalMessage/);
  assert.match(dart, /Message.fromJson/);
});

test("check mode is clean and detects both generated outputs drifting", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "handrail-message-context-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const descriptorPath = resolve(temporaryRoot, "contracts/http/message-context.json");
  await mkdir(dirname(descriptorPath), { recursive: true });
  await writeFile(descriptorPath, await readFile(descriptorSource, "utf8"));
  const run = (...args) => spawnSync(process.execPath, [generator, ...args, "--root", temporaryRoot], { encoding: "utf8" });
  assert.equal(run().status, 0);
  const clean = run("--check");
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /up to date/);

  const typescript = resolve(temporaryRoot, "src/contracts/message-context.ts");
  await writeFile(typescript, "// drift\n", { flag: "a" });
  const tsDrift = run("--check");
  assert.equal(tsDrift.status, 1);
  assert.match(tsDrift.stderr, /message-context\.ts/);

  assert.equal(run().status, 0);
  const dart = resolve(temporaryRoot, "contracts/generated/dart/message_context.dart");
  await writeFile(dart, "// drift\n", { flag: "a" });
  const dartDrift = run("--check");
  assert.equal(dartDrift.status, 1);
  assert.match(dartDrift.stderr, /message_context\.dart/);
});
