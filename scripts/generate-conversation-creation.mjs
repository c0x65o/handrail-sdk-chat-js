import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = resolve(repositoryRoot, "scripts/templates");
const descriptorPath = "contracts/http/conversation-creation.json";
const outputPaths = {
  typescript: "src/contracts/conversation-creation.ts",
  dart: "contracts/generated/dart/conversation_creation.dart",
};

const expectedTypes = ["channel", "direct", "group_direct"];
const expectedStatuses = ["created", "existing_equivalent", "replayed"];
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

export async function readConversationCreationDescriptor(
  root = repositoryRoot,
) {
  const source = await readFile(resolve(root, descriptorPath), "utf8");
  const descriptor = JSON.parse(source);
  validateDescriptor(descriptor);
  return descriptor;
}

export function generateTypeScript(descriptor) {
  validateDescriptor(descriptor);
  return renderTemplate(
    "conversation-creation.ts.tpl",
    replacements(descriptor, '"'),
  );
}

export function generateDart(descriptor) {
  validateDescriptor(descriptor);
  return renderTemplate(
    "conversation_creation.dart.tpl",
    replacements(descriptor, "'"),
  );
}

export async function generateConversationCreation({
  check = false,
  root = repositoryRoot,
} = {}) {
  const descriptor = await readConversationCreationDescriptor(root);
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
  const normalizedAliases = descriptor.trustedIdentityAliases.map(
    normalizeAlias,
  );
  return {
    OPERATION: descriptor.operation,
    PARTICIPANT_IDENTITY_PREFIX: descriptor.participantIdentity.keyPrefix,
    TRUSTED_IDENTITY_FIELDS: normalizedAliases
      .map((alias) => `  ${quoted(alias)},`)
      .join("\n"),
    DART_TRUSTED_IDENTITY_FIELDS: normalizedAliases
      .map((alias) => `  ${quoted(alias)},`)
      .join("\n"),
    TRUSTED_IDENTITY_PROPERTIES: descriptor.trustedIdentityAliases
      .map((alias) => `  readonly ${alias}?: never;`)
      .join("\n"),
  };
}

function validateDescriptor(descriptor) {
  if (descriptor?.schemaVersion !== 1) {
    throw new Error("conversation-creation.json must have schemaVersion 1");
  }
  if (
    descriptor.method !== "POST" ||
    descriptor.path !== "/conversations" ||
    descriptor.operation !== "create_conversation"
  ) {
    throw new Error(
      "conversation-creation.json must define POST /conversations",
    );
  }
  assertEqual(
    descriptor.variants?.map((variant) => variant.type),
    expectedTypes,
    "creation variants",
  );
  assertEqual(
    descriptor.reconciliationStatuses?.map((status) => status.name),
    expectedStatuses,
    "reconciliation statuses",
  );
  assertEqual(
    descriptor.trustedIdentityAliases,
    expectedTrustedAliases,
    "trusted identity aliases",
  );

  const [channel, direct, group] = descriptor.variants ?? [];
  if (
    JSON.stringify(channel?.visibility) !== JSON.stringify(["public", "private"]) ||
    JSON.stringify(channel?.resultStatuses) !==
      JSON.stringify(["created", "replayed"]) ||
    channel?.exposesParticipantIdentity !== false
  ) {
    throw new Error("channel creation shape or statuses are unsupported");
  }
  if (
    direct?.participantCardinality?.intendedMinimum !== 1 ||
    direct?.participantCardinality?.intendedMaximum !== 1 ||
    direct?.participantCardinality?.completeMinimum !== 2 ||
    direct?.participantCardinality?.completeMaximum !== 2 ||
    direct?.exposesParticipantIdentity !== true
  ) {
    throw new Error("direct creation cardinality is unsupported");
  }
  if (
    group?.participantCardinality?.intendedMinimum !== 2 ||
    group?.participantCardinality?.intendedMaximum !== null ||
    group?.participantCardinality?.completeMinimum !== 3 ||
    group?.participantCardinality?.completeMaximum !== null ||
    group?.exposesParticipantIdentity !== true
  ) {
    throw new Error("group-direct creation cardinality is unsupported");
  }
  if (
    descriptor.participantIdentity?.keyPrefix !==
      "handrail-participants.v1." ||
    descriptor.participantIdentity?.completeSetIncludesTrustedActor !== true ||
    descriptor.participantIdentity?.intendedMembersExcludeTrustedActor !== true ||
    descriptor.participantIdentity?.memberIdsMustBeUnique !== true ||
    descriptor.participantIdentity?.canonicalOrder !==
      "ascendingUtf16CodeUnits" ||
    descriptor.participantIdentity?.encoding !== "uriEncodedJsonArray"
  ) {
    throw new Error("participant identity rules are incomplete");
  }
  if (
    Object.values(descriptor.coherenceRules ?? {}).some((value) => value !== true) ||
    Object.keys(descriptor.coherenceRules ?? {}).length !== 7
  ) {
    throw new Error("conversation creation coherence rules are incomplete");
  }
  const inputNames = descriptor.inputFields?.map((field) => field.name);
  assertEqual(
    inputNames,
    [
      "operation",
      "type",
      "name",
      "visibility",
      "entity",
      "intendedMemberUserIds",
      "idempotencyKey",
      "clientRequestId",
    ],
    "input fields",
  );
  assertEqual(
    descriptor.resultFields?.map((field) => field.name),
    [
      "operation",
      "type",
      "reconciliationStatus",
      "clientRequestId",
      "conversation",
      "participantIdentity",
    ],
    "result fields",
  );
  if (
    descriptor.inputFields?.find((field) => field.name === "clientRequestId")
      ?.correlation !== "exactResultEcho" ||
    descriptor.resultFields?.find((field) => field.name === "clientRequestId")
      ?.correlation !== "exactRequestEcho"
  ) {
    throw new Error("client request correlation must be an exact echo");
  }
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `conversation-creation.json has unsupported ${label}`,
    );
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
  const drifted = await generateConversationCreation(options);
  if (options.check && drifted.length > 0) {
    console.error(
      `Generated conversation creation contracts are out of date:\n${drifted
        .map((path) => `- ${relative(options.root, resolve(options.root, path))}`)
        .join("\n")}\nRun npm run generate:conversation-creation.`,
    );
    process.exitCode = 1;
  } else if (options.check) {
    console.log("Generated conversation creation contracts are up to date.");
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
