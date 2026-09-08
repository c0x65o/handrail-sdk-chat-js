import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { flutterExampleRoot as exampleRoot } from "../../../scripts/sdk-repositories.mjs";

const flutterRoot = process.env.FLUTTER_ROOT?.trim();
const flutterExecutable = process.env.FLUTTER_BIN?.trim() ||
  (flutterRoot
    ? path.join(flutterRoot, "bin", process.platform === "win32" ? "flutter.bat" : "flutter")
    : "flutter");

export const resolvedFlutterLabSdkRoot = (labRoot = exampleRoot) => {
  const configUrl = pathToFileURL(path.join(labRoot, ".dart_tool/package_config.json"));
  const config = JSON.parse(readFileSync(configUrl, "utf8"));
  const sdk = config.packages?.find((entry) => entry.name === "handrail_chat");
  if (typeof sdk?.rootUri !== "string") {
    throw new Error("Resolve the lab's locked handrail_chat dependency before recording build provenance.");
  }
  return fileURLToPath(new URL(sdk.rootUri, configUrl));
};

// Hash the SDK Dart actually resolves, which may be a pinned Git checkout in
// pub's cache rather than the lab repository's adjacent lib directory.
export const flutterLabSourceDigest = (labRoot = exampleRoot) => {
  const sdkRoot = resolvedFlutterLabSdkRoot(labRoot);
  const hash = createHash("sha256");
  const add = (root, prefix, relative) => {
    const absolute = path.join(root, relative);
    hash.update(`${prefix}/${relative}`).update("\0").update(readFileSync(absolute)).update("\0");
  };
  const walk = (root, prefix, relative) => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(root, prefix, child);
      else add(root, prefix, child);
    }
  };
  walk(sdkRoot, "sdk", "lib");
  add(sdkRoot, "sdk", "pubspec.yaml");
  for (const directory of ["lib", "web"]) walk(labRoot, "lab", directory);
  for (const file of ["pubspec.yaml", "pubspec.lock"]) add(labRoot, "lab", file);
  return hash.digest("hex");
};

export const flutterLabProvenance = () => {
  const sdkRoot = resolvedFlutterLabSdkRoot();
  return {
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: exampleRoot, encoding: "utf8" }).trim(),
    sdkRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: sdkRoot, encoding: "utf8" }).trim(),
    sourceDigest: flutterLabSourceDigest(),
    builtAt: new Date().toISOString(),
  };
};

const runFlutter = (args, phase) => new Promise((resolve, reject) => {
  const child = spawn(flutterExecutable, args, {
    cwd: exampleRoot, env: process.env, stdio: "inherit",
  });
  child.once("error", (error) => reject(new Error(`Unable to start Flutter from ${flutterExecutable}: ${error.message}`)));
  child.once("close", (code, signal) => {
    if (signal !== null) reject(new Error(`Flutter Chat Lab ${phase} stopped by ${signal}`));
    else if (code !== 0) reject(new Error(`Flutter Chat Lab ${phase} exited with code ${code ?? "unknown"}`));
    else resolve();
  });
});

export const buildFlutterChatLab = async ({ outputDirectory } = {}) => {
  await runFlutter(["pub", "get", "--enforce-lockfile", "--no-example"], "dependency resolution");
  const provenance = flutterLabProvenance();
  await runFlutter([
      "build",
      "web",
      "--release",
      "--no-pub",
      ...(outputDirectory ? ["--output", outputDirectory] : []),
      "--no-wasm-dry-run",
      "--no-web-resources-cdn",
      "--dart-define=HANDRAIL_CHAT_LAB_BACKEND=true",
      `--dart-define=HANDRAIL_SOURCE_REVISION=${provenance.sourceRevision}`,
      `--dart-define=HANDRAIL_SOURCE_DIGEST=${provenance.sourceDigest}`,
      `--dart-define=HANDRAIL_BUILD_TIME=${provenance.builtAt}`,
      "--base-href",
      "/__flutter-chat-lab/",
    ], "build");
  const after = flutterLabProvenance();
  if (after.sourceDigest !== provenance.sourceDigest || after.sdkRevision !== provenance.sdkRevision) {
    throw new Error("Flutter sources changed during compilation; rebuild to attest a stable source tree.");
  }
  return provenance;
};

const isMain = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`));

if (isMain) {
  try {
    await buildFlutterChatLab();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
