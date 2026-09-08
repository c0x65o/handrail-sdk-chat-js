import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");
const builtIns = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);

test("saved-message mutation contracts remain browser-safe", async () => {
  const result = await build({
    absWorkingDir: packageRoot,
    bundle: true,
    entryPoints: ["test/fixtures/browser-saved-message-mutation.ts"],
    format: "esm",
    metafile: true,
    platform: "browser",
    write: false,
  });

  const inputs = Object.entries(result.metafile.inputs);
  assert.ok(
    inputs.some(([input]) =>
      /dist\/contracts\/saved-message-mutation\.js$/.test(input),
    ),
    "the browser bundle did not include the shared saved-message contract",
  );

  for (const [input, metadata] of inputs) {
    assert.doesNotMatch(
      input,
      /(?:^|\/)(?:dist|src)\/(?:server|testing)(?:\/|$)/,
    );
    for (const imported of metadata.imports) {
      assert.equal(
        builtIns.has(imported.path),
        false,
        `browser graph includes Node built-in ${imported.path}`,
      );
    }
  }
});
