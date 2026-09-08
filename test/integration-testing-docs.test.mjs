import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(import.meta.dirname, "..");
const guidePath = resolve(packageRoot, "docs/integration-testing.md");
const exampleNames = ["smoke", "reconnect", "tenant-isolation"];

const execFileChecked = async (...arguments_) => {
  try {
    return await execFileAsync(...arguments_);
  } catch (error) {
    throw new Error(
      `${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`,
      { cause: error },
    );
  }
};

const readGuide = () => readFile(guidePath, "utf8");

const extractExample = (guide, name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const marked = guide.match(
    new RegExp(
      `<!-- integration-testing-example:${escaped}:start -->\\s*` +
        "```ts\\s*\\n([\\s\\S]*?)^```\\s*\\n" +
        `<!-- integration-testing-example:${escaped}:end -->`,
      "mu",
    ),
  )?.[1];
  assert.ok(marked, `marked TypeScript ${name} example is missing`);
  return marked;
};

test("integration testing guide links remain inside the repository", async () => {
  const guide = await readGuide();
  const targets = [...guide.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)]
    .map(([, target]) => target.trim().replace(/^<|>$/gu, ""))
    .filter(
      (target) =>
        !target.startsWith("#") &&
        !target.startsWith("/") &&
        !/^[a-z][a-z+.-]*:/iu.test(target),
    );

  assert.ok(targets.length > 0, "integration testing guide has no links");
  for (const target of targets) {
    const linked = resolve(dirname(guidePath), decodeURIComponent(target.split("#", 1)[0]));
    const repositoryRelative = relative(packageRoot, linked);
    assert.equal(
      repositoryRelative.startsWith("..") || isAbsolute(repositoryRelative),
      false,
      `guide link leaves the repository: ${target}`,
    );
    await access(linked);
  }

  const readme = await readFile(resolve(packageRoot, "README.md"), "utf8");
  assert.match(readme, /\(docs\/integration-testing\.md\)/u);
});

test("all marked createChatTestHarness examples compile against public entry points", async () => {
  const guide = await readGuide();
  const temporaryRoot = await mkdtemp(
    resolve(packageRoot, ".integration-testing-docs-"),
  );
  const tscPath = resolve(packageRoot, "node_modules/typescript/bin/tsc");

  try {
    const sourcePaths = await Promise.all(
      exampleNames.map(async (name) => {
        const sourcePath = resolve(temporaryRoot, `${name}.ts`);
        await writeFile(sourcePath, extractExample(guide, name), "utf8");
        return sourcePath;
      }),
    );
    await execFileChecked(
      process.execPath,
      [
        tscPath,
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--exactOptionalPropertyTypes",
        "--skipLibCheck",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--types",
        "node",
        ...sourcePaths,
      ],
      { cwd: packageRoot },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test(
  "the extracted full-stack smoke example runs when a safe PostgreSQL backend is available",
  { timeout: 60_000 },
  async (t) => {
    const guide = await readGuide();
    const temporaryRoot = await mkdtemp(
      resolve(packageRoot, ".integration-testing-smoke-"),
    );
    const sourcePath = resolve(temporaryRoot, "smoke.ts");
    const outputRoot = resolve(temporaryRoot, "compiled");
    const tscPath = resolve(packageRoot, "node_modules/typescript/bin/tsc");

    try {
      await writeFile(sourcePath, extractExample(guide, "smoke"), "utf8");
      await execFileChecked(
        process.execPath,
        [
          tscPath,
          "--ignoreConfig",
          "--strict",
          "--exactOptionalPropertyTypes",
          "--skipLibCheck",
          "--target",
          "ES2022",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--types",
          "node",
          "--rootDir",
          temporaryRoot,
          "--outDir",
          outputRoot,
          sourcePath,
        ],
        { cwd: packageRoot },
      );

      try {
        await execFileAsync(process.execPath, [resolve(outputRoot, "smoke.js")], {
          cwd: packageRoot,
          timeout: 45_000,
          env: process.env,
        });
      } catch (error) {
        const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
        if (
          !process.env.TEST_DATABASE_URL?.trim() &&
          output.includes("Unable to start container-backed PostgreSQL")
        ) {
          t.skip("TEST_DATABASE_URL is unset and disposable Docker is unavailable");
          return;
        }
        throw error;
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);

test("integration testing safety and lifecycle boundaries remain explicit", async () => {
  const guide = await readGuide();
  const normalized = guide.replace(/\s+/gu, " ");
  const destructiveDatabaseCommand =
    /\b(?:DROP\s+(?:DATABASE|SCHEMA)|TRUNCATE|ALTER\s+SYSTEM|dropdb|createdb|pg_terminate_backend)\b/iu;
  const requiredStatements = [
    "The harness never reads the ordinary `DATABASE_URL` variable and never silently falls back to it.",
    "Every harness creates a uniquely named schema, configures its pool with that schema's `search_path`, and applies all shipped migrations inside it.",
    "Never point this harness at production, staging, an operator database, or any shared database.",
    "A URL-backed PostgreSQL service is never stopped or otherwise treated as harness-owned.",
  ];
  for (const statement of requiredStatements) {
    assert.ok(normalized.includes(statement), `missing safety statement: ${statement}`);
  }

  for (const name of exampleNames) {
    const example = extractExample(guide, name);
    assert.doesNotMatch(example, /process\.env\.DATABASE_URL/u);
    assert.doesNotMatch(example, /postgres(?:ql)?:\/\/[^\s"']+/iu);
    assert.doesNotMatch(
      example,
      destructiveDatabaseCommand,
      `${name} example contains a destructive database command`,
    );
    assert.match(example, /finally\s*\{/u);
    assert.match(example, /await harness\.teardown\(\)/u);
  }

  assert.match(normalized, /deliberately limited to host-owned edges/iu);
  assert.match(normalized, /Do not replace PostgreSQL queries or Handrail repositories with a fake SQL interpreter or a broad repository mock\./u);
  assert.match(normalized, /failures\.failNext\(\).*failures\.queue\(\)/u);
  assert.match(normalized, /calls\.all\(\).*calls\.count\(\).*calls\.reset\(\)/u);

  const fencedCode = [...guide.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gmu)]
    .map(([, body]) => body);
  assert.ok(fencedCode.length >= exampleNames.length);
  for (const body of fencedCode) {
    assert.doesNotMatch(body, destructiveDatabaseCommand);
  }
  assert.doesNotMatch(
    normalized,
    /\b(?:Run|Execute|Use) (?:a )?(?:database reset|shared table truncation|cluster-wide cleanup|destructive database command)/u,
    "guide must not instruct consumers to reset shared or production data",
  );
});
