import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(resolve(root, "build"), { recursive: true });
const output = await mkdtemp(resolve(root, "build/react-reply-routing-"));
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", env: { ...process.env,
    HANDRAIL_COMPOSER_BUILD: `${pathToFileURL(output).href}/`,
    HANDRAIL_REPLY_UI_BUILD: `${pathToFileURL(output).href}/`,
  } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Scoped check exited ${result.status ?? result.signal}`);
}
try {
  run(["node_modules/typescript/bin/tsc", "-p", "tsconfig.react-reply-routing.json", "--outDir", output]);
  run(["node_modules/typescript/bin/tsc", "-p", "tsconfig.react-reply-routing-type-tests.json"]);
  for (const [file, pattern] of [
    ["chat-workspace-default", "inline Reply routing|Reply starts|default public actions|reply style settings|host settings content"],
    ["message-timeline-ui", "reply|Reply|thread|Thread"],
    ["thread-panel", ".*"],
    ["message-composer", "reply|Reply"],
  ]) {
    const source = (await readFile(resolve(root, `test/${file}.test.mjs`), "utf8"))
      .replaceAll('"@handrail/chat"', '"./index.js"')
      .replaceAll('"@handrail/chat/client"', '"./client/index.js"')
      .replaceAll('"@handrail/chat/react"', '"./react/index.js"')
      .replaceAll('"@handrail/chat/ui"', '"./ui/index.js"')
      .replaceAll('"../dist/client/reply-style-runtime.js"', '"./client/reply-style-runtime.js"')
      .replaceAll("../src/ui/styles.css", "../../src/ui/styles.css");
    const path = resolve(output, `${file}.test.mjs`);
    await writeFile(path, source);
    run(["--test", "--test-concurrency=1", "--test-timeout=15000", `--test-name-pattern=${pattern}`, path]);
  }
  run(["--test", "--test-concurrency=1", "test/thread-panel-import-guard.test.mjs"]);
} finally {
  await rm(output, { recursive: true, force: true });
}
