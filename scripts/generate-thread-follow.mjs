import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = resolve(repositoryRoot, "scripts/templates");
const descriptorPath = "contracts/http/thread-follow.json";
const outputPaths = {
  typescript: "src/contracts/thread-follow-mutation.ts",
  dart: "contracts/generated/dart/thread_follow_mutation.dart",
};

const expectedInputFields = [
  "operation",
  "intent",
  "target",
  "expectedFollowRevision",
  "idempotencyKey",
];
const expectedResultFields = [
  "operation",
  "intent",
  "reconciliationStatus",
  "target",
  "expectedFollowRevision",
  "idempotencyKey",
  "followRevision",
  "follow",
];
const expectedSources = ["manual", "reply", "mention"];
const expectedStates = [
  "manual_follow",
  "manual_unfollow",
  "reply_auto_follow",
  "mention_auto_follow",
];
const expectedStatuses = [
  "applied",
  "replayed",
  "already_requested_state",
  "follow_revision_conflict",
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

export async function readThreadFollowDescriptor(root = repositoryRoot) {
  const descriptor = JSON.parse(
    await readFile(resolve(root, descriptorPath), "utf8"),
  );
  validateDescriptor(descriptor);
  return descriptor;
}

export function generateTypeScript(descriptor) {
  validateDescriptor(descriptor);
  return render("thread-follow-mutation.ts.tpl", replacements(descriptor));
}

export function generateDart(descriptor) {
  validateDescriptor(descriptor);
  return render("thread_follow_mutation.dart.tpl", replacements(descriptor));
}

export async function generateThreadFollow({
  check = false,
  root = repositoryRoot,
} = {}) {
  const descriptor = await readThreadFollowDescriptor(root);
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
    PARENT_NORMALIZED: normalizedLines(descriptor.parentTargetAliases, '"'),
    SOURCE_NORMALIZED: normalizedLines(
      descriptor.callerAuthoredSourceAliases,
      '"',
    ),
    DART_TRUSTED_NORMALIZED: normalizedLines(
      descriptor.trustedContextAliases,
      "'",
    ),
    DART_PARENT_NORMALIZED: normalizedLines(
      descriptor.parentTargetAliases,
      "'",
    ),
    DART_SOURCE_NORMALIZED: normalizedLines(
      descriptor.callerAuthoredSourceAliases,
      "'",
    ),
    TRUSTED_PROPERTIES: descriptor.trustedContextAliases
      .map((alias) => `  readonly ${alias}?: never;`)
      .join("\n"),
    INPUT_KEYS: descriptor.inputFields
      .map((field) => `  "${field.name}",`)
      .join("\n"),
    RESULT_KEYS: descriptor.resultFields
      .map((field) => `  "${field.name}",`)
      .join("\n"),
    DART_INPUT_KEYS: descriptor.inputFields
      .map((field) => `  '${field.name}',`)
      .join("\n"),
    DART_RESULT_KEYS: descriptor.resultFields
      .map((field) => `  '${field.name}',`)
      .join("\n"),
  };
}

