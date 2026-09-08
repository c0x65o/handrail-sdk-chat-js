import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builtInSpecifiers = new Set([
  ...builtinModules,
  ...builtinModules.map((specifier) => `node:${specifier}`),
]);

test("host-directory contracts stay browser-safe through the client entry", async () => {
  const result = await build({
    absWorkingDir: packageRoot,
    bundle: true,
    entryPoints: ["test/fixtures/browser-host-directory-snapshot.ts"],
    format: "esm",
    metafile: true,
    platform: "browser",
    write: false,
  });

  const inputs = Object.entries(result.metafile.inputs);
  assert.ok(
    inputs.some(([input]) => /dist\/contracts\/host-directory-snapshot\.js$/.test(input)),
    "the browser bundle did not include the shared host-directory implementation",
  );

  for (const [input, metadata] of inputs) {
    assert.doesNotMatch(input, /(?:^|\/)(?:dist|src)\/server(?:\/|$)/);
    assert.doesNotMatch(input, /(?:^|\/)(?:dist|src)\/testing(?:\/|$)/);
    for (const imported of metadata.imports) {
      assert.equal(
        builtInSpecifiers.has(imported.path),
        false,
        `browser graph includes Node built-in ${imported.path}`,
      );
    }
  }
});
