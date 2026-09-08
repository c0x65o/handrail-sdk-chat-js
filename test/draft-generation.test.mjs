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
  readDraftDescriptor,
  validateDescriptor,
} from "../scripts/generate-draft.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(repositoryRoot, "scripts/generate-draft.mjs");

test("the descriptor defines bounded draft intents and private reconciliation", async () => {
  const descriptor = await readDraftDescriptor(repositoryRoot);
  assert.deepEqual(
    descriptor.intents.map(({ name, canonicalKind }) => ({ name, canonicalKind })),
    [
      { name: "replace", canonicalKind: "replaced" },
      { name: "clear", canonicalKind: "clear_tombstone" },
    ],
  );
  assert.deepEqual(descriptor.content.formats, ["plain", "markdown"]);
  assert.equal(descriptor.content.maximumTextUtf8Bytes, 65_536);
  assert.deepEqual(descriptor.content.replyReference, {
    field: "replyTo", model: "MessageReplyReference", presence: "optional", sendField: "replyTo",
  });
  for (const field of ["field", "model", "presence", "sendField"]) {
    const invalid = structuredClone(descriptor);
    invalid.content.replyReference[field] = "invalid";
    assert.throws(() => validateDescriptor(invalid), /replyTo/);
  }
  assert.equal(descriptor.content.mentionReferenceModel, "MessageMention");
  assert.deepEqual(
    descriptor.content.mentionReferenceTypes,
    ["user", "conversation", "entity"],
  );
  assert.equal(descriptor.content.maximumMentionReferences, 64);
  assert.equal(descriptor.content.uniqueMentionReferences, true);
  assert.equal(descriptor.content.uniqueAttachmentReferences, true);
  assert.deepEqual(
    descriptor.reconciliationStatuses.map(({ name }) => name),
    ["applied", "replayed", "stale_base"],
  );
  assert.equal(descriptor.event.type, "conversation.draft.updated");
  assert.equal(descriptor.event.visibility, "private_user_stream");
  assert.equal(descriptor.event.streamId, "user:${actorUserId}");
});

test("the descriptor deterministically drives TypeScript and Dart outputs", async () => {
  const descriptor = await readDraftDescriptor(repositoryRoot);
  assert.equal(
    await readFile(resolve(repositoryRoot, "src/contracts/draft-mutation.ts"), "utf8"),
    await generateTypeScript(descriptor, repositoryRoot),
  );
  assert.equal(
    await readFile(resolve(repositoryRoot,
      "contracts/generated/dart/draft_mutation.dart"), "utf8"),
    await generateDart(descriptor, repositoryRoot),
  );
});

test("check mode is clean after generation and reports drift", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "handrail-draft-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relativePath of [
    "contracts/http/draft.json",
    "scripts/templates/draft-mutation.ts.tpl",
    "scripts/templates/draft_mutation.dart.tpl",
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
    "contracts/generated/dart/draft_mutation.dart");
  await writeFile(dartPath, "// drift\n", { flag: "a" });
  const drift = spawnSync(process.execPath,
    [generatorPath, "--check", "--root", root], { encoding: "utf8" });
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /draft_mutation\.dart/);
});