function validateDescriptor(descriptor) {
  if (
    descriptor?.schemaVersion !== 1 ||
    descriptor.method !== "PATCH" ||
    descriptor.path !== "/conversations/{threadId}/follow" ||
    descriptor.operation !== "set_thread_follow"
  ) {
    throw new Error(
      "thread-follow.json must define PATCH /conversations/{threadId}/follow schemaVersion 1",
    );
  }
  if (
    descriptor.identifierMaxUtf8Bytes !== 255 ||
    descriptor.idempotencyKeyMaxUtf8Bytes !== 255 ||
    descriptor.initialFollowRevision !== 0
  ) {
    throw new Error("thread follow identifier, idempotency, or revision bounds are unsupported");
  }
  equal(descriptor.intents, ["follow", "unfollow"], "explicit intents");
  equal(descriptor.target?.fields?.map((field) => field.name), ["type", "id"], "target fields");
  if (descriptor.target?.type !== "thread" || descriptor.target?.fields?.[0]?.value !== "thread") {
    throw new Error("thread-follow.json target must be specifically discriminated as thread");
  }
  equal(descriptor.inputFields?.map((field) => field.name), expectedInputFields, "input fields");
  equal(descriptor.resultFields?.map((field) => field.name), expectedResultFields, "result fields");
  equal(descriptor.followSources?.map((source) => source.name), expectedSources, "follow sources");
  equal(descriptor.canonicalStates?.map((state) => state.name), expectedStates, "canonical states");
  equal(descriptor.reconciliationStatuses?.map((status) => status.name), expectedStatuses, "reconciliation statuses");
  equal(
    descriptor.followSources?.map((source) => source.origin),
    ["explicitUserIntent", "serverDerivedParticipation", "serverDerivedParticipation"],
    "follow source origins",
  );
  equal(
    descriptor.reconciliationStatuses?.map((status) => [
      status.authoritativeState,
      status.revisionRule,
    ]),
    [
      ["requestedManualState", "expectedPlusOne"],
      ["requestedManualState", "expectedPlusOne"],
      ["requestedManualState", "equalsExpected"],
      ["currentPrivateFollowState", "differentFromExpected"],
    ],
    "reconciliation rules",
  );
  equal(
    descriptor.canonicalFollowFields?.map((field) => field.name),
    ["target", "isFollowing", "source", "updatedAt"],
    "canonical follow fields",
  );
  if (
    descriptor.canonicalStates?.[1]?.preservedAgainstAutoFollow !== true ||
    descriptor.canonicalStates?.slice(2).some((state) => state.serverDerived !== true) ||
    descriptor.autoFollowPolicy?.origin !== "server_policy" ||
    descriptor.autoFollowPolicy?.whenExplicitlyUnfollowed !== "preserve_explicit_unfollow" ||
    descriptor.autoFollowPolicy?.callerAuthored !== false ||
    descriptor.resultFields?.find((field) => field.name === "follow")?.delivery !== "affectedUserOnly"
  ) {
    throw new Error("thread-follow.json must define private canonical and server-derived auto-follow semantics");
  }
  for (const alias of requiredTrustedAliases) {
    if (!descriptor.trustedContextAliases?.includes(alias)) {
      throw new Error(`thread-follow.json is missing trusted alias ${alias}`);
    }
  }
  for (const aliases of [
    descriptor.trustedContextAliases,
    descriptor.parentTargetAliases,
    descriptor.callerAuthoredSourceAliases,
  ]) {
    if (!Array.isArray(aliases) || new Set(aliases.map(normalizeAlias)).size !== aliases.length) {
      throw new Error("thread-follow.json aliases must be present and normalize uniquely");
    }
  }
  if (
    Object.keys(descriptor.coherenceRules ?? {}).length !== 12 ||
    Object.values(descriptor.coherenceRules).some((value) => value !== true)
  ) {
    throw new Error("thread-follow.json coherence rules are incomplete");
  }
}

function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`thread-follow.json has unsupported ${label}`);
  }
}

function normalizeAlias(alias) {
  return alias.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function render(name, values) {
  let template = readFileSync(resolve(templateRoot, name), "utf8");
  for (const [key, value] of Object.entries(values)) {
    template = template.replaceAll(`{{${key}}}`, value);
  }
  if (/\{\{[A-Z_]+\}\}/.test(template)) {
    throw new Error(`${name} contains an unresolved placeholder`);
  }
  return template;
}

function parseArguments(args) {
  let check = false;
  let root = repositoryRoot;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--check") check = true;
    else if (args[index] === "--root" && args[index + 1]) {
      root = resolve(args[++index]);
    } else throw new Error(`Unknown argument: ${args[index]}`);
  }
  return { check, root };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const drifted = await generateThreadFollow(options);
  if (options.check && drifted.length > 0) {
    console.error(
      `Generated thread follow contracts are out of date:\n${drifted
        .map((path) => `- ${relative(options.root, resolve(options.root, path))}`)
        .join("\n")}\nRun npm run generate:thread-follow.`,
    );
    process.exitCode = 1;
  } else if (options.check) {
    console.log("Generated thread follow contracts are up to date.");
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
