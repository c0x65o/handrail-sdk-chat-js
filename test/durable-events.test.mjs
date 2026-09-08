import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CHAT_DURABLE_EVENT_TYPES,
  DurableEventParseError,
  parseKnownDurableEvent,
} from "../dist/contracts/generated/durable-events.js";
import { parseChatEvent } from "../src/contracts/generated/realtime-session.ts";

const fixtures = JSON.parse(await readFile("conformance-tests/durable-events/fixtures.json", "utf8"));
const trustedIdentity = fixtures.trustedIdentity;
const replies = JSON.parse(await readFile("conformance-tests/durable-events/reply-references.json", "utf8"));
const messageEvents = fixtures.valid.filter((event) => ["message.created", "message.updated", "message.deleted"].includes(event.type));

test("read cursor events accept the canonical event fields without HTTP reconciliation status", () => {
  const wire = structuredClone(fixtures.valid.find((event) => event.type === "conversation.read_cursor_updated"));
  delete wire.payload.reconciliationStatus;
  assert.deepEqual(parseKnownDurableEvent(wire, trustedIdentity), wire);
  wire.payload.actorUserId = "another-user";
  assertRejection(wire, "private_stream_mismatch");
});

for (const fixture of messageEvents) {
  for (const destination of ["conversation-1", "thread-1"]) {
    test(`${fixture.type} round-trips legacy and reply messages in ${destination}`, () => {
      const references = replies.validIds.flatMap((messageId) => [true, false].map((notifyAuthor) => ({ messageId, notifyAuthor })));
      for (const replyTo of [undefined, ...references]) {
        const wire = structuredClone(fixture);
        wire.streamId = wire.payload.message.conversationId = destination;
        if (replyTo !== undefined) wire.payload.message.replyTo = structuredClone(replyTo);
        const parsed = parseKnownDurableEvent(wire, trustedIdentity);
        assert.deepEqual(parsed, wire);
        assert.equal(parsed.streamId, destination);
        assert.equal(parsed.type, fixture.type);
        assert.deepEqual(parseKnownDurableEvent(JSON.parse(JSON.stringify(parsed)), trustedIdentity), parsed);
        if (replyTo !== undefined) {
          assert.ok(Object.isFrozen(parsed.payload.message.replyTo));
          wire.payload.message.replyTo.messageId = "changed-source";
          assert.deepEqual(parsed.payload.message.replyTo, replyTo);
        } else {
          assert.equal(Object.hasOwn(parsed.payload.message, "replyTo"), false);
        }
      }
    });

    test(`${fixture.type} rejects malformed reply references in ${destination}`, () => {
      for (const replyTo of [...replies.invalidReferences, undefined]) {
        const wire = structuredClone(fixture);
        wire.streamId = wire.payload.message.conversationId = destination;
        wire.payload.message.replyTo = replyTo;
        assertRejection(wire, "incoherent_payload");
      }
    });

    test(`${fixture.type} retains tenant and stream checks with replies in ${destination}`, () => {
      for (const notifyAuthor of [true, false]) {
        for (const [patch, code] of [
          [{ tenantId: "other-tenant" }, "tenant_mismatch"],
          [{ message: { tenantId: "other-tenant" } }, "tenant_mismatch"],
          [{ streamId: "source-message" }, "incoherent_payload"],
          [{ message: { conversationId: "other-conversation" } }, "incoherent_payload"],
          [{ streamId: "user:user-1" }, "private_stream_mismatch"],
          [{ streamId: "user:user-2" }, "private_stream_mismatch"],
        ]) {
          const wire = structuredClone(fixture);
          wire.streamId = wire.payload.message.conversationId = destination;
          wire.payload.message.replyTo = { messageId: "source-message", notifyAuthor };
          const { message, ...envelope } = patch;
          Object.assign(wire, envelope);
          Object.assign(wire.payload.message, message);
          assertRejection(wire, code);
        }
      }
    });
  }
}

function assertRejection(wire, code) {
  assert.throws(() => parseKnownDurableEvent(wire, trustedIdentity), (error) => {
    assert.ok(error instanceof DurableEventParseError);
    assert.equal(error.code, code);
    assert.equal(error.message, {
      incoherent_payload: "The durable event payload is malformed or incoherent with its stream.",
      tenant_mismatch: "The durable event does not belong to the trusted tenant.",
      private_stream_mismatch: "The durable event does not belong to the trusted private user stream.",
    }[code]);
    return true;
  });
}

