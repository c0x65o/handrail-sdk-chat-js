import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export function createNodeTestInvocation(testFiles) {
  const selectedFiles = selectNodeTestFiles(testFiles);
  return {
    command: process.execPath,
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

  const invocation = createNodeTestInvocation(await enumerateNodeTestFiles(root));
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: root,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status === null) {
    throw new Error(`Node test process terminated by signal ${result.signal}`);
  }

  process.exitCode = result.status;
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  await runNodeTests();
}
