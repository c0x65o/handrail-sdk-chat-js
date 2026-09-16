import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const root = resolve(import.meta.dirname, "..");
const execFileAsync = promisify(execFile);

// Source declaration regression only: this does not install the SDK or prove
// public Git installation. Build normally before running this test.
test("emitted public declarations need only production dependencies and host React types", async (t) => {
  // TMPDIR can be inside the checkout (including through a symlink). Select
  // a writable location with no ancestor node_modules before copying anything.
  const candidates = [tmpdir(), dirname(root),
    process.platform === "win32" ? resolve(process.env.SystemRoot ?? "C:\\Windows", "Temp") : "/tmp"];
  let scratch;
  const failures = [];
  for (const candidate of new Set(candidates)) {
    try {
      const base = await realpath(candidate);
      for (let ancestor = base; ; ancestor = dirname(ancestor)) {
        const dependencies = resolve(ancestor, "node_modules");
        const exists = await stat(dependencies).then(() => true, (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        });
        if (exists) throw new Error(`dependency lookup would reach ${dependencies}`);
        if (dirname(ancestor) === ancestor) break;
      }
      scratch = await mkdtemp(resolve(base, "chat-declarations-"));
      break;
    } catch (error) {
      failures.push(`${candidate}: ${error.message}`);
    }
  }
  assert.ok(scratch, `No isolated temporary directory available: ${failures.join("; ")}`);
  t.diagnostic(`Isolated declaration consumer: ${scratch}`);
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);

  // Copy the emitted declaration graph outside the repository's dependency
  // lookup ancestry. Never copy SDK development packages implicitly.
  const sdk = resolve(scratch, "node_modules/@handrail/chat");
  await mkdir(sdk, { recursive: true });
  await cp(resolve(root, "dist"), resolve(sdk, "dist"), { recursive: true });
  await cp(resolve(root, "package.json"), resolve(sdk, "package.json"));
  const hostDependencies = new Set(["node_modules/react", "node_modules/@types/react", "node_modules/@types/prop-types", "node_modules/csstype"]);
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path || (entry.dev && !hostDependencies.has(path))) continue;
    const target = resolve(scratch, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(resolve(root, path), target, {
      recursive: true,
      // Nested packages are copied individually according to their lock flags.
      filter: (source) => source === resolve(root, path) || !source.slice(resolve(root, path).length).includes("/node_modules"),
    });
  }
  await writeFile(resolve(scratch, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await writeFile(resolve(scratch, "check.ts"),
    await readFile(resolve(root, "test/fixtures/declarations.ts"), "utf8") +
    '\nimport type * as Root from "@handrail/chat";\nexport type RootExports = typeof Root;\n');
  // Load through real package exports from the same isolated dependency graph.
  await execFileAsync(process.execPath, ["--input-type=module", "-e", `
    for (const entry of ${JSON.stringify(Object.keys(manifest.exports).filter(key => key !== "./ui/styles.css").map(key => key === "." ? manifest.name : manifest.name + key.slice(1)))}) {
      await import(entry);
    }
    import.meta.resolve("@handrail/chat/ui/styles.css");
    await import("@testcontainers/postgresql");
  `], { cwd: scratch });
  const compile = (moduleResolution) => execFileAsync(process.execPath, [
    resolve(root, "node_modules/typescript/bin/tsc"), "--project", resolve(scratch, `tsconfig.${moduleResolution}.json`),
  ], { cwd: scratch, maxBuffer: 4 * 1024 * 1024 });
  for (const [module, moduleResolution] of [["NodeNext", "NodeNext"], ["ESNext", "Bundler"]]) {
    await writeFile(resolve(scratch, `tsconfig.${moduleResolution}.json`), JSON.stringify({
      compilerOptions: {
        strict: true, skipLibCheck: false, noEmit: true,
        exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
        target: "ES2022", module, moduleResolution,
        types: ["node", "react"],
      },
      files: ["check.ts"],
    }, null, 2));
    try {
      await compile(moduleResolution);
      t.diagnostic(`${moduleResolution}: strict emitted-package consumer passed`);
    } catch (error) {
      assert.fail(error.stdout || error.message);
    }
  }

  // Prove that neither ancestor SDK devDependencies nor a permissive shim
  // can mask the original PostgreSQL declaration defect.
  await rm(resolve(scratch, "node_modules/@types/pg"), { recursive: true, force: true });
  for (const mode of ["NodeNext", "Bundler"]) await assert.rejects(compile(mode), (error) => {
    assert.match(error.stdout, /server\/postgres-migrations\.d\.ts.*TS7016/);
    assert.match(error.stdout, /testing\/index\.d\.ts.*TS7016/);
    t.diagnostic(`${mode}: missing-@types/pg negative control rejected both declarations`);
    return true;
  });
});
