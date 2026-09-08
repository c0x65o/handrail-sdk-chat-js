import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

test("public Git install builds the SDK and shares the host React runtime", { timeout: 180_000 }, async (t) => {
  const revision = process.env.HANDRAIL_CHAT_JS_REVISION ?? "";
  assert.match(revision, /^[a-f0-9]{40}$/, "Set HANDRAIL_CHAT_JS_REVISION to the committed extracted SDK SHA; a local copy or tarball is not a consumer install");
  const consumerRoot = await mkdtemp(resolve(tmpdir(), "handrail-chat-git-consumer-"));
  t.after(() => rm(consumerRoot, { recursive: true, force: true }));
  const sourcePackage = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const hostReact = JSON.parse(await readFile(resolve(root, "node_modules/react/package.json"), "utf8"));
  const dependency = `git+https://github.com/c0x65o/handrail-sdk-chat-js.git#${revision}`;
  await writeFile(resolve(consumerRoot, "package.json"), JSON.stringify({
    name: "chat-git-consumer-check",
    private: true,
    type: "module",
    dependencies: { "@handrail/chat": dependency, react: hostReact.version },
  }, null, 2));
  await copyFile(resolve(root, "test/fixtures/react-ui-consumer.mjs"), resolve(consumerRoot, "consumer.mjs"));
  // The SDK's normal prepare hook must build it during the Git installation.
  await execFileAsync("npm", ["install", "--include=dev", "--no-audit", "--no-fund"], {
    cwd: consumerRoot, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  const installRoot = resolve(consumerRoot, "node_modules/@handrail/chat");
  const installedPackage = JSON.parse(await readFile(resolve(installRoot, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(resolve(consumerRoot, "package-lock.json"), "utf8"));
  assert.equal(lock.packages[""].dependencies["@handrail/chat"], dependency);
  assert.equal(lock.packages["node_modules/@handrail/chat"].resolved, dependency);
  assert.equal(installedPackage.name, sourcePackage.name);
  assert.equal(installedPackage.version, sourcePackage.version);
  assert.deepEqual(installedPackage.exports, sourcePackage.exports);
  assert.deepEqual(installedPackage.sideEffects, ["./dist/ui/styles.css"]);
  assert.equal(installedPackage.peerDependencies.react, ">=18.2.0 <20");
  assert.equal(installedPackage.dependencies?.react, undefined);
  await access(resolve(installRoot, "dist/testing/index.js"));
  await access(resolve(installRoot, "dist/ui/styles.css"));
  const { stdout } = await execFileAsync(process.execPath, ["consumer.mjs"], { cwd: consumerRoot });
  const result = JSON.parse(stdout);
  assert.equal(result.reactVersion, hostReact.version);
  assert.deepEqual(result.reactIntegrationExportNames, Object.keys(await import("../dist/react/index.js")));
  assert.deepEqual(result.uiExportNames, Object.keys(await import("../dist/ui/index.js")));
  await assert.rejects(access(resolve(installRoot, "node_modules/react")), { code: "ENOENT" });
});
