import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = resolve(repositoryRoot, "scripts/templates");
const descriptorPath = "contracts/http/device-push-token.json";
const outputPaths = {
  typescript: "src/contracts/device-push-token.ts",
  dart: "contracts/generated/dart/device_push_token.dart",
};

const expectedOperations = ["register", "refresh", "unregister"];
const expectedProviders = ["apns", "fcm"];
const expectedPlatforms = ["ios", "android"];
const expectedEnvironments = ["sandbox", "production"];

export async function readDevicePushTokenDescriptor(root = repositoryRoot) {
  const descriptor = JSON.parse(await readFile(resolve(root, descriptorPath), "utf8"));
  validateDescriptor(descriptor);
  return descriptor;
}

export function generateTypeScript(descriptor) {
  validateDescriptor(descriptor);
  return render("device-push-token.ts.tpl", {
    METHOD: descriptor.method,
    PATH: descriptor.path,
    TOKEN_MAX: numberLiteral(descriptor.bounds.opaqueTokenMaxUtf8Bytes),
    REVISION_MIN: numberLiteral(descriptor.bounds.tokenRevisionMinimum),
    REVISION_MAX: numberLiteral(descriptor.bounds.tokenRevisionMaximum),
    IDEMPOTENCY_MAX: numberLiteral(descriptor.bounds.idempotencyKeyMaxUtf8Bytes),
    REDACTION: descriptor.redaction.replacement,
    TRUSTED_FIELDS_TS: typescriptSetValues(descriptor.forbiddenPublicFields.trustedIdentity),
    TOKEN_FIELDS_TS: typescriptSetValues(descriptor.redaction.recursiveTokenAliases),
  });
}

export function generateDart(descriptor) {
  validateDescriptor(descriptor);
  return render("device_push_token.dart.tpl", {
    METHOD: descriptor.method,
    PATH: descriptor.path,
    TOKEN_MAX: String(descriptor.bounds.opaqueTokenMaxUtf8Bytes),
    REVISION_MIN: String(descriptor.bounds.tokenRevisionMinimum),
    REVISION_MAX: String(descriptor.bounds.tokenRevisionMaximum),
    IDEMPOTENCY_MAX: String(descriptor.bounds.idempotencyKeyMaxUtf8Bytes),
    REDACTION: descriptor.redaction.replacement,
    TRUSTED_FIELDS_DART: dartSetValues(descriptor.forbiddenPublicFields.trustedIdentity),
    TOKEN_FIELDS_DART: dartSetValues(descriptor.redaction.recursiveTokenAliases),
  });
}

