import { flutterRepositoryRoot } from "./sdk-repositories.mjs";
import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CAPABILITY_MANIFEST_PATH =
  "contracts/cross-client-capabilities.v1.json";

// This registry is the result of reviewing every public product entry point. It
// intentionally lives outside the manifest so deleting a manifest row cannot
// also shrink the validator's definition of completeness.
export const REVIEWED_CAPABILITY_FAMILY_IDS = Object.freeze([
  "attachments",
  "conversation_archive_restore",
  "conversation_browsing",
  "conversation_creation",
  "conversation_membership",
  "conversation_preferences",
  "deep_links",
  "device_push_registration",
  "directory_search",
  "drafts",
  "huddles",
  "message_reminders",
  "message_search",
  "messages",
  "notifications",
  "presence",
  "reactions",
  "read_state",
  "realtime",
  "saved_messages",
  "thread_following",
  "threads",
  "typing",
  "user_status",
]);

export const CAPABILITY_STATUSES = Object.freeze([
  "supported",
  "host_composed",
  "not_applicable",
  "product_decision_required",
]);

export const CAPABILITY_SURFACES = Object.freeze([
  "server",
  "typescript_client",
  "react_ui",
  "flutter_client",
  "flutter_widgets",
]);

const ENTRY_POINTS = Object.freeze({
  server: new Set(["src/server/index.ts"]),
  typescript_client: new Set(["src/client/index.ts"]),
  react_ui: new Set(["src/react/index.ts", "src/ui/index.ts"]),
  flutter_client: new Set(["flutter/lib/core.dart"]),
  flutter_widgets: new Set(["flutter/lib/ui.dart"]),
});

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sorted = (values) => [...values].sort();
const sameMembers = (actual, expected) =>
  JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
