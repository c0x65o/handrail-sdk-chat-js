import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CHAT_PROTOCOL_VERSION } from "../dist/contracts/realtime.js";
import { handrailChatPostgresMigrations } from "../dist/server/postgres-schema-migrations.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [readme, packageJsonSource] = await Promise.all([
  readFile(resolve(packageRoot, "README.md"), "utf8"),
  readFile(resolve(packageRoot, "package.json"), "utf8"),
]);
const packageJson = JSON.parse(packageJsonSource);
const latestMigrationOrder = Math.max(
  ...handrailChatPostgresMigrations.map(({ order }) => order),
);
const expectedCompatibility = {
  packageName: packageJson.name,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: latestMigrationOrder,
};
const documentedPackageVersionPlaceholder = "<installed package version>";

const getFencedBlocks = (markdown) =>
  [...markdown.matchAll(/^```([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm)].map(
    ([, info, source]) => ({ info: info.trim(), source }),
  );

const getSingleMatch = (source, pattern, label) => {
  const matches = [...source.matchAll(pattern)];
  assert.equal(matches.length, 1, `${label} must occur exactly once`);
  return matches[0][1];
};

const validateReadmeCompatibility = (markdown, expected) => {
  assert.match(
    markdown,
    /^Migration `0043-chat-thread-lifecycle` is an expand-only addition$/mu,
    "README must name migration 0043 as the current migration",
  );

  const fencedBlocks = getFencedBlocks(markdown);
  const dependencyBlocks = fencedBlocks.filter(
    ({ info, source }) =>
      info.split(/\s+/, 1)[0] === "json" &&
      source.includes('"dependencies"'),
  );
  const installBlocks = fencedBlocks.filter(
    ({ info, source }) =>
      /^(?:sh|shell|bash)(?:\s|$)/.test(info) &&
      /\b(?:npm|pnpm|yarn)\b[^\n]*@handrail\/chat/.test(source),
  );

  assert.equal(
    dependencyBlocks.length,
    0,
    "README consumer setup uses the documented Git install command",
  );
  assert.equal(installBlocks.length, 1, "README must contain one install snippet");

  for (const { source } of installBlocks) {
    assert.match(
      source,
      /@handrail\/chat@git\+https:\/\/github\.com\/c0x65o\/handrail-sdk-chat-js\.git#\$\{HANDRAIL_CHAT_JS_SHA\}/u,
      "README install snippet must use the SDK Git URL and full SHA variable",
    );
    assert.ok(source.includes('[[ "$HANDRAIL_CHAT_JS_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 1'));
  }

  const compatibilityBlocks = fencedBlocks.filter(
    ({ info, source }) =>
      /^(?:js|javascript|mjs)(?:\s|$)/.test(info) &&
      /\bcompatibility\s*:/.test(source),
  );
  assert.equal(
    compatibilityBlocks.length,
    1,
    "README must contain one doctor compatibility assertion example",
  );
  const compatibilitySource = compatibilityBlocks[0].source;
  assert.doesNotMatch(
    compatibilitySource,
    /\bpackageVersion\s*:/u,
    "doctor example must not pin the npm package version",
  );
  assert.equal(
    Number(
      getSingleMatch(
        compatibilitySource,
        /\bprotocolVersion\s*:\s*(\d+)/g,
        "doctor compatibility protocol version",
      ),
    ),
    expected.protocolVersion,
    "doctor compatibility protocol version",
  );
  assert.equal(
    Number(
      getSingleMatch(
        compatibilitySource,
        /\bschemaVersion\s*:\s*(\d+)/g,
        "doctor compatibility schema version",
      ),
    ),
    expected.schemaVersion,
    "doctor compatibility schema version",
  );

  const doctorJsonBlocks = fencedBlocks.filter(({ info, source }) => {
    if (info.split(/\s+/, 1)[0] !== "json") return false;
    try {
      return JSON.parse(source).command === "doctor";
    } catch {
      return false;
    }
  });
  assert.equal(
    doctorJsonBlocks.length,
    1,
    "README must contain one doctor JSON result example",
  );
  const doctorPackage = JSON.parse(doctorJsonBlocks[0].source).package;
  assert.equal(
    doctorPackage.name,
    expected.packageName,
    "doctor JSON package name",
  );
  assert.equal(
    doctorPackage.version,
    documentedPackageVersionPlaceholder,
    "doctor JSON package version placeholder",
  );
  assert.equal(
    doctorPackage.protocolVersion,
    expected.protocolVersion,
    "doctor JSON protocol version",
  );
  assert.equal(
    doctorPackage.schemaVersion,
    expected.schemaVersion,
    "doctor JSON schema version",
  );
};

test(
  `README examples use Git-pinned ${packageJson.name} and track protocol ${CHAT_PROTOCOL_VERSION} and schema ${latestMigrationOrder}`,
  () => {
    validateReadmeCompatibility(readme, expectedCompatibility);
  },
);

test("README validation rejects a registry install version fixture", () => {
  const mutatedReadme = readme.replace(
    "@handrail/chat@git+https://github.com/c0x65o/handrail-sdk-chat-js.git#${HANDRAIL_CHAT_JS_SHA}",
    "@handrail/chat@0.0.0-doc-mutation",
  );
  assert.notEqual(mutatedReadme, readme, "npm mutation fixture must change");
  assert.throws(
    () => validateReadmeCompatibility(mutatedReadme, expectedCompatibility),
    /must use the SDK Git URL and full SHA variable/,
  );
});

test("README validation rejects a literal doctor npm version fixture", () => {
  const mutatedReadme = readme.replace(
    documentedPackageVersionPlaceholder,
    "0.0.0-doc-mutation",
  );
  assert.notEqual(mutatedReadme, readme, "npm mutation fixture must change");
  assert.throws(
    () => validateReadmeCompatibility(mutatedReadme, expectedCompatibility),
    /doctor JSON package version placeholder/,
  );
});

test("README validation rejects a mutated compatibility schema fixture", () => {
  const mutatedReadme = readme.replace(
    `schemaVersion: ${latestMigrationOrder},`,
    `schemaVersion: ${latestMigrationOrder - 1},`,
  );
  assert.notEqual(mutatedReadme, readme, "schema mutation fixture must change");
  assert.throws(
    () => validateReadmeCompatibility(mutatedReadme, expectedCompatibility),
    /doctor compatibility schema version/,
  );
});
