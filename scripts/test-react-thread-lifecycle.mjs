import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(resolve(root, "build"), { recursive: true });
const output = await mkdtemp(resolve(root, "build/react-thread-lifecycle-"));
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", env: {
    ...process.env, HANDRAIL_THREAD_LIFECYCLE_BUILD: pathToFileURL(output).href,
  } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Scoped check exited ${result.status ?? result.signal}`);
}
try {
  run(["node_modules/typescript/bin/tsc", "-p", "tsconfig.react-reply-routing.json", "--outDir", output]);
  const paths = [];
  for (const name of ["thread-panel.test.mjs", "notification-preferences.test.mjs"]) {
    const source = (await readFile(resolve(root, "test", name), "utf8"))
      .replaceAll('"@handrail/chat"', '"./index.js"')
      .replaceAll('"@handrail/chat/client"', '"./client/index.js"')
      .replaceAll('"@handrail/chat/react"', '"./react/index.js"')
      .replaceAll('"@handrail/chat/ui"', '"./ui/index.js"')
      .replaceAll('"../dist/', '"./');
    const path = resolve(output, name);
    await writeFile(path, source);
    paths.push(path);
  }
  run(["--test", "--test-concurrency=1", "--test-timeout=15000", ...process.argv.slice(2), ...paths,
    "test/thread-panel-import-guard.test.mjs", "test/client-thread-lifecycle.test.mjs"]);
} finally {
  await rm(output, { recursive: true, force: true });
}
