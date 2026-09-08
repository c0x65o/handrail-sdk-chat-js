import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const graphPath = fileURLToPath(new URL("../dist/module-graph.json", import.meta.url));
const modules = JSON.parse(await readFile(graphPath, "utf8"));
assert.ok(Array.isArray(modules) && modules.length > 0, "Vite must emit a non-empty browser module graph");

const normalized = modules.map((id) => id.replaceAll("\\", "/"));
const reactEntry = fileURLToPath(import.meta.resolve("@handrail/chat/react"))
  .replaceAll("\\", "/");
const packageRoot = dirname(dirname(dirname(reactEntry))).replaceAll("\\", "/");
assert.ok(
  normalized.includes(reactEntry),
  "the browser graph must enter Handrail Chat through its public React export",
);

const forbidden = normalized.filter((id) =>
  id.startsWith(`${packageRoot}/`) &&
  /\/(?:src|dist)\/(?:server|ui)(?:\/|$)/.test(id),
);
assert.deepEqual(
  forbidden,
  [],
  `server or optional UI implementation entered the browser graph: ${forbidden.join(", ")}`,
);

console.log(`Browser graph passed: ${normalized.length} modules, no server or UI implementation modules.`);
