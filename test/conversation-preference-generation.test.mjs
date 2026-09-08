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
  readConversationPreferenceDescriptor,
} from "../scripts/generate-conversation-preference.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generator = resolve(root, "scripts/generate-conversation-preference.mjs");
const descriptorSource = resolve(root, "contracts/http/conversation-preference.json");

test("descriptor defines explicit preference states and reconciliation rules", async () => {
  const descriptor = await readConversationPreferenceDescriptor(root);
  assert.equal(descriptor.method, "PATCH");
  assert.equal(descriptor.initialPreferenceRevision, 0);
  assert.deepEqual(descriptor.notificationPreferences, ["all", "mentions", "none"]);
  assert.equal(descriptor.inputFields.find((field) => field.name === "isStarred").type, "boolean");
  assert.equal(descriptor.canonicalPreferenceFields.find((field) => field.name === "isStarred").type, "boolean");
  assert.deepEqual(descriptor.muteStates.map((state) => state.name), ["unmuted", "indefinite", "until"]);
  assert.deepEqual(descriptor.reconciliationStatuses.map((status) => status.name), [
    "applied",
    "replayed",
    "already_requested_state",
    "preference_revision_conflict",
  ]);
  assert.equal(descriptor.resultFields.find((field) => field.name === "preference").delivery, "affectedUserOnly");
  assert.ok(descriptor.trustedContextAliases.includes("authorization"));
});

test("descriptor deterministically drives TypeScript and Dart output", async () => {
  const descriptor = await readConversationPreferenceDescriptor(root);
  const typescript = generateTypeScript(descriptor);
  const dart = generateDart(descriptor);
  assert.equal(await readFile(resolve(root, "src/contracts/conversation-preference-mutation.ts"), "utf8"), typescript);
  assert.equal(await readFile(resolve(root, "contracts/generated/dart/conversation_preference.dart"), "utf8"), dart);
  assert.match(typescript, /update_conversation_preference/);
  assert.match(dart, /preferenceRevisionConflict/);
});

test("check mode is clean and detects both generated outputs drifting", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "handrail-conversation-preference-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const descriptorPath = resolve(temporaryRoot, "contracts/http/conversation-preference.json");
  await mkdir(dirname(descriptorPath), { recursive: true });
  await writeFile(descriptorPath, await readFile(descriptorSource, "utf8"));
  const run = (...args) => spawnSync(process.execPath, [generator, ...args, "--root", temporaryRoot], { encoding: "utf8" });
  assert.equal(run().status, 0);
  const clean = run("--check");
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /up to date/);

  const typescript = resolve(temporaryRoot, "src/contracts/conversation-preference-mutation.ts");
  await writeFile(typescript, "// drift\n", { flag: "a" });
  const tsDrift = run("--check");
  assert.equal(tsDrift.status, 1);
  assert.match(tsDrift.stderr, /conversation-preference-mutation\.ts/);

  assert.equal(run().status, 0);
  const dart = resolve(temporaryRoot, "contracts/generated/dart/conversation_preference.dart");
  await writeFile(dart, "// drift\n", { flag: "a" });
  const dartDrift = run("--check");
  assert.equal(dartDrift.status, 1);
  assert.match(dartDrift.stderr, /conversation_preference\.dart/);
});
