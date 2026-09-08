import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  flutterLabSourceDigest,
  resolvedFlutterLabSdkRoot,
} from "../examples/drop-in-react/scripts/build-flutter-chat-lab.mjs";

test("lab fingerprint follows Dart's resolved SDK rather than the adjacent checkout", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "chat-lab-resolved-sdk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lab = resolve(root, "flutter/example");
  const sdk = resolve(root, "pub-cache/sdk");
  const put = async (path, value) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
  };
  await put(resolve(lab, "lib/main.dart"), "void main() {}\n");
  await put(resolve(lab, "web/index.html"), "<html></html>\n");
  await put(resolve(lab, "pubspec.yaml"), "name: example\n");
  await put(resolve(lab, "pubspec.lock"), "packages: {}\n");
  await put(resolve(sdk, "lib/core.dart"), "class CompiledSdk {}\n");
  await put(resolve(sdk, "pubspec.yaml"), "name: handrail_chat\n");
  const configPath = resolve(lab, ".dart_tool/package_config.json");
  await put(configPath, JSON.stringify({
    configVersion: 2,
    packages: [{ name: "handrail_chat", rootUri: pathToFileURL(`${sdk}/`).href, packageUri: "lib/" }],
  }));
  assert.equal(resolve(resolvedFlutterLabSdkRoot(lab)), sdk);
  const before = flutterLabSourceDigest(lab);
  await put(resolve(root, "flutter/lib/core.dart"), "class UncompiledCheckout {}\n");
  assert.equal(flutterLabSourceDigest(lab), before);
  await put(resolve(sdk, "lib/core.dart"), "class ChangedCompiledSdk {}\n");
  const changed = flutterLabSourceDigest(lab);
  assert.notEqual(changed, before);
  await put(resolve(lab, "pubspec.lock"), "packages: {changed: true}\n");
  assert.notEqual(flutterLabSourceDigest(lab), changed);
  await put(configPath, JSON.stringify({ configVersion: 2, packages: [] }));
  assert.throws(() => flutterLabSourceDigest(lab), /Resolve the lab's locked handrail_chat dependency/);
});
