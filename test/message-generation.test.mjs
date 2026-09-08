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
  readMessageDescriptor,
} from "../scripts/generate-messages.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(repositoryRoot, "scripts/generate-messages.mjs");
const descriptorSourcePath = resolve(
  repositoryRoot,
  "contracts/models/message.json",
);

test("the message descriptor deterministically drives both outputs", async () => {
  const descriptor = await readMessageDescriptor(repositoryRoot);
  assert.deepEqual(descriptor.content.formats, ["plain", "markdown"]);
  assert.deepEqual(
    descriptor.mentions.variants.map(({ name, wireType }) => ({ name, wireType })),
    [
      { name: "UserMention", wireType: "user" },
      { name: "ConversationMention", wireType: "conversation" },
      { name: "EntityMention", wireType: "entity" },
    ],
  );

  const typeScript = generateTypeScript(descriptor);
  const dart = generateDart(descriptor);
  assert.equal(typeScript, generateTypeScript(descriptor));
  assert.equal(dart, generateDart(descriptor));
  assert.equal(
    await readFile(resolve(repositoryRoot, "src/contracts/message.ts"), "utf8"),
    typeScript,
  );
  assert.equal(
    await readFile(
      resolve(repositoryRoot, "contracts/generated/dart/message.dart"),
      "utf8",
    ),
    dart,
  );
});

