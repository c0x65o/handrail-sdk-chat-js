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
  readReactionDescriptor,
} from "../scripts/generate-reactions.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(repositoryRoot, "scripts/generate-reactions.mjs");
const descriptorSourcePath = resolve(
  repositoryRoot,
  "contracts/http/reactions.json",
);

test("the descriptor defines deterministic reaction intents and canonical aggregates", async () => {
  const descriptor = await readReactionDescriptor(repositoryRoot);

  assert.equal(descriptor.method, "PATCH");
  assert.equal(
    descriptor.path,
    "/messages/:messageId/reactions/:reactionKey",
  );
  assert.deepEqual(
    descriptor.operations.map((operation) => operation.name),
    ["add_reaction", "remove_reaction"],
  );
  assert.deepEqual(
    descriptor.operations.map((operation) => operation.reactedByCurrentUser),
    [true, false],
  );
  assert.equal(descriptor.reactionKey.normalization, "NFC");
  assert.equal(descriptor.reactionKey.maximumUtf8Bytes, 64);
  assert.equal(descriptor.idempotencyKey.maximumUtf8Bytes, 255);
  assert.deepEqual(
    descriptor.reconciliationStatuses.map((status) => status.name),
    ["applied", "replayed"],
  );
  assert.ok(descriptor.trustedIdentityAliases.includes("session"));
  assert.ok(descriptor.trustedIdentityAliases.includes("authorization"));
  assert.ok(descriptor.trustedIdentityAliases.includes("role"));
});

test("the descriptor deterministically drives TypeScript and Dart outputs", async () => {
  const descriptor = await readReactionDescriptor(repositoryRoot);

  assert.equal(
    await readFile(
      resolve(repositoryRoot, "src/contracts/reaction-mutations.ts"),
      "utf8",
    ),
    generateTypeScript(descriptor),
  );
  assert.equal(
    await readFile(
      resolve(
        repositoryRoot,
        "contracts/generated/dart/reaction_mutations.dart",
      ),
      "utf8",
    ),
    generateDart(descriptor),
  );
});

test("check mode is clean after generation and reports output drift", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "handrail-reactions-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const descriptorPath = resolve(temporaryRoot, "contracts/http/reactions.json");
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

  const driftedTypeScript = resolve(
    temporaryRoot,
    "src/contracts/reaction-mutations.ts",
  );
  await writeFile(driftedTypeScript, "// drift\n", { flag: "a" });
  const drift = spawnSync(
    process.execPath,
    [generatorPath, "--check", "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /reaction-mutations\.ts/);
});
