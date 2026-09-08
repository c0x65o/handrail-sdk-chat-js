import assert from "node:assert/strict";
import test from "node:test";
import { createNormalizedChatCache } from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const now = "2026-09-07T00:00:00.000Z";
const thread = { id: "thread", tenantId: "tenant", type: "thread", visibility: "public",
  parentConversationId: "channel", rootMessageId: "root", name: "Launch date decision",
  createdAt: now, updatedAt: now };
const created = (eventId, conversation) => ({ eventId, protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId: "tenant", streamId: "thread", type: "thread.created", occurredAt: now,
  payload: { conversation } });
const cache = () => createNormalizedChatCache({ tenantId: "tenant", userId: "bob", sessionId: "session" });

test("thread creation events preserve the canonical name and supplied lifecycle", () => {
  const c = cache();
  const threadLifecycle = { revision: 1, locked: false };
  c.applyDurableEvent(created("first", { ...thread, threadLifecycle }));
  assert.equal(c.getState().entities.conversations.thread.name, thread.name);
  assert.deepEqual(c.getState().entities.conversations.thread.threadLifecycle, threadLifecycle);
});

test("legacy or older creation replay cannot erase a hydrated thread lifecycle", () => {
  for (const older of [undefined, { revision: 1, locked: false }]) {
    const c = cache();
    const threadLifecycle = { revision: 3, locked: true, closedAt: now, closedByUserId: "alice" };
    c.applyDurableEvent(created("current", { ...thread, threadLifecycle }));
    c.applyDurableEvent({ ...created("replayed", { ...thread, ...(older === undefined ? {} : { threadLifecycle: older }) }),
      occurredAt: "2026-09-07T00:00:01.000Z" });
    assert.equal(c.getState().entities.conversations.thread.name, thread.name);
    assert.deepEqual(c.getState().entities.conversations.thread.threadLifecycle, threadLifecycle);
  }
});

test("malformed event thread metadata rejects atomically", () => {
  for (const invalid of [{ name: " " }, { threadLifecycle: { revision: 0, locked: false } }]) {
    const c = cache();
    const before = c.getState();
    assert.throws(() => c.applyDurableEvent(created("invalid", { ...thread, ...invalid })));
    assert.equal(c.getState(), before);
  }
});