test("strict parser accepts one shared fixture for every registry entry", () => {
  assert.equal(fixtures.valid.length, 21);
  assert.deepEqual(
    new Set(fixtures.valid.map((event) => event.type)),
    new Set(Object.values(CHAT_DURABLE_EVENT_TYPES)),
  );
  for (const fixture of fixtures.valid) {
    const parsed = parseKnownDurableEvent(structuredClone(fixture), trustedIdentity);
    assert.deepEqual(parsed, fixture, fixture.type);
    assert.ok(Object.isFrozen(parsed.payload));
  }
});

test("strict parser returns stable payload-safe rejection categories", () => {
  for (const { code, event } of Object.values(fixtures.rejections)) {
    assert.throws(
      () => parseKnownDurableEvent(structuredClone(event), trustedIdentity),
      (error) => {
        assert.ok(error instanceof DurableEventParseError);
        assert.equal(error.code, code);
        assert.ok(!error.message.includes(JSON.stringify(event.payload)));
        return true;
      },
    );
  }
});

test("the generic session event parser remains forward compatible", () => {
  const future = fixtures.rejections.unknownType.event;
  const generic = parseChatEvent(structuredClone(future), trustedIdentity.tenantId);
  assert.equal(generic.type, "future.event");
  assert.deepEqual(generic.payload, {});
  assert.throws(
    () => parseKnownDurableEvent(generic, trustedIdentity),
    (error) => error instanceof DurableEventParseError && error.code === "unknown_event_type",
  );
});

const threadNames = JSON.parse(await readFile("conformance-tests/thread-names.json", "utf8"));
const threadEvent = fixtures.valid.find(event => event.type === "thread.created");

test("thread.created retains exact supplied names and legacy omission", () => {
  for (const visibility of ["public", "private"]) {
    for (const name of [undefined, ...threadNames.valid]) {
      const wire = structuredClone(threadEvent);
      wire.payload.conversation.visibility = visibility;
      if (name !== undefined) wire.payload.conversation.name = name;
      const parsed = parseKnownDurableEvent(wire, trustedIdentity);
      assert.deepEqual(parsed, wire);
      assert.equal(Object.hasOwn(parsed.payload.conversation, "name"), name !== undefined);
      assert.equal(parsed.payload.conversation.name, name);
      assert.deepEqual(parseKnownDurableEvent(JSON.parse(JSON.stringify(parsed)), trustedIdentity), wire);
      assert.ok(Object.isFrozen(parsed.payload.conversation));
    }
  }
});

test("thread.created rejects invalid supplied names without changing its error contract", () => {
  for (const name of [...threadNames.invalid, undefined]) {
    const wire = structuredClone(threadEvent);
    wire.payload.conversation.name = name;
    assertRejection(wire, "incoherent_payload");
  }
});

test("named thread.created retains parent, root, visibility and routing invariants", () => {
  for (const patch of [
    ...["parentConversationId", "rootMessageId"].flatMap(field =>
      [undefined, null, "", 7].map(value => ({ [field]: value }))),
    { visibility: "invited" }, { visibility: null },
  ]) {
    const wire = structuredClone(threadEvent);
    Object.assign(wire.payload.conversation, { name: "Launch 🚀" }, patch);
    assertRejection(wire, "incoherent_payload");
  }
  const wire = structuredClone(threadEvent);
  wire.payload.conversation.name = "Launch 🚀";
  wire.payload.conversation.id = "other-thread";
  assertRejection(wire, "incoherent_payload");
});


const replyStyles = JSON.parse(await readFile("conformance-tests/durable-events/reply-style-updated.json", "utf8"));
const replyStyleEvent = fixtures.valid.find(event => event.type === "reply.style.updated");
for (const fixture of replyStyles.valid) {
  test(`reply.style.updated round-trips ${fixture.name}`, () => {
    const wire = { ...structuredClone(replyStyleEvent), payload: structuredClone(fixture.payload) };
    const parsed = parseKnownDurableEvent(wire, trustedIdentity);
    assert.deepEqual(parsed, wire);
    assert.deepEqual(parseKnownDurableEvent(JSON.parse(JSON.stringify(parsed)), trustedIdentity), wire);
    assert.ok(Object.isFrozen(parsed.payload.preference));
    if (parsed.payload.mutation) assert.ok(Object.isFrozen(parsed.payload.mutation));
    wire.payload.preference.style = "changed-after-parse";
    assert.deepEqual(parsed.payload, fixture.payload);
  });
}
for (const [index, fixture] of replyStyles.rejections.entries()) {
  test(`reply.style.updated rejects ${index}: ${fixture.path}`, () => {
    const wire = structuredClone(replyStyleEvent);
    const parts = fixture.path.split(".");
    const key = parts.pop();
    const target = parts.reduce((value, part) => value[part], wire);
    if (fixture.remove) delete target[key];
    else target[key] = fixture.value;
    assertRejection(wire, fixture.code);
  });
}

