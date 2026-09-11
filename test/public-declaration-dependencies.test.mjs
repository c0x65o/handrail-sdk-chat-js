import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const root = resolve(import.meta.dirname, "..");
const execFileAsync = promisify(execFile);

// Source declaration regression only: this does not install the SDK or prove
// public Git installation. Build normally before running this test.
test("emitted public declarations need only production dependencies and host React types", async (t) => {
  const scratch = await mkdtemp(resolve(tmpdir(), "chat-declarations-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);

  // Copy the emitted declaration graph outside the repository's dependency
  // lookup ancestry. Never copy SDK development packages implicitly.
  await cp(resolve(root, "dist"), resolve(scratch, "declarations"), { recursive: true });
  const hostTypes = new Set(["node_modules/@types/react", "node_modules/csstype"]);
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path || (entry.dev && !hostTypes.has(path))) continue;
    const target = resolve(scratch, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(resolve(root, path), target, {
      recursive: true,
      // Nested packages are copied individually according to their lock flags.
      filter: (source) => source === resolve(root, path) || !source.slice(resolve(root, path).length).includes("/node_modules"),
    });
  }
  await writeFile(resolve(scratch, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await cp(resolve(root, "test/fixtures/declarations.ts"), resolve(scratch, "check.ts"));
  const paths = Object.fromEntries(Object.entries(manifest.exports)
    .filter(([, entry]) => typeof entry === "object" && entry.types)
    .map(([key, entry]) => [key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`, [entry.types.replace("./dist/", "./declarations/")]]));
  await writeFile(resolve(scratch, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true, skipLibCheck: false, noEmit: true,
      exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
      target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext",
      types: ["node", "react"], paths,
    },
    files: ["check.ts", ...Object.values(paths).flat()],
  }, null, 2));
  const compile = () => execFileAsync(process.execPath, [
    resolve(root, "node_modules/typescript/bin/tsc"), "--project", resolve(scratch, "tsconfig.json"),
  ], { cwd: scratch, maxBuffer: 4 * 1024 * 1024 });
  try {
    await compile();
  } catch (error) {
    assert.fail(error.stdout || error.message);
  }

  // Prove that neither ancestor SDK devDependencies nor a permissive shim
  // can mask the original PostgreSQL declaration defect.
  await rm(resolve(scratch, "node_modules/@types/pg"), { recursive: true, force: true });
  await assert.rejects(compile(), (error) => {
    assert.match(error.stdout, /server\/postgres-migrations\.d\.ts.*TS7016/);
    assert.match(error.stdout, /testing\/index\.d\.ts.*TS7016/);
    return true;
  });
});
