import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = resolve(repositoryRoot, "scripts/templates");
const descriptorPath = "contracts/http/reactions.json";
const outputPaths = {
  typescript: "src/contracts/reaction-mutations.ts",
  dart: "contracts/generated/dart/reaction_mutations.dart",
};

const expectedOperations = ["add_reaction", "remove_reaction"];
const expectedInputFields = [
  "operation",
  "messageId",
  "reactionKey",
  "idempotencyKey",
];
const expectedResultFields = [
  "operation",
  "reconciliationStatus",
  "messageId",
  "reactionKey",
  "count",
  "reactedByCurrentUser",
];
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
  "author",
  "authorId",
  "authorUserId",
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
  "authentication",
  "authorization",
  "role",
  "roles",
];

export async function readReactionDescriptor(root = repositoryRoot) {
  const source = await readFile(resolve(root, descriptorPath), "utf8");
  const descriptor = JSON.parse(source);
  validateDescriptor(descriptor);
  return descriptor;
}

export function generateTypeScript(descriptor) {
  validateDescriptor(descriptor);
  return renderTemplate("reaction-mutations.ts.tpl", replacements(descriptor, '"'));
}

export function generateDart(descriptor) {
  validateDescriptor(descriptor);
  return renderTemplate("reaction_mutations.dart.tpl", replacements(descriptor, "'"));
}

export async function generateReactions({
  check = false,
  root = repositoryRoot,
} = {}) {
  const descriptor = await readReactionDescriptor(root);
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
    ADD_OPERATION: descriptor.operations[0].name,
    REMOVE_OPERATION: descriptor.operations[1].name,
    APPLIED_STATUS: descriptor.reconciliationStatuses[0].name,
    REPLAYED_STATUS: descriptor.reconciliationStatuses[1].name,
    MAX_REACTION_KEY_UTF8_BYTES: String(
      descriptor.reactionKey.maximumUtf8Bytes,
    ),
    MAX_IDEMPOTENCY_KEY_UTF8_BYTES: String(
      descriptor.idempotencyKey.maximumUtf8Bytes,
    ),
    TRUSTED_IDENTITY_FIELDS: descriptor.trustedIdentityAliases
      .map(normalizeAlias)
      .map((alias) => `  ${quoted(alias)},`)
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
    throw new Error("reactions.json must have schemaVersion 1");
  }
  if (
    descriptor.method !== "PATCH" ||
    descriptor.path !== "/messages/:messageId/reactions/:reactionKey"
  ) {
    throw new Error("reactions.json must define the PATCH reaction route");
  }
  assertNames(descriptor.operations, expectedOperations, "operations");
  if (
    descriptor.operations[0]?.reactedByCurrentUser !== true ||
    descriptor.operations[1]?.reactedByCurrentUser !== false
  ) {
    throw new Error("reactions.json operations must define deterministic states");
  }
  assertNames(descriptor.inputFields, expectedInputFields, "input fields");
  assertNames(descriptor.resultFields, expectedResultFields, "result fields");
  assertFieldDefinitions(
    descriptor.inputFields,
    [
      ["operation", "operation", undefined],
      ["messageId", "MessageId", undefined],
      ["reactionKey", "normalizedReactionKey", undefined],
      ["idempotencyKey", "boundedNonBlankString", undefined],
    ],
    "input fields",
  );
  assertFieldDefinitions(
    descriptor.resultFields,
    [
      ["operation", "operation", undefined],
      ["reconciliationStatus", "reconciliationStatus", undefined],
      ["messageId", "MessageId", "requestEcho"],
      ["reactionKey", "normalizedReactionKey", "requestEcho"],
      ["count", "nonNegativeSafeInteger", "server"],
      ["reactedByCurrentUser", "operationState", "server"],
    ],
    "result fields",
  );
  assertNames(
    descriptor.reconciliationStatuses,
    ["applied", "replayed"],
    "reconciliation statuses",
  );
  if (
    descriptor.reconciliationStatuses[0]?.canonicalState !==
      "committedAggregate" ||
    descriptor.reconciliationStatuses[1]?.canonicalState !==
      "storedAppliedAggregate"
  ) {
    throw new Error("reactions.json must define applied and replayed aggregates");
  }
  if (
    descriptor.reactionKey?.required !== true ||
    descriptor.reactionKey?.nonBlank !== true ||
    descriptor.reactionKey?.normalization !== "NFC" ||
    descriptor.reactionKey?.allowLeadingOrTrailingWhitespace !== false ||
    descriptor.reactionKey?.maximumUtf8Bytes !== 64
  ) {
    throw new Error("reactions.json must preserve the canonical 64-byte key bound");
  }
  if (
    descriptor.idempotencyKey?.required !== true ||
    descriptor.idempotencyKey?.nonBlank !== true ||
    descriptor.idempotencyKey?.maximumUtf8Bytes !== 255
  ) {
    throw new Error("reactions.json must preserve the 255-byte idempotency bound");
  }
  if (
    descriptor.aggregateRules?.count !== "nonNegativeSafeInteger" ||
    descriptor.aggregateRules?.addRequiresPositiveCount !== true ||
    descriptor.aggregateRules?.reactedByCurrentUserMatchesOperation !== true
  ) {
    throw new Error("reactions.json must define canonical aggregate coherence");
  }
  if (
    descriptor.resultFields[2]?.source !== "requestEcho" ||
    descriptor.resultFields[3]?.source !== "requestEcho" ||
    descriptor.resultFields[4]?.source !== "server" ||
    descriptor.resultFields[5]?.source !== "server"
  ) {
    throw new Error("reactions.json must define canonical result ownership");
  }
  if (
    JSON.stringify(descriptor.trustedIdentityAliases) !==
    JSON.stringify(expectedTrustedAliases)
  ) {
    throw new Error("reactions.json trusted identity aliases are incomplete");
  }
}

function assertNames(values, expected, label) {
  const names = values?.map((value) => value?.name);
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(
      "reactions.json must define exactly these " +
        label +
        ": " +
        expected.join(", "),
    );
  }
}

function assertFieldDefinitions(values, expected, label) {
  const actual = values?.map((field) => [field?.name, field?.type, field?.source]);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("reactions.json has unsupported " + label);
  }
}

function renderTemplate(name, values) {
  let template = readFileSync(resolve(templateRoot, name), "utf8");
  for (const [key, value] of Object.entries(values)) {
    template = template.replaceAll(`{{${key}}}`, value);
  }
  if (/\{\{[A-Z_]+\}\}/.test(template)) {
    throw new Error(name + " contains an unresolved generator placeholder");
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
      throw new Error("Unknown argument: " + argument);
    }
  }
  return { check, root };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const drifted = await generateReactions(options);
  if (options.check && drifted.length > 0) {
    console.error(
      `Generated reaction contracts are out of date:\n${drifted
        .map((path) => `- ${relative(options.root, resolve(options.root, path))}`)
        .join("\n")}\nRun npm run generate:reactions.`,
    );
    process.exitCode = 1;
  } else if (options.check) {
    console.log("Generated reaction contracts are up to date.");
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
