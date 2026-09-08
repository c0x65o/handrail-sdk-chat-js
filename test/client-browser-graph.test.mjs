import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");
const builtIns = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);

test("the client and React search graphs exclude Node and server dependencies", async () => {
  const result = await build({
    absWorkingDir: packageRoot,
    bundle: true,
    entryPoints: ["dist/client/index.js", "dist/react/index.js"],
    format: "esm",
    metafile: true,
    outdir: "browser-graph",
    platform: "browser",
    write: false,
  });

  const inputs = Object.entries(result.metafile.inputs);
  assert.ok(inputs.some(([input]) => /dist\/client\/application-chat-storage\.js$/.test(input)));
  assert.ok(inputs.some(([input]) => /dist\/client\/offline-send-message-queue\.js$/.test(input)));
  assert.ok(inputs.some(([input]) => /dist\/client\/create-chat-client\.js$/.test(input)));
  assert.ok(inputs.some(([input]) => /dist\/client\/command-dispatcher\.js$/.test(input)));
  assert.ok(inputs.some(([input]) => /dist\/client\/normalized-cache\.js$/.test(input)));
  assert.ok(inputs.some(([input]) => /dist\/client\/read-state\.js$/.test(input)));
  assert.ok(inputs.some(([input]) => /dist\/client\/huddle-media-session\.js$/.test(input)));
  assert.ok(inputs.some(([input]) => /dist\/client\/message-search\.js$/.test(input)));
  assert.ok(inputs.some(([input]) => /dist\/contracts\/generated\/forward-message\.js$/.test(input)));
  assert.ok(inputs.some(([input]) => /dist\/contracts\/conversation-creation\.js$/.test(input)));
  assert.ok(inputs.some(([input]) => /dist\/contracts\/conversation-archive\.js$/.test(input)));
  assert.ok(inputs.some(([input]) => /dist\/contracts\/thread-follow-mutation\.js$/.test(input)));
  assert.ok(inputs.some(([input]) => /dist\/contracts\/saved-message-mutation\.js$/.test(input)));
  assert.ok(inputs.some(([input]) => /dist\/contracts\/generated\/message-reminder\.js$/.test(input)));
  assert.ok(inputs.some(([input]) => /dist\/react\/query-hooks\.js$/.test(input)));

  for (const [input, metadata] of inputs) {
    assert.doesNotMatch(input, /(?:^|\/)(?:dist|src)\/(?:server|testing)(?:\/|$)/);
    assert.doesNotMatch(input, /node_modules\/(?:pg|@testcontainers)(?:\/|$)/);
    for (const imported of metadata.imports) {
      assert.equal(
        builtIns.has(imported.path),
        false,
        `browser graph includes Node built-in ${imported.path}`,
      );
      assert.doesNotMatch(imported.path, /^(?:pg|@testcontainers\/)/);
    }
  }
});
