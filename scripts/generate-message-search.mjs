import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = resolve(repositoryRoot, "scripts/templates");
const descriptorPath = "contracts/http/message-search.json";
const outputPaths = {
  typescript: "src/contracts/message-search.ts",
  dart: "contracts/generated/dart/message_search.dart",
};

const expectedAliases = [
  "tenant", "tenantId", "organization", "organizationId", "actor", "actorId",
  "actorContext", "actorUserId", "currentActor", "currentActorId", "currentUser",
  "currentUserId", "user", "userId", "principal", "principalId", "subject",
  "subjectId", "authenticatedUser", "authenticatedUserId", "identity", "session",
  "sessionId", "auth", "authorization", "role", "roles", "capability",
  "capabilities", "permission", "permissions",
];

export async function readMessageSearchDescriptor(root = repositoryRoot) {
  const source = await readFile(resolve(root, descriptorPath), "utf8");
  const descriptor = JSON.parse(source);
  validateDescriptor(descriptor);
  return descriptor;
}

export function generateTypeScript(descriptor) {
  validateDescriptor(descriptor);
  return renderTemplate("message-search.ts.tpl", replacements(descriptor, '"'));
}

export function generateDart(descriptor) {
  validateDescriptor(descriptor);
  return renderTemplate("message_search.dart.tpl", replacements(descriptor, "'"));
}

export async function generateMessageSearch({ check = false, root = repositoryRoot } = {}) {
  const descriptor = await readMessageSearchDescriptor(root);
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
  const aliases = descriptor.trustedIdentityAliases.map(normalizeAlias);
  return {
    MIN_PAGE_SIZE: descriptor.request.pageSize.minimum,
    MAX_PAGE_SIZE: descriptor.request.pageSize.maximum,
    MAX_CURSOR_LENGTH: descriptor.request.cursor.maximumLength,
    MAX_IDENTIFIER_LENGTH: descriptor.identifiers.maximumLength,
    MAX_TITLE_LENGTH: descriptor.text.titleMaximumLength,
    MAX_SNIPPET_LENGTH: descriptor.text.snippetMaximumLength,
    MAX_AUTHOR_DISPLAY_NAME_LENGTH: descriptor.text.authorDisplayNameMaximumLength,
    TRUSTED_IDENTITY_FIELDS: aliases.map((alias) => `  ${quoted(alias)},`).join("\n"),
    TRUSTED_IDENTITY_PROPERTIES: descriptor.trustedIdentityAliases
      .map((alias) => `  readonly ${alias}?: never;`).join("\n"),
  };
}

function validateDescriptor(descriptor) {
  if (descriptor?.schemaVersion !== 1 || descriptor.method !== "POST" || descriptor.path !== "/messages/search") {
    throw new Error("message-search.json must define schemaVersion 1 POST /messages/search");
  }
  assertEqual(descriptor.request?.fields, ["query", "filters", "pageSize", "cursor"], "request fields");
  assertEqual(descriptor.request?.queryNormalization, ["nfc", "trim", "collapse_whitespace"], "query normalization");
  assertEqual(descriptor.request?.filters?.fields, ["conversationIds", "authorUserIds", "sentAfter", "sentBefore"], "filter fields");
  assertEqual(descriptor.response?.fields, ["hits", "nextCursor"], "response fields");
  assertEqual(descriptor.hits?.map((hit) => hit.type), ["conversation", "message"], "hit variants");
  assertEqual(descriptor.trustedIdentityAliases, expectedAliases, "trusted identity aliases");
  if (
    descriptor.request.queryMustBeNonBlank !== true ||
    descriptor.request.filters.identifiersMustBeUnique !== true ||
    descriptor.request.filters.sentRange !== "sentAfter_strictly_before_sentBefore" ||
    descriptor.request.pageSize.minimum !== 1 ||
    descriptor.request.pageSize.maximum !== 100 ||
    descriptor.request.cursor.opaque !== true ||
    descriptor.request.cursor.nonBlank !== true ||
    descriptor.request.cursor.maximumLength !== 2048 ||
    JSON.stringify(descriptor.request.cursor) !== JSON.stringify(descriptor.response.cursor) ||
    descriptor.response.order !== "server_relevance_order" ||
    descriptor.response.hitIdentityMustBeUnique !== true
  ) {
    throw new Error("message-search.json request, pagination, or response invariants are incomplete");
  }
  if (
    descriptor.identifiers?.maximumLength !== 255 ||
    descriptor.text?.snippetFormat !== "plain_text" ||
    descriptor.text?.titleMaximumLength !== 512 ||
    descriptor.text?.snippetMaximumLength !== 4096 ||
    descriptor.text?.authorDisplayNameMaximumLength !== 256
  ) {
    throw new Error("message-search.json transport bounds are unsupported");
  }
  if (
    descriptor.authorization?.identityComesFromTrustedContext !== true ||
    descriptor.authorization?.filterConversationIdsMustBeAuthorized !== true ||
    descriptor.authorization?.hitConversationIdsMustBeAuthorized !== true
  ) {
    throw new Error("message-search.json authorization boundaries are incomplete");
  }
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`message-search.json has unsupported ${label}`);
  }
}

function normalizeAlias(alias) {
  return alias.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function renderTemplate(name, values) {
  let template = readFileSync(resolve(templateRoot, name), "utf8");
  for (const [key, value] of Object.entries(values)) template = template.replaceAll(`{{${key}}}`, value);
  if (/\{\{[A-Z_]+\}\}/.test(template)) throw new Error(`${name} contains an unresolved generator placeholder`);
  return template;
}

function parseArguments(args) {
  let check = false;
  let root = repositoryRoot;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") check = true;
    else if (argument === "--root") {
      const value = args[index + 1];
      if (!value) throw new Error("--root requires a path");
      root = resolve(value);
      index += 1;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return { check, root };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const drifted = await generateMessageSearch(options);
  if (options.check && drifted.length > 0) {
    console.error(`Generated message search contracts are out of date:\n${drifted.map((path) => `- ${relative(options.root, resolve(options.root, path))}`).join("\n")}\nRun npm run generate:message-search.`);
    process.exitCode = 1;
  } else if (options.check) console.log("Generated message search contracts are up to date.");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
