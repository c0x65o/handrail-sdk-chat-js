import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const NODE_TEST_CONCURRENCY = 2;
export const NODE_TEST_TIMEOUT_MS = 120_000;

const repositoryRoot = resolve(import.meta.dirname, "..");
const rootTestPattern = /^test\/[^/]+\.test\.mjs$/u;
const postgresTestBasenamePattern = /^postgres-.*\.test\.mjs$/u;

export function selectNodeTestFiles(rootTestFiles) {
  if (!Array.isArray(rootTestFiles)) {
    throw new TypeError("Root test selection must be an array");
  }

  const uniqueFiles = new Set();
  for (const testFile of rootTestFiles) {
    if (typeof testFile !== "string" || !rootTestPattern.test(testFile)) {
      throw new Error(`Unknown root test selection: ${String(testFile)}`);
    }
    if (uniqueFiles.has(testFile)) {
      throw new Error(`Duplicate root test selection: ${testFile}`);
    }
    uniqueFiles.add(testFile);
  }

  const selectedFiles = [...uniqueFiles]
    .filter((testFile) => {
      const basename = testFile.slice("test/".length);
      return !postgresTestBasenamePattern.test(basename);
    })
    .sort();

  if (selectedFiles.length === 0) {
    throw new Error("No non-database root Node tests were selected");
  }

  return selectedFiles;
}

export async function enumerateNodeTestFiles(root = repositoryRoot) {
  const entries = await readdir(resolve(root, "test"), { withFileTypes: true });
  const testEntries = entries.filter((entry) => entry.name.endsWith(".test.mjs"));
  const unknownEntries = testEntries.filter((entry) => !entry.isFile());

  if (unknownEntries.length > 0) {
    throw new Error(
      `Unknown root test selection: ${unknownEntries
        .map((entry) => `test/${entry.name}`)
        .sort()
        .join(", ")}`,
    );
  }

  return selectNodeTestFiles(testEntries.map((entry) => `test/${entry.name}`));
}

export function createNodeTestInvocation(testFiles, root = repositoryRoot) {
  const selectedFiles = selectNodeTestFiles(testFiles);
  return {
    command: process.execPath,
    // The full build contains the same modules as the focused compiler projects.
    // Explicit locations prevent scoped tests from using missing or stale output.
    env: {
      ...process.env,
      ...Object.fromEntries([
        "HANDRAIL_REPLY_STYLE_BUILD", "HANDRAIL_THREAD_LIST_BUILD",
        "HANDRAIL_THREAD_LIFECYCLE_BUILD", "HANDRAIL_MESSAGE_CONTEXT_BUILD",
      ].map((key) => [key, pathToFileURL(resolve(root, "dist")).href])),
    },
    args: [
      "--experimental-strip-types",
      "--test",
      `--test-concurrency=${NODE_TEST_CONCURRENCY}`,
      `--test-timeout=${NODE_TEST_TIMEOUT_MS}`,
      ...selectedFiles,
    ],
  };
}

export async function runNodeTests(root = repositoryRoot) {
  if (process.argv.length > 2) {
    throw new Error("This runner does not accept a partial test selection");
  }

  const run = (command, args, env = process.env) => {
    const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status === null) throw new Error(`Process terminated by signal ${result.signal}`);
    return result;
  };
  // Check before build can regenerate and conceal checked-out version drift.
  for (const [command, args] of [
    [process.execPath, ["scripts/generate-package-version.mjs", "--check"]],
    process.platform === "win32"
      ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm run build"]]
      : ["npm", ["run", "build"]],
  ]) {
    const prepared = run(command, args);
    if (prepared.status !== 0) {
      process.exitCode = prepared.status;
      return;
    }
  }
  const invocation = createNodeTestInvocation(await enumerateNodeTestFiles(root), root);
  const result = run(invocation.command, invocation.args, invocation.env);


  process.exitCode = result.status;
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  await runNodeTests();
}
