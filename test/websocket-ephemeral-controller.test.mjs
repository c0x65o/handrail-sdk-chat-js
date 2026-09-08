import assert from "node:assert/strict";
import test from "node:test";

import { CHAT_PROTOCOL_VERSION } from "../dist/contracts/realtime.js";
import {
  createChatEphemeralSignalController,
  normalizeChatEphemeralSignalOptions,
} from "../dist/server/websocket-ephemeral-signals.js";

const START_TIME = Date.parse("2026-09-05T12:00:00.000Z");

// Real time is used only to bound failures, never to schedule test progress.
async function bounded(promise, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(description)), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createFixture() {
  const calls = [];
  const arrivals = [];
  const gates = [];
  const sessions = [];
  const tasks = new Map();
  let timerId = 0;
  let queryCalls = 0;
  const controller = createChatEphemeralSignalController({
    database: {
      query() {
        queryCalls += 1;
        throw new Error("Presence must not query the database");
      },
    },
    schema: "chat",
    permissions: {},
    features: { presence: true },
    options: normalizeChatEphemeralSignalOptions({
      idFactory: () => "controller-test",
      clock: {
        now: () => START_TIME,
        setTimeout(callback, delayMs) {
          const handle = ++timerId;
          tasks.set(handle, { callback, due: START_TIME + delayMs });
          return handle;
        },
        clearTimeout: (handle) => tasks.delete(handle),
      },
    }),
    realtime: {
      async publish(event) {
        const index = calls.length;
        calls.push(event);
        arrivals[index]?.resolve(event);
        if (gates[index]) await gates[index].promise;
      },
    },
  });

  return {
    controller,
    calls,
    attach(tenantId, userId = "user-a") {
      const actor = { tenantId, userId, roles: [] };
      const session = controller.attachSession(actor, CHAT_PROTOCOL_VERSION);
      sessions.push(session);
      return { actor, session };
    },
    gate(index) {
      const gate = Promise.withResolvers();
      gates[index] = gate;
      return gate;
    },
    published(index, description) {
      arrivals[index] ??= Promise.withResolvers();
      return bounded(
        calls[index] ? Promise.resolve(calls[index]) : arrivals[index].promise,
        description,
      );
    },
    async close() {
      // Release every publisher even when an assertion or arrival timeout fails.
      for (const gate of gates) gate?.resolve();
      for (const session of sessions) session.dispose();
      await bounded(controller.drain(), "cleanup drain did not complete");
      assert.equal(tasks.size, 0, "disposal must clear injected timers");
      assert.equal(queryCalls, 0);
    },
  };
}

function presence(owner, state, offset = 0) {
  const sentAt = new Date(START_TIME + offset).toISOString();
  return JSON.stringify({
    eventId: `client-${owner.session.identity.sessionId}-${offset}`,
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId: owner.actor.tenantId,
    streamId: `user:${owner.actor.userId}`,
    type: "presence.signal",
    occurredAt: sentAt,
    payload: {
      capability: "presence",
      durability: "ephemeral",
      actorUserId: owner.actor.userId,
      ...owner.session.identity,
      sequence: offset + 1,
      sentAt,
      expiresAt: new Date(START_TIME + offset + 60_000).toISOString(),
      state,
      scope: { type: "user_private", userId: owner.actor.userId },
    },
  });
}

function assertEvent(event, owner, state, sequence) {
  assert.equal(event.type, "presence.signal");
  assert.equal(event.protocolVersion, CHAT_PROTOCOL_VERSION);
  assert.equal(event.tenantId, owner.actor.tenantId);
  assert.equal(event.streamId, `user:${owner.actor.userId}`);
  assert.deepEqual(event.payload, {
    capability: "presence",
    durability: "ephemeral",
    actorUserId: owner.actor.userId,
    ...owner.session.identity,
    sequence,
    sentAt: new Date(START_TIME + sequence - 1).toISOString(),
    expiresAt: new Date(START_TIME + sequence - 1 + 60_000).toISOString(),
    state,
    scope: { type: "user_private", userId: owner.actor.userId },
  });
  assert.equal(event.occurredAt, event.payload.sentAt);
}

for (const [name, tenantB] of [
  ["separate tenants", "tenant-b"],
  ["two sessions of the same actor", "tenant-a"],
]) {
  test(`stalled presence publisher isolates ${name} and preserves owner order`, async () => {
    const fixture = createFixture();
    const a = fixture.attach("tenant-a");
    const b = fixture.attach(tenantB);
    const firstGate = fixture.gate(0);
    try {
      assert.notEqual(a.session.identity.sessionId, b.session.identity.sessionId);
      assert.notEqual(a.session.identity.deviceId, b.session.identity.deviceId);
      const first = a.session.handle(presence(a, "online"));
      assertEvent(await fixture.published(0, "A did not enter publish"), a, "online", 1);
      const next = a.session.handle(presence(a, "away", 1));

      const other = b.session.handle(presence(b, "online"));
      assertEvent(await fixture.published(1, "B online blocked by gated A"), b, "online", 1);
      assert.equal(await bounded(other, "B handle did not finish"), true);
      b.session.dispose();
      assertEvent(await fixture.published(2, "B disposal blocked by gated A"), b, "offline", 2);
      // B's completed work is the synchronization barrier: A's second event
      // has had an opportunity to run, but must still be behind its first.
      assert.equal(fixture.calls.length, 3);
      assert.deepEqual(fixture.calls.filter((event) =>
        event.payload.sessionId === a.session.identity.sessionId,
      ).map((event) => event.payload.state), ["online"]);

      const secondGate = fixture.gate(3);
      let drained = false;
      const draining = fixture.controller.drain().then(() => { drained = true; });
      firstGate.resolve();
      assertEvent(await fixture.published(3, "A queued event did not resume"), a, "away", 2);
      assert.equal(await bounded(first, "A first handle did not finish"), true);
      assert.equal(drained, false, "drain must include the newer owner queue tail");
      secondGate.resolve();
      assert.equal(await bounded(next, "A next handle did not finish"), true);
      await bounded(draining, "drain did not complete after releasing A");
      assert.equal(fixture.calls.length, 4);
      assert.equal(new Set(fixture.calls.map((event) => event.eventId)).size, 4);
    } finally {
      await fixture.close();
    }
  });
}

test("rejecting presence publisher allows queued work and drain to recover", async () => {
  const fixture = createFixture();
  const owner = fixture.attach("tenant-a");
  const gate = fixture.gate(0);
  try {
    const first = owner.session.handle(presence(owner, "online"));
    assertEvent(await fixture.published(0, "first publish did not start"), owner, "online", 1);
    const next = owner.session.handle(presence(owner, "away", 1));
    const draining = fixture.controller.drain();
    gate.reject(new Error("expected realtime delivery failure"));
    assertEvent(await fixture.published(1, "queued publish did not recover"), owner, "away", 2);
    assert.deepEqual(await bounded(Promise.all([first, next]), "handles did not recover"), [true, true]);
    await bounded(draining, "drain did not recover from publisher rejection");
    owner.session.dispose();
    await bounded(fixture.controller.drain(), "disposal drain did not complete");
    assertEvent(fixture.calls[2], owner, "offline", 3);
    assert.equal(fixture.calls.length, 3);
  } finally {
    await fixture.close();
  }
});
