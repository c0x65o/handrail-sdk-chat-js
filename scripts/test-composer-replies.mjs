import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// Keep transient compiler output under the repository's existing ignored path.
await mkdir(resolve(root, "dist"), { recursive: true });
const output = await mkdtemp(resolve(root, "dist/.composer-replies-"));
const run = (args, env = process.env) => {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Composer check exited ${result.status ?? result.signal}`);
};
try {
  run(["node_modules/typescript/bin/tsc", "-p", "tsconfig.composer-replies.json", "--outDir", output]);
  run(["node_modules/typescript/bin/tsc", "-p", "tsconfig.composer-replies-type-tests.json"]);
  run(["--test", "--test-concurrency=1", "test/message-composer.test.mjs", "test/client-draft-synchronization.test.mjs"],
    { ...process.env, HANDRAIL_COMPOSER_BUILD: `${pathToFileURL(output).href}/` });
} finally {
  await rm(output, { recursive: true, force: true });
}
