import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const descriptorPath = "contracts/http/draft.json";
const typescriptTemplatePath = "scripts/templates/draft-mutation.ts.tpl";
const dartTemplatePath = "scripts/templates/draft_mutation.dart.tpl";
const outputPaths = {
  typescript: "src/contracts/draft-mutation.ts",
  dart: "contracts/generated/dart/draft_mutation.dart",
};

const expectedAliases = [
  "tenant", "tenantId", "organization", "organizationId", "actor",
  "actorId", "actorContext", "actorUserId", "currentActor",
  "currentActorId", "currentUser", "currentUserId", "user", "userId",
  "principal", "principalId", "subject", "subjectId", "authenticatedUser",
  "authenticatedUserId", "identity", "session", "sessionId", "auth",
  "authorization", "role", "roles", "capability", "capabilities",
  "permission", "permissions",
];

export async function readDraftDescriptor(root = repositoryRoot) {
  const descriptor = JSON.parse(
    await readFile(resolve(root, descriptorPath), "utf8"),
  );
  validateDescriptor(descriptor);
  return descriptor;
}

export async function generateTypeScript(descriptor, root = repositoryRoot) {
  validateDescriptor(descriptor);
  const template = await readFile(resolve(root, typescriptTemplatePath), "utf8");
  return applyDescriptor(template, descriptor);
}

export async function generateDart(descriptor, root = repositoryRoot) {
  validateDescriptor(descriptor);
  const template = await readFile(resolve(root, dartTemplatePath), "utf8");
  return applyDescriptor(template, descriptor);
}

function applyDescriptor(template, descriptor) {
  return template
    .replaceAll("{{METHOD}}", descriptor.method)
    .replaceAll("{{PATH}}", descriptor.path)
    .replaceAll("{{OPERATION}}", descriptor.operation)
    .replaceAll("{{EVENT_TYPE}}", descriptor.event.type)
    .replaceAll("__MAX_TEXT_UTF8_BYTES__",
      String(descriptor.content.maximumTextUtf8Bytes))
    .replaceAll("__MAX_IDENTIFIER_UTF8_BYTES__",
      String(descriptor.identifiers.maximumUtf8Bytes))
    .replaceAll("__MAX_IDEMPOTENCY_UTF8_BYTES__",
      String(descriptor.idempotencyKey.maximumUtf8Bytes))
    .replaceAll("__MAX_MENTION_REFERENCES__",
      String(descriptor.content.maximumMentionReferences))
    .replaceAll("__MAX_ATTACHMENT_REFERENCES__",
      String(descriptor.content.maximumAttachmentReferences));
}

