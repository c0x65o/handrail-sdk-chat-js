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
  readRealtimeSessionDescriptor,
} from "../scripts/generate-realtime-session.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = resolve(
  repositoryRoot,
  "scripts/generate-realtime-session.mjs",
);
const descriptorSourcePath = resolve(
  repositoryRoot,
  "contracts/realtime/session.json",
);

test("the realtime session descriptor drives both generated wire surfaces", async () => {
  const descriptor = await readRealtimeSessionDescriptor(repositoryRoot);
  assert.deepEqual(descriptor.subprotocols, {
    stable: "handrail-chat.v1",
    bearerPrefix: "handrail-chat.bearer.",
  });
  assert.deepEqual(Object.values(descriptor.messageTypes), [
    "chat.session.accepted",
    "chat.session.refresh_required",
    "chat.session.snapshot_required",
    "chat.subscribe",
    "chat.unsubscribe",
    "chat.subscription.accepted",
    "chat.subscription.removed",
    "chat.subscription.rejected",
    "chat.subscription.revoked",
  ]);
  assert.deepEqual(
    descriptor.types.map(({ name }) => name),
    [
      "EventCursor",
      "ClientHandshakeInput",
      "ChatRealtimeSessionAcceptedMessage",
      "ChatRealtimeRefreshRequiredMessage",
      "ChatRealtimeSnapshotRequiredMessage",
      "ChatRealtimeSubscribeRequest",
      "ChatRealtimeUnsubscribeRequest",
      "ChatRealtimeSubscriptionAcceptedMessage",
      "ChatRealtimeSubscriptionRemovedMessage",
      "ChatRealtimeSubscriptionRejectedMessage",
      "ChatRealtimeSubscriptionRevokedMessage",
      "ChatEvent",
    ],
  );

  const typeScript = generateTypeScript(descriptor);
  const dart = generateDart(descriptor);
  assert.equal(typeScript, generateTypeScript(descriptor));
  assert.equal(dart, generateDart(descriptor));
  assert.equal(
    await readFile(
      resolve(repositoryRoot, "src/contracts/generated/realtime-session.ts"),
      "utf8",
    ),
    typeScript,
  );
  assert.equal(
    await readFile(
      resolve(
        repositoryRoot,
        "contracts/generated/dart/realtime_session.dart",
      ),
      "utf8",
    ),
    dart,
  );
});

test("check mode reports stale realtime session output", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "handrail-session-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const descriptorPath = resolve(
    temporaryRoot,
    "contracts/realtime/session.json",
  );
  await mkdir(dirname(descriptorPath), { recursive: true });
  await writeFile(
    descriptorPath,
    await readFile(descriptorSourcePath, "utf8"),
    "utf8",
  );

  const generated = spawnSync(
    process.execPath,
    [generatorPath, "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);

  const clean = spawnSync(
    process.execPath,
    [generatorPath, "--check", "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /up to date/);

  const stalePath = resolve(
    temporaryRoot,
    "src/contracts/generated/realtime-session.ts",
  );
  await writeFile(stalePath, "// deliberately stale\n", { flag: "a" });
  const stale = spawnSync(
    process.execPath,
    [generatorPath, "--check", "--root", temporaryRoot],
    { encoding: "utf8" },
  );
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /src\/contracts\/generated\/realtime-session\.ts/);
});
