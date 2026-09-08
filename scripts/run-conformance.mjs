import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { flutterRepositoryRoot } from "./sdk-repositories.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestsDirectory = "conformance-tests/manifests";
const resultStatuses = new Set(["passed", "failed", "unavailable"]);

export async function discoverConformanceSuites({ root = repositoryRoot } = {}) {
  const absoluteRoot = resolve(root);
  const manifestsRoot = resolve(absoluteRoot, manifestsDirectory);
  let entries;
  try {
    entries = await readdir(manifestsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${manifestsDirectory}/ does not exist`);
    }
    throw error;
  }

  const suites = [];
  for (const entry of entries.filter(
    (candidate) => candidate.isFile() && candidate.name.endsWith(".json"),
  )) {
    const manifestPath = resolve(manifestsRoot, entry.name);
    const source = await readFile(manifestPath, "utf8");

    let manifest;
    try {
      manifest = JSON.parse(source);
    } catch {
      throw new Error(`${relative(absoluteRoot, manifestPath)} is not valid JSON`);
    }
    suites.push(
      validateManifest(
        manifest,
        basename(entry.name, ".json"),
        manifestPath,
        absoluteRoot,
      ),
    );
  }

  suites.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  for (let index = 1; index < suites.length; index += 1) {
    if (suites[index - 1].id === suites[index].id) {
      throw new Error(`duplicate conformance suite id: ${suites[index].id}`);
    }
  }
  return suites;
}

export async function executeConformanceCommand({ command, cwd }) {
  return new Promise((complete) => {
    let completed = false;
    const finish = (status) => {
      if (completed) return;
      completed = true;
      complete({ status });
    };
    const child = spawn(resolveToolchainExecutable(command[0]), command.slice(1), {
      cwd,
      env: process.env,
      shell: false,
      stdio: "ignore",
    });
    child.once("error", (error) => {
      finish(error?.code === "ENOENT" ? "unavailable" : "failed");
    });
    child.once("close", (code) => finish(code === 0 ? "passed" : "failed"));
  });
}

function resolveToolchainExecutable(executable) {
  if (executable === "flutter" && process.env.FLUTTER_ROOT) {
    return join(process.env.FLUTTER_ROOT, "bin", "flutter");
  }
  if (executable === "dart" && process.env.DART_SDK) {
    return join(process.env.DART_SDK, "bin", "dart");
  }
  return executable;
}

export async function runConformance({
  root = repositoryRoot,
  suiteId,
  execute = executeConformanceCommand,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const suites = await discoverConformanceSuites({ root });
  if (suites.length === 0) {
    throw new Error(`no suite manifests were found in ${manifestsDirectory}/`);
  }

  let selectedSuites = suites;
  if (suiteId !== undefined) {
    selectedSuites = suites.filter((suite) => suite.id === suiteId);
    if (selectedSuites.length === 0) {
      throw new Error(
        `unknown conformance suite "${suiteId}"; available suites: ${suites
          .map((suite) => suite.id)
          .join(", ")}`,
      );
    }
  }

  let failedSuites = 0;
  for (const suite of selectedSuites) {
    const generator = suite.generator
      ? await runStep(execute, suite, "generator", suite.generator)
      : { status: "passed" };
    const typescript = await runStep(execute, suite, "typescript", suite.typescript);
    const dart = await runStep(execute, suite, "dart", suite.dart);
    let suiteFailed = false;

    if (suite.generator && generator.status !== "passed") {
      suiteFailed = true;
      if (generator.status === "unavailable") {
        writeLine(
          stderr,
          `[${suite.id}] generator runtime unavailable; install the required local toolchain and retry.`,
        );
      } else {
        writeLine(
          stderr,
          `[${suite.id}] generated-contract drift check failed. Regenerate with: npm run ${suite.generator.regenerateScript}`,
        );
      }
    }

    if (typescript.status === "unavailable") {
      suiteFailed = true;
      writeLine(
        stderr,
        `[${suite.id}] TypeScript runtime unavailable; install Node.js and ensure it is on PATH.`,
      );
    }
    if (dart.status === "unavailable") {
      suiteFailed = true;
      writeLine(
        stderr,
        `[${suite.id}] Dart/Flutter unavailable; install Flutter and ensure "flutter" is on PATH.`,
      );
    }

    if (typescript.status !== "unavailable" && dart.status !== "unavailable") {
      if (typescript.status === "passed" && dart.status === "passed") {
        writeLine(stdout, `[${suite.id}] agreement: TypeScript and Dart passed.`);
      } else if (typescript.status !== dart.status) {
        suiteFailed = true;
        writeLine(
          stderr,
          `[${suite.id}] language disagreement: TypeScript ${typescript.status}; Dart ${dart.status}.`,
        );
      } else {
        suiteFailed = true;
        writeLine(stderr, `[${suite.id}] fixture checks failed in both TypeScript and Dart.`);
      }
    }

    if (suiteFailed) failedSuites += 1;
  }

  if (failedSuites > 0) {
    writeLine(
      stderr,
      `Conformance failed: ${failedSuites} of ${selectedSuites.length} suite(s).`,
    );
    return 1;
  }
  writeLine(stdout, `Conformance passed: ${selectedSuites.length} suite(s).`);
  return 0;
}

export function parseArguments(args) {
  let suiteId;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--suite") {
      if (suiteId !== undefined) throw new Error("--suite may be provided only once");
      suiteId = args[index + 1];
      if (!suiteId) throw new Error("--suite requires a suite id");
      index += 1;
    } else if (argument.startsWith("--suite=")) {
      if (suiteId !== undefined) throw new Error("--suite may be provided only once");
      suiteId = argument.slice("--suite=".length);
      if (!suiteId) throw new Error("--suite requires a suite id");
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return { suiteId };
}

function validateManifest(manifest, directoryName, manifestPath, root) {
  const label = relative(root, manifestPath);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${label} must contain an object`);
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error(`${label} must declare schemaVersion 1`);
  }
  if (manifest.id !== directoryName || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id)) {
    throw new Error(`${label} id must match its kebab-case directory name`);
  }

  return Object.freeze({
    id: manifest.id,
    typescript: validateStep(manifest.typescript, "typescript", label, root),
    dart: validateStep(manifest.dart, "dart", label, root),
    ...(manifest.generator === undefined
      ? {}
      : { generator: validateGenerator(manifest.generator, label, root) }),
  });
}