const assertRecord = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
};
const assertExactKeys = (value, expected, label) => {
  const actual = Object.keys(value);
  if (!sameMembers(actual, expected)) {
    throw new TypeError(
      `${label} must contain exactly ${expected.join(", ")}; received ${actual.join(", ")}`,
    );
  }
};
const assertNonEmptyString = (value, label) => {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty trimmed string`);
  }
};

const resolveLocalReference = (fromPath, specifier) => {
  const isDartRelative = fromPath.endsWith(".dart") &&
    !specifier.startsWith("dart:") &&
    !specifier.startsWith("package:");
  if (!specifier.startsWith(".") && !isDartRelative) return undefined;
  const target = specifier.endsWith(".js")
    ? `${specifier.slice(0, -3)}.ts`
    : specifier;
  const absolute = resolve(repositoryRoot, dirname(fromPath), target);
  const repositoryPath = relative(repositoryRoot, absolute).replaceAll("\\", "/");
  if (repositoryPath.startsWith("..") || isAbsolute(repositoryPath) ||
      (fromPath.startsWith("flutter/") && !repositoryPath.startsWith("flutter/"))) {
    throw new TypeError(`public export leaves the repository: ${specifier}`);
  }
  return repositoryPath;
};

const localReferences = (source, sourcePath) => {
  const references = [];
  const patterns = [
    /\bexport\s+(?:\*|\{[\s\S]*?\})\s+from\s+["']([^"']+)["']/g,
    /^\s*export\s+["']([^"']+)["']/gm,
    /^\s*part\s+["']([^"']+)["']/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const resolved = resolveLocalReference(sourcePath, match[1]);
      if (resolved !== undefined) references.push(resolved);
    }
  }
  return references;
};

const createSourceReader = (overrides = new Map()) => async (repositoryPath) => {
  if (overrides.has(repositoryPath)) return overrides.get(repositoryPath);
  return readFile(repositoryPath.startsWith("flutter/")
    ? resolve(flutterRepositoryRoot, repositoryPath.slice("flutter/".length))
    : resolve(repositoryRoot, repositoryPath), "utf8");
};

const entryPointExposesSource = async (entryPoint, citedSource, readSource) => {
  const pending = [entryPoint];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === citedSource) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const source = await readSource(current);
    pending.push(...localReferences(source, current));
  }
  return false;
};

const sourceDeclaresPublicSymbol = (sourcePath, source, symbol) => {
  const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (sourcePath.endsWith(".ts")) {
    const exportedDeclaration = new RegExp(
      `\\bexport\\s+(?:declare\\s+)?(?:async\\s+)?` +
        `(?:function|class|const|let|var|interface|type|enum)\\s+${escapedSymbol}\\b`,
    );
    const exportedInterfaceMethod =
      /\bexport\s+interface\s+[A-Za-z_$][A-Za-z0-9_$]*/.test(source) &&
      new RegExp(
        `^  ${escapedSymbol}(?:<[^\\n>]+>)?\\s*\\(`,
        "m",
      ).test(source);
    return exportedDeclaration.test(source) || exportedInterfaceMethod;
  }
  if (sourcePath.endsWith(".dart")) {
    const publicDeclaration = new RegExp(
      `^\\s*(?:(?:final|base|sealed|abstract|interface)\\s+)*` +
        `(?:class|enum|mixin|extension|typedef)\\s+${escapedSymbol}\\b`,
      "m",
    );
    const publicContainer =
      /^(?:(?:final|base|sealed|abstract|interface)\s+)*(?:class|extension)\s+[A-Z]/m;
    const publicInstanceMethod =
      publicContainer.test(source) &&
      new RegExp(`^\\s{2,}[^\\n]*\\b${escapedSymbol}\\s*\\(`, "m").test(source);
    return publicDeclaration.test(source) || publicInstanceMethod;
  }
  return false;
};

const validateCitation = async (citation, surface, label, readSource) => {
  assertRecord(citation, label);
  assertExactKeys(citation, ["entryPoint", "source", "symbol"], label);
  for (const field of ["entryPoint", "source", "symbol"]) {
    assertNonEmptyString(citation[field], `${label}.${field}`);
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(citation.symbol)) {
    throw new TypeError(`${label}.symbol is malformed`);
  }
  if (!ENTRY_POINTS[surface].has(citation.entryPoint)) {
    throw new TypeError(
      `${label}.entryPoint is not a public entry point for ${surface}`,
    );
  }
  if (!(await entryPointExposesSource(citation.entryPoint, citation.source, readSource))) {
    throw new TypeError(
      `${citation.entryPoint} does not publicly expose ${citation.source}`,
    );
  }
  const source = await readSource(citation.source);
  if (!sourceDeclaresPublicSymbol(citation.source, source, citation.symbol)) {
    throw new TypeError(
      `${label} cites missing public symbol ${citation.symbol} in ${citation.source}`,
    );
  }
};

export async function validateCapabilityManifest(
  manifest,
  { sourceOverrides = new Map() } = {},
) {
  assertRecord(manifest, "manifest");
  assertExactKeys(
    manifest,
    ["schemaVersion", "statuses", "surfaces", "capabilities"],
    "manifest",
  );
  if (manifest.schemaVersion !== 1) {
    throw new TypeError("manifest.schemaVersion must be 1");
  }
  if (!Array.isArray(manifest.statuses) ||
      !sameMembers(manifest.statuses, CAPABILITY_STATUSES)) {
    throw new TypeError("manifest.statuses must match the closed status vocabulary");
  }
  if (!Array.isArray(manifest.surfaces) ||
      !sameMembers(manifest.surfaces, CAPABILITY_SURFACES)) {
    throw new TypeError("manifest.surfaces must match the closed surface vocabulary");
  }
  if (!Array.isArray(manifest.capabilities)) {
    throw new TypeError("manifest.capabilities must be an array");
  }

  const ids = manifest.capabilities.map((capability, index) => {
    assertRecord(capability, `capabilities[${index}]`);
    return capability.id;
  });
  if (new Set(ids).size !== ids.length) {
    throw new TypeError("manifest contains duplicate capability IDs");
  }
  const unknownIds = ids.filter(
    (id) => !REVIEWED_CAPABILITY_FAMILY_IDS.includes(id),
  );
  if (unknownIds.length > 0) {
    throw new TypeError(`manifest contains unknown capability IDs: ${unknownIds.join(", ")}`);
  }
  const missingIds = REVIEWED_CAPABILITY_FAMILY_IDS.filter(
    (id) => !ids.includes(id),
  );
  if (missingIds.length > 0) {
    throw new TypeError(
      `manifest is missing reviewed capability families: ${missingIds.join(", ")}`,
    );
  }

  const readSource = createSourceReader(sourceOverrides);
  for (const [capabilityIndex, capability] of manifest.capabilities.entries()) {
    const capabilityLabel = `capabilities[${capabilityIndex}]`;
    assertExactKeys(capability, ["id", "description", "surfaces"], capabilityLabel);
    assertNonEmptyString(capability.description, `${capabilityLabel}.description`);
    assertRecord(capability.surfaces, `${capabilityLabel}.surfaces`);
    assertExactKeys(
      capability.surfaces,
      CAPABILITY_SURFACES,
      `${capabilityLabel}.surfaces`,
    );

    for (const surface of CAPABILITY_SURFACES) {
      const entry = capability.surfaces[surface];
      const entryLabel = `${capability.id}.${surface}`;
      assertRecord(entry, entryLabel);
      if (!CAPABILITY_STATUSES.includes(entry.status)) {
        throw new TypeError(`${entryLabel} has unknown status ${entry.status}`);
      }
      if (entry.status === "supported") {
        assertExactKeys(entry, ["status", "citations"], entryLabel);
        if (!Array.isArray(entry.citations) || entry.citations.length === 0) {
          throw new TypeError(`${entryLabel} must cite at least one public symbol`);
        }
        for (const [citationIndex, citation] of entry.citations.entries()) {
          await validateCitation(
            citation,
            surface,
            `${entryLabel}.citations[${citationIndex}]`,
            readSource,
          );
        }
      } else {
        assertExactKeys(entry, ["status", "reason"], entryLabel);
        assertNonEmptyString(entry.reason, `${entryLabel}.reason`);
      }
    }
  }
}

export async function readCapabilityManifest() {
  return JSON.parse(
    await readFile(resolve(repositoryRoot, CAPABILITY_MANIFEST_PATH), "utf8"),
  );
}

const isMain = process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await access(resolve(repositoryRoot, CAPABILITY_MANIFEST_PATH));
  await validateCapabilityManifest(await readCapabilityManifest());
  console.log(`Validated ${CAPABILITY_MANIFEST_PATH}`);
}
