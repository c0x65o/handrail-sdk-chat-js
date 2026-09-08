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
  readHuddlesDescriptor,
} from "../scripts/generate-huddles.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(repositoryRoot, "scripts/generate-huddles.mjs");
const descriptorPath = resolve(repositoryRoot, "contracts/http/huddles.json");

test("canonical huddle descriptor enumerates the complete public protocol", async () => {
  const descriptor = await readHuddlesDescriptor(repositoryRoot);
  assert.deepEqual(descriptor.states, ["inactive", "starting", "active", "ended"]);
  assert.deepEqual(descriptor.participantStatuses, ["joined", "left"]);
  assert.deepEqual(Object.keys(descriptor.operations), [
    "start_huddle", "join_huddle", "leave_huddle",
    "set_huddle_screen_share", "end_huddle",
  ]);
  assert.equal(descriptor.mediaJoinDescriptor.opaque, true);
  assert.equal(descriptor.mediaJoinDescriptor.providerNeutral, true);
  assert.deepEqual(
    Object.entries(descriptor.operations).filter(([, value]) => value.featureDisabled).map(([operation]) => operation),
    ["start_huddle", "join_huddle"],
  );
  for (const forbidden of ["actorUserId", "providerConfiguration", "roomToken", "accessToken"]) {
    assert.equal(JSON.stringify(descriptor.forbiddenPublicFields).includes(forbidden), true);
  }
});

test("descriptor deterministically drives compatible TypeScript and pure-Dart outputs", async () => {
  const descriptor = await readHuddlesDescriptor(repositoryRoot);
  assert.equal(await readFile(resolve(repositoryRoot, "src/contracts/huddle-session.ts"), "utf8"), generateTypeScript(descriptor));
  assert.equal(await readFile(resolve(repositoryRoot, "contracts/generated/dart/huddle_session.dart"), "utf8"), generateDart(descriptor));
});

test("check mode reports generated huddle drift", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "handrail-huddles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const temporaryDescriptor = resolve(root, "contracts/http/huddles.json");
  await mkdir(dirname(temporaryDescriptor), { recursive: true });
  await writeFile(temporaryDescriptor, await readFile(descriptorPath, "utf8"));
  let run = spawnSync(process.execPath, [generatorPath, "--root", root], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  run = spawnSync(process.execPath, [generatorPath, "--check", "--root", root], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /up to date/);
  const dart = resolve(root, "contracts/generated/dart/huddle_session.dart");
  await writeFile(dart, "// drift\n", { flag: "a" });
  run = spawnSync(process.execPath, [generatorPath, "--check", "--root", root], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /huddle_session\.dart/);
});
