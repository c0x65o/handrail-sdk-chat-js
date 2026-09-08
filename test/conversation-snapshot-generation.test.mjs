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
  readConversationSnapshotDescriptor,
} from "../scripts/generate-conversation-snapshots.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(
  repositoryRoot,
  "scripts/generate-conversation-snapshots.mjs",
);
const descriptorSourcePath = resolve(
  repositoryRoot,
  "contracts/http/conversations.json",
);

test("the HTTP descriptor deterministically drives TypeScript and Dart snapshots", async () => {
  const descriptor = await readConversationSnapshotDescriptor(repositoryRoot);
  assert.deepEqual(
    descriptor.endpoints.map(({ method, path }) => ({ method, path })),
    [
      { method: "GET", path: "/conversations" },
      { method: "GET", path: "/conversations/:id" },
    ],
  );
  assert.deepEqual(
    descriptor.scopes.map(({ wireType }) => wireType),
    ["organization", "entity"],
  );
  assert.equal(descriptor.cursor.opaque, true);
  assert.equal(descriptor.cursor.envelopePrefix, "handrail-conversations.v");
  assert.equal(descriptor.cursor.version, 3);
  assert.deepEqual(descriptor.cursor.navigationRanks, [
    { value: 0, conversationType: "direct" },
    { value: 1, conversationType: "channel", visibility: "public" },
    { value: 2, conversationType: "channel", visibility: "private" },
    { value: 3, conversationType: "group_direct" },
  ]);
  assert.deepEqual(descriptor.cursor.position, [
    { name: "isStarred", type: "boolean" },
    { name: "navigationRank", type: "integer", minimum: 0, maximum: 3 },
    { name: "activityAt", type: "IsoTimestamp" },
    { name: "conversationId", type: "ConversationId" },
  ]);
  assert.deepEqual(descriptor.cursor.legacyVersions, [
    {
      version: 2,
      semantics: "starred-first ordering for the full legacy pagination path",
      position: [
        { name: "isStarred", type: "boolean" },
        { name: "activityAt", type: "IsoTimestamp" },
        { name: "conversationId", type: "ConversationId" },
      ],
    },
    {
      version: 1,
      semantics: "activity-only ordering for the full legacy pagination path",
      position: [
        { name: "activityAt", type: "IsoTimestamp" },
        { name: "conversationId", type: "ConversationId" },
      ],
    },
  ]);
  assert.deepEqual(
    descriptor.summaryEnrichment.find(
      ({ name }) => name === "unreadMentionCount",
    ),
    {
      name: "unreadMentionCount",
      type: "integer",
      minimum: 0,
    },
  );
  assert.deepEqual(
    descriptor.summaryEnrichment.find(
      ({ name }) => name === "activeMemberUserIds",
    ),
    {
      name: "activeMemberUserIds",
      type: "readonly UserId[]",
      maximumItems: 100,
    },
  );
  assert.deepEqual(descriptor.preference.starred, {
    field: "isStarred",
    type: "boolean",
    presence: "required",
  });

  const typeScript = generateTypeScript(descriptor);
  const dart = generateDart(descriptor);
  assert.equal(typeScript, generateTypeScript(descriptor));
  assert.equal(dart, generateDart(descriptor));
  assert.equal(
    await readFile(
      resolve(repositoryRoot, "src/contracts/conversation-snapshot.ts"),
      "utf8",
    ),
    typeScript,
  );
  assert.equal(
    await readFile(
      resolve(
        repositoryRoot,
        "contracts/generated/dart/conversation_snapshot.dart",
      ),
      "utf8",
    ),
    dart,
  );
});

test("check mode is clean and reports either generated output drifting", async (t) => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "handrail-conversation-snapshots-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const descriptorPath = resolve(
    temporaryRoot,
    "contracts/http/conversations.json",
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

  for (const output of [
    "src/contracts/conversation-snapshot.ts",
    "contracts/generated/dart/conversation_snapshot.dart",
  ]) {
    await writeFile(resolve(temporaryRoot, output), "// drift\n", { flag: "a" });
  }
  const drift = spawnSync(
    process.execPath,
    [generatorPath, "--check", "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /src\/contracts\/conversation-snapshot\.ts/);
  assert.match(
    drift.stderr,
    /contracts\/generated\/dart\/conversation_snapshot\.dart/,
  );
});

test("client snapshot inputs deny all descriptor-owned trusted identities", async () => {
  const descriptor = await readConversationSnapshotDescriptor(repositoryRoot);
  const dart = generateDart(descriptor);
  for (const field of descriptor.trustedIdentityFields) {
    assert.match(dart, new RegExp(`  '${field}',`));
  }
  for (const required of [
    "tenant",
    "actor",
    "user",
    "principal",
    "subject",
    "session",
    "auth",
    "role",
  ]) {
    assert.ok(descriptor.trustedIdentityFields.includes(required));
  }
});

test("snapshot generation retains canonical thread name validation", async () => {
  const descriptor = await readConversationSnapshotDescriptor(repositoryRoot);
  assert.match(generateDart(descriptor), /if \(name != null\) validateThreadConversationName\(name\)/);
  assert.match(generateTypeScript(descriptor), /conversation-snapshot-runtime\.js/);
  const model = JSON.parse(await readFile("contracts/models/conversation.json", "utf8"));
  const rule = model.variants.find(variant => variant.wireType === "thread").fields.find(field => field.name === "name").validation;
  const names = JSON.parse(await readFile("conformance-tests/thread-names.json", "utf8"));
  for (const point of rule.whitespaceCodePoints) {
    const whitespace = String.fromCodePoint(point);
    assert.ok(names.invalid.includes(`${whitespace}Launch`));
    assert.ok(names.invalid.includes(`Launch${whitespace}`));
  }
  assert.ok(names.valid.includes("🚀".repeat(rule.maxLength)));
  assert.ok(names.invalid.includes("🚀".repeat(rule.maxLength + 1)));
});

test("snapshot parsers reuse the canonical lifecycle model and preserve absence", async () => {
  const descriptor = await readConversationSnapshotDescriptor(repositoryRoot);
  assert.match(generateDart(descriptor), /Conversation.fromJson\(conversationJson\)/);
  const runtime = await readFile("src/contracts/conversation-snapshot-runtime.ts", "utf8");
  assert.match(runtime, /validateConversationThreadLifecycle\(summary/);
  const model = JSON.parse(await readFile("contracts/models/conversation.json", "utf8"));
  const fixtures = JSON.parse(await readFile("conformance-tests/thread-lifecycle.json", "utf8"));
  assert.ok(fixtures.valid.some(state => state.revision === model.threadLifecycle.revisionValidation.minimum));
  assert.ok(fixtures.valid.some(state => state.revision === model.threadLifecycle.revisionValidation.maximum));
});
