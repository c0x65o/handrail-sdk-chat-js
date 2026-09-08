import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  generateDart,
  generateTypeScript,
  readReadCursorDescriptor,
} from "../scripts/generate-read-cursor.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(repositoryRoot, "scripts/generate-read-cursor.mjs");

test("the descriptor defines bounded intents, explicit retries, and a private durable event", async () => {
  const descriptor = await readReadCursorDescriptor(repositoryRoot);
  assert.deepEqual(descriptor.operations.map(({ name, sequenceField }) =>
    ({ name, sequenceField })), [
    { name: "mark_read", sequenceField: "throughSequence" },
    { name: "mark_unread", sequenceField: "fromSequence" },
  ]);
  assert.equal(descriptor.idempotencyKey.maximumUtf8Bytes, 255);
  assert.deepEqual(
    descriptor.reconciliationStatuses.map(({ name }) => name),
    ["applied", "replayed"],
  );
  assert.equal(descriptor.event.visibility, "private_user_stream");
  assert.equal(descriptor.event.durability, "durable");
});

test("the descriptor deterministically drives TypeScript and Dart outputs", async () => {
  const descriptor = await readReadCursorDescriptor(repositoryRoot);
  assert.equal(
    await readFile(resolve(repositoryRoot, "src/contracts/read-cursor-mutation.ts"), "utf8"),
    await generateTypeScript(descriptor, repositoryRoot),
  );
  assert.equal(
    await readFile(resolve(repositoryRoot,
      "contracts/generated/dart/read_cursor_mutation.dart"), "utf8"),
    await generateDart(descriptor, repositoryRoot),
  );
});

test("check mode is clean after generation and reports drift", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "handrail-read-cursor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relativePath of [
    "contracts/http/read-cursor.json",
    "scripts/templates/read-cursor-mutation.ts.tpl",
    "scripts/templates/read_cursor_mutation.dart.tpl",
  ]) {
    const target = resolve(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await cp(resolve(repositoryRoot, relativePath), target);
  }
  const generated = spawnSync(process.execPath, [generatorPath, "--root", root],
    { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const clean = spawnSync(process.execPath,
    [generatorPath, "--check", "--root", root], { encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /up to date/);
  const dartPath = resolve(root,
    "contracts/generated/dart/read_cursor_mutation.dart");
  await writeFile(dartPath, "// drift\n", { flag: "a" });
  const drift = spawnSync(process.execPath,
    [generatorPath, "--check", "--root", root], { encoding: "utf8" });
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /read_cursor_mutation\.dart/);
});
