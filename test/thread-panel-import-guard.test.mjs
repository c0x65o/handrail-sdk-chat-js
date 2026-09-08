import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const packageRoot = resolve(import.meta.dirname, "..");

test("ThreadPanel imports only React, public hooks/contracts, and public UI primitives", async () => {
  const source = await readFile(resolve(packageRoot, "src/ui/thread-panel.ts"), "utf8");
  const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(new Set(imports), new Set([
    "react",
    "./slots.js",
    "../contracts/index.js",
    "../react/index.js",
    "./message-composer.js",
    "./message-timeline.js",
    "./notification-preferences.js",
  ]));
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(
    imports.join("\n"),
    /(?:ChatContext|\.\.\/client\/|normalized-cache|create-chat-client|socket|server|testing|provider|node:)/i,
  );
});
