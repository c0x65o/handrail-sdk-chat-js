import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(resolve(root, "build"), { recursive: true });
const output = await mkdtemp(resolve(root, "build/react-thread-discovery-"));
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", env: { ...process.env,
    HANDRAIL_COMPOSER_BUILD: `${pathToFileURL(output).href}/`,
    HANDRAIL_REPLY_UI_BUILD: `${pathToFileURL(output).href}/`,
    HANDRAIL_THREAD_LIST_BUILD: pathToFileURL(output).href,
  } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Scoped check exited ${result.status ?? result.signal}`);
}
try {
  run(["node_modules/typescript/bin/tsc", "-p", "tsconfig.react-reply-routing.json", "--outDir", output]);
  run(["node_modules/typescript/bin/tsc", "-p", "tsconfig.react-reply-routing-type-tests.json"]);
  await writeFile(resolve(output, "react-thread-discovery.cases.mjs"),
    (await readFile(resolve(root, "test/react-thread-discovery.cases.mjs"), "utf8")).replaceAll('"../dist/', '"./'));
  for (const [file, pattern] of [
    ["chat-workspace-default", "channel discovery"],
    ["message-timeline-ui", "reply|Reply|thread|Thread"],
    ["thread-panel", ".*"],
    ["client-thread-opening", ".*"],
    ["message-composer", "reply|Reply"],
  ]) {
    const source = (await readFile(resolve(root, `test/${file}.test.mjs`), "utf8"))
      .replaceAll('"@handrail/chat"', '"./index.js"')
      .replaceAll('"@handrail/chat/client"', '"./client/index.js"')
      .replaceAll('"@handrail/chat/react"', '"./react/index.js"')
      .replaceAll('"@handrail/chat/ui"', '"./ui/index.js"')
      .replaceAll('"../dist/client/reply-style-runtime.js"', '"./client/reply-style-runtime.js"')
      .replaceAll('"../dist/client/index.js"', '"./client/index.js"')
      .replaceAll('"../dist/index.js"', '"./index.js"')
      .replaceAll('"../dist/', '"./')
      .replaceAll("../src/ui/styles.css", "../../src/ui/styles.css");
    const path = resolve(output, `${file}.test.mjs`);
    const discoveryRegistration = '\nconst { registerDiscoveryTests } = await import("./react-thread-discovery.cases.mjs");\nregisterDiscoveryTests({ createFixture, withReplyRouting, mount, workspace, click, keyDown, input, act, flush,\n  publicId, privateId, threadId, rootMessageId, publicConversation, privateConversation, threadConversation,\n  detail, timeline, message, now, userId, createElement, ChatWorkspace, ChatProvider, mounted });\n';
    await writeFile(path, file === "chat-workspace-default" ? source + discoveryRegistration : source);
    run(["--test", "--test-concurrency=1", "--test-timeout=15000", `--test-name-pattern=${pattern}`, path]);
  }
  run(["--test", "--test-concurrency=1", "test/thread-panel-import-guard.test.mjs"]);
  run(["--test", "--test-concurrency=1", "--test-timeout=15000", "test/client-thread-list.test.mjs"]);
} finally {
  await rm(output, { recursive: true, force: true });
}
