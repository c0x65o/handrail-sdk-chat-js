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
  readConversationDescriptor,
} from "../scripts/generate-conversations.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(repositoryRoot, "scripts/generate-conversations.mjs");
const descriptorSourcePath = resolve(
  repositoryRoot,
  "contracts/models/conversation.json",
);

test("the conversation descriptor deterministically drives both outputs", async () => {
  const descriptor = await readConversationDescriptor(repositoryRoot);
  assert.deepEqual(
    descriptor.variants.map(({ name, wireType }) => ({ name, wireType })),
    [
      { name: "ChannelConversation", wireType: "channel" },
      { name: "DirectConversation", wireType: "direct" },
      { name: "GroupDirectConversation", wireType: "group_direct" },
      { name: "ThreadConversation", wireType: "thread" },
    ],
  );

  const typeScript = generateTypeScript(descriptor);
  const dart = generateDart(descriptor);
  assert.equal(typeScript, generateTypeScript(descriptor));
  assert.equal(dart, generateDart(descriptor));
  assert.equal(
    await readFile(resolve(repositoryRoot, "src/contracts/conversation.ts"), "utf8"),
    typeScript,
  );
  assert.equal(
    await readFile(
      resolve(
        repositoryRoot,
        "contracts/generated/dart/conversation.dart",
      ),
      "utf8",
    ),
    dart,
  );
});

test("check mode is clean after generation and reports either output drifting", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "handrail-conversations-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const temporaryDescriptor = resolve(
    temporaryRoot,
    "contracts/models/conversation.json",
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

  const cleanCheck = spawnSync(
    process.execPath,
    [generatorPath, "--check", "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(cleanCheck.status, 0, cleanCheck.stderr);
  assert.match(cleanCheck.stdout, /up to date/);

  await writeFile(
    resolve(temporaryRoot, "src/contracts/conversation.ts"),
    "// drift\n",
    { flag: "a" },
  );
  await writeFile(
    resolve(
      temporaryRoot,
      "contracts/generated/dart/conversation.dart",
    ),
    "// drift\n",
    { flag: "a" },
  );

  const driftCheck = spawnSync(
    process.execPath,
    [generatorPath, "--check", "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(driftCheck.status, 1);
  assert.match(driftCheck.stderr, /src\/contracts\/conversation\.ts/);
  assert.match(
    driftCheck.stderr,
    /contracts\/generated\/dart\/conversation\.dart/,
  );
});

test("the strict descriptor rejects thread name rule or presence drift", async () => {
  const descriptor = await readConversationDescriptor(repositoryRoot);
  const mutations = [
    (field) => { field.presence = "never"; },
    (field) => { field.presence = "required"; },
    (field) => { delete field.validation; },
    (field) => { field.validation.minLength = 0; },
    (field) => { field.validation.maxLength = 101; },
    (field) => { field.validation.lengthUnit = "utf16"; },
    (field) => { field.validation.normalization = "trim"; },
    (field) => { field.validation.malformedUnicode = "allow"; },
    (field) => { field.validation.whitespaceCodePoints.pop(); },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(descriptor);
    mutate(changed.variants.find(({ wireType }) => wireType === "thread")
      .fields.find(({ name }) => name === "name"));
    assert.throws(() => generateTypeScript(changed), /contract|validation/);
    assert.throws(() => generateDart(changed), /contract|validation/);
  }
});

test("the strict descriptor rejects lifecycle field, presence, and rule drift", async () => {
  const descriptor = await readConversationDescriptor(repositoryRoot);
  const mutations = [
    (d) => { delete d.threadLifecycle; },
    (d) => { d.threadLifecycle.fields[0].type = "number"; },
    (d) => { d.threadLifecycle.fields[1].presence = "optional"; },
    (d) => { d.threadLifecycle.revisionValidation.minimum = 0; },
    (d) => { d.threadLifecycle.revisionValidation.maximum += 1; },
    (d) => { d.threadLifecycle.revisionValidation.mustBeSafeInteger = false; },
    (d) => { d.threadLifecycle.closureState.open[0].presence = "optional"; },
    (d) => { d.threadLifecycle.closureState.closed.pop(); },
    ...Object.keys(descriptor.threadLifecycle.rules).map((key) => (d) => {
      delete d.threadLifecycle.rules[key];
    }),
    ...descriptor.variants.map((_, index) => (d) => {
      d.variants[index].fields.find(({ name }) => name === "threadLifecycle")
        .presence = "required";
    }),
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(descriptor);
    mutate(changed);
    assert.throws(() => generateTypeScript(changed), /contract/);
    assert.throws(() => generateDart(changed), /contract/);
  }
});