const lifecycleFixtures = JSON.parse(await readFile("conformance-tests/thread-lifecycle.json", "utf8"));
const lifecycleEvents = fixtures.valid.filter(event => event.type.startsWith("thread.lifecycle."));

for (const fixture of lifecycleEvents) {
  test(`${fixture.type} preserves authoritative revisions and enforces its own conversation stream`, () => {
    for (const state of lifecycleFixtures.valid) {
      const wire = structuredClone(fixture);
      if (wire.type === "thread.lifecycle.updated") wire.payload.threadLifecycle = state;
      else wire.payload.revision = state.revision;
      const parsed = parseKnownDurableEvent(wire, trustedIdentity);
      assert.deepEqual(parsed, wire);
      assert.deepEqual(parseKnownDurableEvent(JSON.parse(JSON.stringify(parsed)), trustedIdentity), wire);
      const opposite = wire.streamId === wire.payload.threadId ? wire.payload.parentConversationId : wire.payload.threadId;
      for (const streamId of [opposite, "unrelated", "user:user-1", "user:user-2"]) {
        assertRejection({ ...wire, streamId }, streamId.startsWith("user:") ? "private_stream_mismatch" : "incoherent_payload");
      }
      assertRejection({ ...wire, tenantId: "other-tenant" }, "tenant_mismatch");
    }
  });

  test(`${fixture.type} rejects malformed identities, lifecycle and private extras`, () => {
    const field = fixture.type === "thread.lifecycle.updated" ? "threadLifecycle" : "revision";
    const invalid = field === "revision" ? lifecycleFixtures.invalidRevisions : lifecycleFixtures.invalid;
    for (const value of [...invalid, undefined]) {
      const wire = structuredClone(fixture);
      wire.payload[field] = value;
      assertRejection(wire, "incoherent_payload");
    }
    for (const field of Object.keys(fixture.payload)) {
      const wire = structuredClone(fixture);
      delete wire.payload[field];
      assertRejection(wire, "incoherent_payload");
    }
    for (const field of ["threadId", "parentConversationId"]) {
      for (const value of [null, "", " spaced ", 7]) {
        assertRejection({ ...fixture, payload: { ...fixture.payload, [field]: value } }, "incoherent_payload");
      }
    }
    assertRejection({ ...fixture, payload: { ...fixture.payload, threadId: fixture.streamId, parentConversationId: fixture.streamId } }, "incoherent_payload");
    for (const [key, value] of Object.entries(lifecycleFixtures.privateExtras)) {
      assertRejection({ ...fixture, payload: { ...fixture.payload, [key]: value } }, "incoherent_payload");
    }
    if (field === "revision") {
      assertRejection({ ...fixture, payload: { ...fixture.payload, threadLifecycle: lifecycleFixtures.valid[0] } }, "incoherent_payload");
    }
  });
}

for (const type of ["conversation.created", "thread.created"]) {
  test(`${type} reuses lifecycle validation while preserving names, archive and legacy absence`, () => {
    const fixture = structuredClone(fixtures.valid.find(event => event.type === "thread.created"));
    fixture.type = type;
    if (type === "conversation.created") delete fixture.payload.rootThreadSummary;
    for (const state of [undefined, ...lifecycleFixtures.valid]) {
      for (const archived of [false, true]) {
        const wire = structuredClone(fixture);
        Object.assign(wire.payload.conversation, { name: "Launch 🚀", ...(state ? { threadLifecycle: state } : {}), ...(archived ? { archivedAt: wire.occurredAt, archivedByUserId: "archiver" } : {}) });
        const parsed = parseKnownDurableEvent(wire, trustedIdentity);
        assert.deepEqual(parsed, wire);
        assert.deepEqual(parseKnownDurableEvent(JSON.parse(JSON.stringify(parsed)), trustedIdentity), wire);
      }
    }
    for (const state of [...lifecycleFixtures.invalid, undefined]) {
      const wire = structuredClone(fixture);
      wire.payload.conversation.threadLifecycle = state;
      assertRejection(wire, "incoherent_payload");
    }
    for (const type of ["channel", "direct", "group_direct"]) {
      const wire = structuredClone(fixtures.valid.find(event => event.type === "conversation.created"));
      Object.assign(wire.payload.conversation, { type, visibility: "private", threadLifecycle: lifecycleFixtures.valid[0] });
      assertRejection(wire, "incoherent_payload");
    }
    const wire = structuredClone(fixture);
    wire.payload.conversation.threadLifecycle = lifecycleFixtures.valid[0];
    wire.payload.conversation.tenantId = "other-tenant";
    assertRejection(wire, "tenant_mismatch");
  });
}
