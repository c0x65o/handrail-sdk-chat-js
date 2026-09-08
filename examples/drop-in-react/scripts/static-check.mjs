import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = resolve(root, "../..");
const guidePath = join(packageRoot, "docs/chat-workspace-customization.md");
const slotsPath = join(packageRoot, "src/ui/slots.ts");
const workspacePath = join(packageRoot, "src/ui/chat-workspace.ts");
const packageStylesPath = join(packageRoot, "src/ui/styles.css");
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

const allowedImports = new Set([
  "@handrail/chat/client",
  "@handrail/chat/react",
  "@handrail/chat/ui",
  "@handrail/chat/ui/styles.css",
]);
for (const path of files) {
  const source = await readFile(path, "utf8");
  for (const match of source.matchAll(/(?:from\s+|import\s*)["'](@handrail\/chat(?:\/[^"']*)?)["']/g)) {
    assert.ok(
      allowedImports.has(match[1]),
      `non-public or disallowed Handrail import ${match[1]} in ${relative(root, path)}`,
    );
  }
  assert.equal(
    /(?:from\s+|import\s*)["'](?:\.\.\/){2,}(?:src|dist)\//.test(source),
    false,
    `relative package-internal import in ${relative(root, path)}`,
  );
  assert.equal(/<iframe\b/i.test(source), false, `iframe in ${relative(root, path)}`);
  assert.equal(
    /\b(?:new\s+)?WebSocket\s*\(|\bsocket\s*\./.test(source),
    false,
    `raw socket API in ${relative(root, path)}`,
  );
  assert.equal(
    /["'][^"']*(?:client\/cache|internal\/cache|transport\/|realtime\/)[^"']*["']/.test(source),
    false,
    `private cache, transport, or realtime import in ${relative(root, path)}`,
  );
}

const joinedSource = (await Promise.all(files.map((path) => readFile(path, "utf8")))).join("\n");
for (const required of allowedImports) {
  assert.ok(joinedSource.includes(required), `missing required public import ${required}`);
}
assert.ok(joinedSource.includes("endpoint: \"/api/chat\""), "host-owned endpoint must remain visible");
assert.ok(joinedSource.includes("getAccessToken()"), "host-owned getAccessToken callback must remain visible");

const css = await readFile(join(root, "src/styles.css"), "utf8");
assert.doesNotMatch(css, /^\s*(?::root\b|html\b|body\b|\*(?:\s|,|\{))/m, "example CSS must not use global selectors");
assert.match(css, /\.drop-in-example \.company-chat-theme\s*\{/);
assert.match(css, /--hr-chat-color-accent:/);
assert.match(css, /--hr-chat-radius-md:/);

const [guide, slotSource, workspaceSource, packageStyles, slotFixture] = await Promise.all([
  readFile(guidePath, "utf8"),
  readFile(slotsPath, "utf8"),
  readFile(workspacePath, "utf8"),
  readFile(packageStylesPath, "utf8"),
  readFile(join(root, "src/company-slots.tsx"), "utf8"),
]);

const sorted = (values) => [...new Set(values)].sort();
const quotedValues = (source) => [...source.matchAll(/"([A-Za-z][A-Za-z_-]*)"/g)]
  .map((match) => match[1]);
const tableKeys = (source) => [...source.matchAll(/^\| `([^`]+)` \|/gm)]
  .map((match) => match[1].replaceAll("\\|", "|"));

const slotBlock = slotSource.match(/CHAT_WORKSPACE_SLOT_KEYS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\s*as const\)/);
assert.ok(slotBlock, "could not read public slot keys from src/ui/slots.ts");
const sourceSlots = quotedValues(slotBlock[1]);
const guideSlotSection = guide.slice(
  guide.indexOf("## Component slots"),
  guide.indexOf("The view models have these public fields:"),
);
const documentedSlots = tableKeys(guideSlotSection);
assert.deepEqual(sorted(documentedSlots), sorted(sourceSlots), "guide slot table must exactly match public slot keys");
for (const slot of sourceSlots) {
  assert.match(slotFixture, new RegExp(`^\\s*${slot}:`, "m"), `typechecked fixture is missing ${slot}`);
}

const modeBlock = workspaceSource.match(/export type ChatWorkspaceMode\s*=([\s\S]*?);/);
assert.ok(modeBlock, "could not read ChatWorkspaceMode from src/ui/chat-workspace.ts");
const sourceModes = quotedValues(modeBlock[1]);
const guideModeSection = guide.slice(
  guide.indexOf("## Layout, scope, and selection"),
  guide.indexOf("## Component slots"),
);
const documentedModes = tableKeys(guideModeSection);
assert.deepEqual(sorted(documentedModes), sorted(sourceModes), "guide layout table must exactly match ChatWorkspaceMode");
const contractFixture = await readFile(join(root, "src/customization-contract.tsx"), "utf8");
for (const mode of sourceModes) {
  assert.ok(contractFixture.includes(`mode="${mode}"`), `typechecked fixture is missing ${mode} mode`);
}

const sourceTokens = sorted(
  [...packageStyles.matchAll(/^\s*(--hr-chat-[a-z0-9-]+)\s*:/gm)].map((match) => match[1]),
);
const documentedTokens = sorted(
  [...guide.matchAll(/`(--hr-chat-[a-z0-9-]+)`/g)].map((match) => match[1]),
);
assert.deepEqual(documentedTokens, sourceTokens, "guide token table must document every and only public CSS token");
for (const token of css.matchAll(/--hr-chat-[a-z0-9-]+/g)) {
  assert.ok(sourceTokens.includes(token[0]), `example CSS uses unknown package token ${token[0]}`);
}

for (const match of guide.matchAll(/```css\s*\n([\s\S]*?)```/g)) {
  const selectorLines = match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith("{") && !line.startsWith("@"));
  for (const selectorLine of selectorLines) {
    const selector = selectorLine.slice(0, -1).trim();
    assert.ok(
      selector === ".handrail-chat" ||
        selector.startsWith(".handrail-chat.") ||
        selector.startsWith(".handrail-chat[") ||
        selector.startsWith(".handrail-chat ") ||
        selector.startsWith(".handrail-chat:"),
      `guide CSS contains an unscoped selector: ${selector}`,
    );
    assert.doesNotMatch(selector, /(^|[\s,>+~])(?::root|html\b|body\b|\*)/);
  }
}

for (const match of guide.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
  const target = match[1];
  if (/^(?:https?:|#)/.test(target)) continue;
  const fileTarget = target.split("#", 1)[0];
  await access(resolve(join(packageRoot, "docs"), fileTarget));
}

for (const match of guide.matchAll(/(?:from\s+|import\s*)["'](@handrail\/chat(?:\/[^"']*)?)["']/g)) {
  assert.ok(allowedImports.has(match[1]), `guide uses disallowed Handrail import ${match[1]}`);
}
assert.doesNotMatch(guide, /<iframe\b/i, "guide must not contain iframe markup");
assert.doesNotMatch(guide, /\b(?:new\s+)?WebSocket\s*\(|\bsocket\s*\./, "guide must not contain raw socket examples");
assert.doesNotMatch(
  guide,
  /(?:from\s+|import\s*)["'](?:@handrail\/chat\/(?:src|dist|internal)|(?:\.\.\/)+(?:src|dist)\/)/,
  "guide must not contain private package imports",
);

console.log(
  `Static boundaries passed for ${files.length} TypeScript files, ${sourceSlots.length} slots, ${sourceModes.length} layouts, ${sourceTokens.length} tokens, guide links, and scoped CSS.`,
);
