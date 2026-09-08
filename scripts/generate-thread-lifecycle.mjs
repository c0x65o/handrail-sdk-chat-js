import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = resolve(repositoryRoot, "scripts/templates");
const descriptorPath = "contracts/http/thread-lifecycle.json";
const outputPaths = {
  typescript: "src/contracts/thread-lifecycle.ts",
  dart: "contracts/generated/dart/thread_lifecycle.dart",
};
export async function readThreadLifecycleDescriptor(root = repositoryRoot) {
  const descriptor = JSON.parse(await readFile(resolve(root, descriptorPath), "utf8"));
  validateDescriptor(descriptor);
  return descriptor;
}

export function generateTypeScript(descriptor) {
  validateDescriptor(descriptor);
  return render("thread-lifecycle.ts.tpl", replacements(descriptor));
}

export function generateDart(descriptor) {
  validateDescriptor(descriptor);
  return render("thread_lifecycle.dart.tpl", replacements(descriptor));
}

export async function generateThreadLifecycle({ check = false, root = repositoryRoot } = {}) {
  const descriptor = await readThreadLifecycleDescriptor(root);
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
  const list = values => values.map(value => JSON.stringify(value)).join(', ');
  return {
    HASH: createHash('sha256').update(JSON.stringify(d)).digest('hex'),
    OPERATION: d.operation, PATH: d.endpoint.path, FEATURE: d.feature.name,
    INPUT_KEYS: list(d.inputFields), RESULT_KEYS: list(d.resultFields),
    INTENTS: list(d.intents), STATUSES: list(d.reconciliationStatuses.map(s => s.name)),
    MAX_REVISION: String(d.maxSafeRevision),
    TRUSTED: list(d.trustedContextAliases.map(s => s.replaceAll(/[^a-zA-Z0-9]/g, '').toLowerCase())),
    TS_TRANSITIONS: JSON.stringify(d.transitions),
    DART_TRANSITIONS: JSON.stringify(d.transitions).replaceAll('"', "'"),
  };
}
// Pin semantics: descriptor edits require reviewing both language validators.
function validateDescriptor(d) {
  if (createHash('sha256').update(JSON.stringify(d)).digest('hex') !== '56bf15a7f992ed856b656b8ed691fe2a3037e06ea2a5f7501fc4b4d59754e4ed') {
    throw new Error('Unsupported thread-lifecycle descriptor; review templates and supported descriptor hash');
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
  const drifted = await generateThreadLifecycle(options);
  if (options.check && drifted.length > 0) {
    console.error(`Generated thread lifecycle contracts are out of date:\n${drifted.map((path) => `- ${relative(options.root, resolve(options.root, path))}`).join("\n")}\nRun npm run generate:thread-lifecycle.`);
    process.exitCode = 1;
  } else if (options.check) console.log("Generated thread lifecycle contracts are up to date.");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
