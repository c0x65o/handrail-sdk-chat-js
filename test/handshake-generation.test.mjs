import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  generateDart,
  generateTypeScript,
  readHandshakeDescriptor,
} from "../scripts/generate-handshake.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(repositoryRoot, "scripts/generate-handshake.mjs");
const descriptorSourcePath = resolve(
  repositoryRoot,
  "contracts/realtime/handshake.json",
);

test("the handshake descriptor deterministically drives both generated outputs", async () => {
  const descriptor = await readHandshakeDescriptor(repositoryRoot);
  assert.deepEqual(
    descriptor.types.map(({ name, kind }) => ({ name, kind })),
    [
      { name: "EnabledFeatures", kind: "map" },
      { name: "SupportedProtocolRange", kind: "object" },
      { name: "ServerHandshakeMetadata", kind: "object" },
      { name: "ServerHandshakeMetadataInput", kind: "object" },
    ],
  );

  const typeScript = generateTypeScript(descriptor);
  const dart = generateDart(descriptor);
  assert.equal(typeScript, generateTypeScript(descriptor));
  assert.equal(dart, generateDart(descriptor));
  assert.equal(
    await readFile(
      resolve(repositoryRoot, "src/contracts/generated/realtime-handshake.ts"),
      "utf8",
    ),
    typeScript,
  );
  assert.equal(
    await readFile(
      resolve(
        repositoryRoot,
        "contracts/generated/dart/realtime_handshake.dart",
      ),
      "utf8",
    ),
    dart,
  );
});

test("check mode identifies a deliberately stale generated fixture", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "handrail-handshake-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const temporaryDescriptor = resolve(
    temporaryRoot,
    "contracts/realtime/handshake.json",
  );
  await mkdir(dirname(temporaryDescriptor), { recursive: true });
  await writeFile(
    temporaryDescriptor,
    await readFile(descriptorSourcePath, "utf8"),
    "utf8",
  );

  const generate = spawnSync(
    process.execPath,
    [generatorPath, "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(generate.status, 0, generate.stderr);

  const cleanCheck = spawnSync(
    process.execPath,
    [generatorPath, "--check", "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(cleanCheck.status, 0, cleanCheck.stderr);
  assert.match(cleanCheck.stdout, /up to date/);

  const staleFixture = resolve(
    temporaryRoot,
    "contracts/generated/dart/realtime_handshake.dart",
  );
  await writeFile(staleFixture, "// deliberately stale\n", { flag: "a" });

  const driftCheck = spawnSync(
    process.execPath,
    [generatorPath, "--check", "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(driftCheck.status, 1);
  assert.match(
    driftCheck.stderr,
    /contracts\/generated\/dart\/realtime_handshake\.dart/,
  );
});


test("reserved reply/thread names are canonical and preserve the saved-style spelling", async () => {
  const descriptor = await readHandshakeDescriptor(repositoryRoot);
  const style = JSON.parse(await readFile(resolve(repositoryRoot, "contracts/http/reply-style-preference.json"), "utf8"));
  assert.equal(descriptor.reservedFeatures.savedReplyStyle, style.feature.name);
  assert.equal(descriptor.reservedFeatures.threadDiscovery, "threadDiscovery");
  for (const [key, value] of Object.entries(descriptor.reservedFeatures)) {
    assert.ok(generateTypeScript(descriptor).includes(`${key}: "${value}"`));
    assert.ok(generateDart(descriptor).includes(`${key} = '${value}'`));
  }
});
