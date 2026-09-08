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
  readReplyStylePreferenceDescriptor,
} from "../scripts/generate-reply-style-preference.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generator = resolve(root, "scripts/generate-reply-style-preference.mjs");
const descriptorSource = resolve(root, "contracts/http/reply-style-preference.json");

test("descriptor defines private GET/PATCH, absence, fallback and exact revision rules", async () => {
  const descriptor = await readReplyStylePreferenceDescriptor(root);
  assert.deepEqual(descriptor.methods, ["GET", "PATCH"]);
  assert.equal(descriptor.scope, "trustedSessionTenantAndUser");
  assert.equal(descriptor.feature.name, "reply_style_preference_v1");
  assert.equal(descriptor.feature.missing, false);
  assert.equal(descriptor.feature.advertiseRuntime, true);
  assert.equal(descriptor.feature.defaultEnabled, false);
  assert.equal(descriptor.feature.requires, "hostOptInAndPersistenceReadiness");
  assert.equal(descriptor.preferenceStates[0].revision, 0);
  assert.equal(descriptor.preferenceStates[1].style, "rawStringIncludingUnknown");
  assert.equal(descriptor.fallbackStyle, "current");
});

test("unsupported descriptor changes cannot silently retain parser semantics", async () => {
  const descriptor = await readReplyStylePreferenceDescriptor(root);
  for (const mutate of [
    d => { d.preferenceStates[0].revision = 1; },
    d => { d.reconciliationStatuses[0].revisionRule = "equalsBase"; },
    d => { d.coherenceRules.preserveUnknownSavedValues = false; },
    d => { d.styles.push("future"); },
    d => { d.feature.missing = true; },
    d => { d.feature.defaultEnabled = true; },
    d => { d.feature.requires = "hostOptIn"; },
    d => { d.trustedContextAliases = []; },
  ]) {
    const changed = structuredClone(descriptor);
    mutate(changed);
    assert.throws(() => generateTypeScript(changed));
    assert.throws(() => generateDart(changed));
  }
  const changed = structuredClone(descriptor);
  changed.trustedContextAliases.push("trustedHost");
  assert.match(generateTypeScript(changed), /readonly trustedHost\?: never/);
  assert.match(generateDart(changed), /'trustedhost'/);
});

test("descriptor deterministically drives TypeScript and Dart output", async () => {
  const descriptor = await readReplyStylePreferenceDescriptor(root);
  const typescript = generateTypeScript(descriptor);
  const dart = generateDart(descriptor);
  assert.equal(generateTypeScript(descriptor), typescript);
  assert.equal(generateDart(descriptor), dart);
  assert.equal(await readFile(resolve(root, "src/contracts/reply-style-preference.ts"), "utf8"), typescript);
  assert.equal(await readFile(resolve(root, "contracts/generated/dart/reply_style_preference.dart"), "utf8"), dart);
  assert.match(typescript, /update_reply_style_preference/);
  assert.match(dart, /preferenceRevisionConflict/);
});

test("check mode is clean and detects both generated outputs drifting", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "handrail-reply-style-preference-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const descriptorPath = resolve(temporaryRoot, "contracts/http/reply-style-preference.json");
  await mkdir(dirname(descriptorPath), { recursive: true });
  await writeFile(descriptorPath, await readFile(descriptorSource, "utf8"));
  const run = (...args) => spawnSync(process.execPath, [generator, ...args, "--root", temporaryRoot], { encoding: "utf8" });
  assert.equal(run().status, 0);
  const clean = run("--check");
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /up to date/);

  const typescript = resolve(temporaryRoot, "src/contracts/reply-style-preference.ts");
  await writeFile(typescript, "// drift\n", { flag: "a" });
  const tsDrift = run("--check");
  assert.equal(tsDrift.status, 1);
  assert.match(tsDrift.stderr, /reply-style-preference\.ts/);

  assert.equal(run().status, 0);
  const dart = resolve(temporaryRoot, "contracts/generated/dart/reply_style_preference.dart");
  await writeFile(dart, "// drift\n", { flag: "a" });
  const dartDrift = run("--check");
  assert.equal(dartDrift.status, 1);
  assert.match(dartDrift.stderr, /reply_style_preference\.dart/);
});
