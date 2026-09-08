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
const handrailDependencies = [
  ...new Set(
    dependencySections
      .flatMap((section) => Object.keys(section ?? {}))
      .filter((name) => name.startsWith("@handrail/")),
  ),
];
assert.deepEqual(
  handrailDependencies,
  ["@handrail/chat"],
  "the example must consume exactly one Handrail package",
);

const includedExtensions = new Set([".ts", ".mjs", ".md", ".json"]);
const ignoredDirectories = new Set(["dist", "node_modules"]);
const files = [];
const collect = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(path);
    } else if (
      includedExtensions.has(extname(entry.name)) &&
      entry.name !== "package-lock.json" &&
      entry.name !== "static-check.mjs"
    ) {
      files.push(path);
    }
  }
};
await collect(root);

const allowedHandrailSpecifiers = new Set([
  "@handrail/chat",
  "@handrail/chat/server",
]);
const checks = [
  {
    label: "package-internal or additional Handrail package reference",
    pattern: /["'](@handrail\/[^"']+)["']/g,
    inspect(match) {
      return !allowedHandrailSpecifiers.has(match[1]);
    },
  },
  {
    label: "relative package-internal import",
    pattern: /(?:from\s+|import\s*\()["'](?:\.\.\/){2,}(?:src|dist)\//g,
  },
  {
    label: "credential-like literal",
    pattern:
      /(?:password|passwd|secret|api[_-]?key|access[_-]?key|auth(?:orization)?|bearer|token|session[_-]?(?:id|token))\s*[:=]\s*["'][^"']+["']|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}/gi,
  },
  {
    label: "non-loopback provider URL",
    pattern: /https?:\/\/(?!(?:127\.0\.0\.1|localhost)(?::|\/|$))[^\s"'`)]+/gi,
    inspect(match) {
      return !/^https:\/\/github\.com\/c0x65o\/handrail-sdk-chat-js\.git#[a-f0-9]{40}$/.test(match[0]);
    },
  },
  {
    label: "live provider SDK or call",
    pattern: /(?:@aws-sdk|cloudinary|sendgrid|twilio|firebase-admin|stripe\.)/gi,
  },
];

for (const path of files) {
  const source = await readFile(path, "utf8");
  for (const check of checks) {
    for (const match of source.matchAll(check.pattern)) {
      if (check.inspect?.(match) === false) {
        continue;
      }
      throw new Error(`${check.label} found in ${relative(root, path)}`);
    }
  }
}

const hostSource = await readFile(join(root, "src/host.ts"), "utf8");
const clientIdentitySources = [
  /headers\s*\[?\s*["']x-(?:tenant|user|roles?|actor)/i,
  /searchParams\.(?:get|getAll)\(\s*["'](?:tenantId|userId|roles?|actor)/i,
  /(?:body|payload)\.(?:tenantId|userId|roles?|actor)/i,
];
for (const pattern of clientIdentitySources) {
  assert.equal(
    pattern.test(hostSource),
    false,
    "host identity must come only from the server-side session mapping",
  );
}

console.log(`Static acceptance checks passed for ${files.length} example files.`);
