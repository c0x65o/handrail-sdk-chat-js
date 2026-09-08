import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const packageRoot = resolve(import.meta.dirname, "..");

test("MessageTimeline imports only React, public hooks, contracts, and UI slots", async () => {
  const source = await readFile(resolve(packageRoot, "src/ui/message-timeline.ts"), "utf8");
  const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(new Set(imports), new Set([
    "react",
    "./message-composer.js",
    "../contracts/index.js",
    "../react/index.js",
    "./slots.js",
  ]));
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(imports.join("\n"), /(?:socket|normalized-cache|ChatContext|create-chat-client|server|testing|provider|node:)/i);
});
