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
  readMessageTimelineDescriptor,
} from "../scripts/generate-message-timeline.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(
  repositoryRoot,
  "scripts/generate-message-timeline.mjs",
);
const descriptorSourcePath = resolve(
  repositoryRoot,
  "contracts/http/message-timeline.json",
);

test("the timeline descriptor deterministically drives TypeScript and Dart", async () => {
  const descriptor = await readMessageTimelineDescriptor(repositoryRoot);
  assert.deepEqual(descriptor.request.directions, ["backward", "forward"]);
  assert.equal(descriptor.request.cursor.exclusive, true);
  assert.equal(descriptor.response.order, "sequence_ascending");
  assert.equal(descriptor.message.attachments.alignment, "reference_order_exact");
  assert.equal(descriptor.replay.cursorType, "EventCursor");
  assert.equal(descriptor.message.replyReference.field, "replyTo");

  const typeScript = generateTypeScript(descriptor);
  const dart = generateDart(descriptor);
  assert.match(dart, /const _timelineMessageFields = \{[^}]*'replyTo'/);
  assert.equal(typeScript, generateTypeScript(descriptor));
  assert.equal(dart, generateDart(descriptor));
  assert.equal(
    await readFile(resolve(repositoryRoot, "src/contracts/message-timeline.ts"), "utf8"),
    typeScript,
  );
  assert.equal(
    await readFile(
      resolve(
        repositoryRoot,
        "contracts/generated/dart/message_timeline.dart",
      ),
      "utf8",
    ),
    dart,
  );
});

test("rejects descriptor changes that weaken canonical optional reply preservation", async () => {
  const descriptor = await readMessageTimelineDescriptor(repositoryRoot);
  for (const [field, value] of Object.entries({
    field: "forward", type: "Message", presence: "required", validation: "none",
    preservedOnDeletedMessages: false, infersThreadRoot: true, synthesizesForwardSnapshot: true,
  })) {
    const changed = structuredClone(descriptor);
    changed.message.replyReference[field] = value;
    assert.throws(() => generateTypeScript(changed), /supported schemaVersion 1 contract/);
    assert.throws(() => generateDart(changed), /supported schemaVersion 1 contract/);
  }
  for (const invariant of ["canonical_optional_reply_reference", "reply_reference_independent_of_thread_and_forward"]) {
    const changed = structuredClone(descriptor);
    changed.invariants = changed.invariants.filter((value) => value !== invariant);
    assert.throws(() => generateDart(changed), /supported schemaVersion 1 contract/);
  }
});

test("check mode supports alternate roots and reports both outputs drifting", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "handrail-message-timeline-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const temporaryDescriptor = resolve(
    temporaryRoot,
    "contracts/http/message-timeline.json",
  );
  await mkdir(dirname(temporaryDescriptor), { recursive: true });
  await writeFile(
    temporaryDescriptor,
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

  for (const outputPath of [
    "src/contracts/message-timeline.ts",
    "contracts/generated/dart/message_timeline.dart",
  ]) {
    await writeFile(resolve(temporaryRoot, outputPath), "// drift\n", {
      flag: "a",
    });
  }

  const drift = spawnSync(
    process.execPath,
    [generatorPath, "--check", "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /src\/contracts\/message-timeline\.ts/);
  assert.match(
    drift.stderr,
    /contracts\/generated\/dart\/message_timeline\.dart/,
  );
});