test("normalized thread summaries require nullable unread counts and share facts", async () => {
  const descriptor = await readMessageDescriptor(repositoryRoot);
  const facts = descriptor.threadSummaryFacts;
  const normalized = descriptor.normalizedThreadSummary;
  assert.equal(normalized.name, "NormalizedThreadSummary");
  assert.deepEqual(
    normalized.fields.filter(({ name }) => name === "unreadCount"),
    [{ name: "unreadCount", type: "integer", presence: "required_nullable", minimum: 0 }],
  );
  assert.deepEqual(
    normalized.fields.filter(({ name }) => name !== "unreadCount"),
    facts.fields,
  );
  assert.equal(facts.fields.some(({ name }) => name === "unreadCount"), false);
  assert.deepEqual(
    descriptor.threadSummary.fields.filter(({ name }) => name === "unreadCount"),
    [{ name: "unreadCount", type: "integer", presence: "required", minimum: 0 }],
  );

  const typeScript = generateTypeScript(descriptor);
  const dart = generateDart(descriptor);
  // Match through the top-level closing brace, never into a neighboring model.
  const declaration = (output, prefix, name) => {
    const match = output.match(
      new RegExp(`^${prefix} ${name}\\b[^\\n]*\\{[\\s\\S]*?^\\}`, "m"),
    );
    assert.ok(match, `Missing ${prefix} ${name}`);
    return match[0];
  };
  const normalizedTypeScript = declaration(typeScript, "export interface", normalized.name);
  assert.match(normalizedTypeScript, /^export interface NormalizedThreadSummary extends ThreadSummaryFacts \{/);
  assert.match(normalizedTypeScript, /^  readonly unreadCount: number \| null;$/m);
  assert.doesNotMatch(normalizedTypeScript, /unreadCount\?/);
  assert.doesNotMatch(declaration(typeScript, "export interface", "ThreadSummaryFacts"), /unreadCount/);
  const legacyTypeScript = declaration(typeScript, "export interface", "ThreadSummary");
  assert.match(legacyTypeScript, /^  readonly unreadCount: number;$/m);
  assert.doesNotMatch(legacyTypeScript, /unreadCount\?/);

  assert.doesNotMatch(declaration(dart, "final class", "ThreadSummaryFacts"), /unreadCount/);
  for (const [name, nullable] of [["NormalizedThreadSummary", true], ["ThreadSummary", false]]) {
    const summary = declaration(dart, "final class", name);
    assert.match(
      summary,
      new RegExp(`  ${name}\\(\\{[^}]*\\brequired this\\.unreadCount,`),
    );
    assert.match(summary, nullable ? /^  final int\? unreadCount;$/m : /^  final int unreadCount;$/m);
    assert.match(
      summary,
      new RegExp(
        `unreadCount: ${nullable ? "_readNullableInt" : "_readInt"}\\(\\s*` +
        `_readRequired\\(object, 'unreadCount', '${name}'\\),\\s*` +
        `'${name}\\.unreadCount',\\s*minimum: 0,\\s*\\),`,
      ),
    );
    // Anchor at the map opening so a collection-if cannot hide null values.
    assert.match(
      summary,
      /Map<String, Object\?> toJson\(\) => \{\s*'threadId': threadId\.toJson\(\),\s*'replyCount': replyCount,\s*'participantIds': participantIds\.map\(\(id\) => id\.toJson\(\)\)\.toList\(\),\s*'unreadCount': unreadCount,/,
    );
  }
});

test("check mode is clean and reports TypeScript and Dart drift", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "handrail-messages-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const temporaryDescriptor = resolve(
    temporaryRoot,
    "contracts/models/message.json",
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

  for (const outputPath of [
    "src/contracts/message.ts",
    "contracts/generated/dart/message.dart",
  ]) {
    await writeFile(resolve(temporaryRoot, outputPath), "// drift\n", {
      flag: "a",
    });
  }

  const driftCheck = spawnSync(
    process.execPath,
    [generatorPath, "--check", "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(driftCheck.status, 1);
  assert.match(driftCheck.stderr, /src\/contracts\/message\.ts/);
  assert.match(
    driftCheck.stderr,
    /contracts\/generated\/dart\/message\.dart/,
  );
});

test("generation and check mode reject nullable summary descriptor drift", async (t) => {
  const cases = [
    ...[
      ["optional unreadCount", { presence: "optional" }],
      ["optional nullable unreadCount", { presence: "optional_nullable" }],
      ["nonnullable unreadCount", { presence: "required" }],
      ["changed unreadCount type", { type: "number" }],
      ["changed unreadCount minimum", { minimum: 1 }],
    ].map(([name, patch]) => [name, (descriptor) => {
      Object.assign(
        descriptor.normalizedThreadSummary.fields.find(({ name }) => name === "unreadCount"),
        patch,
      );
    }]),
    ["missing normalized model", (descriptor) => {
      delete descriptor.normalizedThreadSummary;
    }],
    ["normalized shared fact drift", (descriptor) => {
      descriptor.normalizedThreadSummary.fields.find(({ name }) => name === "replyCount").minimum = 1;
    }],
    ["canonical shared fact drift", (descriptor) => {
      descriptor.threadSummaryFacts.fields.find(({ name }) => name === "lastReplyAt").presence = "required";
    }],
    ["shared fact order drift", (descriptor) => {
      descriptor.normalizedThreadSummary.fields.reverse();
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async (t) => {
      const temporaryRoot = await mkdtemp(join(tmpdir(), "handrail-messages-"));
      t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
      const temporaryDescriptor = resolve(temporaryRoot, "contracts/models/message.json");
      await mkdir(dirname(temporaryDescriptor), { recursive: true });
      const source = await readFile(descriptorSourcePath, "utf8");
      await writeFile(temporaryDescriptor, source, "utf8");

      const generate = spawnSync(
        process.execPath,
        [generatorPath, "--root", temporaryRoot],
        { encoding: "utf8" },
      );
      assert.equal(generate.status, 0, generate.stderr);

      const descriptor = JSON.parse(source);
      mutate(descriptor);
      await writeFile(temporaryDescriptor, JSON.stringify(descriptor), "utf8");
      for (const flags of [[], ["--check"]]) {
        const rejected = spawnSync(
          process.execPath,
          [generatorPath, "--root", temporaryRoot, ...flags],
          { encoding: "utf8" },
        );
        assert.equal(rejected.status, 1, rejected.stderr);
        assert.match(
          rejected.stderr,
          /message\.json does not match the supported message contract shape/,
        );
      }
    });
  }
});


test("reply references are immutable top-level metadata in both generated models", async () => {
  const descriptor = await readMessageDescriptor(repositoryRoot);
  assert.deepEqual(descriptor.replyReference.fields.map(({ name, type, presence }) => ({ name, type, presence })), [
    { name: "messageId", type: "MessageId", presence: "required" },
    { name: "notifyAuthor", type: "boolean", presence: "required" },
  ]);
  for (const fields of [descriptor.message.sharedFields, descriptor.composition.fields]) {
    assert.deepEqual(fields.find(({ name }) => name === "replyTo"),
      { name: "replyTo", type: "MessageReplyReference", presence: "optional" });
  }
  for (const fields of [descriptor.content.fields, descriptor.forwardedSnapshot.fields]) {
    assert.equal(fields.some(({ name }) => name === "replyTo"), false);
  }
  const ts = generateTypeScript(descriptor);
  const dart = generateDart(descriptor);
  assert.match(ts, /readonly messageId: MessageId;/);
  assert.match(ts, /readonly notifyAuthor: boolean;/);
  assert.equal(ts.match(/readonly replyTo\?: MessageReplyReference;/g).length, 2);
  for (const field of descriptor.replyReference.forbiddenFields) {
    assert.ok(ts.includes(`readonly ${field}?: never;`));
  }
  assert.match(dart, /final MessageId messageId;/);
  assert.match(dart, /final bool notifyAuthor;/);
  assert.equal(dart.match(/super.replyTo,/g).length, 2);
});

test("generation and check mode reject reply descriptor drift", async (t) => {
  const cases = [
    ["missing reference", d => { delete d.replyReference; }],
    ["renamed reference", d => { d.replyReference.name = "Reply"; }],
    ["missing messageId", d => { d.replyReference.fields.shift(); }],
    ["missing notifyAuthor", d => { d.replyReference.fields.pop(); }],
    ["optional notifyAuthor", d => { d.replyReference.fields[1].presence = "optional"; }],
    ["nullable notifyAuthor", d => { d.replyReference.fields[1].presence = "required_nullable"; }],
    ["defaulted notifyAuthor", d => { d.replyReference.fields[1].default = true; }],
    ["invalid boolean type", d => { d.replyReference.fields[1].type = "string"; }],
    ["unbranded ID", d => { d.replyReference.fields[0].type = "string"; }],
    ["changed ID bound", d => { d.replyReference.fields[0].maximumUtf8Bytes = 256; }],
    ["missing ID safety", d => { delete d.replyReference.fields[0].validation; }],
    ["source attribution field", d => { d.replyReference.fields.push({ name: "sourceDisplay", type: "string" }); }],
    ["missing attribution exclusion", d => { d.replyReference.forbiddenFields.pop(); }],
    ["missing actor exclusion", d => { d.composition.serverOwnedFields.pop(); }],
    ["missing message reply", d => { d.message.sharedFields = d.message.sharedFields.filter(f => f.name !== "replyTo"); }],
    ["required composition reply", d => { d.composition.fields[1].presence = "required"; }],
    ["reply in content", d => { d.content.fields.push(d.composition.fields[1]); }],
    ["reply in forwarded snapshot", d => { d.forwardedSnapshot.fields.push(d.composition.fields[1]); }],
  ];
  const source = await readFile(descriptorSourcePath, "utf8");
  for (const [name, mutate] of cases) {
    await t.test(name, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "handrail-replies-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const path = resolve(root, "contracts/models/message.json");
      await mkdir(dirname(path), { recursive: true });
      const descriptor = JSON.parse(source);
      mutate(descriptor);
      for (const generate of [generateTypeScript, generateDart]) {
        assert.throws(() => generate(descriptor), /supported message contract shape/);
      }
      await writeFile(path, JSON.stringify(descriptor));
      for (const flags of [[], ["--check"]]) {
        const result = spawnSync(process.execPath, [generatorPath, "--root", root, ...flags], { encoding: "utf8" });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /supported message contract shape/);
      }
    });
  }
});
