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
  readDevicePushTokenDescriptor,
} from "../scripts/generate-device-push-token.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generator = resolve(root, "scripts/generate-device-push-token.mjs");
const descriptorSource = resolve(root, "contracts/http/device-push-token.json");

test("descriptor owns push-token intents, coherence, identity, bounds, and redaction", async () => {
  const descriptor = await readDevicePushTokenDescriptor(root);
  assert.deepEqual(Object.keys(descriptor.operations), ["register", "refresh", "unregister"]);
  assert.deepEqual(descriptor.providers, ["apns", "fcm"]);
  assert.deepEqual(descriptor.platforms, ["ios", "android"]);
  assert.equal(descriptor.revisionPolicy.strictlyGreaterThanCurrent, true);
  assert.equal(descriptor.canonicalResult.serverAuthored, true);
  assert.equal(descriptor.canonicalResult.containsOpaqueToken, false);
  assert.ok(descriptor.forbiddenPublicFields.trustedIdentity.includes("authorization"));
  assert.ok(descriptor.redaction.recursiveTokenAliases.includes("registrationToken"));
});

test("descriptor deterministically drives TypeScript and pure-Dart outputs", async () => {
  const descriptor = await readDevicePushTokenDescriptor(root);
  assert.equal(await readFile(resolve(root, "src/contracts/device-push-token.ts"), "utf8"), generateTypeScript(descriptor));
  assert.equal(await readFile(resolve(root, "contracts/generated/dart/device_push_token.dart"), "utf8"), generateDart(descriptor));
});

test("check mode is clean and reports drift in either output", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "handrail-device-push-token-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const descriptor = resolve(temporaryRoot, "contracts/http/device-push-token.json");
  await mkdir(dirname(descriptor), { recursive: true });
  await writeFile(descriptor, await readFile(descriptorSource, "utf8"));
  const run = (...args) => spawnSync(process.execPath, [generator, ...args, "--root", temporaryRoot], { encoding: "utf8" });
  assert.equal(run().status, 0);
  const clean = run("--check");
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /up to date/);

  const typescript = resolve(temporaryRoot, "src/contracts/device-push-token.ts");
  await writeFile(typescript, "// drift\n", { flag: "a" });
  let drift = run("--check");
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /device-push-token\.ts/);

  assert.equal(run().status, 0);
  const dart = resolve(temporaryRoot, "contracts/generated/dart/device_push_token.dart");
  await writeFile(dart, "// drift\n", { flag: "a" });
  drift = run("--check");
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /device_push_token\.dart/);
});
