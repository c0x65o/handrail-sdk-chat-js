import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(resolve(root, "build"), { recursive: true });
const output = await mkdtemp(resolve(root, "build/reply-reference-ui-"));
const run = (args, env = process.env) => {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Reply UI check exited ${result.status ?? result.signal}`);
};
try {
  run(["node_modules/typescript/bin/tsc", "-p", "tsconfig.reply-reference-ui.json", "--outDir", output]);
  run(["node_modules/typescript/bin/tsc", "-p", "tsconfig.reply-reference-ui-type-tests.json"]);
  run(["--test", "--test-concurrency=1", "test/message-timeline-ui.test.mjs", "test/ui-slots.test.mjs"],
    { ...process.env, HANDRAIL_REPLY_UI_BUILD: `${pathToFileURL(output).href}/` });
} finally {
  await rm(output, { recursive: true, force: true });
}
