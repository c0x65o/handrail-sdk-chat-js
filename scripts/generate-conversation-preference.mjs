import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = resolve(repositoryRoot, "scripts/templates");
const descriptorPath = "contracts/http/conversation-preference.json";
const outputPaths = {
  typescript: "src/contracts/conversation-preference-mutation.ts",
  dart: "contracts/generated/dart/conversation_preference.dart",
};
const expectedNotifications = ["all", "mentions", "none"];
const expectedMuteStates = ["unmuted", "indefinite", "until"];
const expectedStatuses = [
  "applied",
  "replayed",
  "already_requested_state",
  "preference_revision_conflict",
];
const expectedInputFields = [
  "operation",
  "conversationId",
  "expectedPreferenceRevision",
  "idempotencyKey",
  "notificationPreference",
  "isStarred",
  "mute",
];
const expectedCanonicalPreferenceFields = [
  "notificationPreference",
  "isStarred",
  "mute",
  "updatedAt",
];
const expectedResultFields = [
  "operation",
  "reconciliationStatus",
  "conversationId",
  "expectedPreferenceRevision",
  "idempotencyKey",
  "requestedPreference",
  "preferenceRevision",
  "preference",
];
const requiredTrustedAliases = [
  "tenantId",
  "organizationId",
  "actorUserId",
  "currentUserId",
  "userId",
  "principalId",
  "sessionId",
  "authentication",
  "authorization",
  "roles",
  "capabilities",
  "permissions",
];

export async function readConversationPreferenceDescriptor(root = repositoryRoot) {
  const descriptor = JSON.parse(await readFile(resolve(root, descriptorPath), "utf8"));
  validateDescriptor(descriptor);
  return descriptor;
}

export function generateTypeScript(descriptor) {
  validateDescriptor(descriptor);
  return render("conversation-preference-mutation.ts.tpl", replacements(descriptor));
}

export function generateDart(descriptor) {
  validateDescriptor(descriptor);
  return render("conversation_preference.dart.tpl", replacements(descriptor));
}

export async function generateConversationPreference({ check = false, root = repositoryRoot } = {}) {
  const descriptor = await readConversationPreferenceDescriptor(root);
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
  const normalized = descriptor.trustedContextAliases.map(normalizeAlias);
  return {
    OPERATION: descriptor.operation,
    IDENTIFIER_MAX: String(descriptor.identifierMaxUtf8Bytes),
    IDEMPOTENCY_MAX: String(descriptor.idempotencyKeyMaxUtf8Bytes),
    INITIAL_REVISION: String(descriptor.initialPreferenceRevision),
    TRUSTED_NORMALIZED: normalized.map((alias) => `  "${alias}",`).join("\n"),
    DART_TRUSTED_NORMALIZED: normalized.map((alias) => `  '${alias}',`).join("\n"),
    TRUSTED_PROPERTIES: descriptor.trustedContextAliases.map((alias) => `  readonly ${alias}?: never;`).join("\n"),
    TS_STATUSES: descriptor.reconciliationStatuses.map((entry, index, all) => `  | "${entry.name}"${index === all.length - 1 ? ";" : ""}`).join("\n"),
    INPUT_KEYS: descriptor.inputFields.map((field) => `"${field.name}"`).join(", "),
    RESULT_KEYS: descriptor.resultFields.map((field) => `"${field.name}"`).join(", "),
    DART_INPUT_KEYS: descriptor.inputFields.map((field) => `  '${field.name}',`).join("\n"),
    DART_RESULT_KEYS: descriptor.resultFields.map((field) => `  '${field.name}',`).join("\n"),
  };
}

function validateDescriptor(descriptor) {
  if (descriptor?.schemaVersion !== 1 || descriptor.method !== "PATCH" || descriptor.path !== "/conversations/{conversationId}/preference" || descriptor.operation !== "update_conversation_preference") {
    throw new Error("conversation-preference.json must define PATCH /conversations/{conversationId}/preference schemaVersion 1");
  }
  if (descriptor.identifierMaxUtf8Bytes !== 255 || descriptor.idempotencyKeyMaxUtf8Bytes !== 255 || descriptor.initialPreferenceRevision !== 0) {
    throw new Error("conversation preference identifier, idempotency, or initial revision bounds are unsupported");
  }
  equal(descriptor.notificationPreferences, expectedNotifications, "notification preferences");
  equal(descriptor.muteStates?.map((state) => state.name), expectedMuteStates, "mute states");
  equal(descriptor.reconciliationStatuses?.map((status) => status.name), expectedStatuses, "reconciliation statuses");
  equal(descriptor.inputFields?.map((field) => field.name), expectedInputFields, "input fields");
  equal(descriptor.canonicalPreferenceFields?.map((field) => field.name), expectedCanonicalPreferenceFields, "canonical preference fields");
  equal(descriptor.resultFields?.map((field) => field.name), expectedResultFields, "result fields");
  for (const alias of requiredTrustedAliases) {
    if (!descriptor.trustedContextAliases?.includes(alias)) throw new Error(`conversation-preference.json is missing trusted alias ${alias}`);
  }
  if (new Set(descriptor.trustedContextAliases?.map(normalizeAlias)).size !== descriptor.trustedContextAliases?.length) {
    throw new Error("conversation-preference.json trusted aliases must normalize uniquely");
  }
  if (Object.keys(descriptor.coherenceRules ?? {}).length !== 7 || Object.values(descriptor.coherenceRules).some((value) => value !== true)) {
    throw new Error("conversation-preference.json coherence rules are incomplete");
  }
}

function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`conversation-preference.json has unsupported ${label}`);
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
  const drifted = await generateConversationPreference(options);
  if (options.check && drifted.length > 0) {
    console.error(`Generated conversation preference contracts are out of date:\n${drifted.map((path) => `- ${relative(options.root, resolve(options.root, path))}`).join("\n")}\nRun npm run generate:conversation-preference.`);
    process.exitCode = 1;
  } else if (options.check) console.log("Generated conversation preference contracts are up to date.");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
