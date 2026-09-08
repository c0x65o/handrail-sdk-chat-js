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
  readConversationCreationDescriptor,
} from "../scripts/generate-conversation-creation.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(
  repositoryRoot,
  "scripts/generate-conversation-creation.mjs",
);
const descriptorSourcePath = resolve(
  repositoryRoot,
  "contracts/http/conversation-creation.json",
);

test("descriptor defines every creation variant and reconciliation outcome", async () => {
  const descriptor = await readConversationCreationDescriptor(repositoryRoot);

  assert.equal(descriptor.method, "POST");
  assert.equal(descriptor.path, "/conversations");
  assert.equal(descriptor.operation, "create_conversation");
  assert.deepEqual(
    descriptor.variants.map((variant) => variant.type),
    ["channel", "direct", "group_direct"],
  );
  assert.deepEqual(
    descriptor.reconciliationStatuses.map((status) => status.name),
    ["created", "existing_equivalent", "replayed"],
  );
  assert.equal(
    descriptor.participantIdentity.completeSetIncludesTrustedActor,
    true,
  );
  assert.equal(
    descriptor.inputFields.find((field) => field.name === "clientRequestId")
      .correlation,
    "exactResultEcho",
  );
  assert.ok(descriptor.trustedIdentityAliases.includes("authorization"));
  assert.ok(descriptor.trustedIdentityAliases.includes("capabilities"));
});

test("descriptor deterministically drives TypeScript and Dart outputs", async () => {
  const descriptor = await readConversationCreationDescriptor(repositoryRoot);

  assert.equal(
    await readFile(
      resolve(repositoryRoot, "src/contracts/conversation-creation.ts"),
      "utf8",
    ),
    generateTypeScript(descriptor),
  );
  assert.equal(
    await readFile(
      resolve(
        repositoryRoot,
        "contracts/generated/dart/conversation_creation.dart",
      ),
      "utf8",
    ),
    generateDart(descriptor),
  );
});

test("check mode detects TypeScript and Dart drift", async (t) => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "handrail-conversation-creation-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const descriptorPath = resolve(
    temporaryRoot,
    "contracts/http/conversation-creation.json",
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

  const typescriptOutput = resolve(
    temporaryRoot,
    "src/contracts/conversation-creation.ts",
  );
  await writeFile(typescriptOutput, "// TypeScript drift\n", { flag: "a" });
  const typescriptDrift = spawnSync(
    process.execPath,
    [generatorPath, "--check", "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(typescriptDrift.status, 1);
  assert.match(typescriptDrift.stderr, /conversation-creation\.ts/);

  await writeFile(
    typescriptOutput,
    generateTypeScript(await readConversationCreationDescriptor(temporaryRoot)),
    "utf8",
  );
  const dartOutput = resolve(
    temporaryRoot,
    "contracts/generated/dart/conversation_creation.dart",
  );
  await writeFile(dartOutput, "// Dart drift\n", { flag: "a" });
  const dartDrift = spawnSync(
    process.execPath,
    [generatorPath, "--check", "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(dartDrift.status, 1);
  assert.match(dartDrift.stderr, /conversation_creation\.dart/);
});
