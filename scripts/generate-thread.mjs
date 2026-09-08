import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = resolve(repositoryRoot, "scripts/templates");
const descriptorPath = "contracts/http/thread.json";
const outputPaths = {
  typescript: "src/contracts/thread-creation.ts",
  dart: "contracts/generated/dart/thread_creation.dart",
};

const expectedInputFields = [
  "operation",
  "parentConversationId",
  "rootMessageId",
  "name",
  "initialFollow",
  "idempotencyKey",
];
const expectedResultFields = [
  "operation",
  "reconciliationStatus",
  "parentConversationId",
  "rootMessageId",
  "conversation",
  "rootThreadSummary",
];
const expectedStatuses = ["created", "existing_for_root", "replayed"];
const expectedTrustedAliases = [
  "tenant",
  "tenantId",
  "organization",
  "organizationId",
  "actor",
  "actorId",
  "actorContext",
  "actorUserId",
  "currentActor",
  "currentActorId",
  "currentUser",
  "currentUserId",
  "user",
  "userId",
  "principal",
  "principalId",
  "subject",
  "subjectId",
  "authenticatedUser",
  "authenticatedUserId",
  "identity",
  "session",
  "sessionId",
  "auth",
  "authorization",
  "role",
  "roles",
  "capability",
  "capabilities",
  "permissions",
];

export async function readThreadDescriptor(root = repositoryRoot) {
  const source = await readFile(resolve(root, descriptorPath), "utf8");
  const descriptor = JSON.parse(source);
  validateDescriptor(descriptor);
  return descriptor;
}

export function generateTypeScript(descriptor) {
  validateDescriptor(descriptor);
  return renderTemplate(
    "thread-creation.ts.tpl",
    replacements(descriptor, '"'),
  );
}

export function generateDart(descriptor) {
  validateDescriptor(descriptor);
  return renderTemplate(
    "thread_creation.dart.tpl",
    replacements(descriptor, "'"),
  );
}

