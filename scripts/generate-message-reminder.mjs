import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = resolve(repositoryRoot, "scripts/templates");
const descriptorPath = "contracts/http/message-reminder.json";
const outputPaths = {
  typescript: "src/contracts/generated/message-reminder.ts",
  dart: "contracts/generated/dart/message_reminder.dart",
};

const inputFields = [
  "operation",
  "intent",
  "conversationId",
  "messageId",
  "expectedReminderRevision",
  "idempotencyKey",
  "dueAt",
];
const resultFields = [
  "operation",
  "intent",
  "reconciliationStatus",
  "conversationId",
  "messageId",
  "expectedReminderRevision",
  "idempotencyKey",
  "reminderRevision",
  "reminder",
];
const statuses = [
  "applied",
  "replayed",
  "already-requested",
  "revision-conflict",
  "unavailable-source",
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

export async function readMessageReminderDescriptor(root = repositoryRoot) {
  const descriptor = JSON.parse(
    await readFile(resolve(root, descriptorPath), "utf8"),
  );
  validateDescriptor(descriptor);
  return descriptor;
}

export function generateTypeScript(descriptor) {
  validateDescriptor(descriptor);
  return render("message-reminder.ts.tpl", replacements(descriptor));
}

export function generateDart(descriptor) {
  validateDescriptor(descriptor);
  return render("message_reminder.dart.tpl", replacements(descriptor));
}

export async function generateMessageReminder({
  check = false,
  root = repositoryRoot,
} = {}) {
  const descriptor = await readMessageReminderDescriptor(root);
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
  const normalizedLines = (values, quote) =>
    values
      .map(normalizeAlias)
      .map((value) => `  ${quote}${value}${quote},`)
      .join("\n");
  return {
    OPERATION: descriptor.operation,
    IDENTIFIER_MAX: String(descriptor.identifierMaxUtf8Bytes),
    IDEMPOTENCY_MAX: String(descriptor.idempotencyKeyMaxUtf8Bytes),
    TRUSTED_NORMALIZED: normalizedLines(descriptor.trustedContextAliases, '"'),
    TOGGLE_NORMALIZED: normalizedLines(descriptor.toggleLikeAliases, '"'),
    DART_TRUSTED_NORMALIZED: normalizedLines(descriptor.trustedContextAliases, "'"),
    DART_TOGGLE_NORMALIZED: normalizedLines(descriptor.toggleLikeAliases, "'"),
    TRUSTED_PROPERTIES: descriptor.trustedContextAliases
      .map((alias) => `  readonly ${alias}?: never;`)
      .join("\n"),
    TOGGLE_PROPERTIES: descriptor.toggleLikeAliases
      .map((alias) => `  readonly ${alias}?: never;`)
      .join("\n"),
  };
}

function validateDescriptor(descriptor) {
  if (
    descriptor?.schemaVersion !== 1 ||
    descriptor.method !== "PUT" ||
    descriptor.path !== "/conversations/{conversationId}/messages/{messageId}/reminder" ||
    descriptor.operation !== "message_reminder.v1"
  ) {
    throw new Error("message-reminder.json must define the versioned PUT reminder route");
  }
  if (
    descriptor.identifierMaxUtf8Bytes !== 255 ||
    descriptor.idempotencyKeyMaxUtf8Bytes !== 255 ||
    descriptor.initialReminderRevision !== 0
  ) {
    throw new Error("message-reminder.json identifier, idempotency, or initial revision bounds are unsupported");
  }
  equal(descriptor.intents, ["set", "cancel"], "explicit intents");
  equal(
    descriptor.intentSemantics,
    {
      set: "createOrReschedule",
      reschedule: "set",
      cancel: "cancelRequestedState",
      toggle: "forbidden",
    },
    "intent semantics",
  );
  equal(descriptor.inputFields?.map(({ name }) => name), inputFields, "input fields");
  equal(descriptor.resultFields?.map(({ name }) => name), resultFields, "result fields");
  equal(descriptor.canonicalReminderFields?.map(({ name }) => name), ["privacy", "state", "dueAt"], "canonical fields");
  equal(descriptor.reconciliationStatuses?.map(({ name }) => name), statuses, "statuses");
  equal(
    descriptor.reconciliationStatuses?.map((status) => [
      status.authoritativeState,
      status.revisionRule,
      status.canonicalData,
    ]),
    [
      ["requestedState", "expectedPlusOne", "required"],
      ["requestedState", "expectedPlusOne", "required"],
      ["requestedState", "equalsExpected", "required"],
      ["currentAffectedActorStateDifferentFromRequest", "differentFromExpected", "required"],
      ["undisclosed", "undisclosed", "forbidden"],
    ],
    "status coherence",
  );
  if (
    descriptor.inputFields[6]?.requiredFor !== "set" ||
    descriptor.inputFields[6]?.forbiddenFor !== "cancel" ||
    descriptor.resultFields[8]?.delivery !== "affectedAuthenticatedActorOnly" ||
    descriptor.privacyPolicy?.identitySource !== "trustedServerContextOnly" ||
    descriptor.privacyPolicy?.canonicalReminderDelivery !== "affectedAuthenticatedActorOnly" ||
    descriptor.privacyPolicy?.canonicalReminderContainsActorIdentity !== false ||
    descriptor.privacyPolicy?.otherActorReminderData !== "forbidden" ||
    descriptor.privacyPolicy?.unavailableSourceActorStateDisclosure !== "none" ||
    !Object.values(descriptor.coherenceRules ?? {}).every((value) => value === true)
  ) {
    throw new Error("message-reminder.json privacy and coherence invariants are incomplete");
  }
  for (const alias of requiredTrustedAliases) {
    if (!descriptor.trustedContextAliases?.includes(alias)) {
      throw new Error(`message-reminder.json is missing trusted alias ${alias}`);
    }
  }
  if (!descriptor.toggleLikeAliases?.includes("toggle") ||
      !descriptor.toggleLikeAliases?.includes("reminderEnabled")) {
    throw new Error("message-reminder.json toggle aliases are incomplete");
  }
}

function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`message-reminder.json has unsupported ${label}`);
  }
}

function normalizeAlias(alias) {
  return alias.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function render(name, replacements) {
  let source = readFileSync(resolve(templateRoot, name), "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    source = source.replaceAll(`{{${key}}}`, String(value));
  }
  if (/\{\{[A-Z_]+\}\}/.test(source)) {
    throw new Error(`${name} contains an unresolved placeholder`);
  }
  return source;
}

function parseArguments(args) {
  let check = false;
  let root = repositoryRoot;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--check") check = true;
    else if (args[index] === "--root") {
      if (!args[index + 1]) throw new Error("--root requires a path");
      root = resolve(args[index + 1]);
      index += 1;
    } else throw new Error(`Unknown argument: ${args[index]}`);
  }
  return { check, root };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const drifted = await generateMessageReminder(options);
  if (options.check && drifted.length > 0) {
    console.error(
      `Generated message-reminder contracts are out of date:\n${drifted
        .map((path) => `- ${relative(options.root, resolve(options.root, path))}`)
        .join("\n")}\nRun npm run generate:message-reminder.`,
    );
    process.exitCode = 1;
  } else if (options.check) {
    console.log("Generated message-reminder contracts are up to date.");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
