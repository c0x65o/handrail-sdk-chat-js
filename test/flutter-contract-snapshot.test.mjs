import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { syncFlutterContracts } from "../scripts/sync-flutter-contracts.mjs";

test("Flutter snapshot detects changed fixtures and generated Dart outputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chat-contract-split-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const jsRoot = join(root, "js");
  const flutterRoot = join(root, "flutter");
  const put = async (path, value) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
  };
  await put(join(flutterRoot, "pubspec.yaml"), "name: handrail_chat\n");
  for (const [path, value] of Object.entries({
    "contracts/models/message.json": '{"revision":1}\n',
    "contracts/generated/dart/message.dart": "class Message {}\n",
    "conformance-tests/messages.json": "[]\n",
    "test/fixtures/messages.json": "[]\n",
  })) await put(join(jsRoot, path), value);

  await put(join(flutterRoot, "test/fixtures/local.dart"), "// Flutter-owned fixture\n");
  await syncFlutterContracts({ jsRoot, flutterRoot });
  await syncFlutterContracts({ jsRoot, flutterRoot, check: true });
  assert.equal(await readFile(join(flutterRoot, "test/fixtures/local.dart"), "utf8"), "// Flutter-owned fixture\n");
  assert.equal(await readFile(join(flutterRoot, "lib/src/generated/message.dart"), "utf8"), "class Message {}\n");
  const lock = JSON.parse(await readFile(join(flutterRoot, "shared-contracts.lock.json"), "utf8"));
  assert.equal(lock.sourceRepository, "https://github.com/c0x65o/handrail-sdk-chat-js.git");
  assert.match(lock.files["lib/src/generated/message.dart"], /^[a-f0-9]{64}$/);

  await put(join(flutterRoot, "lib/src/generated/message.dart"), "class Drift {}\n");
  await assert.rejects(syncFlutterContracts({ jsRoot, flutterRoot, check: true }), /lib\/src\/generated\/message.dart/);
  await syncFlutterContracts({ jsRoot, flutterRoot });
  await put(join(jsRoot, "conformance-tests/messages.json"), '["new fixture"]\n');
  await assert.rejects(syncFlutterContracts({ jsRoot, flutterRoot, check: true }), /conformance-tests\/messages.json/);
  await syncFlutterContracts({ jsRoot, flutterRoot });
  await put(join(flutterRoot, "lib/src/generated/removed.dart"), "class Stale {}\n");
  await assert.rejects(syncFlutterContracts({ jsRoot, flutterRoot, check: true }), /removed.dart \(removed upstream\)/);
  await syncFlutterContracts({ jsRoot, flutterRoot });
  await assert.rejects(readFile(join(flutterRoot, "lib/src/generated/removed.dart")), { code: "ENOENT" });

  await put(join(flutterRoot, "pubspec.yaml"), "name: another_package\n");
  await assert.rejects(syncFlutterContracts({ jsRoot, flutterRoot }), /must be the handrail_chat Flutter SDK/);
});
