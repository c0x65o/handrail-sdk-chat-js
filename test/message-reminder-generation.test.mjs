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
  readMessageReminderDescriptor,
} from "../scripts/generate-message-reminder.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(repositoryRoot, "scripts/generate-message-reminder.mjs");
const descriptorPath = resolve(repositoryRoot, "contracts/http/message-reminder.json");

test("descriptor fixes explicit intent, correlation, revision, privacy, and oracle-safety invariants", async () => {
  const descriptor = await readMessageReminderDescriptor(repositoryRoot);
  assert.equal(descriptor.operation, "message_reminder.v1");
  assert.deepEqual(descriptor.intents, ["set", "cancel"]);
  assert.equal(descriptor.intentSemantics.reschedule, "set");
  assert.equal(descriptor.intentSemantics.toggle, "forbidden");
  assert.equal(descriptor.initialReminderRevision, 0);
  assert.equal(descriptor.inputFields.at(-1).requiredFor, "set");
  assert.equal(descriptor.inputFields.at(-1).forbiddenFor, "cancel");
  assert.deepEqual(
    descriptor.reconciliationStatuses.map(({ name }) => name),
    ["applied", "replayed", "already-requested", "revision-conflict", "unavailable-source"],
  );
  assert.equal(descriptor.resultFields.at(-1).delivery, "affectedAuthenticatedActorOnly");
  assert.equal(descriptor.privacyPolicy.canonicalReminderContainsActorIdentity, false);
  assert.equal(descriptor.privacyPolicy.otherActorReminderData, "forbidden");
  assert.equal(descriptor.privacyPolicy.unavailableSourceActorStateDisclosure, "none");
  assert.equal(descriptor.coherenceRules.rejectNormalizedTrustedAliasesRecursively, true);
  assert.equal(descriptor.coherenceRules.rejectNormalizedToggleAliasesRecursively, true);
});

test("descriptor deterministically generates runtime-neutral TypeScript and pure Dart", async () => {
  const descriptor = await readMessageReminderDescriptor(repositoryRoot);
  const typescript = generateTypeScript(descriptor);
  const dart = generateDart(descriptor);
  assert.equal(
    await readFile(resolve(repositoryRoot, "src/contracts/generated/message-reminder.ts"), "utf8"),
    typescript,
  );
  assert.equal(
    await readFile(resolve(repositoryRoot, "contracts/generated/dart/message_reminder.dart"), "utf8"),
    dart,
  );
  assert.doesNotMatch(typescript, /node:/);
  assert.doesNotMatch(dart, /package:flutter/);
});

test("check mode is clean and reports drift in both generated outputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "handrail-message-reminder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const temporaryDescriptor = resolve(root, "contracts/http/message-reminder.json");
  await mkdir(dirname(temporaryDescriptor), { recursive: true });
  await writeFile(temporaryDescriptor, await readFile(descriptorPath, "utf8"), "utf8");
  const generate = spawnSync(process.execPath, [generatorPath, "--root", root], { encoding: "utf8" });
  assert.equal(generate.status, 0, generate.stderr);
  const clean = spawnSync(process.execPath, [generatorPath, "--check", "--root", root], { encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /up to date/);
  for (const path of [
    "src/contracts/generated/message-reminder.ts",
    "contracts/generated/dart/message_reminder.dart",
  ]) {
    await writeFile(resolve(root, path), "// drift\n", { flag: "a" });
  }
  const drift = spawnSync(process.execPath, [generatorPath, "--check", "--root", root], { encoding: "utf8" });
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /message-reminder\.ts/);
  assert.match(drift.stderr, /message_reminder\.dart/);
});
