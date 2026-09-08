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
  readConversationArchiveDescriptor,
} from "../scripts/generate-conversation-archive.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(
  repositoryRoot,
  "scripts/generate-conversation-archive.mjs",
);
const descriptorSourcePath = resolve(
  repositoryRoot,
  "contracts/http/conversation-archive.json",
);

test("the descriptor defines explicit inverse intents and every reconciliation outcome", async () => {
  const descriptor = await readConversationArchiveDescriptor(repositoryRoot);

  assert.deepEqual(descriptor.intents, [
    {
      name: "archive",
      expectedState: "active",
      requestedState: "archived",
    },
    {
      name: "restore",
      expectedState: "archived",
      requestedState: "active",
    },
  ]);
  assert.deepEqual(
    descriptor.reconciliationStatuses.map((status) => status.name),
    [
      "applied",
      "replayed",
      "already_requested_state",
      "lifecycle_conflict",
    ],
  );
  assert.deepEqual(
    descriptor.archiveStates[1].fields.find(
      (field) => field.name === "archivedByUserId",
    ),
    { name: "archivedByUserId", type: "UserId", source: "server" },
  );
});

test("the descriptor deterministically drives TypeScript and Dart outputs", async () => {
  const descriptor = await readConversationArchiveDescriptor(repositoryRoot);

  assert.equal(
    await readFile(
      resolve(repositoryRoot, "src/contracts/conversation-archive.ts"),
      "utf8",
    ),
    generateTypeScript(descriptor),
  );
  assert.equal(
    await readFile(
      resolve(
        repositoryRoot,
        "contracts/generated/dart/conversation_archive.dart",
      ),
      "utf8",
    ),
    generateDart(descriptor),
  );
});

test("check mode is clean after generation and reports output drift", async (t) => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "handrail-conversation-archive-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const descriptorPath = resolve(
    temporaryRoot,
    "contracts/http/conversation-archive.json",
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

  const driftedDart = resolve(
    temporaryRoot,
    "contracts/generated/dart/conversation_archive.dart",
  );
  await writeFile(driftedDart, "// drift\n", { flag: "a" });
  const drift = spawnSync(
    process.execPath,
    [generatorPath, "--check", "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /conversation_archive\.dart/);
});
