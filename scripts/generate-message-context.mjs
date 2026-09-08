import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = resolve(repositoryRoot, "scripts/templates");
const descriptorPath = "contracts/http/message-context.json";
const outputPaths = {
  typescript: "src/contracts/message-context.ts",
  dart: "contracts/generated/dart/message_context.dart",
};
export async function readMessageContextDescriptor(root = repositoryRoot) {
  const descriptor = JSON.parse(await readFile(resolve(root, descriptorPath), "utf8"));
  validateDescriptor(descriptor);
  return descriptor;
}

export function generateTypeScript(descriptor) {
  validateDescriptor(descriptor);
  return render("message-context.ts.tpl", replacements(descriptor));
}

export function generateDart(descriptor) {
  validateDescriptor(descriptor);
  return render("message_context.dart.tpl", replacements(descriptor));
}

export async function generateMessageContext({ check = false, root = repositoryRoot } = {}) {
  const descriptor = await readMessageContextDescriptor(root);
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

function replacements(d) {
  return {
    PATH: d.endpoint.path,
    REQUEST_KEYS: d.request.fields.map(key => JSON.stringify(key)).join(", "),
    AVAILABLE_KEYS: d.response.statuses[0].fields.map(key => JSON.stringify(key)).join(", "),
    UNAVAILABLE_KEYS: d.response.statuses[2].fields.map(key => JSON.stringify(key)).join(", "),
    MAX_ID_BYTES: String(d.request.maxIdentifierUtf8Bytes),
    MIN_SEQUENCE: String(d.response.sequence.minimum),
    MAX_SEQUENCE: String(d.response.sequence.maximum),
  };
}

// Reject semantic descriptor changes until both language templates implement them.
function validateDescriptor(d) {
  const expected = {
  "schemaVersion": 1,
  "endpoint": {
    "method": "GET",
    "path": "/conversations/:conversationId/messages/:messageId/context"
  },
  "request": {
    "fields": ["conversationId", "messageId"],
    "identifiers": "canonical_types_nonempty_unpadded_control_free",
    "maxIdentifierUtf8Bytes": 255,
    "queryFields": [],
    "body": "none"
  },
  "response": {
    "name": "MessageContextResult",
    "discriminant": "status",
    "identityFields": ["conversationId", "messageId"],
    "maxMessages": 1,
    "statuses": [
      { "status": "available", "fields": ["status", "conversationId", "messageId", "sequence", "message"], "message": "canonical_active_message" },
      { "status": "deleted", "fields": ["status", "conversationId", "messageId", "sequence", "message"], "message": "canonical_deleted_message_with_null_content" },
      { "status": "unavailable", "fields": ["status", "conversationId", "messageId"], "message": "forbidden" }
    ],
    "rejectUnknownFields": true,
    "requestIdentityMustMatch": true,
    "messageIdentityMustMatch": true,
    "sequence": { "type": "MessageSequence", "minimum": 1, "maximum": 9007199254740991, "equals": "message.sequence", "scope": "conversation", "timelineCursorExclusive": true }
  },
  "authorization": {
    "authority": "trusted_session_tenant_actor_and_current_server_access_checks",
    "identifiersGrantAccess": false,
    "crossConversationLookup": false,
    "absentAndInaccessible": "identical_unavailable_result_echoing_only_requested_identity",
    "deletedRequiresAccess": true
  },
  "transport": {
    "resultHttpStatus": 200,
    "unavailableIsTransportFailure": false,
    "retryableFailures": "network_timeout_rate_limit_and_transient_server_errors_remain_transport_errors",
    "malformedResponses": "throw_parse_error_never_coerce_to_unavailable",
    "execution": "out_of_scope"
  },
  "pagination": {
    "descriptor": "contracts/http/message-timeline.json",
    "older": "before_target_sequence_exclusive",
    "newer": "after_target_sequence_exclusive",
    "targetReturnedSeparately": true,
    "changesExistingRoutes": false
  }
};
  if (JSON.stringify(d) !== JSON.stringify(expected)) {
    throw new Error("Unsupported message-context descriptor; update both parsers with contract changes");
  }
}
function render(name, values) {
  let template = readFileSync(resolve(templateRoot, name), "utf8");
  for (const [key, value] of Object.entries(values)) template = template.replaceAll(`{{${key}}}`, value);
  if (/\{\{[A-Z_]+\}\}/.test(template)) throw new Error(`${name} contains an unresolved placeholder`);
  return template;
}
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
  const drifted = await generateMessageContext(options);
  if (options.check && drifted.length > 0) {
    console.error(`Generated message context contracts are out of date:\n${drifted.map((path) => `- ${relative(options.root, resolve(options.root, path))}`).join("\n")}\nRun npm run generate:message-context.`);
    process.exitCode = 1;
  } else if (options.check) console.log("Generated message context contracts are up to date.");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
