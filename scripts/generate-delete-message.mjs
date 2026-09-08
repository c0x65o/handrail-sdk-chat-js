import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = resolve(repositoryRoot, "scripts/templates");
const descriptorPath = "contracts/http/delete-message.json";
const outputPaths = {
  typescript: "src/contracts/generated/delete-message.ts",
  dart: "contracts/generated/dart/delete_message.dart",
};

const expectedInputFields = [
  "operation",
  "messageId",
  "expectedRevision",
  "idempotencyKey",
];
const expectedResultFields = [
  "operation",
  "reconciliationStatus",
  "expectedRevision",
  "message",
  "canonicalRevision",
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

export async function readDeleteMessageDescriptor(root = repositoryRoot) {
  const source = await readFile(resolve(root, descriptorPath), "utf8");
  const descriptor = JSON.parse(source);
  validateDescriptor(descriptor);
  return descriptor;
}

export function generateTypeScript(descriptor) {
  validateDescriptor(descriptor);
  return renderTemplate("delete-message.ts.tpl", {
    OPERATION: descriptor.operation,
    TRUSTED_IDENTITY_FIELDS: descriptor.trustedIdentityAliases
      .map(normalizeAlias)
      .map((alias) => `  ${JSON.stringify(alias)},`)
      .join("\n"),
    INPUT_KEYS: descriptor.inputFields
      .map((field) => `  ${JSON.stringify(field.name)},`)
      .join("\n"),
    RESULT_KEYS: descriptor.resultFields
      .map((field) => `  ${JSON.stringify(field.name)},`)
      .join("\n"),
  });
}

export function generateDart(descriptor) {
  validateDescriptor(descriptor);
  return renderTemplate("delete_message.dart.tpl", {
    OPERATION: descriptor.operation,
    TRUSTED_IDENTITY_FIELDS: descriptor.trustedIdentityAliases
      .map(normalizeAlias)
      .map((alias) => `  '${alias}',`)
      .join("\n"),
    INPUT_KEYS: descriptor.inputFields
      .map((field) => `        '${field.name}',`)
      .join("\n"),
    RESULT_KEYS: descriptor.resultFields
      .map((field) => `        '${field.name}',`)
      .join("\n"),
  });
}

export async function generateDeleteMessage({
  check = false,
  root = repositoryRoot,
} = {}) {
  const descriptor = await readDeleteMessageDescriptor(root);
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

function validateDescriptor(descriptor) {
  if (descriptor?.schemaVersion !== 1) {
    throw new Error("delete-message.json must have schemaVersion 1");
  }
  if (
    descriptor.method !== "DELETE" ||
    descriptor.path !== "/messages/:messageId" ||
    descriptor.operation !== "soft_delete"
  ) {
    throw new Error("delete-message.json must define DELETE soft-delete routing");
  }
  assertNames(descriptor.inputFields, expectedInputFields, "input fields");
  assertNames(descriptor.resultFields, expectedResultFields, "result fields");
  assertNames(
    descriptor.reconciliationStatuses,
    ["applied", "replayed", "revision_conflict"],
    "reconciliation statuses",
  );
  const expectedRules = [
    ["committedDeletionShell", "expectedPlusOne"],
    ["storedAppliedDeletionShell", "expectedPlusOne"],
    ["currentServerMessage", "differentFromExpected"],
  ];
  descriptor.reconciliationStatuses.forEach((status, index) => {
    const [canonicalState, revisionRule] = expectedRules[index];
    if (
      status.canonicalState !== canonicalState ||
      status.revisionRule !== revisionRule
    ) {
      throw new Error(status.name + " has unsupported reconciliation rules");
    }
  });
  if (descriptor.canonicalRevisionRule !== "equalsMessageRevision") {
    throw new Error("delete-message.json must tie canonical and message revisions");
  }
  if (
    descriptor.successfulMessageRule !== "deletedMessageShell" ||
    descriptor.deletedMessageShell?.model !== "Message" ||
    descriptor.deletedMessageShell?.content !== "null" ||
    descriptor.deletedMessageShell?.deletionMetadata !== "requiredPaired"
  ) {
    throw new Error("delete-message.json must define canonical deletion shells");
  }
  if (
    descriptor.staleRevisionConflict?.status !== "revision_conflict" ||
    JSON.stringify(descriptor.staleRevisionConflict.carries) !==
      JSON.stringify(["message", "canonicalRevision"]) ||
    descriptor.staleRevisionConflict.canonicalRevisionRule !==
      "differentFromExpectedRevision"
  ) {
    throw new Error("delete-message.json must define deterministic stale conflicts");
  }
  if (
    descriptor.resultFields[2]?.source !== "requestEcho" ||
    descriptor.resultFields[3]?.type !== "Message" ||
    descriptor.resultFields[3]?.source !== "server" ||
    descriptor.resultFields[4]?.type !== "positiveSafeInteger" ||
    descriptor.resultFields[4]?.source !== "server"
  ) {
    throw new Error("delete-message.json must define canonical server ownership");
  }
  if (
    JSON.stringify(descriptor.trustedIdentityAliases) !==
    JSON.stringify(expectedTrustedAliases)
  ) {
    throw new Error("delete-message.json trusted identity aliases are incomplete");
  }
}

function assertNames(values, expected, label) {
  const names = values?.map((value) => value?.name);
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(
      "delete-message.json must define exactly these " +
        label +
        ": " +
        expected.join(", "),
    );
  }
}

function renderTemplate(name, replacements) {
  let template = readFileSync(resolve(templateRoot, name), "utf8");
  for (const [key, value] of Object.entries(replacements)) {
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
  const drifted = await generateDeleteMessage(options);
  if (options.check && drifted.length > 0) {
    console.error(
      `Generated delete-message contracts are out of date:\n${drifted
        .map((path) => `- ${relative(options.root, resolve(options.root, path))}`)
        .join("\n")}\nRun npm run generate:delete-message.`,
    );
    process.exitCode = 1;
  } else if (options.check) {
    console.log("Generated delete-message contracts are up to date.");
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
