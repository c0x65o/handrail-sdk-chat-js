import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, cp, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

for (const runner of ["style", "routing"]) {
  test(`React reply ${runner} runner retains helpers and cleans up on success and failure`, async (t) => {
    const fixture = await mkdtemp(resolve(tmpdir(), `react-reply-${runner}-regression-`));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    // Exercise the real compiler, tests and shared act helper in an isolated copy.
    // Share only installed dependencies; no install or generated output is reused.
    for (const file of ["package.json", "src", "test", "type-tests", "scripts",
      ...(await readdir(root)).filter((name) => /^tsconfig.*\.json$/.test(name))]) {
      await cp(resolve(root, file), resolve(fixture, file), { recursive: true });
    }
    await symlink(resolve(root, "node_modules"), resolve(fixture, "node_modules"), "junction");

    const env = { ...process.env };
    // Child Node test runners need their own reporter, not the parent's IPC mode.
    delete env.NODE_TEST_CONTEXT;
    const run = () => spawnSync(process.execPath, [`scripts/test-react-reply-${runner}.mjs`], {
      cwd: fixture,
      env,
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const assertCleanup = async () => {
      assert.deepEqual(
        (await readdir(resolve(fixture, "build"))).filter((name) => name.startsWith(`react-reply-${runner}-`)),
        [],
        "runner must remove its temporary compilation and copied helpers",
      );
    };
    const passed = run();
    await assertCleanup();
    assert.ifError(passed.error);
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.match(passed.stdout, /# fail 0/);

    // This name matches both unchanged workspace selections. A failure after
    // relocation must propagate, and the same finally block must still clean up.
    await appendFile(resolve(fixture, "test/chat-workspace-default.test.mjs"),
      '\ntest("WorkspaceHeader reply style settings runner failure", () => { throw new Error("intentional relocated assertion failure"); });\n');
    const failed = run();
    await assertCleanup();
    assert.ifError(failed.error);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.match(failed.stdout, /intentional relocated assertion failure/);
    assert.match(failed.stderr, /Scoped check exited 1/);
  });
}
