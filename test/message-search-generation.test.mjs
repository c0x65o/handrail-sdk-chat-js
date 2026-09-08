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
  readMessageSearchDescriptor,
} from "../scripts/generate-message-search.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(repositoryRoot, "scripts/generate-message-search.mjs");
const descriptorSourcePath = resolve(repositoryRoot, "contracts/http/message-search.json");

test("descriptor defines the body search endpoint and strict transport invariants", async () => {
  const descriptor = await readMessageSearchDescriptor(repositoryRoot);
  assert.equal(descriptor.method, "POST");
  assert.equal(descriptor.path, "/messages/search");
  assert.deepEqual(descriptor.request.queryNormalization, ["nfc", "trim", "collapse_whitespace"]);
  assert.deepEqual(descriptor.request.pageSize, { minimum: 1, maximum: 100 });
  assert.equal(descriptor.request.cursor.maximumLength, 2048);
  assert.deepEqual(descriptor.hits.map((hit) => hit.type), ["conversation", "message"]);
  assert.equal(descriptor.response.hitIdentityMustBeUnique, true);
  assert.equal(descriptor.text.snippetFormat, "plain_text");
  assert.equal(descriptor.authorization.hitConversationIdsMustBeAuthorized, true);
  assert.ok(descriptor.trustedIdentityAliases.includes("authorization"));
  assert.ok(descriptor.trustedIdentityAliases.includes("permission"));
});

test("descriptor deterministically drives runtime-neutral TypeScript and pure Dart", async () => {
  const descriptor = await readMessageSearchDescriptor(repositoryRoot);
  const typescript = generateTypeScript(descriptor);
  const dart = generateDart(descriptor);
  assert.equal(await readFile(resolve(repositoryRoot, "src/contracts/message-search.ts"), "utf8"), typescript);
  assert.equal(
    await readFile(resolve(repositoryRoot, "contracts/generated/dart/message_search.dart"), "utf8"),
    dart,
  );
  assert.doesNotMatch(typescript, /node:/);
  assert.doesNotMatch(dart, /package:flutter/);
});

test("check mode detects TypeScript and Dart drift", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "handrail-message-search-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const descriptorPath = resolve(temporaryRoot, "contracts/http/message-search.json");
  await mkdir(dirname(descriptorPath), { recursive: true });
  await writeFile(descriptorPath, await readFile(descriptorSourcePath, "utf8"), "utf8");

  const generate = spawnSync(process.execPath, [generatorPath, "--root", temporaryRoot], { encoding: "utf8" });
  assert.equal(generate.status, 0, generate.stderr);
  const clean = spawnSync(process.execPath, [generatorPath, "--check", "--root", temporaryRoot], { encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /up to date/);

  for (const outputPath of [
    "src/contracts/message-search.ts",
    "contracts/generated/dart/message_search.dart",
  ]) {
    await writeFile(resolve(temporaryRoot, outputPath), "// drift\n", { flag: "a" });
  }
  const drift = spawnSync(process.execPath, [generatorPath, "--check", "--root", temporaryRoot], { encoding: "utf8" });
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /src\/contracts\/message-search\.ts/);
  assert.match(drift.stderr, /contracts\/generated\/dart\/message_search\.dart/);
});