export async function generateDraft({ root = repositoryRoot, check = false } = {}) {
  const descriptor = await readDraftDescriptor(root);
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
      descriptor.path !== "/conversations/:conversationId/draft" ||
      descriptor.operation !== "synchronize_draft") {
    throw new Error("draft.json must define the version 1 synchronize-draft PATCH endpoint");
  }
  assertNames(descriptor.intents, ["replace", "clear"], "intents");
  const [replace, clear] = descriptor.intents;
  if (replace.requiresContent !== true || replace.canonicalKind !== "replaced" ||
      clear.requiresContent !== false || clear.canonicalKind !== "clear_tombstone") {
    throw new Error("draft intents must define explicit replace and clear semantics");
  }
  if (JSON.stringify(descriptor.content?.formats) !== JSON.stringify(["plain", "markdown"]) ||
      descriptor.content?.maximumTextUtf8Bytes !== 65_536 ||
      descriptor.content?.mentionReferenceModel !== "MessageMention" ||
      JSON.stringify(descriptor.content?.mentionReferenceTypes) !==
        JSON.stringify(["user", "conversation", "entity"]) ||
      descriptor.content?.maximumMentionReferences !== 64 ||
      descriptor.content?.uniqueMentionReferences !== true ||
      descriptor.content?.attachmentReferenceField !== "attachmentId" ||
      descriptor.content?.maximumAttachmentReferences !== 32 ||
      descriptor.content?.uniqueAttachmentReferences !== true) {
    throw new Error(
      "draft content must be safe, bounded, and uniquely reference canonical mentions and attachments",
    );
  }
  if (descriptor.content?.replyReference?.field !== "replyTo" ||
      descriptor.content.replyReference.model !== "MessageReplyReference" ||
      descriptor.content.replyReference.presence !== "optional" ||
      descriptor.content.replyReference.sendField !== "replyTo") {
    throw new Error("draft replyTo must be optional MessageReplyReference composition metadata for top-level send replyTo");
  }
  if (descriptor.identifiers?.maximumUtf8Bytes !== 255 ||
      descriptor.identifiers?.nonBlank !== true ||
      descriptor.identifiers?.trimmed !== true ||
      descriptor.identifiers?.nfcNormalized !== true ||
      descriptor.identifiers?.safeUnicode !== true) {
    throw new Error("draft identifiers must be normalized and bounded to 255 UTF-8 bytes");
  }
  if (descriptor.baseRevision?.minimum !== 0 ||
      descriptor.baseRevision?.mustBeSafeInteger !== true ||
      descriptor.baseRevision?.mustBeAdvanceable !== true) {
    throw new Error("baseRevision must be a nonnegative advanceable safe integer");
  }
  if (descriptor.deviceMutationId?.required !== true ||
      descriptor.deviceMutationId?.source !== "client" ||
      descriptor.idempotencyKey?.required !== true ||
      descriptor.idempotencyKey?.nonBlank !== true ||
      descriptor.idempotencyKey?.maximumUtf8Bytes !== 255) {
    throw new Error("device mutation and idempotency identities must be explicit and bounded");
  }
  assertNames(descriptor.inputFields, [
    "operation", "intent", "conversationId", "baseRevision",
    "deviceMutationId", "idempotencyKey", "content",
  ], "input fields");
  assertNames(descriptor.canonicalStates, ["replaced", "clear_tombstone"],
    "canonical states");
  if (descriptor.canonicalStates[0].content !== "DraftContent" ||
      descriptor.canonicalStates[1].content !== null) {
    throw new Error("canonical draft states must retain replaced content or a null tombstone");
  }
  assertNames(descriptor.reconciliationStatuses,
    ["applied", "replayed", "stale_base"], "reconciliation statuses");
  if (descriptor.reconciliationStatuses[0].requestedStateMustMatch !== true ||
      descriptor.reconciliationStatuses[1].requestedStateMustMatch !== true ||
      descriptor.reconciliationStatuses[2].canonicalRevisionMustExceedBase !== true) {
    throw new Error("draft reconciliation semantics are incomplete");
  }
  assertNames(descriptor.resultFields, [
    "operation", "intent", "reconciliationStatus", "conversationId",
    "baseRevision", "deviceMutationId", "idempotencyKey",
    "canonicalRevision", "canonicalUpdatedAt", "draft",
  ], "result fields");
  for (const name of [
    "operation", "intent", "conversationId", "baseRevision",
    "deviceMutationId", "idempotencyKey",
  ]) {
    if (descriptor.resultFields.find((field) => field.name === name)?.echo !== "exact") {
      throw new Error(`draft result ${name} must be an exact request echo`);
    }
  }
  if (descriptor.event?.type !== "conversation.draft.updated" ||
      descriptor.event?.durability !== "durable" ||
      descriptor.event?.visibility !== "private_user_stream" ||
      descriptor.event?.streamId !== "user:${actorUserId}") {
    throw new Error("draft updates must use the actor's durable private user stream");
  }
  assertNames(descriptor.event.payloadFields,
    ["actorUserId", "input", "result"], "event payload fields");
  if (JSON.stringify(descriptor.trustedContextAliases) !== JSON.stringify(expectedAliases)) {
    throw new Error("draft.json trusted context aliases are incomplete");
  }
}

function assertNames(values, expected, label) {
  const names = values?.map((value) => value?.name);
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`draft.json must define exactly these ${label}: ${expected.join(", ")}`);
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
  const drifted = await generateDraft(options);
  if (options.check && drifted.length > 0) {
    console.error(`Generated draft contracts are out of date:\n${drifted
      .map((path) => `- ${relative(options.root, resolve(options.root, path))}`)
      .join("\n")}\nRun npm run generate:draft.`);
    process.exitCode = 1;
  } else if (options.check) console.log("Generated draft contracts are up to date.");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