export async function generateThread({
  check = false,
  root = repositoryRoot,
} = {}) {
  const descriptor = await readThreadDescriptor(root);
  const outputs = {
    [outputPaths.typescript]: generateTypeScript(descriptor),
    [outputPaths.dart]: generateDart(descriptor),
  };
  const drifted = [];

  for (const [path, generated] of Object.entries(outputs)) {
    const absolutePath = resolve(root, path);
    if (check) {
      let existing;
      try {
        existing = await readFile(absolutePath, "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (existing !== generated) drifted.push(path);
      continue;
    }
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, generated, "utf8");
  }
  return drifted;
}

function replacements(descriptor, quote) {
  const quoted = (value) => `${quote}${value}${quote}`;
  return {
    OPERATION: descriptor.operation,
    CREATED_STATUS: descriptor.reconciliationStatuses[0].name,
    EXISTING_STATUS: descriptor.reconciliationStatuses[1].name,
    REPLAYED_STATUS: descriptor.reconciliationStatuses[2].name,
    TRUSTED_IDENTITY_FIELDS: descriptor.trustedIdentityAliases
      .map(normalizeAlias)
      .map((alias) => `  ${quoted(alias)},`)
      .join("\n"),
    TRUSTED_IDENTITY_PROPERTIES: descriptor.trustedIdentityAliases
      .map((alias) => `  readonly ${alias}?: never;`)
      .join("\n"),
    INPUT_KEYS: descriptor.inputFields
      .map((field) => `  ${quoted(field.name)},`)
      .join("\n"),
    DART_INPUT_KEYS: descriptor.inputFields
      .map((field) => `      ${quoted(field.name)},`)
      .join("\n"),
    RESULT_KEYS: descriptor.resultFields
      .map((field) => `  ${quoted(field.name)},`)
      .join("\n"),
    DART_RESULT_KEYS: descriptor.resultFields
      .map((field) => `      ${quoted(field.name)},`)
      .join("\n"),
  };
}

function validateDescriptor(descriptor) {
  if (descriptor?.schemaVersion !== 1) {
    throw new Error("thread.json must have schemaVersion 1");
  }
  if (
    descriptor.method !== "POST" ||
    descriptor.path !== "/messages/:rootMessageId/thread" ||
    descriptor.operation !== "create_thread"
  ) {
    throw new Error("thread.json must define POST /messages/:rootMessageId/thread");
  }
  assertFieldDefinitions(
    descriptor.inputFields,
    [
      ["operation", "literal", undefined, undefined],
      ["parentConversationId", "ConversationId", undefined, undefined],
      ["rootMessageId", "MessageId", undefined, undefined],
      ["name", "ThreadConversationName", undefined, true],
      ["initialFollow", "boolean", undefined, true],
      ["idempotencyKey", "nonBlankString", undefined, undefined],
    ],
    "input fields",
  );
  assertFieldDefinitions(
    descriptor.resultFields,
    [
      ["operation", "literal", undefined, undefined],
      ["reconciliationStatus", "reconciliationStatus", undefined, undefined],
      ["parentConversationId", "ConversationId", "requestEcho", undefined],
      ["rootMessageId", "MessageId", "requestEcho", undefined],
      ["conversation", "ConversationDetailSnapshot", undefined, undefined],
      ["rootThreadSummary", "ThreadSummary", "server", undefined],
    ],
    "result fields",
  );
  assertNames(descriptor.inputFields, expectedInputFields, "input fields");
  assertNames(descriptor.resultFields, expectedResultFields, "result fields");
  assertNames(
    descriptor.reconciliationStatuses,
    expectedStatuses,
    "reconciliation statuses",
  );
  const canonicalStates = descriptor.reconciliationStatuses?.map(
    (status) => status?.canonicalState,
  );
  if (
    JSON.stringify(canonicalStates) !==
    JSON.stringify([
      "newThreadConversation",
      "existingRootThreadConversation",
      "storedAuthoritativeResult",
    ])
  ) {
    throw new Error("thread.json must define canonical reconciliation state");
  }
  const conversation = descriptor.resultFields?.[4];
  if (conversation?.constraint !== "thread") {
    throw new Error("thread.json conversation result must be constrained to a thread");
  }
  if (
    descriptor.coherenceRules?.resultIdentifiersMatchRequest !== true ||
    descriptor.coherenceRules?.conversationType !== "thread" ||
    descriptor.coherenceRules?.conversationParentMatchesResult !== true ||
    descriptor.coherenceRules?.conversationRootMatchesResult !== true ||
    descriptor.coherenceRules?.rootThreadSummaryThreadIdMatchesConversation !== true
  ) {
    throw new Error("thread.json must define root, parent, and thread coherence");
  }
  if (
    JSON.stringify(descriptor.trustedIdentityAliases) !==
    JSON.stringify(expectedTrustedAliases)
  ) {
    throw new Error("thread.json trusted identity aliases are incomplete");
  }
}

function assertNames(values, expected, label) {
  const names = values?.map((value) => value?.name);
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(
      `thread.json must define exactly these ${label}: ${expected.join(", ")}`,
    );
  }
}

function assertFieldDefinitions(values, expected, label) {
  const actual = values?.map((field) => [
    field?.name,
    field?.type,
    field?.source,
    field?.optional,
  ]);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`thread.json has unsupported ${label}`);
  }
}

function renderTemplate(name, values) {
  let template = readFileSync(resolve(templateRoot, name), "utf8");
  for (const [key, value] of Object.entries(values)) {
    template = template.replaceAll(`{{${key}}}`, value);
  }
  if (/\{\{[A-Z_]+\}\}/.test(template)) {
    throw new Error(`${name} contains an unresolved generator placeholder`);
  }
  return template;
}

function normalizeAlias(alias) {
  return alias.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function parseArguments(args) {
  let check = false;
  let root = repositoryRoot;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") {
      check = true;
    } else if (argument === "--root") {
      const value = args[index + 1];
      if (!value) throw new Error("--root requires a path");
      root = resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { check, root };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const drifted = await generateThread(options);
  if (options.check && drifted.length > 0) {
    console.error(
      `Generated thread creation contracts are out of date:\n${drifted
        .map((path) => `- ${relative(options.root, resolve(options.root, path))}`)
        .join("\n")}\nRun npm run generate:thread.`,
    );
    process.exitCode = 1;
  } else if (options.check) {
    console.log("Generated thread creation contracts are up to date.");
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
