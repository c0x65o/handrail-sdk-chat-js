import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const dependencySections = [
  manifest.dependencies,
  manifest.devDependencies,
  manifest.optionalDependencies,
  manifest.peerDependencies,
];
const handrailDependencies = [...new Set(
  dependencySections
    .flatMap((section) => Object.keys(section ?? {}))
    .filter((name) => name.startsWith("@handrail/")),
)];
assert.deepEqual(handrailDependencies, ["@handrail/chat"]);
assert.match(manifest.dependencies["@handrail/chat"], /^git\+https:\/\/github\.com\/c0x65o\/handrail-sdk-chat-js\.git#[a-f0-9]{40}$/, "SDK dependency must use the public Git repository at a full SHA");

const files = [];
const collect = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if ([".ts", ".tsx"].includes(extname(entry.name))) files.push(path);
  }
};
await collect(join(root, "src"));
await collect(join(root, "test"));

const allowedImports = new Set(["@handrail/chat/client", "@handrail/chat/react"]);
for (const path of files) {
  const source = await readFile(path, "utf8");
  for (const match of source.matchAll(/(?:from\s+|import\s*\()["'](@handrail\/chat(?:\/[^"']*)?)["']/g)) {
    assert.ok(
      allowedImports.has(match[1]),
      `non-public or disallowed Handrail import ${match[1]} in ${relative(root, path)}`,
    );
  }
  assert.equal(
    /(?:from\s+|import\s*\()["'](?:\.\.\/){2,}(?:src|dist)\//.test(source),
    false,
    `relative package-internal import in ${relative(root, path)}`,
  );
  assert.equal(
    /\b(?:new\s+)?WebSocket\s*\(/.test(source),
    false,
    `raw socket construction in ${relative(root, path)}`,
  );
  assert.equal(
    /["'][^"']*(?:normalized-cache|client\/cache|internal\/cache)[^"']*["']/.test(source),
    false,
    `package-internal cache import in ${relative(root, path)}`,
  );
}

const joinedSource = (await Promise.all(files.map((path) => readFile(path, "utf8")))).join("\n");
for (const required of allowedImports) {
  assert.match(joinedSource, new RegExp(required.replace("/", "\\/")));
}

console.log(`Static boundaries passed for ${files.length} TypeScript files.`);
