import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = resolve(repositoryRoot, "scripts/templates");
const descriptorPath = "contracts/http/thread-list.json";
const outputPaths = {
  typescript: "src/contracts/thread-list.ts",
  dart: "contracts/generated/dart/thread_list.dart",
};
export async function readThreadListDescriptor(root = repositoryRoot) {
  const descriptor = JSON.parse(await readFile(resolve(root, descriptorPath), "utf8"));
  validateDescriptor(descriptor);
  return descriptor;
}

export function generateTypeScript(descriptor) {
  validateDescriptor(descriptor);
  return render("thread-list.ts.tpl", replacements(descriptor));
}

export function generateDart(descriptor) {
  validateDescriptor(descriptor);
  return render("thread_list.dart.tpl", replacements(descriptor));
}

export async function generateThreadList({ check = false, root = repositoryRoot } = {}) {
  const descriptor = await readThreadListDescriptor(root);
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
  // Field ownership stays in the canonical model/snapshot descriptors.
  const conversation = JSON.parse(readFileSync(resolve(repositoryRoot, 'contracts/models/conversation.json'), 'utf8'));
  const snapshots = JSON.parse(readFileSync(resolve(repositoryRoot, 'contracts/http/conversations.json'), 'utf8'));
  const thread = conversation.variants.find(variant => variant.wireType === 'thread');
  const threadFields = ['type', ...conversation.sharedFields.map(field => field.name),
    ...conversation.archiveState.archived.map(field => field.name),
    ...thread.fields.filter(field => field.presence !== 'never').map(field => field.name),
    ...snapshots.summaryEnrichment.map(field => field.name),
    ...snapshots.detailEnrichment.filter(field => field.name === 'currentPreference').map(field => field.name)];
  const list = values => values.map(value => JSON.stringify(value)).join(', ');
  return {
    HASH: createHash('sha256').update(JSON.stringify(d)).digest('hex'),
    PATH: d.endpoint.path,
    THREAD_FIELDS: list(threadFields),
    REQUEST_REQUIRED: list(d.request.required), REQUEST_OPTIONAL: list(d.request.optional),
    DEFAULT_VIEW: d.request.defaultView, DEFAULT_LIMIT: String(d.request.defaultLimit),
    MIN_LIMIT: String(d.request.minimumLimit), MAX_LIMIT: String(d.request.maximumLimit),
    MAX_ID: String(d.request.maxIdentifierUtf8Bytes), MAX_CURSOR: String(d.cursor.maximumLength),
    PREFIX: d.cursor.prefix, CURSOR_FIELDS: list(d.cursor.fields),
    RESULT_REQUIRED: list(d.response.required), RESULT_OPTIONAL: list(d.response.optional),
    ITEM_FIELDS: list(d.response.itemFields),
  };
}
// Pin supported semantics. Any descriptor change requires reviewing both templates.
function validateDescriptor(d) {
  if (createHash('sha256').update(JSON.stringify(d)).digest('hex') !== 'ffedf79a5d4cc3d0f7e6f515de529c829c4d5dac60c0552d8f388c487bbee38c') {
    throw new Error('Unsupported thread-list descriptor; update both language templates and the supported descriptor hash');
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
  const drifted = await generateThreadList(options);
  if (options.check && drifted.length > 0) {
    console.error(`Generated thread list contracts are out of date:\n${drifted.map((path) => `- ${relative(options.root, resolve(options.root, path))}`).join("\n")}\nRun npm run generate:thread-list.`);
    process.exitCode = 1;
  } else if (options.check) console.log("Generated thread list contracts are up to date.");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
