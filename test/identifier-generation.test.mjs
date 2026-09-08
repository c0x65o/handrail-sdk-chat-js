import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  generateDart,
  generateTypeScript,
  readIdentifierDescriptor,
} from "../scripts/generate-identifiers.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(repositoryRoot, "scripts/generate-identifiers.mjs");
const descriptorSourcePath = resolve(
  repositoryRoot,
  "contracts/models/identifiers.json",
);

test("the identifier descriptor deterministically drives both generated outputs", async () => {
  const descriptor = await readIdentifierDescriptor(repositoryRoot);
  assert.deepEqual(
    descriptor.identifiers.map(({ name, wireType }) => ({ name, wireType })),
    [
      { name: "TenantScopedId", wireType: "string" },
      { name: "TenantId", wireType: "string" },
      { name: "ConversationId", wireType: "string" },
      { name: "MessageId", wireType: "string" },
      { name: "UserId", wireType: "string" },
      { name: "AttachmentId", wireType: "string" },
      { name: "DeviceId", wireType: "string" },
      { name: "SessionId", wireType: "string" },
      { name: "IsoTimestamp", wireType: "string" },
      { name: "MessageSequence", wireType: "number" },
    ],
  );

  assert.equal(
    await readFile(resolve(repositoryRoot, "src/contracts/identifiers.ts"), "utf8"),
    generateTypeScript(descriptor),
  );
  assert.equal(
    await readFile(
      resolve(
        repositoryRoot,
        "contracts/generated/dart/identifiers.dart",
      ),
      "utf8",
    ),
    generateDart(descriptor),
  );
});

test("generation is immediately clean and check mode exits nonzero on drift", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "handrail-identifiers-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const temporaryDescriptor = resolve(
    temporaryRoot,
    "contracts/models/identifiers.json",
  );
  await mkdir(dirname(temporaryDescriptor), { recursive: true });
  await writeFile(
    temporaryDescriptor,
    await readFile(descriptorSourcePath, "utf8"),
    "utf8",
  );

  const generate = spawnSync(process.execPath, [generatorPath, "--root", temporaryRoot], {
    encoding: "utf8",
  });
  assert.equal(generate.status, 0, generate.stderr);

  const cleanCheck = spawnSync(
    process.execPath,
    [generatorPath, "--check", "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(cleanCheck.status, 0, cleanCheck.stderr);
  assert.match(cleanCheck.stdout, /up to date/);

  await writeFile(
    resolve(temporaryRoot, "src/contracts/identifiers.ts"),
    "// drift\n",
    { flag: "a" },
  );
  const driftCheck = spawnSync(
    process.execPath,
    [generatorPath, "--check", "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(driftCheck.status, 1);
  assert.match(driftCheck.stderr, /src\/contracts\/identifiers\.ts/);
});
