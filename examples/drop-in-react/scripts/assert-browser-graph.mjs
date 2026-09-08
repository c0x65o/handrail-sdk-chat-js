import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const graphPath = fileURLToPath(new URL("../dist/module-graph.json", import.meta.url));
const modules = JSON.parse(await readFile(graphPath, "utf8"));
assert.ok(Array.isArray(modules) && modules.length > 0, "Vite must emit a non-empty browser module graph");

const normalized = modules.map((id) => id.replaceAll("\\", "/"));
const runtimeEntries = [
  import.meta.resolve("@handrail/chat/react"),
].map((url) => fileURLToPath(url).replaceAll("\\", "/"));
const clientEntry = fileURLToPath(import.meta.resolve("@handrail/chat/client"))
  .replaceAll("\\", "/");
const packageRoot = dirname(dirname(dirname(clientEntry))).replaceAll("\\", "/");

for (const entry of runtimeEntries) {
  assert.ok(
    normalized.includes(entry),
    `the browser graph must enter Handrail Chat through ${entry}`,
  );
}
assert.ok(
  normalized.some((id) => id.startsWith(`${packageRoot}/dist/client/`)),
  "the public UI graph must include the browser client runtime",
);
assert.ok(
  normalized.some((id) => id.startsWith(`${packageRoot}/dist/ui/`)),
  "the public UI graph must include the optional UI runtime",
);

const forbidden = normalized.filter((id) =>
  id.startsWith(`${packageRoot}/`) &&
  /\/(?:src|dist)\/server(?:\/|$)/.test(id),
);
assert.deepEqual(
  forbidden,
  [],
  `server implementation entered the browser graph: ${forbidden.join(", ")}`,
);

console.log(`Browser graph passed: ${normalized.length} modules, no server implementation modules.`);
