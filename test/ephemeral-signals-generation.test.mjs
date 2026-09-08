import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  generateDart,
  generateEphemeralSignals,
  generateTypeScript,
  readEphemeralSignalsDescriptor,
} from "../scripts/generate-ephemeral-signals.mjs";

test("descriptor generates exact TypeScript and Dart wire contracts", async () => {
  const descriptor = await readEphemeralSignalsDescriptor();
  assert.equal(descriptor.features.typing.eventType, "typing.signal");
  assert.deepEqual(descriptor.features.typing.states, ["start", "stop"]);
  assert.equal(descriptor.features.typing.maximumTtlMs, 15_000);
  assert.deepEqual(descriptor.features.presence.states, ["online", "away", "offline"]);
  assert.equal(descriptor.features.presence.maximumTtlMs, 120_000);
  assert.equal(descriptor.sequence.maximum, Number.MAX_SAFE_INTEGER);

  const typescript = generateTypeScript(descriptor);
  assert.match(typescript, /readonly sequence: number/);
  assert.match(typescript, /trustedAcceptedSessionIdentity/);
  assert.match(typescript, /"active_participants"/);
  const dart = generateDart(descriptor);
  assert.match(dart, /sealed class EphemeralSignalEvent/);
  assert.match(dart, /UnmodifiableMapView/);
  assert.match(dart, /maxPresenceSignalTtlMs = 120000/);
});

test("--check behavior reports drift and becomes clean after generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "handrail-ephemeral-"));
  const source = await readFile("contracts/realtime/ephemeral.json", "utf8");
  const descriptor = join(root, "contracts/realtime/ephemeral.json");
  await mkdir(dirname(descriptor), { recursive: true });
  await writeFile(descriptor, source, "utf8");

  assert.deepEqual(await generateEphemeralSignals({ root, check: true }), [
    "src/contracts/generated/ephemeral-signals.ts",
    "contracts/generated/dart/ephemeral_signals.dart",
  ]);
  await generateEphemeralSignals({ root });
  assert.deepEqual(await generateEphemeralSignals({ root, check: true }), []);
});

test("checked-in generated files match deterministic output", async () => {
  assert.deepEqual(await generateEphemeralSignals({ check: true }), []);
});