function validateGenerator(generator, label, root) {
  const step = validateStep(generator, "generator", label, root);
  if (
    typeof generator.regenerateScript !== "string" ||
    !/^[a-z0-9][a-z0-9:-]*$/.test(generator.regenerateScript)
  ) {
    throw new Error(`${label} generator must declare a safe regenerateScript`);
  }
  return Object.freeze({ ...step, regenerateScript: generator.regenerateScript });
}

function validateStep(step, name, label, root) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    throw new Error(`${label} must declare a ${name} command`);
  }
  if (
    !Array.isArray(step.command) ||
    step.command.length === 0 ||
    step.command.some((value) => typeof value !== "string" || value.length === 0)
  ) {
    throw new Error(`${label} ${name}.command must be a non-empty string array`);
  }
  if (step.repository !== undefined && step.repository !== "flutter") {
    throw new Error(`${label} ${name}.repository must be flutter when specified`);
  }
  const stepRoot = step.repository === "flutter" ? flutterRepositoryRoot : root;
  const requestedCwd = step.cwd ?? ".";
  if (typeof requestedCwd !== "string" || isAbsolute(requestedCwd)) {
    throw new Error(`${label} ${name}.cwd must be repository-relative`);
  }
  const cwd = resolve(stepRoot, requestedCwd);
  const relativeCwd = relative(stepRoot, cwd);
  if (relativeCwd === ".." || relativeCwd.startsWith(`..${sep}`) || isAbsolute(relativeCwd)) {
    throw new Error(`${label} ${name}.cwd must stay inside the repository`);
  }
  return Object.freeze({ command: Object.freeze([...step.command]), cwd });
}

async function runStep(execute, suite, role, step) {
  try {
    const result = await execute({
      suiteId: suite.id,
      role,
      command: step.command,
      cwd: step.cwd,
    });
    return resultStatuses.has(result?.status) ? result : { status: "failed" };
  } catch {
    return { status: "failed" };
  }
}

function writeLine(stream, value) {
  stream.write(`${value}\n`);
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    process.exitCode = await runConformance(options);
  } catch (error) {
    console.error(`Conformance runner error: ${error instanceof Error ? error.message : "unknown failure"}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
