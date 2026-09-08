import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  generatePackageVersion,
  generatePackageVersionSource,
  packageVersionOutputPath,
  readPackageVersion,
} from "../scripts/generate-package-version.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const generatorPath = resolve(
  repositoryRoot,
  "scripts/generate-package-version.mjs",
);
const execFileAsync = promisify(execFile);

test("build refreshes package version while main CI checks committed drift", async () => {
  const manifest = JSON.parse(
    await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
  );
  const buildCommands = manifest.scripts.build.split("&&").map((command) =>
    command.trim(),
  );

  assert.equal(
    manifest.scripts["generate:package-version"],
    "node scripts/generate-package-version.mjs",
  );
  assert.equal(manifest.scripts.version, "npm run generate:package-version");
  assert.deepEqual(
    buildCommands.filter((command) =>
      command.includes("scripts/generate-package-version.mjs"),
    ),
    ["node scripts/generate-package-version.mjs"],
  );
  assert.equal(
    buildCommands[0],
    "node scripts/generate-package-version.mjs",
  );
  assert.match(buildCommands[1], /^tsc\b/);

  const nodeWorkflow = await readFile(
    resolve(repositoryRoot, ".github/workflows/node-tests.yml"),
    "utf8",
  );
  const ciCheckIndex = nodeWorkflow.indexOf("run: npm run check:package-version");
  const ciBuildIndex = nodeWorkflow.indexOf("run: npm run build");
  assert.match(nodeWorkflow, /push:\s*\n\s*branches:\s*\n\s*- main/);
  assert.match(nodeWorkflow, /pull_request:/);
  assert.notEqual(ciCheckIndex, -1);
  assert.ok(ciCheckIndex < ciBuildIndex);
});

test("npm version lifecycle regenerates the browser package version", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "handrail-package-version-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  await mkdir(resolve(temporaryRoot, "scripts"), { recursive: true });
  await writeFile(
    resolve(temporaryRoot, "scripts/generate-package-version.mjs"),
    await readFile(generatorPath),
  );
  const manifest = {
    name: "handrail-package-version-fixture",
    version: "9.8.7-test",
    scripts: {
      "generate:package-version": "node scripts/generate-package-version.mjs",
      version: "npm run generate:package-version",
    },
  };
  await writeFile(
    resolve(temporaryRoot, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    resolve(temporaryRoot, "package-lock.json"),
    `${JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: manifest.name,
            version: manifest.version,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await generatePackageVersion({ root: temporaryRoot });

  await execFileAsync(
    "npm",
    ["version", "9.8.8-test", "--no-git-tag-version", "--ignore-scripts=false"],
    { cwd: temporaryRoot, encoding: "utf8" },
  );

  const updatedManifest = JSON.parse(
    await readFile(resolve(temporaryRoot, "package.json"), "utf8"),
  );
  const updatedLockfile = JSON.parse(
    await readFile(resolve(temporaryRoot, "package-lock.json"), "utf8"),
  );
  assert.equal(updatedManifest.version, "9.8.8-test");
  assert.equal(updatedLockfile.version, "9.8.8-test");
  assert.equal(updatedLockfile.packages[""].version, "9.8.8-test");
  assert.equal(
    await readFile(resolve(temporaryRoot, packageVersionOutputPath), "utf8"),
    generatePackageVersionSource("9.8.8-test"),
  );
});

test("package.json deterministically drives the generated browser package version", async () => {
  const version = await readPackageVersion(repositoryRoot);
  assert.equal(
    await readFile(resolve(repositoryRoot, packageVersionOutputPath), "utf8"),
    generatePackageVersionSource(version),
  );
  assert.deepEqual(
    await generatePackageVersion({ check: true, root: repositoryRoot }),
    [],
  );
});

test("check mode detects a generated browser package version that trails the manifest", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "handrail-package-version-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  await mkdir(dirname(resolve(temporaryRoot, packageVersionOutputPath)), {
    recursive: true,
  });
  await writeFile(
    resolve(temporaryRoot, "package.json"),
    JSON.stringify({ version: "9.8.7-test" }),
    "utf8",
  );
  await generatePackageVersion({ root: temporaryRoot });
  assert.deepEqual(
    await generatePackageVersion({ check: true, root: temporaryRoot }),
    [],
  );

  await writeFile(
    resolve(temporaryRoot, "package.json"),
    JSON.stringify({ version: "9.8.8-test" }),
    "utf8",
  );
  const generatedPath = resolve(temporaryRoot, packageVersionOutputPath);
  const generatedBeforeCheck = await readFile(generatedPath);
  assert.deepEqual(
    await generatePackageVersion({ check: true, root: temporaryRoot }),
    [packageVersionOutputPath],
  );
  assert.deepEqual(await readFile(generatedPath), generatedBeforeCheck);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [generatorPath, "--check", "--root", temporaryRoot],
      { encoding: "utf8" },
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(
        error.stderr,
        /Generated package-version source is out of date:/,
      );
      assert.match(error.stderr, /- src\/client\/generated\/package-version\.ts/);
      assert.match(error.stderr, /Run npm run generate:package-version\./);
      return true;
    },
  );
  assert.deepEqual(await readFile(generatedPath), generatedBeforeCheck);

  // Manifest-only bumps (including automation that skips npm lifecycle scripts)
  // must be repaired by the version-generation step used by the build.
  await execFileAsync(process.execPath, [generatorPath, "--root", temporaryRoot]);
  assert.equal(
    await readFile(generatedPath, "utf8"),
    generatePackageVersionSource("9.8.8-test"),
  );
  assert.deepEqual(await generatePackageVersion({ check: true, root: temporaryRoot }), []);
});
