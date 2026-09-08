import assert from "node:assert/strict";
import test from "node:test";

import {
  createChatTestHarness,
  createPostgresTestBackend,
} from "@handrail/chat/testing";
import { handrailChatPostgresMigrations } from "@handrail/chat/server";
import { WebSocket } from "ws";

const actorA = {
  credential: "opaque-credential-a",
  actor: {
    tenantId: "tenant-a",
    userId: "user-a",
    roles: ["employee"],
  },
  capabilities: ["conversation.read"],
  user: {
    tenantId: "tenant-a",
    userId: "user-a",
    displayName: "Ada A",
  },
};

const actorB = {
  credential: "opaque-credential-b",
  actor: {
    tenantId: "tenant-b",
    userId: "user-b",
    roles: ["employee"],
  },
  capabilities: ["conversation.read"],
  user: {
    tenantId: "tenant-b",
    userId: "user-b",
    displayName: "Babbage B",
  },
};

const directoryLookup = (harness, credential, userId) =>
  fetch(`${harness.endpoint}/directory/users:batch`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ userIds: [userId] }),
  });

test("createChatTestHarness composes real migrations, trusted actors, sockets, and teardown", async () => {
  const backend = await createPostgresTestBackend();
  let harness;

  try {
    harness = await createChatTestHarness({
      backend,
      actors: [actorA, actorB],
      initialTime: "2030-02-03T04:05:06.000Z",
    });
    const schema = harness.schema;

    assert.equal(await backend.schemaExists(schema), true);
    assert.equal(harness.httpServer.listenerCount("upgrade"), 1);
    assert.equal(harness.migrationResult.status.pending.length, 0);
    assert.deepEqual(
      harness.migrationResult.status.applied.map(({ id }) => id),
      handrailChatPostgresMigrations.map(({ id }) => id),
    );

    const rawPushToken = "harness-raw-push-token-secret";
    const protectionContext = {
      tenantId: actorA.actor.tenantId,
      userId: actorA.actor.userId,
      deviceId: "harness-device",
    };
    const protectedToken =
      await harness.adapters.pushTokenProtector.protect({
        ...protectionContext,
        token: rawPushToken,
      });
    assert.equal(
      harness.runtime.config.adapters.pushTokenProtector,
      harness.adapters.pushTokenProtector,
    );
    assert.doesNotMatch(JSON.stringify(protectedToken), /raw-push-token-secret/u);
    assert.equal(
      await harness.adapters.pushTokenProtector.unprotect({
        ...protectionContext,
        protectedToken,
      }),
      rawPushToken,
    );

    const [clientA, clientB] = [
      harness.createClient("opaque-credential-a"),
      harness.createClient("opaque-credential-b"),
    ];
    assert.equal((await clientA.start()).state, "ready");
    assert.equal((await clientB.start()).state, "ready");

    const ownLookup = await directoryLookup(
      harness,
      actorA.credential,
      actorA.actor.userId,
    );
    assert.equal(ownLookup.status, 200);
    assert.equal((await ownLookup.json()).users[0].displayName, "Ada A");

    const crossTenantLookup = await directoryLookup(
      harness,
      actorA.credential,
      actorB.actor.userId,
    );
    assert.equal(crossTenantLookup.status, 200);
    assert.deepEqual((await crossTenantLookup.json()).users, [
      { kind: "unavailable", userId: "user-b", reason: "missing" },
    ]);

    harness.failures.failNext(
      "directory.getUser",
      "deterministic directory edge failure",
    );
    const failedLookup = await directoryLookup(
      harness,
      actorA.credential,
      actorA.actor.userId,
    );
    assert.equal(failedLookup.status, 503);
    assert.equal(harness.failures.pending("directory.getUser"), 0);
    assert.equal(harness.calls.count("directory.getUser"), 3);

    harness.clock.advance(1_000);
    await harness.adapters.notifications?.send({
      deliveryId: "notification:test-delivery",
      sourceEventId: "test-event",
      tenantId: actorA.actor.tenantId,
      recipientUserId: actorA.actor.userId,
      type: "test.notification",
      occurredAt: harness.clock.iso(),
      conversationId: "test-conversation",
      messageId: "test-message",
      sequence: 1,
      actorUserId: actorB.actor.userId,
      metadata: { fixture: true },
    });
    assert.equal(
      harness.calls.all("notifications.send")[0].occurredAt,
      "2030-02-03T04:05:07.000Z",
    );

    const connection = await harness.connectWebSocket(actorB.credential);
    assert.equal(connection.accepted.type, "chat.session.accepted");
    assert.equal(harness.runtime.webSocketSessionCount, 1);

    const firstTeardown = harness.teardown();
    const secondTeardown = harness.teardown();
    assert.equal(firstTeardown, secondTeardown);
    await firstTeardown;
    assert.equal(harness.httpServer.listening, false);
    assert.equal(harness.httpServer.listenerCount("upgrade"), 0);
    assert.equal(connection.socket.readyState, WebSocket.CLOSED);
    assert.equal(await backend.schemaExists(schema), false);
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});
