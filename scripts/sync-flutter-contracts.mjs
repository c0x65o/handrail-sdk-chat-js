import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { flutterRepositoryRoot, jsRepositoryRoot } from "./sdk-repositories.mjs";

// JS owns descriptors/generators/fixtures. Flutter vendors their exact outputs
// so its package tests need neither Node nor a neighboring JS checkout.
export async function contractSnapshot(jsRoot = jsRepositoryRoot) {
  const files = new Map();
  const walk = async (sourceDirectory, targetDirectory, excluded = []) => {
    for (const entry of (await readdir(resolve(jsRoot, sourceDirectory), { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded.includes(entry.name)) continue;
      const source = `${sourceDirectory}/${entry.name}`;
      const target = `${targetDirectory}/${entry.name}`;
      if (entry.isDirectory()) await walk(source, target);
      else if (entry.isFile()) files.set(target, await readFile(resolve(jsRoot, source)));
      else throw new Error(`Unsupported contract snapshot entry: ${source}`);
    }
  };
  await walk("contracts", "contracts", ["generated"]);
  await walk("contracts/generated/dart", "lib/src/generated");
  await walk("conformance-tests", "conformance-tests");
  await walk("test/fixtures", "test/shared-fixtures");
  return files;
}

export async function syncFlutterContracts({
  jsRoot = jsRepositoryRoot,
  flutterRoot = flutterRepositoryRoot,
  check = false,
} = {}) {
  const manifest = await readFile(resolve(flutterRoot, "pubspec.yaml"), "utf8");
  if (!/^name: handrail_chat\s*$/m.test(manifest)) {
    throw new Error("Contract target must be the handrail_chat Flutter SDK root");
  }
  const files = await contractSnapshot(jsRoot);
  const hashes = Object.fromEntries([...files].map(([path, bytes]) => [
    path, createHash("sha256").update(bytes).digest("hex"),
  ]));
  files.set("shared-contracts.lock.json", Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    sourceRepository: "https://github.com/c0x65o/handrail-sdk-chat-js.git",
    files: hashes,
  }, null, 2)}\n`));
  const drift = [];
  const findRemoved = async (directory) => {
    let entries;
    try { entries = await readdir(resolve(flutterRoot, directory), { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await findRemoved(path);
      else if (!entry.isFile()) throw new Error(`Unsupported Flutter snapshot entry: ${path}`);
      else if (!files.has(path)) {
        if (check) drift.push(`${path} (removed upstream)`);
        else await unlink(resolve(flutterRoot, path));
      }
    }
  };
  for (const directory of ["contracts", "lib/src/generated", "conformance-tests", "test/shared-fixtures"]) {
    await findRemoved(directory);
  }
  for (const [path, bytes] of files) {
    const target = resolve(flutterRoot, path);
    if (check) {
      let existing;
      try { existing = await readFile(target); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!existing?.equals(bytes)) drift.push(path);
    } else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
  }
  if (drift.length) throw new Error(`Flutter contract snapshot drift: ${drift.join(", ")}`);
  return files.size;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== "--check")) {
      throw new Error("Usage: node scripts/sync-flutter-contracts.mjs [--check]");
    }
    const check = process.argv.includes("--check");
    const count = await syncFlutterContracts({ check });
    console.log(`Flutter shared contracts ${check ? "verified" : "synchronized"}: ${count} files.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
