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
  readThreadFollowDescriptor,
} from "../scripts/generate-thread-follow.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generator = resolve(root, "scripts/generate-thread-follow.mjs");
const descriptorSource = resolve(root, "contracts/http/thread-follow.json");

test("descriptor defines private explicit and server-derived follow semantics", async () => {
  const descriptor = await readThreadFollowDescriptor(root);
  assert.equal(descriptor.method, "PATCH");
  assert.equal(descriptor.target.type, "thread");
  assert.deepEqual(descriptor.intents, ["follow", "unfollow"]);
  assert.deepEqual(descriptor.followSources.map((source) => source.name), [
    "manual",
    "reply",
    "mention",
  ]);
  assert.equal(
    descriptor.canonicalStates.find((state) => state.name === "manual_unfollow")
      .preservedAgainstAutoFollow,
    true,
  );
  assert.equal(descriptor.autoFollowPolicy.callerAuthored, false);
  assert.equal(
    descriptor.resultFields.find((field) => field.name === "follow").delivery,
    "affectedUserOnly",
  );
  assert.deepEqual(
    descriptor.reconciliationStatuses.map((status) => status.name),
    [
      "applied",
      "replayed",
      "already_requested_state",
      "follow_revision_conflict",
    ],
  );
});

test("descriptor deterministically drives compatible TypeScript and Dart outputs", async () => {
  const descriptor = await readThreadFollowDescriptor(root);
  const typescript = generateTypeScript(descriptor);
  const dart = generateDart(descriptor);
  assert.equal(
    await readFile(resolve(root, "src/contracts/thread-follow-mutation.ts"), "utf8"),
    typescript,
  );
  assert.equal(
    await readFile(
      resolve(root, "contracts/generated/dart/thread_follow_mutation.dart"),
      "utf8",
    ),
    dart,
  );
  assert.match(typescript, /parseSetThreadFollowResult/);
  assert.match(dart, /CanonicalManualThreadUnfollowState/);
});

test("check mode is clean and detects drift in both generated outputs", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "handrail-thread-follow-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const descriptorPath = resolve(temporaryRoot, "contracts/http/thread-follow.json");
  await mkdir(dirname(descriptorPath), { recursive: true });
  await writeFile(descriptorPath, await readFile(descriptorSource, "utf8"));
  const run = (...args) =>
    spawnSync(process.execPath, [generator, ...args, "--root", temporaryRoot], {
      encoding: "utf8",
    });

  assert.equal(run().status, 0);
  const clean = run("--check");
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /up to date/);

  const typescript = resolve(temporaryRoot, "src/contracts/thread-follow-mutation.ts");
  await writeFile(typescript, "// drift\n", { flag: "a" });
  const tsDrift = run("--check");
  assert.equal(tsDrift.status, 1);
  assert.match(tsDrift.stderr, /thread-follow-mutation\.ts/);

  assert.equal(run().status, 0);
  const dart = resolve(
    temporaryRoot,
    "contracts/generated/dart/thread_follow_mutation.dart",
  );
  await writeFile(dart, "// drift\n", { flag: "a" });
  const dartDrift = run("--check");
  assert.equal(dartDrift.status, 1);
  assert.match(dartDrift.stderr, /thread_follow_mutation\.dart/);
});
