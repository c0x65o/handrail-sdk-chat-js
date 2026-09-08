import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const descriptorPath = "contracts/http/read-cursor.json";
const typescriptTemplatePath = "scripts/templates/read-cursor-mutation.ts.tpl";
const dartTemplatePath = "scripts/templates/read_cursor_mutation.dart.tpl";
const outputPaths = {
  typescript: "src/contracts/read-cursor-mutation.ts",
  dart: "contracts/generated/dart/read_cursor_mutation.dart",
};

const expectedAliases = [
  "tenant", "tenantId", "organization", "organizationId", "actor",
  "actorId", "actorContext", "actorUserId", "currentActor",
  "currentActorId", "currentUserId", "user", "userId", "principal",
  "principalId", "subject", "subjectId", "authenticatedUser",
  "authenticatedUserId", "identity", "session", "sessionId", "auth",
  "authorization", "roles",
];

export async function readReadCursorDescriptor(root = repositoryRoot) {
  const descriptor = JSON.parse(
    await readFile(resolve(root, descriptorPath), "utf8"),
  );
  validateDescriptor(descriptor);
  return descriptor;
}

export async function generateTypeScript(descriptor, root = repositoryRoot) {
  validateDescriptor(descriptor);
  const template = await readFile(resolve(root, typescriptTemplatePath), "utf8");
  return template
    .replaceAll("{{METHOD}}", descriptor.method)
    .replaceAll("{{PATH}}", descriptor.path)
    .replaceAll("{{EVENT_TYPE}}", descriptor.event.type)
    .replaceAll("{{EVENT_KIND}}", descriptor.event.kind)
    .replaceAll("__MAX_IDEMPOTENCY_UTF8_BYTES__",
      String(descriptor.idempotencyKey.maximumUtf8Bytes));
}

export async function generateDart(descriptor, root = repositoryRoot) {
  validateDescriptor(descriptor);
  const template = await readFile(resolve(root, dartTemplatePath), "utf8");
  return template
    .replaceAll("__MAX_IDEMPOTENCY_UTF8_BYTES__", String(descriptor.idempotencyKey.maximumUtf8Bytes))
    .replaceAll("{{METHOD}}", descriptor.method)
    .replaceAll("{{PATH}}", descriptor.path)
    .replaceAll("{{EVENT_TYPE}}", descriptor.event.type)
    .replaceAll("{{EVENT_KIND}}", descriptor.event.kind);
}

export async function generateReadCursor({ root = repositoryRoot, check = false } = {}) {
  const descriptor = await readReadCursorDescriptor(root);
  const outputs = {
    [outputPaths.typescript]: await generateTypeScript(descriptor, root),
    [outputPaths.dart]: await generateDart(descriptor, root),
  };
  const drifted = [];
  for (const [path, content] of Object.entries(outputs)) {
    const absolutePath = resolve(root, path);
    let current;
    try {
      current = await readFile(absolutePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (current === content) continue;
    drifted.push(path);
    if (!check) {
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf8");
    }
  }
  return drifted;
}

export function validateDescriptor(descriptor) {
  if (descriptor?.schemaVersion !== 1 || descriptor.method !== "PATCH" ||
      descriptor.path !== "/conversations/:conversationId/read-cursor") {
    throw new Error("read-cursor.json must define the version 1 PATCH endpoint");
  }
  assertNames(descriptor.operations, ["mark_read", "mark_unread"], "operations");
  const [markRead, markUnread] = descriptor.operations;
  if (markRead.sequenceField !== "throughSequence" || markRead.minimum !== 0 ||
      markRead.mustNotExceed !== "latestSequence" ||
      markRead.mustNotPrecede !== "currentReadState.lastReadSequence" ||
      markRead.clearsManualUnread !== true) {
    throw new Error("mark_read must define monotonic throughSequence semantics");
  }
  if (markUnread.sequenceField !== "fromSequence" || markUnread.minimum !== 1 ||
      markUnread.mustNotExceed !== "min(currentReadState.lastReadSequence, latestSequence)" ||
      markUnread.preservesMonotonicCursor !== true) {
    throw new Error("mark_unread must define bounded fromSequence semantics");
  }
  if (descriptor.idempotencyKey?.required !== true ||
      descriptor.idempotencyKey?.nonBlank !== true ||
      descriptor.idempotencyKey?.maximumUtf8Bytes !== 255) {
    throw new Error("idempotency keys must be nonblank and bounded to 255 UTF-8 bytes");
  }
  assertNames(descriptor.inputFields,
    ["operation", "conversationId", "sequence", "idempotencyKey"], "input fields");
  assertNames(descriptor.readStateFields,
    ["conversationId", "userId", "lastReadSequence", "manualUnreadFromSequence", "updatedAt"],
    "read-state fields");
  if (!descriptor.readStateFields.every((field) => field.source === "server")) {
    throw new Error("canonical read state must be server-authored");
  }
  assertNames(descriptor.resultFields,
    ["operation", "reconciliationStatus", "idempotencyKey", "conversationId", "readState", "latestSequence", "unreadCount"],
    "result fields");
  assertNames(descriptor.reconciliationStatuses, ["applied", "replayed"], "statuses");
  if (descriptor.resultFields.find((field) => field.name === "unreadCount")?.type !== "derivedUnreadCount") {
    throw new Error("unreadCount must be derived from canonical read state");
  }
  if (descriptor.event?.type !== "conversation.read_cursor_updated" ||
      descriptor.event?.kind !== "conversation_read_cursor" ||
      descriptor.event?.durability !== "durable" ||
      descriptor.event?.visibility !== "private_user_stream" ||
      descriptor.event?.streamId !== "user:${actorUserId}") {
    throw new Error("read-cursor events must be durable and user-private");
  }
  assertNames(descriptor.event.fields,
    ["kind", "actorUserId", "operation", "conversationId", "readState", "latestSequence", "unreadCount"],
    "event fields");
  if (JSON.stringify(descriptor.trustedContextAliases) !== JSON.stringify(expectedAliases)) {
    throw new Error("read-cursor.json trusted aliases are incomplete");
  }
}

function assertNames(values, expected, label) {
  const names = values?.map((value) => value?.name);
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`read-cursor.json must define exactly these ${label}: ${expected.join(", ")}`);
  }
}

function parseArguments(args) {
  let check = false;
  let root = repositoryRoot;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") check = true;
    else if (argument === "--root") {
      if (!args[index + 1]) throw new Error("--root requires a path");
      root = resolve(args[++index]);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return { check, root };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const drifted = await generateReadCursor(options);
  if (options.check && drifted.length > 0) {
    console.error(`Generated read-cursor contracts are out of date:\n${drifted
      .map((path) => `- ${relative(options.root, resolve(options.root, path))}`)
      .join("\n")}\nRun npm run generate:read-cursor.`);
    process.exitCode = 1;
  } else if (options.check) console.log("Generated read-cursor contracts are up to date.");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
