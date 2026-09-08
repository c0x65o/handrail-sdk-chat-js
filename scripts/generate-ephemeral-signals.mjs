import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = resolve(repositoryRoot, "scripts/templates");
const descriptorPath = "contracts/realtime/ephemeral.json";
const outputPaths = {
  typescript: "src/contracts/generated/ephemeral-signals.ts",
  dart: "contracts/generated/dart/ephemeral_signals.dart",
};

export async function readEphemeralSignalsDescriptor(root = repositoryRoot) {
  const source = await readFile(resolve(root, descriptorPath), "utf8");
  const descriptor = JSON.parse(source);
  validateDescriptor(descriptor);
  return descriptor;
}

export function generateTypeScript(descriptor) {
  validateDescriptor(descriptor);
  return renderTemplate("ephemeral-signals.ts.tpl", replacements(descriptor));
}

export function generateDart(descriptor) {
  validateDescriptor(descriptor);
  return renderTemplate("ephemeral_signals.dart.tpl", replacements(descriptor));
}

export async function generateEphemeralSignals({
  check = false,
  root = repositoryRoot,
} = {}) {
  const descriptor = await readEphemeralSignalsDescriptor(root);
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

function replacements(descriptor) {
  const typing = descriptor.features.typing;
  const presence = descriptor.features.presence;
  return {
    DURABILITY: descriptor.durability,
    MAX_SEQUENCE: String(descriptor.sequence.maximum),
    MIN_SEQUENCE: String(descriptor.sequence.minimum),
    PRESENCE_EVENT_TYPE: presence.eventType,
    PRESENCE_MAX_TTL: String(presence.maximumTtlMs),
    PRESENCE_STATES_DART: presence.states.map((value) => `'${value}'`).join(", "),
    PRESENCE_STATES_TS: presence.states.map(JSON.stringify).join(", "),
    PRESENCE_STATE_UNION_TS: presence.states.map(JSON.stringify).join(" | "),
    PRIVATE_AUDIENCE: typing.scopes[0].audience,
    PRIVATE_VISIBILITY: typing.scopes[0].visibility,
    PUBLIC_AUDIENCE: typing.scopes[1].audience,
    PUBLIC_VISIBILITY: typing.scopes[1].visibility,
    TYPING_EVENT_TYPE: typing.eventType,
    TYPING_MAX_TTL: String(typing.maximumTtlMs),
    TYPING_STATES_DART: typing.states.map((value) => `'${value}'`).join(", "),
    TYPING_STATES_TS: typing.states.map(JSON.stringify).join(", "),
    TYPING_STATE_UNION_TS: typing.states.map(JSON.stringify).join(" | "),
    USER_PRIVATE_PREFIX: presence.scope.streamPrefix,
    USER_PRIVATE_SCOPE: presence.scope.type,
  };
}

function validateDescriptor(descriptor) {
  if (descriptor?.schemaVersion !== 1 || descriptor.durability !== "ephemeral") {
    throw new Error("ephemeral.json must define schemaVersion 1 ephemeral signals");
  }
  assertExact(descriptor.eventEnvelope?.fields, [
    "eventId", "protocolVersion", "tenantId", "streamId", "type",
    "occurredAt", "payload",
  ], "event envelope fields");
  if (descriptor.eventEnvelope.occurredAtMatches !== "payload.sentAt") {
    throw new Error("ephemeral.json must tie occurredAt to payload.sentAt");
  }
  assertExact(descriptor.provenanceFields, ["actorUserId", "deviceId", "sessionId"], "provenance fields");
  assertExact(descriptor.timestampFields, ["sentAt", "expiresAt"], "timestamp fields");
  if (
    descriptor.sequence?.minimum !== 1 ||
    descriptor.sequence?.maximum !== Number.MAX_SAFE_INTEGER ||
    descriptor.sequence?.scope !== "actor-device-session"
  ) {
    throw new Error("ephemeral.json must define positive safe actor-session sequences");
  }
  const typing = descriptor.features?.typing;
  const presence = descriptor.features?.presence;
  if (
    typing?.eventType !== "typing.signal" || typing.maximumTtlMs !== 15_000 ||
    typing.stream !== "conversation"
  ) throw new Error("ephemeral.json typing contract is invalid");
  assertExact(typing.states, ["start", "stop"], "typing states");
  if (
    JSON.stringify(typing.scopes) !== JSON.stringify([
      { type: "conversation", visibility: "private", audience: "members" },
      { type: "conversation", visibility: "public", audience: "active_participants" },
    ])
  ) throw new Error("ephemeral.json typing scopes are invalid");
  if (
    presence?.eventType !== "presence.signal" || presence.maximumTtlMs !== 120_000 ||
    presence.stream !== "user_private" || presence.scope?.type !== "user_private" ||
    presence.scope?.streamPrefix !== "user:"
  ) throw new Error("ephemeral.json presence contract is invalid");
  assertExact(presence.states, ["online", "away", "offline"], "presence states");
}

function assertExact(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`ephemeral.json must define exact ${label}: ${expected.join(", ")}`);
  }
}

function renderTemplate(name, replacements) {
  let template = readFileSync(resolve(templateRoot, name), "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    template = template.replaceAll(`{{${key}}}`, value);
  }
  if (/\{\{[A-Z_]+\}\}/.test(template)) {
    throw new Error(`${name} contains an unresolved generator placeholder`);
  }
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
  const drifted = await generateEphemeralSignals(options);
  if (options.check && drifted.length > 0) {
    console.error(
      `Generated ephemeral signal contracts are out of date:\n${drifted
        .map((path) => `- ${relative(options.root, resolve(options.root, path))}`)
        .join("\n")}\nRun npm run generate:ephemeral-signals.`,
    );
    process.exitCode = 1;
  } else if (options.check) {
    console.log("Generated ephemeral signal contracts are up to date.");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