export async function generateDevicePushToken({ check = false, root = repositoryRoot } = {}) {
  const descriptor = await readDevicePushTokenDescriptor(root);
  const outputs = {
    [outputPaths.typescript]: generateTypeScript(descriptor),
    [outputPaths.dart]: generateDart(descriptor),
  };
  const drifted = [];
  for (const [path, generated] of Object.entries(outputs)) {
    const absolute = resolve(root, path);
    let existing;
    try { existing = await readFile(absolute, "utf8"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (existing === generated) continue;
    drifted.push(path);
    if (!check) {
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, generated, "utf8");
    }
  }
  return drifted;
}

export function validateDescriptor(descriptor) {
  if (descriptor?.schemaVersion !== 1 || descriptor.method !== "PUT" || descriptor.path !== "/devices/:deviceId/push-token") {
    throw new Error("device-push-token.json must define the version 1 PUT endpoint");
  }
  equal(Object.keys(descriptor.operations ?? {}), expectedOperations, "operations");
  equal(descriptor.providers, expectedProviders, "providers");
  equal(descriptor.platforms, expectedPlatforms, "platforms");
  equal(descriptor.environments, expectedEnvironments, "environments");
  equal(descriptor.coherentProviderTargets, [
    { platform: "ios", provider: "apns", environments: ["sandbox", "production"] },
    { platform: "android", provider: "fcm", environments: ["production"] },
  ], "provider targets");
  equal(descriptor.operations.register.inputFields, ["operation", "deviceId", "platform", "provider", "environment", "token", "tokenRevision", "idempotencyKey"], "register fields");
  equal(descriptor.operations.refresh.inputFields, descriptor.operations.register.inputFields, "refresh fields");
  equal(descriptor.operations.unregister.inputFields, ["operation", "intent", "deviceId", "tokenRevision", "idempotencyKey"], "unregister fields");
  if (descriptor.operations.unregister.intent !== "unregister" || descriptor.operations.unregister.resultStatus !== "unregistered") {
    throw new Error("unregister must carry the explicit unregister intent and canonical status");
  }
  const bounds = descriptor.bounds ?? {};
  for (const [name, value] of Object.entries(bounds)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`device-push-token.json bound ${name} must be a positive safe integer`);
  }
  if (bounds.tokenRevisionMinimum !== 1 || bounds.tokenRevisionMaximum <= bounds.tokenRevisionMinimum || descriptor.revisionPolicy?.integer !== true || descriptor.revisionPolicy?.strictlyGreaterThanCurrent !== true) {
    throw new Error("token revisions must be bounded integers strictly greater than current state");
  }
  equal(descriptor.reconciliationStatuses, ["applied", "replayed"], "reconciliation statuses");
  equal(descriptor.canonicalResult?.fields, ["operation", "reconciliationStatus", "idempotencyKey", "devicePushToken"], "canonical result fields");
  equal(descriptor.canonicalResult?.stateFields, ["deviceId", "status", "platform", "provider", "environment", "tokenRevision", "updatedAt"], "canonical state fields");
  if (descriptor.canonicalResult?.serverAuthored !== true || descriptor.canonicalResult?.containsOpaqueToken !== false) {
    throw new Error("canonical result must be server-authored and exclude opaque tokens");
  }
  if (descriptor.redaction?.replacement !== "[REDACTED]" || descriptor.redaction?.diagnosticSafeRepresentations !== true || !descriptor.redaction.recursiveTokenAliases.includes("token")) {
    throw new Error("opaque token redaction policy is incomplete");
  }
  if (!Array.isArray(descriptor.forbiddenPublicFields?.trustedIdentity) || descriptor.forbiddenPublicFields.trustedIdentity.length < 20) {
    throw new Error("trusted identity aliases are incomplete");
  }
  if (Object.keys(descriptor.coherenceRules ?? {}).length !== 6 || Object.values(descriptor.coherenceRules).some((value) => value !== true)) {
    throw new Error("device push-token coherence rules are incomplete");
  }
}

function render(name, values) {
  let output = readFileSync(resolve(templateRoot, name), "utf8");
  for (const [key, value] of Object.entries(values)) output = output.replaceAll(`{{${key}}}`, value);
  if (/\{\{[A-Z_]+\}\}/.test(output)) throw new Error(`${name} contains an unresolved placeholder`);
  return output;
}
function normalize(value) { return value.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase(); }
function typescriptSetValues(values) { return [...new Set(values.map(normalize))].map((value) => `  ${JSON.stringify(value)},`).join("\n"); }
function dartSetValues(values) { return [...new Set(values.map(normalize))].map((value) => `  '${value}',`).join("\n"); }
function numberLiteral(value) { return value >= 1000 ? value.toLocaleString("en-US").replaceAll(",", "_") : String(value); }
function equal(actual, expected, label) { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`device-push-token.json has unsupported ${label}`); }
function parseArguments(args) {
  let check = false;
  let root = repositoryRoot;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--check") check = true;
    else if (args[index] === "--root" && args[index + 1]) root = resolve(args[++index]);
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  return { check, root };
}
async function main() {
  const options = parseArguments(process.argv.slice(2));
  const drifted = await generateDevicePushToken(options);
  if (options.check && drifted.length > 0) {
    console.error(`Generated device push-token contracts are out of date:\n${drifted.map((path) => `- ${relative(options.root, resolve(options.root, path))}`).join("\n")}\nRun npm run generate:device-push-token.`);
    process.exitCode = 1;
  } else if (options.check) console.log("Generated device push-token contracts are up to date.");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
