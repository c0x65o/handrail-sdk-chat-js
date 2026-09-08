import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("npm and Flutter distributions are independently versioned", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const releaseGuide = await readFile(resolve(root, "docs/releasing.md"), "utf8");

  assert.equal(manifest.scripts.preversion, undefined);
  assert.equal(manifest.scripts["check:version-sync"], undefined);
  assert.equal(manifest.scripts["check:unified-release"], undefined);
  assert.match(releaseGuide, /two independently versioned distributions/u);
  assert.match(releaseGuide, /version numbers do not\s+need to match/u);
  assert.match(releaseGuide, /full release commit/u);
});
