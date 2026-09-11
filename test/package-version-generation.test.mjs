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

test("compiled client package version agrees with package metadata", async () => {
  const { CHAT_CLIENT_PACKAGE_VERSION } = await import("../dist/client/generated/package-version.js");
  assert.equal(CHAT_CLIENT_PACKAGE_VERSION, await readPackageVersion(repositoryRoot));
});

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
  assert.match(nodeWorkflow, /push:\s*\n\s*branches:\s*\n\s*- main/);
  assert.match(nodeWorkflow, /pull_request:/);
});

test("CI version gate protects checked-out bytes before install lifecycles", async (t) => {
  const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
  const workflow = await readFile(resolve(repositoryRoot, ".github/workflows/node-tests.yml"), "utf8");
  // Execute the workflow's actual single-line run steps, stopping on failure as
  // Actions does. Fail closed if its command shape changes (including block YAML).
  const commands = [...workflow.matchAll(/^\s+run: (.+)$/gm)].map((match) => match[1].trim());
  const checkCommand = commands.find((command) =>
    command === "node scripts/generate-package-version.mjs --check" ||
    command === "npm run check:package-version",
  );
  assert.ok(checkCommand);
  assert.deepEqual([...commands].sort(), [checkCommand, "npm ci", "npm run build", "npm run test:node"].sort());
  assert.equal(commands.at(-1), "npm run test:node");
  const lifecycleCommands = commands.slice(0, -1);
  const generationCommand = manifest.scripts.build.split("&&")[0].trim();
  assert.equal(manifest.scripts.prepare, "npm run build");
  assert.equal(generationCommand, "node scripts/generate-package-version.mjs");

  async function fixture(t, stale) {
    const root = await mkdtemp(join(tmpdir(), "handrail-ci-version-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(resolve(root, "scripts"), { recursive: true });
    await writeFile(resolve(root, "scripts/generate-package-version.mjs"), await readFile(generatorPath));
    await writeFile(resolve(root, "scripts/record-lifecycle.mjs"),
      'import { appendFileSync } from "node:fs";\nappendFileSync("lifecycle.log", process.argv[2] + "\\n");\n');
    // This dependency-free package is an npm lifecycle fixture, not an SDK
    // consumer install. Retain real prepare/build generation; replace only the
    // unrelated compiler/CSS tail with an observable completion marker.
    const pkg = {
      name: "handrail-ci-version-fixture",
      version: "9.8.8-test",
      private: true,
      scripts: {
        preinstall: "node scripts/record-lifecycle.mjs preinstall",
        prepare: manifest.scripts.prepare,
        build: `${generationCommand} && node scripts/record-lifecycle.mjs build`,
        "check:package-version": manifest.scripts["check:package-version"],
      },
    };
    await writeFile(resolve(root, "package.json"), JSON.stringify(pkg));
    await writeFile(resolve(root, "package-lock.json"), JSON.stringify({
      name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true,
      packages: { "": { name: pkg.name, version: pkg.version, hasInstallScript: true } },
    }));
    const generatedPath = resolve(root, packageVersionOutputPath);
    await mkdir(dirname(generatedPath), { recursive: true });
    const before = Buffer.from(generatePackageVersionSource(stale ? "9.8.7-test" : pkg.version));
    await writeFile(generatedPath, before);
    return { root, generatedPath, before, version: pkg.version };
  }

  async function runSteps(t, root, steps) {
    for (const command of steps) {
      const [file, ...args] = command.split(" ");
      try {
        const { stdout } = await execFileAsync(file, args, {
          cwd: root, encoding: "utf8", timeout: 30_000,
          env: {
            ...process.env,
            npm_config_cache: resolve(root, ".npm-cache"),
            npm_config_offline: "true",
            npm_config_audit: "false",
            npm_config_fund: "false",
            npm_config_ignore_scripts: "false",
          },
        });
        t.diagnostic(`${command}: exit 0\n${stdout.trim()}`);
      } catch (error) {
        t.diagnostic(`${command}: exit ${error.code}\n${error.stderr.trim()}`);
        throw error;
      }
    }
  }

  await t.test("stale source fails without installation or regeneration", async (t) => {
    const f = await fixture(t, true);
    await assert.rejects(runSteps(t, f.root, lifecycleCommands), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Generated package-version source is out of date:/);
      return true;
    });
    assert.deepEqual(await readFile(f.generatedPath), f.before);
    await assert.rejects(readFile(resolve(f.root, "lifecycle.log")), { code: "ENOENT" });
  });

  await t.test("aligned source passes and allows normal prepare and explicit build", async (t) => {
    const f = await fixture(t, false);
    await runSteps(t, f.root, lifecycleCommands);
    assert.deepEqual(await readFile(f.generatedPath), f.before);
    assert.equal(await readFile(resolve(f.root, "lifecycle.log"), "utf8"), "preinstall\nbuild\nbuild\n");
  });

  await t.test("former install-first ordering conceals stale checked-out source", async (t) => {
    const f = await fixture(t, true);
    await runSteps(t, f.root, ["npm ci", "npm run check:package-version", "npm run build"]);
    assert.notDeepEqual(await readFile(f.generatedPath), f.before);
    assert.equal(await readFile(f.generatedPath, "utf8"), generatePackageVersionSource(f.version));
    assert.equal(await readFile(resolve(f.root, "lifecycle.log"), "utf8"), "preinstall\nbuild\nbuild\n");
  });
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
