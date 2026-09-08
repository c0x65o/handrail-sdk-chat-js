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
  readConversationMembershipDescriptor,
} from "../scripts/generate-conversation-membership.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(
  repositoryRoot,
  "scripts/generate-conversation-membership.mjs",
);
const descriptorSourcePath = resolve(
  repositoryRoot,
  "contracts/http/conversation-membership.json",
);

test("descriptor defines every membership intent, outcome, and safety invariant", async () => {
  const descriptor = await readConversationMembershipDescriptor(repositoryRoot);
  assert.equal(descriptor.operation, "mutate_conversation_membership");
  assert.deepEqual(
    descriptor.intents.map((intent) => intent.name),
    ["join", "leave", "add_member", "remove_member", "change_member_role"],
  );
  assert.deepEqual(
    descriptor.reconciliationStatuses.map((status) => status.name),
    [
      "applied",
      "replayed",
      "already_requested_state",
      "member_list_conflict",
      "safety_rejected",
    ],
  );
  assert.deepEqual(
    descriptor.safetyErrors.map((error) => error.code),
    ["last_owner", "last_active_member"],
  );
  assert.equal(descriptor.memberRow.complete, true);
  assert.equal(descriptor.memberRow.uniqueBy, "userId");
  assert.equal(descriptor.memberRow.canonicalOrder, "ascendingUtf16CodeUnits");
  assert.ok(descriptor.trustedContextAliases.includes("authorization"));
  assert.ok(descriptor.trustedContextAliases.includes("hostEntityAuthorization"));
});

test("descriptor deterministically drives TypeScript and Dart outputs", async () => {
  const descriptor = await readConversationMembershipDescriptor(repositoryRoot);
  assert.equal(
    await readFile(resolve(repositoryRoot, "src/contracts/conversation-membership.ts"), "utf8"),
    generateTypeScript(descriptor),
  );
  assert.equal(
    await readFile(resolve(repositoryRoot, "contracts/generated/dart/conversation_membership.dart"), "utf8"),
    generateDart(descriptor),
  );
});

test("check mode is clean after generation and detects both output drifts", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "handrail-membership-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const descriptorPath = resolve(temporaryRoot, "contracts/http/conversation-membership.json");
  await mkdir(dirname(descriptorPath), { recursive: true });
  await writeFile(descriptorPath, await readFile(descriptorSourcePath, "utf8"));

  const generate = spawnSync(process.execPath, [generatorPath, "--root", temporaryRoot], { encoding: "utf8" });
  assert.equal(generate.status, 0, generate.stderr);
  const clean = spawnSync(process.execPath, [generatorPath, "--check", "--root", temporaryRoot], { encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /up to date/);

  const typescript = resolve(temporaryRoot, "src/contracts/conversation-membership.ts");
  await writeFile(typescript, "// drift\n", { flag: "a" });
  const tsDrift = spawnSync(process.execPath, [generatorPath, "--check", "--root", temporaryRoot], { encoding: "utf8" });
  assert.equal(tsDrift.status, 1);
  assert.match(tsDrift.stderr, /conversation-membership\.ts/);

  await writeFile(typescript, generateTypeScript(await readConversationMembershipDescriptor(temporaryRoot)));
  const dart = resolve(temporaryRoot, "contracts/generated/dart/conversation_membership.dart");
  await writeFile(dart, "// drift\n", { flag: "a" });
  const dartDrift = spawnSync(process.execPath, [generatorPath, "--check", "--root", temporaryRoot], { encoding: "utf8" });
  assert.equal(dartDrift.status, 1);
  assert.match(dartDrift.stderr, /conversation_membership\.dart/);
});
