import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(resolve(root, "build"), { recursive: true });
const output = await mkdtemp(resolve(root, "build/thread-list-check-"));
const run = (args, env = process.env) => {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Scoped check exited ${result.status ?? result.signal}`);
};
try {
  run(["node_modules/typescript/bin/tsc", "--project", "tsconfig.client-thread-list.json", "--outDir", output]);
  run(["node_modules/typescript/bin/tsc", "--project", "tsconfig.client-thread-list-type-tests.json"]);
  const compiled = pathToFileURL(output).href;
  const opening = (await readFile(resolve(root, "test/client-thread-opening.test.mjs"), "utf8"))
    .replaceAll("../dist/client/", `${compiled}/client/`)
    .replaceAll("../dist/contracts/", `${compiled}/contracts/`)
    .replaceAll("../dist/index.js", `${compiled}/contracts/realtime.js`);
  const regression = resolve(output, "opening-regression.test.mjs");
  await writeFile(regression, opening);
  run(["--test", "--test-concurrency=1", "test/client-thread-list.test.mjs", "test/client-thread-lifecycle.test.mjs", regression],
    { ...process.env, HANDRAIL_THREAD_LIST_BUILD: compiled, HANDRAIL_THREAD_LIFECYCLE_BUILD: compiled });
} finally { await rm(output, { recursive: true, force: true }); }
