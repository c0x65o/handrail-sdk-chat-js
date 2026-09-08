import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const descriptorPath = "contracts/http/forward-message.json";
const templateRoot = resolve(repositoryRoot, "scripts/templates");
const outputPaths = {
  typescript: "src/contracts/generated/forward-message.ts",
  dart: "contracts/generated/dart/forward_message.dart",
};

const inputFields = [
  "operation",
  "sourceMessageId",
  "destinationConversationId",
  "clientCorrelationId",
  "idempotencyKey",
];
const resultFields = [
  "operation",
  "reconciliationStatus",
  "clientCorrelationId",
  "destinationConversationId",
  "message",
  "canonicalRevision",
];
const statuses = ["applied", "replayed"];
const snapshotFields = ["sourceMessageId", "originalAuthor", "originalCreatedAt"];
const authorFields = ["userId", "displayName"];
const displayFields = ["format", "text", "mentions", "forwarded"];
const requiredErrorCodes = [
  "malformed_input",
  "trusted_identity_field",
  "server_owned_field",
  "malformed_result",
  "correlation_mismatch",
  "destination_conversation_mismatch",
  "source_message_mismatch",
  "noncanonical_destination",
  "malformed_attribution",
  "source_attachments_unsupported",
  "source_message_not_found",
  "source_message_forbidden",
  "destination_conversation_not_found",
  "destination_conversation_forbidden",
  "idempotency_conflict",
];

export async function readForwardMessageDescriptor(root = repositoryRoot) {
  const source = await readFile(resolve(root, descriptorPath), "utf8");
  const descriptor = JSON.parse(source);
  validateDescriptor(descriptor);
  return descriptor;
}

export function generateTypeScript(descriptor) {
  validateDescriptor(descriptor);
  return render("forward-message.ts.tpl", replacements(descriptor, '"'));
}

export function generateDart(descriptor) {
  validateDescriptor(descriptor);
  return render("forward_message.dart.tpl", replacements(descriptor, "'"));
}

export async function generateForwardMessage({
  check = false,
  root = repositoryRoot,
} = {}) {
  const descriptor = await readForwardMessageDescriptor(root);
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
    } else {
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, generated, "utf8");
    }
  }
  return drifted;
}

function replacements(descriptor, quote) {
  const quoted = (value) => `${quote}${value}${quote}`;
  const list = (values) => values.map((value) => `  ${quoted(value)},`).join("\n");
  return {
    OPERATION: descriptor.operation,
    TRUSTED_IDENTITY_FIELDS: list(descriptor.trustedIdentityAliases.map(normalizeAlias)),
    SERVER_OWNED_FIELDS: list(descriptor.serverOwnedAliases.map(normalizeAlias)),
    TRUSTED_IDENTITY_PROPERTIES: descriptor.trustedIdentityAliases
      .map((alias) => `  readonly ${alias}?: never;`)
      .join("\n"),
    SERVER_OWNED_PROPERTIES: descriptor.serverOwnedAliases
      .map((alias) => `  readonly ${alias}?: never;`)
      .join("\n"),
  };
}

function validateDescriptor(descriptor) {
  if (
    descriptor?.schemaVersion !== 1 ||
    descriptor.method !== "POST" ||
    descriptor.path !== "/messages/forward" ||
    descriptor.operation !== "forward_message.v1"
  ) {
    throw new Error("forward-message.json must define schemaVersion 1 POST forward_message.v1");
  }
  assertEqual(descriptor.inputFields?.map(({ name }) => name), inputFields, "input fields");
  assertEqual(descriptor.resultFields?.map(({ name }) => name), resultFields, "result fields");
  assertEqual(descriptor.reconciliationStatuses?.map(({ name }) => name), statuses, "statuses");
  assertEqual(descriptor.snapshot?.fields, snapshotFields, "snapshot fields");
  assertEqual(descriptor.snapshot?.originalAuthorFields, authorFields, "author fields");
  assertEqual(descriptor.snapshot?.displayContentFields, displayFields, "display fields");
  assertEqual(descriptor.errorCodes, requiredErrorCodes, "error codes");
  if (
    descriptor.canonicalRevisionRule !== "createdMessageRevisionOne" ||
    descriptor.snapshot.contentField !== "forwarded" ||
    descriptor.snapshot.snapshotSemantics !== "immutable_display_copy" ||
    descriptor.snapshot.liveSourceResolution !== "forbidden" ||
    descriptor.snapshot.rawHtml !== "forbidden" ||
    descriptor.snapshot.blocks !== "forbidden" ||
    descriptor.snapshot.trustedSessionOrPrivateAuthorizationData !== "forbidden" ||
    descriptor.attachmentPolicy?.sourceReferences !== "unsupported" ||
    descriptor.attachmentPolicy?.destinationReferences !== "forbidden" ||
    descriptor.attachmentPolicy?.errorCode !== "source_attachments_unsupported" ||
    descriptor.attachmentPolicy?.silentDrop !== false ||
    descriptor.attachmentPolicy?.referenceReuse !== false ||
    !Object.values(descriptor.resultConsistency ?? {}).every((value) => value === true)
  ) {
    throw new Error("forward-message.json safety and consistency invariants are incomplete");
  }
  if (!descriptor.trustedIdentityAliases?.includes("authorization") ||
      !descriptor.serverOwnedAliases?.includes("destinationMessageId")) {
    throw new Error("forward-message.json trusted and server-owned aliases are incomplete");
  }
  for (const [index, source] of ["input", "input", "server", "server"].entries()) {
    const field = descriptor.resultFields[index + 2];
    if (field?.source !== source) {
      throw new Error("forward-message.json result ownership is incomplete");
    }
  }
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`forward-message.json has unsupported ${label}`);
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
  const drifted = await generateForwardMessage(options);
  if (options.check && drifted.length > 0) {
    console.error(
      `Generated forward-message contracts are out of date:\n${drifted
        .map((path) => `- ${relative(options.root, resolve(options.root, path))}`)
        .join("\n")}\nRun npm run generate:forward-message.`,
    );
    process.exitCode = 1;
  } else if (options.check) {
    console.log("Generated forward-message contracts are up to date.");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
