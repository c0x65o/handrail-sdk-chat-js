import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = resolve(repositoryRoot, "scripts/templates");
const descriptorPath = "contracts/http/reply-style-preference.json";
const outputPaths = {
  typescript: "src/contracts/reply-style-preference.ts",
  dart: "contracts/generated/dart/reply_style_preference.dart",
};
export async function readReplyStylePreferenceDescriptor(root = repositoryRoot) {
  const descriptor = JSON.parse(await readFile(resolve(root, descriptorPath), "utf8"));
  validateDescriptor(descriptor);
  return descriptor;
}

export function generateTypeScript(descriptor) {
  validateDescriptor(descriptor);
  return render("reply-style-preference.ts.tpl", replacements(descriptor));
}

export function generateDart(descriptor) {
  validateDescriptor(descriptor);
  return render("reply_style_preference.dart.tpl", replacements(descriptor));
}

export async function generateReplyStylePreference({ check = false, root = repositoryRoot } = {}) {
  const descriptor = await readReplyStylePreferenceDescriptor(root);
  const outputs = {
    [outputPaths.typescript]: generateTypeScript(descriptor),
    [outputPaths.dart]: generateDart(descriptor),
  };
  const drifted = [];
  for (const [path, generated] of Object.entries(outputs)) {
    const absolute = resolve(root, path);
    if (check) {
      let existing;
      try {
        existing = await readFile(absolute, "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (existing !== generated) drifted.push(path);
    } else {
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, generated, "utf8");
    }
  }
  return drifted;
}

function replacements(descriptor) {
  return {
    FEATURE: descriptor.feature.name,
    OPERATION: descriptor.operation,
    FALLBACK: descriptor.fallbackStyle,
    MAX_REVISION: String(descriptor.maxSafeRevision),
    IDEMPOTENCY_MAX: String(descriptor.idempotencyKeyMaxUtf8Bytes),
    TRUSTED_NORMALIZED: descriptor.trustedContextAliases.map(alias => `  "${normalizeAlias(alias)}",`).join("\n"),
    DART_TRUSTED_NORMALIZED: descriptor.trustedContextAliases.map(alias => `  '${normalizeAlias(alias)}',`).join("\n"),
    TRUSTED_PROPERTIES: descriptor.trustedContextAliases.map(alias => `  readonly ${alias}?: never;`).join("\n"),
    INPUT_KEYS: descriptor.inputFields.map(key => JSON.stringify(key)).join(", "),
    RESULT_KEYS: descriptor.resultFields.map(key => JSON.stringify(key)).join(", "),
    DART_INPUT_KEYS: descriptor.inputFields.map(key => `'${key}'`).join(", "),
    DART_RESULT_KEYS: descriptor.resultFields.map(key => `'${key}'`).join(", "),
  };
}

function validateDescriptor(d) {
  if (d?.schemaVersion !== 1 || d.path !== "/preferences/reply-style" || d.operation !== "update_reply_style_preference" || d.scope !== "trustedSessionTenantAndUser" || d.delivery !== "affectedUserOnly") throw new Error("Unsupported reply-style preference endpoint or scope");
  equal(d.methods, ["GET", "PATCH"], "methods");
  equal(d.feature, { name: "reply_style_preference_v1", missing: false, advertiseRuntime: true, defaultEnabled: false, requires: "hostOptInAndPersistenceReadiness" }, "feature");
  equal(d.styles, ["current", "discord"], "styles");
  if (d.fallbackStyle !== "current" || d.maxSafeRevision !== 9007199254740991 || d.idempotencyKeyMaxUtf8Bytes !== 255) throw new Error("Unsupported reply-style fallback or bounds");
  equal(d.get.inputFields, [], "GET input fields");
  equal(d.get.result, "preferenceState", "GET result");
  equal(d.preferenceStates, [
    { state: "absent", fields: ["state", "revision"], revision: 0, style: "forbidden" },
    { state: "saved", fields: ["state", "revision", "style"], revision: "positiveSafeInteger", style: "rawStringIncludingUnknown" },
  ], "read states");
  equal(d.inputFields, ["operation", "style", "baseRevision", "idempotencyKey"], "input fields");
  equal(d.resultFields, ["operation", "reconciliationStatus", "baseRevision", "idempotencyKey", "requestedStyle", "preference"], "result fields");
  equal(d.inputRules.style, "supportedLiteralOnly", "write style");
  equal(d.inputRules.baseRevision, "integerFromZeroThroughMaxSafeRevisionMinusOne", "write revision");
  equal(d.reconciliationStatuses, [
    { name: "applied", revisionRule: "basePlusOne", stateRule: "savedRequestedStyle" },
    { name: "replayed", revisionRule: "basePlusOne", stateRule: "savedRequestedStyle" },
    { name: "already_requested_state", revisionRule: "equalsBase", stateRule: "savedRequestedStyle" },
    { name: "preference_revision_conflict", revisionRule: "differentFromBase", stateRule: "authoritativeAbsentOrSavedIncludingUnknown" },
  ], "status rules");
  equal(d.coherenceRules, { rejectUnknownFields: true, rejectNormalizedTrustedAliasesRecursively: true, requestEchoesMustMatch: true, statusSpecificRevisionRules: true, preserveUnknownSavedValues: true }, "coherence rules");
  const required = ["tenant", "tenantId", "organization", "organizationId", "actor", "actorId", "actorContext", "actorRole", "actorRoles", "actorUserId", "currentActor", "currentActorId", "currentUser", "currentUserId", "user", "userId", "otherUser", "otherUserId", "arbitraryUser", "arbitraryUserId", "targetUser", "targetUserId", "principal", "principalId", "subject", "subjectId", "authenticatedUser", "authenticatedUserId", "identity", "session", "sessionId", "auth", "authentication", "authorization", "role", "roles", "capability", "capabilities", "permission", "permissions"];
  if (!Array.isArray(d.trustedContextAliases) || d.trustedContextAliases.some(alias => typeof alias !== "string" || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(alias)) || required.some(alias => !d.trustedContextAliases.includes(alias)) || new Set(d.trustedContextAliases.map(normalizeAlias)).size !== d.trustedContextAliases.length) throw new Error("Invalid or missing trusted aliases");
}

function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`reply-style-preference.json has unsupported ${label}`);
}
function normalizeAlias(alias) {
  return alias.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
}
function render(name, values) {
  let template = readFileSync(resolve(templateRoot, name), "utf8");
  for (const [key, value] of Object.entries(values)) template = template.replaceAll(`{{${key}}}`, value);
  if (/\{\{[A-Z_]+\}\}/.test(template)) throw new Error(`${name} contains an unresolved placeholder`);
  return template;
}
function parseArguments(args) {
  let check = false;
  let root = repositoryRoot;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--check") check = true;
    else if (args[index] === "--root" && args[index + 1]) root = resolve(args[++index]);
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  return { check, root };
}
async function main() {
  const options = parseArguments(process.argv.slice(2));
  const drifted = await generateReplyStylePreference(options);
  if (options.check && drifted.length > 0) {
    console.error(`Generated reply style preference contracts are out of date:\n${drifted.map((path) => `- ${relative(options.root, resolve(options.root, path))}`).join("\n")}\nRun npm run generate:reply-style-preference.`);
    process.exitCode = 1;
  } else if (options.check) console.log("Generated reply style preference contracts are up to date.");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
