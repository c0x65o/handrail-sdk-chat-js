import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_DURABLE_EVENT_TYPES,
  DurableEventReductionError,
  createChatRealtimeSession,
  createNormalizedChatCache,
} from "../dist/client/index.js";
import {
  CHAT_PROTOCOL_VERSION,
  createReadCursorUpdatedEvent,
  parseKnownDurableEvent,
} from "../dist/index.js";
import {
  appliedMembershipResult,
  membershipInputs,
} from "./fixtures/conversation-membership-mutations.mjs";
import {
  allUnmutedInput,
  settledPreferenceResult,
} from "./fixtures/conversation-preference-mutations.mjs";
import {
  replaceDraftInput,
  settledDraftResult,
} from "./fixtures/draft-mutations.mjs";
import {
  saveMessageInput,
  settledSavedMessageResult,
} from "./fixtures/saved-message-mutations.mjs";

const tenantId = "tenant-a";
const userId = "user-actor";
const identity = { tenantId, userId, sessionId: "session-a" };
const at = (second) => `2026-08-26T06:00:${String(second).padStart(2, "0")}.000Z`;

const event = (eventId, streamId, type, payload, second = 0, overrides = {}) => ({
  eventId,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId,
  streamId,
  type,
  occurredAt: at(second),
  payload,
  ...overrides,
});

const conversation = (id = "conversation-1", overrides = {}) => ({
  id,
  tenantId,
  type: "channel",
  visibility: "public",
  name: "General",
  createdAt: at(0),
  updatedAt: at(0),
  memberUserIds: [userId, "user-b"],
  ...overrides,
});

const message = (id, conversationId, sequence, overrides = {}) => ({
  id,
  tenantId,
  conversationId,
  author: { type: "user", userId: "user-b" },
  sequence,
  createdAt: at(sequence),
  updatedAt: at(sequence),
  revision: { revision: 1 },
  content: { format: "plain", text: id },
  ...overrides,
});

test("table-driven durable families reduce canonical cache state atomically", () => {
  const cache = createNormalizedChatCache(identity);
  const parentId = "conversation-1";
  const threadId = "thread-1";
  const rootId = "message-root";

  const readEvent = createReadCursorUpdatedEvent({
    eventId: "read-1",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId,
    occurredAt: at(1),
    result: {
      operation: "mark_read",
      conversationId: parentId,
      readState: { conversationId: parentId, userId, lastReadSequence: 1, updatedAt: at(1) },
      latestSequence: 1,
      unreadCount: 0,
    },
  });

  const cases = [
    ["conversation lifecycle", event("conversation-1", parentId, CHAT_DURABLE_EVENT_TYPES.conversationCreated, { conversation: conversation() }, 0)],
    ["attachment", event("attachment-1", parentId, CHAT_DURABLE_EVENT_TYPES.attachmentUpdated, { attachment: { attachmentId: "attachment-1", fileName: "a.txt", contentType: "text/plain", sizeBytes: 3, downloadUrl: "/a" } }, 1)],
    ["message create", event("message-1", parentId, CHAT_DURABLE_EVENT_TYPES.messageCreated, { clientMessageId: "client-1", message: message(rootId, parentId, 1, { content: { format: "plain", text: "root", attachments: [{ attachmentId: "attachment-1" }] }, threadSummary: { threadId, replyCount: 0, participantIds: [], unreadCount: 0 } }) }, 2)],
    ["thread lifecycle", event("thread-create", threadId, CHAT_DURABLE_EVENT_TYPES.threadCreated, { conversation: conversation(threadId, { type: "thread", visibility: "public", parentConversationId: parentId, rootMessageId: rootId, memberUserIds: [userId, "user-b"] }) }, 0)],
    ["thread reply", event("reply-1", threadId, CHAT_DURABLE_EVENT_TYPES.messageCreated, { message: message("reply-1", threadId, 1) }, 1)],
    ["membership", event("member-1", parentId, CHAT_DURABLE_EVENT_TYPES.membershipUpdated, { input: membershipInputs.join, result: appliedMembershipResult(membershipInputs.join) }, 3)],
    ["reaction", event("reaction-1", parentId, CHAT_DURABLE_EVENT_TYPES.reactionUpdated, { operation: "add_reaction", messageId: rootId, reactionKey: "thumbsup", count: 1, reactedByCurrentUser: true }, 4)],
    ["message edit", event("edit-1", parentId, CHAT_DURABLE_EVENT_TYPES.messageUpdated, { message: message(rootId, parentId, 1, { createdAt: at(1), updatedAt: at(5), revision: { revision: 2, editedAt: at(5), editedByUserId: userId }, content: { format: "plain", text: "edited", attachments: [{ attachmentId: "attachment-1" }] }, threadSummary: { threadId, replyCount: 1, participantIds: ["user-b"], unreadCount: 1, lastReplyAt: at(1) } }) }, 5)],
    ["message delete", event("delete-1", parentId, CHAT_DURABLE_EVENT_TYPES.messageDeleted, { message: message(rootId, parentId, 1, { createdAt: at(1), updatedAt: at(6), revision: { revision: 3, editedAt: at(6), editedByUserId: userId }, content: null, deletedAt: at(6), deletedByUserId: userId, threadSummary: { threadId, replyCount: 1, participantIds: ["user-b"], unreadCount: 1, lastReplyAt: at(1) } }) }, 6)],
    ["thread summary", event("summary-1", parentId, CHAT_DURABLE_EVENT_TYPES.threadSummaryUpdated, { parentConversationId: parentId, rootMessageId: rootId, rootThreadSummary: { threadId, replyCount: 2, participantIds: [userId, "user-b"], unreadCount: 1, lastReplyAt: at(7) } }, 7)],
    ["huddle", event("huddle-1", parentId, CHAT_DURABLE_EVENT_TYPES.huddleUpdated, { state: { status: "inactive", conversationId: parentId } }, 8)],
    ["read cursor", readEvent],
    ["preference private state", event("preference-1", `user:${userId}`, CHAT_DURABLE_EVENT_TYPES.preferenceUpdated, { actorUserId: userId, input: { ...allUnmutedInput, conversationId: parentId }, result: settledPreferenceResult({ ...allUnmutedInput, conversationId: parentId }) }, 2)],
    ["draft private state", event("draft-1", `user:${userId}`, CHAT_DURABLE_EVENT_TYPES.draftUpdated, { actorUserId: userId, input: { ...replaceDraftInput, conversationId: parentId }, result: settledDraftResult({ ...replaceDraftInput, conversationId: parentId }) }, 3)],
    ["archive lifecycle", event("archive-1", parentId, CHAT_DURABLE_EVENT_TYPES.conversationArchived, { conversation: conversation(parentId, { updatedAt: at(9), archivedAt: at(9), archivedByUserId: userId }) }, 9)],
  ];

  for (const [name, durableEvent] of cases) {
    assert.equal(cache.applyDurableEvent(durableEvent).status, "applied", name);
    assert.equal(cache.getState().metadata.realtimeCursor.eventId, durableEvent.eventId, name);
  }

  const state = cache.getState();
  assert.deepEqual(state.timelines[parentId].messageIds, [rootId]);
  assert.deepEqual(state.timelines[threadId].messageIds, ["reply-1"]);
  assert.equal(state.entities.messages[rootId].sequence, 1, "edits preserve authoring sequence");
  assert.equal(state.entities.messages[rootId].revision.revision, 3);
  assert.equal(state.entities.messages[rootId].threadSummary.replyCount, 2);
  assert.equal(state.entities.messages[rootId].reactions[0].count, 1);
  assert.equal(state.entities.messages[rootId].reactions[0].reactedByCurrentUser, false);
  assert.deepEqual(state.entities.memberUserIdsByConversation[parentId], [userId, "user-b"]);
  assert.equal(state.currentUser.readStates[parentId].lastReadSequence, 1);
  assert.equal(state.currentUser.preferences[parentId].notificationPreference, "all");
  assert.equal(state.currentUser.drafts[parentId].kind, "replaced");
  assert.equal(state.huddles[parentId].status, "inactive");
});

for (const [name, threadOverrides, rejects] of [
  ["wrong cached type", { type: "channel" }, true],
  ["wrong parent", { parentConversationId: "conversation-other" }, true],
  ["wrong root", { rootMessageId: "message-other" }, true],
  ["matching thread", {}, false],
  ["absent thread", null, false],
]) {
  test(`parsed thread summary identity: ${name}`, () => {
    const cache = createNormalizedChatCache(identity);
    const parentId = "conversation-1";
    const threadId = "thread-1";
    const rootId = "message-root";
    const initialSummary = { threadId, replyCount: 0, participantIds: [], unreadCount: 0 };
    const seeds = [
      event("seed-parent", parentId, CHAT_DURABLE_EVENT_TYPES.conversationCreated,
        { conversation: conversation(parentId) }, 0),
      event("seed-root", parentId, CHAT_DURABLE_EVENT_TYPES.messageCreated, {
        clientMessageId: "client-root",
        message: message(rootId, parentId, 1, { threadSummary: initialSummary }),
      }, 1),
    ];
    if (threadOverrides !== null) {
      const cached = conversation(threadId, threadOverrides.type === "channel"
        ? threadOverrides
        : { type: "thread", parentConversationId: parentId, rootMessageId: rootId, ...threadOverrides });
      seeds.push(event("seed-thread", threadId, cached.type === "thread"
        ? CHAT_DURABLE_EVENT_TYPES.threadCreated : CHAT_DURABLE_EVENT_TYPES.conversationCreated,
      { conversation: cached, ...(cached.type === "thread" ? { rootThreadSummary: initialSummary } : {}) }, 2));
    }
    for (const seed of seeds) {
      assert.equal(cache.applyDurableEvent(parseKnownDurableEvent(seed, identity)).status, "applied");
    }

    const summary = { threadId, replyCount: 2, participantIds: [userId, "user-b"], unreadCount: 1, lastReplyAt: at(3) };
    const incoming = event("summary-update", parentId, CHAT_DURABLE_EVENT_TYPES.threadSummaryUpdated,
      { parentConversationId: parentId, rootMessageId: rootId, rootThreadSummary: summary }, 3);
    let parsed;
    assert.doesNotThrow(() => { parsed = parseKnownDurableEvent(incoming, identity); },
      "the canonical event must parse before checking cached identity");
    assert.deepEqual(parsed, incoming);
    const before = cache.getState();
    const snapshot = structuredClone(before);
    assert.ok(Object.values(before.metadata.durableStreams)
      .every((stream) => Date.parse(stream.lastOccurredAt) < Date.parse(parsed.occurredAt)));

    if (rejects) {
      assert.throws(() => cache.applyDurableEvent(parsed), (error) => {
        assert.ok(error instanceof DurableEventReductionError);
        assert.equal(error.diagnostic.reason, "event_invalid");
        assert.equal(error.diagnostic.code, "incoherent_payload");
        return true;
      });
      assert.equal(cache.getState(), before, "rejection preserves the whole cache reference");
      assert.deepEqual(cache.getState(), snapshot, "rejection cannot mutate cache contents");
      assert.deepEqual(cache.getState().metadata.realtimeCursor, snapshot.metadata.realtimeCursor);
      assert.deepEqual(cache.getState().metadata.durableStreams, snapshot.metadata.durableStreams);
      return;
    }

    assert.equal(cache.applyDurableEvent(parsed).status, "applied");
    const after = cache.getState();
    assert.deepEqual(after.entities.messages[rootId].threadSummary, summary);
    assert.equal(after.entities.messages[rootId].isThreadRoot, true);
    assert.deepEqual(after.metadata.realtimeCursor, { eventId: parsed.eventId });
    assert.deepEqual(after.metadata.durableStreams[parentId], {
      lastEventId: parsed.eventId,
      lastOccurredAt: parsed.occurredAt,
      recentEventIds: [...before.metadata.durableStreams[parentId].recentEventIds, parsed.eventId],
    });
    assert.equal(after.entities.conversations, before.entities.conversations);
    if (threadOverrides === null) {
      assert.equal(Object.hasOwn(after.entities.conversations, threadId), false,
        "a summary must not populate an absent thread conversation");
    }
    const appliedSnapshot = structuredClone(after);
    assert.equal(cache.applyDurableEvent(parsed).status, "duplicate");
    assert.equal(cache.getState(), after, "exact replay preserves the whole cache reference");
    assert.deepEqual(cache.getState(), appliedSnapshot);
  });
}

for (const [clock, occurredAt] of [
  ["tied", "2026-08-26T06:00:05.123Z"],
  ["1ms earlier", "2026-08-26T06:00:05.122Z"],
]) {
  const parentId = "conversation-1";
  const rootId = "message-root";
  const threadId = "thread-1";
  const highWater = "2026-08-26T06:00:05.123Z";
  const summary = (replyCount, overrides = {}) => ({
    threadId, replyCount, participantIds: [userId, "user-b"],
    unreadCount: 0, lastReplyAt: at(4), ...overrides,
  });
  const summaryEvent = (eventId, rootMessageId, rootThreadSummary, time = occurredAt) =>
    parseKnownDurableEvent(event(eventId, parentId, CHAT_DURABLE_EVENT_TYPES.threadSummaryUpdated,
      { parentConversationId: parentId, rootMessageId, rootThreadSummary }, 0, { occurredAt: time }), identity);
  const seed = (rootOverrides = {}) => {
    const cache = createNormalizedChatCache(identity);
    for (const incoming of [
      event("seed-parent", parentId, CHAT_DURABLE_EVENT_TYPES.conversationCreated,
        { conversation: conversation(parentId) }),
      event("seed-root", parentId, CHAT_DURABLE_EVENT_TYPES.messageCreated,
        { clientMessageId: "client-root", message: message(rootId, parentId, 1, rootOverrides) }, 1),
    ]) {
      assert.equal(cache.applyDurableEvent(parseKnownDurableEvent(incoming, identity)).status, "applied");
    }
    return cache;
  };
  const advanceClock = (cache) => {
    const incoming = event("parent-high-water", parentId, CHAT_DURABLE_EVENT_TYPES.huddleUpdated,
      { state: { status: "inactive", conversationId: parentId } }, 0, { occurredAt: highWater });
    assert.equal(cache.applyDurableEvent(parseKnownDurableEvent(incoming, identity)).status, "applied");
  };
  const assertArrival = (before, after, incoming) => {
    assert.deepEqual(after.metadata.realtimeCursor, { eventId: incoming.eventId });
    assert.deepEqual(after.metadata.durableStreams[parentId], {
      lastEventId: incoming.eventId,
      lastOccurredAt: highWater,
      recentEventIds: [...before.metadata.durableStreams[parentId].recentEventIds, incoming.eventId],
    });
    assert.ok(Date.parse(after.metadata.durableStreams[parentId].lastOccurredAt)
      >= Date.parse(before.metadata.durableStreams[parentId].lastOccurredAt));
  };

  test(`parsed thread summary progress for independent roots with ${clock} clocks`, () => {
    const otherRootId = "message-root-2";
    const cache = seed({ threadSummary: summary(2) });
    const secondRoot = event("seed-root-2", parentId, CHAT_DURABLE_EVENT_TYPES.messageCreated,
      { clientMessageId: "client-root-2", message: message(otherRootId, parentId, 2, {
        threadSummary: summary(0, { threadId: "thread-2", participantIds: [] }),
      }) }, 2);
    assert.equal(cache.applyDurableEvent(parseKnownDurableEvent(secondRoot, identity)).status, "applied");
    advanceClock(cache);

    for (const [id, root, accepted] of [
      ["root-1-progress", rootId, summary(3)],
      ["root-2-progress", otherRootId, summary(1, { threadId: "thread-2" })],
      ["root-1-more", rootId, summary(4, { lastReplyAt: at(3) })],
      ["root-2-more", otherRootId, summary(2, { threadId: "thread-2", participantIds: [userId] })],
    ]) {
      const incoming = summaryEvent(id, root, accepted);
      const before = cache.getState();
      assert.equal(Date.parse(highWater) - Date.parse(incoming.occurredAt), clock === "tied" ? 0 : 1);
      assert.equal(cache.applyDurableEvent(incoming).status, "applied", id);
      const after = cache.getState();
      assert.deepEqual(after.entities.messages[root], {
        ...before.entities.messages[root], isThreadRoot: true, threadSummary: accepted,
      });
      const untouchedRoot = root === rootId ? otherRootId : rootId;
      assert.equal(after.entities.messages[untouchedRoot], before.entities.messages[untouchedRoot]);
      assertArrival(before, after, incoming);
    }
  });

  test(`parsed thread summary replay preserves facts and tracks arrival with ${clock} clocks`, () => {
    const cache = seed();
    const accepted = summaryEvent("accepted-summary", rootId, summary(3), at(4));
    assert.equal(cache.applyDurableEvent(accepted).status, "applied");
    advanceClock(cache);
    const acceptedRoot = cache.getState().entities.messages[rootId];
    const acceptedSnapshot = structuredClone(acceptedRoot);
    for (const [name, replyCount] of [["lower", 1], ["equal", 3]]) {
      const incoming = summaryEvent(`${name}-progress`, rootId,
        summary(replyCount, { participantIds: ["user-other"], lastReplyAt: at(2) }));
      const before = cache.getState();
      assert.equal(cache.applyDurableEvent(incoming).status, "applied");
      const after = cache.getState();
      assert.equal(after.entities.messages[rootId], acceptedRoot);
      assert.deepEqual(after.entities.messages[rootId], acceptedSnapshot);
      assert.equal(after.entities.messages[rootId].isThreadRoot, true);
      assert.equal(after.entities, before.entities);
      assertArrival(before, after, incoming);

      for (const exactReplay of [incoming, accepted]) {
        const snapshot = structuredClone(after);
        assert.equal(cache.applyDurableEvent(exactReplay).status, "duplicate");
        assert.equal(cache.getState(), after, "exact replay preserves state and cannot rewind the cursor");
        assert.deepEqual(cache.getState(), snapshot);
      }
    }
  });

  test(`parsed thread summary initializes zero replies without loading the thread with ${clock} clocks`, () => {
    const cache = seed();
    advanceClock(cache);
    const before = cache.getState();
    assert.equal(before.entities.messages[rootId].threadSummary, undefined);
    assert.equal(before.entities.messages[rootId].isThreadRoot, false);
    const initial = { threadId, replyCount: 0, participantIds: [], unreadCount: 0 };
    const incoming = summaryEvent("zero-summary", rootId, initial);
    assert.equal(cache.applyDurableEvent(incoming).status, "applied");
    const after = cache.getState();
    assert.deepEqual(after.entities.messages[rootId], {
      ...before.entities.messages[rootId], isThreadRoot: true, threadSummary: initial,
    });
    assert.equal(after.entities.conversations, before.entities.conversations);
    assert.equal(Object.hasOwn(after.entities.conversations, threadId), false);
    assertArrival(before, after, incoming);
  });

  for (const [name, overrides] of [
    ["wrong cached type", { type: "channel" }],
    ["wrong parent", { parentConversationId: "conversation-other" }],
    ["wrong root", { rootMessageId: "message-other" }],
  ]) {
    test(`parsed thread summary identity rejects ${name} with ${clock} clocks`, () => {
      const cache = seed({ threadSummary: summary(2) });
      const cached = conversation(threadId, overrides.type === "channel" ? overrides
        : { type: "thread", parentConversationId: parentId, rootMessageId: rootId, ...overrides });
      const thread = event("seed-thread", threadId, CHAT_DURABLE_EVENT_TYPES.conversationCreated,
        { conversation: cached }, 2);
      assert.equal(cache.applyDurableEvent(parseKnownDurableEvent(thread, identity)).status, "applied");
      advanceClock(cache);
      // Identity validation must precede both reply-progress no-ops and replacement.
      for (const replyCount of [1, 2, 3]) {
        let incoming;
        assert.doesNotThrow(() => { incoming = summaryEvent(`conflict-${replyCount}`, rootId, summary(replyCount)); },
          "canonical parsing succeeds before cached identity rejection");
        const before = cache.getState();
        const snapshot = structuredClone(before);
        assert.throws(() => cache.applyDurableEvent(incoming), (error) => {
          assert.ok(error instanceof DurableEventReductionError);
          assert.equal(error.diagnostic.reason, "event_invalid");
          assert.equal(error.diagnostic.code, "incoherent_payload");
          return true;
        });
        assert.equal(cache.getState(), before);
        assert.deepEqual(cache.getState(), snapshot, "rejection preserves all root facts, cursor and stream metadata");
      }
    });
  }
}

test("duplicates and stale events are no-ops while gaps and invalid events roll back", () => {
  const cache = createNormalizedChatCache(identity);
  const created = event("created", "conversation-1", CHAT_DURABLE_EVENT_TYPES.conversationCreated, { conversation: conversation() }, 1);
  cache.applyDurableEvent(created);
  const beforeDuplicate = cache.getState();
  assert.equal(cache.applyDurableEvent(created).status, "duplicate");
  assert.equal(cache.getState(), beforeDuplicate);

  const stale = event("stale", "conversation-1", CHAT_DURABLE_EVENT_TYPES.conversationArchived, { conversation: conversation("conversation-1", { updatedAt: at(0) }) }, 0);
  assert.equal(cache.applyDurableEvent(stale).status, "stale");
  assert.equal(cache.getState(), beforeDuplicate);

  const failures = [
    ["ambiguous order", event("ambiguous", "conversation-1", CHAT_DURABLE_EVENT_TYPES.huddleUpdated, { state: { status: "inactive", conversationId: "conversation-1" } }, 1), "event_gap"],
    ["gap", event("gap", "conversation-1", CHAT_DURABLE_EVENT_TYPES.messageCreated, { message: message("message-gap", "conversation-1", 4) }, 2), "event_gap"],
    ["unknown", event("unknown", "conversation-1", "future.event", {}, 2), "event_incompatible"],
    ["tenant", event("tenant", "conversation-1", CHAT_DURABLE_EVENT_TYPES.huddleUpdated, {}, 2, { tenantId: "tenant-b" }), "event_invalid"],
    ["private", event("private", "user:user-other", CHAT_DURABLE_EVENT_TYPES.draftUpdated, {}, 2), "event_invalid"],
  ];
  for (const [name, invalidEvent, reason] of failures) {
    const before = cache.getState();
    assert.throws(() => cache.applyDurableEvent(invalidEvent), (error) => error instanceof DurableEventReductionError && error.diagnostic.reason === reason, name);
    assert.equal(cache.getState(), before, `${name} must roll back atomically`);
    assert.equal(cache.getState().metadata.realtimeCursor.eventId, "created");
  }
});

for (const [intent, type, previousRevision] of [
  ["archive", CHAT_DURABLE_EVENT_TYPES.conversationArchived, 1],
  ["restore", CHAT_DURABLE_EVENT_TYPES.conversationRestored, 2],
]) {
  for (const [clock, occurredAt] of [
    ["1ms older", "2026-08-26T06:00:05.122Z"],
    ["tied", "2026-08-26T06:00:05.123Z"],
    ["1ms newer", "2026-08-26T06:00:05.124Z"],
  ]) {
    const id = "conversation-1";
    const highWater = "2026-08-26T06:00:05.123Z";
    const expectedHighWater = occurredAt > highWater ? occurredAt : highWater;
    const payload = {
      conversationId: id,
      intent,
      previousState: intent === "archive" ? "active" : "archived",
      currentState: intent === "archive" ? "archived" : "active",
      previousLifecycleRevision: previousRevision,
      currentLifecycleRevision: previousRevision + 1,
    };
    const incoming = event("lifecycle-transition", id, type, payload, 0, { occurredAt });
    const seed = (knownRevision = previousRevision) => {
      const cache = createNormalizedChatCache(identity);
      cache.applyDurableEvent(event("seed", id, CHAT_DURABLE_EVENT_TYPES.conversationCreated,
        { conversation: conversation(id, intent === "restore"
          ? { archivedAt: at(0), archivedByUserId: userId } : {}) }));
      if (knownRevision > 1) {
        const knownIntent = knownRevision % 2 === 0 ? "archive" : "restore";
        cache.applyDurableEvent(event("known-lifecycle", id, knownIntent === "archive"
          ? CHAT_DURABLE_EVENT_TYPES.conversationArchived : CHAT_DURABLE_EVENT_TYPES.conversationRestored, {
          ...payload, intent: knownIntent,
          previousState: knownIntent === "archive" ? "active" : "archived",
          currentState: knownIntent === "archive" ? "archived" : "active",
          previousLifecycleRevision: knownRevision - 1,
          currentLifecycleRevision: knownRevision,
        }, 1));
      }
      cache.applyDurableEvent(event("message-high-water", id, CHAT_DURABLE_EVENT_TYPES.messageCreated,
        { message: message("message-1", id, 1) }, 0, { occurredAt: highWater }));
      cache.beginConversationOperation({ logicalKey: "archive", family: "archive",
        conversationId: id, idempotencyKey: "lifecycle-request" });
      return cache;
    };
    const assertTransport = (state, delivery, timestampHighWater) => {
      assert.equal(state.metadata.realtimeCursor.eventId, delivery.eventId);
      assert.equal(state.metadata.durableStreams[id].lastEventId, delivery.eventId);
      assert.equal(state.metadata.durableStreams[id].lastOccurredAt, timestampHighWater);
      assert.equal(state.metadata.durableStreams[id].recentEventIds.at(-1), delivery.eventId);
    };

    test(`canonical lifecycle ${intent} advances revision and survives replay with ${clock} clocks`, () => {
      const cache = seed();
      const before = cache.getState();
      assert.equal(cache.applyDurableEvent(incoming).status, "applied");
      const after = cache.getState();
      assert.equal(after.metadata.lifecycleRevisions[id], previousRevision + 1);
      assert.equal(after.entities, before.entities, "transition metadata does not fabricate a full snapshot");
      assert.deepEqual(after.metadata.pendingConversationOperations, {});
      assertTransport(after, incoming, expectedHighWater);
      assert.equal(cache.applyDurableEvent(incoming).status, "duplicate");
      assert.equal(cache.getState(), after);

      const subsequent = event("subsequent-message", id, CHAT_DURABLE_EVENT_TYPES.messageCreated,
        { message: message("message-2", id, 2) }, 6);
      assert.equal(cache.applyDurableEvent(subsequent).status, "applied");
      const afterSubsequent = cache.getState();
      assert.equal(cache.applyDurableEvent(incoming).status, "duplicate");
      assert.equal(cache.getState(), afterSubsequent, "replay after subsequent delivery preserves all state");
      assert.equal(afterSubsequent.metadata.lifecycleRevisions[id], previousRevision + 1);
      assertTransport(afterSubsequent, subsequent, at(6));
    });

    test(`canonical lifecycle ${intent} lower revision preserves canonical state with ${clock} clocks`, () => {
      const cache = seed(previousRevision + 3);
      const before = cache.getState();
      assert.equal(cache.applyDurableEvent(incoming).status, "applied");
      const after = cache.getState();
      assert.equal(after.metadata.lifecycleRevisions, before.metadata.lifecycleRevisions);
      assert.equal(after.metadata.lifecycleRevisions[id], previousRevision + 3);
      assert.equal(after.entities, before.entities);
      assert.equal(after.metadata.pendingConversationOperations, before.metadata.pendingConversationOperations,
        "lower revisions retain the existing pending-operation behavior");
      assertTransport(after, incoming, expectedHighWater);
      assert.equal(cache.applyDurableEvent(incoming).status, "duplicate");
      assert.equal(cache.getState(), after);
    });

    test(`canonical lifecycle ${intent} validates atomically with ${clock} clocks`, () => {
      for (const [name, overrides] of [
        ["wrong stream", { streamId: "conversation-other" }],
        ["wrong intent", { payload: { ...payload, intent: "invalid" } }],
        ["wrong previous state", { payload: { ...payload, previousState: payload.currentState } }],
        ["wrong current state", { payload: { ...payload, currentState: payload.previousState } }],
        ["nonconsecutive revisions", { payload: { ...payload, currentLifecycleRevision: previousRevision + 2 } }],
        ["nonpositive revision", { payload: { ...payload, previousLifecycleRevision: 0 } }],
        ["missing revision", { payload: { ...payload, currentLifecycleRevision: undefined } }],
        ["malformed payload", { payload: null }],
      ]) {
        const cache = seed();
        const rejected = { ...incoming, ...overrides };
        if (rejected.streamId !== id) {
          cache.applyDurableEvent(event("seed-other", rejected.streamId, CHAT_DURABLE_EVENT_TYPES.conversationCreated,
            { conversation: conversation(rejected.streamId) }, 0, { occurredAt: highWater }));
        }
        const before = cache.getState();
        const snapshot = structuredClone(before);
        assert.equal(before.metadata.durableStreams[rejected.streamId].lastOccurredAt, highWater);
        assert.throws(() => cache.applyDurableEvent(rejected), (error) =>
          error instanceof DurableEventReductionError &&
          error.diagnostic.code === "incoherent_payload" && error.diagnostic.reason === "event_invalid", name);
        assert.equal(cache.getState(), before, name);
        assert.deepEqual(cache.getState(), snapshot, name);
        assert.equal(cache.getState().metadata.realtimeCursor, before.metadata.realtimeCursor);
        assert.equal(cache.getState().metadata.durableStreams, before.metadata.durableStreams);
        assert.equal(cache.applyDurableEvent(incoming).status, "applied", "corrected delivery reuses rejected event ID");
        assert.equal(cache.getState().metadata.lifecycleRevisions[id], previousRevision + 1);
        assertTransport(cache.getState(), incoming, expectedHighWater);
      }
    });

    test(`legacy lifecycle ${intent} snapshot retains timestamp admission with ${clock} clocks`, () => {
      // Even extra revision fields must not override the full-snapshot branch.
      for (const extra of [{}, payload]) {
        const cache = seed();
        const before = cache.getState();
        const snapshot = conversation(id, { updatedAt: at(9),
          ...(intent === "archive" ? { archivedAt: at(9), archivedByUserId: userId } : {}) });
        const legacy = { ...incoming, payload: { ...extra, conversation: snapshot } };
        if (clock === "tied") {
          assert.throws(() => cache.applyDurableEvent(legacy), (error) =>
            error instanceof DurableEventReductionError && error.diagnostic.code === "ordering_gap");
          assert.equal(cache.getState(), before);
        } else if (clock === "1ms older") {
          assert.equal(cache.applyDurableEvent(legacy).status, "stale");
          assert.equal(cache.getState(), before);
        } else {
          assert.equal(cache.applyDurableEvent(legacy).status, "applied");
          assert.equal(cache.getState().entities.conversations[id].archivedAt, snapshot.archivedAt);
          assert.equal(cache.getState().entities.conversations[id].updatedAt, snapshot.updatedAt);
          assert.equal(cache.getState().metadata.lifecycleRevisions, before.metadata.lifecycleRevisions);
          assert.deepEqual(cache.getState().metadata.pendingConversationOperations, {});
          assertTransport(cache.getState(), legacy, occurredAt);
        }
      }
    });
  }
}

for (const [clock, occurredAt] of [
  ["tied", "2026-08-26T06:00:01.123Z"],
  ["1ms older", "2026-08-26T06:00:01.122Z"],
]) {
  const highWater = "2026-08-26T06:00:01.123Z";
  const conversationId = "conversation-1";
  // Message payload timestamps follow canonical sequence independently of envelope clocks.
  const first = event("message-first", conversationId, CHAT_DURABLE_EVENT_TYPES.messageCreated,
    { message: message("message-1", conversationId, 1) }, 0, { occurredAt: highWater });
  const second = event("message-second", conversationId, CHAT_DURABLE_EVENT_TYPES.messageCreated,
    { message: message("message-2", conversationId, 2) }, 0, { occurredAt });

  test(`message.created sequences and replays preserve canonical state with ${clock} clocks`, () => {
    const cache = createNormalizedChatCache(identity);
    cache.applyDurableEvent(event("seed", conversationId, CHAT_DURABLE_EVENT_TYPES.conversationCreated,
      { conversation: conversation(conversationId) }));
    const knownMessage = { ...first, eventId: "message-known", occurredAt };
    const accepted = [];
    for (const incoming of [first, second, knownMessage]) {
      assert.equal(cache.applyDurableEvent(incoming).status, "applied");
      accepted.push(incoming);
      const after = cache.getState();
      const canonical = incoming === first ? [first.payload.message] : [first.payload.message, second.payload.message];
      assert.deepEqual(after.entities.messages, Object.fromEntries(canonical.map((value) => [value.id, {
        ...value, reactions: [], attachmentMetadata: [], isThreadRoot: false,
      }])));
      assert.deepEqual(after.timelines[conversationId].messageIds, canonical.map((value) => value.id));
      assert.equal(after.metadata.conversations[conversationId].latestSequence, canonical.length);
      assert.equal(after.metadata.realtimeCursor.eventId, incoming.eventId);
      assert.equal(after.metadata.durableStreams[conversationId].lastEventId, incoming.eventId);
      assert.equal(after.metadata.durableStreams[conversationId].lastOccurredAt, highWater);

      for (const replay of accepted) {
        assert.equal(cache.applyDurableEvent(replay).status, "duplicate");
        assert.equal(cache.getState(), after, "exact replay preserves the entire state, even after later acceptance");
        assert.equal(cache.getState().metadata.realtimeCursor.eventId, incoming.eventId);
      }
    }
  });

  for (const [name, streamId, sequence, reason] of [
    ["sequence jump", conversationId, 3, "event_gap"],
    ["mismatched conversation stream", "conversation-other", 2, "event_invalid"],
  ]) {
    test(`message.created ${name} rejects atomically with ${clock} clocks`, () => {
      const cache = createNormalizedChatCache(identity);
      cache.applyDurableEvent(event("seed", conversationId, CHAT_DURABLE_EVENT_TYPES.conversationCreated,
        { conversation: conversation(conversationId) }));
      assert.equal(cache.applyDurableEvent(first).status, "applied");
      if (streamId !== conversationId) {
        cache.applyDurableEvent(event("seed-other", streamId, CHAT_DURABLE_EVENT_TYPES.conversationCreated,
          { conversation: conversation(streamId) }, 0, { occurredAt: highWater }));
      }
      const invalid = event("message-invalid", streamId, CHAT_DURABLE_EVENT_TYPES.messageCreated,
        { message: message("message-invalid", conversationId, sequence) }, 0, { occurredAt });
      const before = cache.getState();
      const snapshot = structuredClone(before);
      assert.equal(before.metadata.durableStreams[streamId].lastOccurredAt, highWater,
        "the envelope stream must already have an equal or greater timestamp high-water");
      assert.throws(() => cache.applyDurableEvent(invalid), (error) =>
        error instanceof DurableEventReductionError && error.diagnostic.reason === reason);
      assert.equal(cache.getState(), before, "rejection preserves the entire cache atomically");
      assert.deepEqual(cache.getState(), snapshot);
      assert.equal(cache.getState().metadata.realtimeCursor, before.metadata.realtimeCursor);
      assert.equal(cache.getState().metadata.durableStreams, before.metadata.durableStreams);
    });
  }
}

for (const [clock, occurredAt] of [
  ["tied", "2026-08-26T06:00:05.123Z"],
  ["1ms older", "2026-08-26T06:00:05.122Z"],
  ["1ms newer", "2026-08-26T06:00:05.124Z"],
]) {
  const highWater = "2026-08-26T06:00:05.123Z";
  const conversationId = "conversation-1";
  const original = message("message-1", conversationId, 1);
  const edit = event("edit-1", conversationId, CHAT_DURABLE_EVENT_TYPES.messageUpdated, {
    message: {
      ...original,
      updatedAt: occurredAt,
      revision: { revision: 2, editedAt: occurredAt, editedByUserId: userId },
      content: { format: "plain", text: "edited" },
    },
  }, 0, { occurredAt });
  const seed = () => {
    const cache = createNormalizedChatCache(identity);
    cache.applyDurableEvent(event("seed", conversationId, CHAT_DURABLE_EVENT_TYPES.conversationCreated,
      { conversation: conversation(conversationId) }));
    cache.applyDurableEvent(event("message-first", conversationId, CHAT_DURABLE_EVENT_TYPES.messageCreated,
      { message: original }, 1));
    cache.applyDurableEvent(event("message-second", conversationId, CHAT_DURABLE_EVENT_TYPES.messageCreated,
      { message: message("message-2", conversationId, 2) }, 0, { occurredAt: highWater }));
    return cache;
  };

  test(`message.updated revisions apply and survive replay with ${clock} clocks`, () => {
    const cache = seed();
    const before = cache.getState();
    assert.equal(cache.applyDurableEvent(edit).status, "applied");
    const after = cache.getState();
    const canonical = { ...before.entities.messages[original.id], ...edit.payload.message };
    assert.deepEqual(after.entities.messages[original.id], canonical);
    assert.equal(after.entities.messages[original.id].sequence, 1);
    assert.equal(after.timelines, before.timelines);
    assert.deepEqual(after.timelines[conversationId].messageIds, ["message-1", "message-2"]);
    assert.equal(after.metadata.conversations[conversationId].latestSequence, 2);
    assert.equal(after.metadata.realtimeCursor.eventId, edit.eventId);
    assert.equal(after.metadata.durableStreams[conversationId].lastEventId, edit.eventId);
    assert.equal(after.metadata.durableStreams[conversationId].lastOccurredAt,
      occurredAt > highWater ? occurredAt : highWater);

    assert.equal(cache.applyDurableEvent(edit).status, "duplicate");
    assert.equal(cache.getState(), after, "exact replay preserves state and cursor");

    cache.applyDurableEvent(event("message-third", conversationId, CHAT_DURABLE_EVENT_TYPES.messageCreated,
      { message: message("message-3", conversationId, 3) }, 6));
    const afterCreate = cache.getState();
    assert.deepEqual(afterCreate.entities.messages[original.id], canonical);
    assert.deepEqual(afterCreate.timelines[conversationId].messageIds, ["message-1", "message-2", "message-3"]);
    assert.equal(afterCreate.metadata.realtimeCursor.eventId, "message-third");
    assert.equal(afterCreate.metadata.durableStreams[conversationId].lastEventId, "message-third");
    assert.equal(afterCreate.metadata.durableStreams[conversationId].lastOccurredAt, at(6));
    assert.equal(cache.applyDurableEvent(edit).status, "duplicate");
    assert.equal(cache.getState(), afterCreate, "replay cannot rewind a later cursor");

    const lowerRevision = { ...edit, eventId: "edit-lower-revision", occurredAt: at(7), payload: { message: original } };
    assert.equal(cache.applyDurableEvent(lowerRevision).status, "applied");
    const afterLower = cache.getState();
    assert.equal(afterLower.entities, afterCreate.entities, "lower revisions cannot overwrite edited content");
    assert.equal(afterLower.timelines, afterCreate.timelines);
    assert.equal(afterLower.metadata.realtimeCursor.eventId, lowerRevision.eventId);
    assert.equal(afterLower.metadata.durableStreams[conversationId].lastEventId, lowerRevision.eventId);
    assert.equal(afterLower.metadata.durableStreams[conversationId].lastOccurredAt, at(7));
  });

  test(`message.updated revision jumps reject atomically with ${clock} clocks`, () => {
    const cache = seed();
    const before = cache.getState();
    const snapshot = structuredClone(before);
    const jump = { ...edit, payload: { message: {
      ...edit.payload.message, revision: { ...edit.payload.message.revision, revision: 3 },
    } } };
    assert.throws(() => cache.applyDurableEvent(jump), (error) =>
      error instanceof DurableEventReductionError && error.diagnostic.reason === "event_gap");
    assert.equal(cache.getState(), before, "revision gaps preserve the entire cache atomically");
    assert.deepEqual(cache.getState(), snapshot);
    assert.equal(cache.getState().entities, before.entities);
    assert.equal(cache.getState().metadata.realtimeCursor, before.metadata.realtimeCursor);
    assert.equal(cache.getState().metadata.durableStreams, before.metadata.durableStreams);
    assert.equal(cache.applyDurableEvent(edit).status, "applied", "rejection must not consume the event ID");
  });
}

for (const [clock, occurredAt] of [
  ["tied", "2026-08-26T06:00:05.123Z"],
  ["1ms older", "2026-08-26T06:00:05.122Z"],
  ["1ms newer", "2026-08-26T06:00:05.124Z"],
]) {
  const highWater = "2026-08-26T06:00:05.123Z";
  const conversationId = "conversation-1";
  const original = message("message-1", conversationId, 1);
  const deletion = event("delete-1", conversationId, CHAT_DURABLE_EVENT_TYPES.messageDeleted, {
    message: {
      ...original,
      updatedAt: occurredAt,
      revision: { revision: 2, editedAt: occurredAt, editedByUserId: userId },
      content: null,
      deletedAt: occurredAt,
      deletedByUserId: userId,
    },
  }, 0, { occurredAt });
  const saved = settledSavedMessageResult({
    ...saveMessageInput, messageId: original.id, expectedSavedMessageRevision: 0,
  });
  const seed = () => {
    const cache = createNormalizedChatCache(identity);
    cache.applyDurableEvent(event("seed", conversationId, CHAT_DURABLE_EVENT_TYPES.conversationCreated,
      { conversation: conversation(conversationId) }));
    cache.applyDurableEvent(event("message-first", conversationId, CHAT_DURABLE_EVENT_TYPES.messageCreated,
      { message: original }, 1));
    cache.applyDurableEvent(event("saved-1", `user:${userId}`, CHAT_DURABLE_EVENT_TYPES.savedMessageUpdated, {
      operation: saved.operation, messageId: original.id,
      savedMessageRevision: saved.savedMessageRevision, savedMessage: saved.savedMessage,
    }, 2));
    cache.applyDurableEvent(event("message-second", conversationId, CHAT_DURABLE_EVENT_TYPES.messageCreated,
      { message: message("message-2", conversationId, 2) }, 0, { occurredAt: highWater }));
    return cache;
  };

  test(`message.deleted revisions apply and survive replay with ${clock} clocks`, () => {
    const cache = seed();
    const before = cache.getState();
    assert.deepEqual(before.currentUser.savedMessages[original.id], saved.savedMessage);
    assert.equal(cache.applyDurableEvent(deletion).status, "applied");
    const after = cache.getState();
    const canonical = { ...before.entities.messages[original.id], ...deletion.payload.message };
    assert.deepEqual(after.entities.messages[original.id], canonical);
    assert.equal(after.entities.messages[original.id].sequence, 1);
    assert.deepEqual(after.currentUser.savedMessages[original.id], { messageId: original.id, isSaved: true });
    assert.equal(after.currentUser.savedMessageUnavailableReasons[original.id], "deleted");
    assert.equal(after.currentUser.savedMessageRevisions[original.id], saved.savedMessageRevision);
    assert.equal(after.timelines, before.timelines);
    assert.deepEqual(after.timelines[conversationId].messageIds, ["message-1", "message-2"]);
    assert.equal(after.metadata.conversations, before.metadata.conversations);
    assert.equal(after.metadata.conversations[conversationId].latestSequence, 2);
    assert.equal(after.metadata.realtimeCursor.eventId, deletion.eventId);
    assert.equal(after.metadata.durableStreams[conversationId].lastEventId, deletion.eventId);
    assert.equal(after.metadata.durableStreams[conversationId].lastOccurredAt,
      occurredAt > highWater ? occurredAt : highWater);
    assert.deepEqual(after.metadata.durableStreams[conversationId].recentEventIds,
      [...before.metadata.durableStreams[conversationId].recentEventIds, deletion.eventId]);

    assert.equal(cache.applyDurableEvent(deletion).status, "duplicate");
    assert.equal(cache.getState(), after, "exact replay preserves state and cursor");

    cache.applyDurableEvent(event("message-third", conversationId, CHAT_DURABLE_EVENT_TYPES.messageCreated,
      { message: message("message-3", conversationId, 3) }, 6));
    const afterCreate = cache.getState();
    assert.deepEqual(afterCreate.entities.messages[original.id], canonical);
    assert.equal(afterCreate.currentUser.savedMessageUnavailableReasons[original.id], "deleted");
    assert.deepEqual(afterCreate.timelines[conversationId].messageIds, ["message-1", "message-2", "message-3"]);
    assert.equal(afterCreate.metadata.realtimeCursor.eventId, "message-third");
    assert.equal(afterCreate.metadata.durableStreams[conversationId].lastEventId, "message-third");
    assert.equal(afterCreate.metadata.durableStreams[conversationId].lastOccurredAt, at(6));
    assert.equal(cache.applyDurableEvent(deletion).status, "duplicate");
    assert.equal(cache.getState(), afterCreate, "replay cannot rewind a later cursor");
  });

  for (const [name, streamId, revision, reason] of [
    ["revision jump", conversationId, 3, "event_gap"],
    ["wrong stream", "conversation-other", 2, "event_invalid"],
  ]) {
    test(`message.deleted ${name} rejects atomically with ${clock} clocks`, () => {
      const cache = seed();
      if (streamId !== conversationId) {
        cache.applyDurableEvent(event("seed-other", streamId, CHAT_DURABLE_EVENT_TYPES.conversationCreated,
          { conversation: conversation(streamId) }, 0, { occurredAt: highWater }));
      }
      const invalid = { ...deletion, streamId, payload: { message: {
        ...deletion.payload.message, revision: { ...deletion.payload.message.revision, revision },
      } } };
      const before = cache.getState();
      const snapshot = structuredClone(before);
      assert.equal(before.metadata.durableStreams[streamId].lastOccurredAt, highWater);
      assert.throws(() => cache.applyDurableEvent(invalid), (error) =>
        error instanceof DurableEventReductionError && error.diagnostic.reason === reason);
      assert.equal(cache.getState(), before, "rejection preserves the entire cache atomically");
      assert.deepEqual(cache.getState(), snapshot);
      assert.equal(cache.getState().metadata.realtimeCursor, before.metadata.realtimeCursor);
      assert.equal(cache.getState().metadata.durableStreams, before.metadata.durableStreams);
      assert.equal(cache.getState().metadata.durableStreams[streamId].recentEventIds.includes(invalid.eventId), false);
      assert.equal(cache.applyDurableEvent(deletion).status, "applied", "rejection must not consume the event ID");
    });
  }
}

const readCursorEvent = (eventId, conversationId, occurredAt, readState = {}) => {
  const state = { conversationId, userId, lastReadSequence: 2, updatedAt: at(2), ...readState };
  return createReadCursorUpdatedEvent({
    eventId, protocolVersion: CHAT_PROTOCOL_VERSION, tenantId, occurredAt,
    result: {
      operation: state.manualUnreadFromSequence === undefined ? "mark_read" : "mark_unread",
      conversationId,
      readState: state,
      latestSequence: 2,
      unreadCount: state.manualUnreadFromSequence === undefined
        ? 2 - state.lastReadSequence
        : 3 - state.manualUnreadFromSequence,
    },
  });
};

for (const [clock, occurredAt] of [
  ["tied", "2026-08-26T06:00:01.123Z"],
  ["1ms older", "2026-08-26T06:00:01.122Z"],
]) {
  const highWater = "2026-08-26T06:00:01.123Z";
  const streamId = `user:${userId}`;

  test(`independent conversation read cursors apply with ${clock} user-stream clocks`, () => {
    const cache = createNormalizedChatCache(identity);
    const incoming = [readCursorEvent("read-a", "a", highWater), readCursorEvent("read-b", "b", occurredAt)];
    for (const id of ["a", "b"]) {
      cache.applyDurableEvent(event(`seed-${id}`, id, CHAT_DURABLE_EVENT_TYPES.conversationCreated, { conversation: conversation(id) }));
      cache.applyDurableEvent(event(`message-${id}`, id, CHAT_DURABLE_EVENT_TYPES.messageCreated, { message: message(`message-${id}`, id, 1) }, 1));
    }
    for (const read of incoming) {
      assert.equal(cache.applyDurableEvent(read).status, "applied");
      const after = cache.getState();
      assert.deepEqual(after.currentUser.readStates[read.payload.conversationId], read.payload.readState);
      assert.equal(after.metadata.realtimeCursor.eventId, read.eventId);
      assert.equal(after.metadata.durableStreams[streamId].lastEventId, read.eventId);
      assert.equal(after.metadata.durableStreams[streamId].lastOccurredAt, highWater);
    }
    const after = cache.getState();
    for (const read of incoming) {
      assert.deepEqual(after.currentUser.readStates[read.payload.conversationId], read.payload.readState);
      assert.equal(cache.applyDurableEvent(read).status, "duplicate");
      assert.equal(cache.getState(), after, "replay preserves canonical state and the latest transport cursor");
    }
  });

  test(`read payload ordering survives ${clock} envelope clocks`, () => {
    const cache = createNormalizedChatCache(identity);
    cache.applyDurableEvent(event("seed-a", "a", CHAT_DURABLE_EVENT_TYPES.conversationCreated, { conversation: conversation("a") }));
    cache.applyDurableEvent(event("message-a", "a", CHAT_DURABLE_EVENT_TYPES.messageCreated, { message: message("message-a", "a", 1) }, 1));
    cache.applyDurableEvent(readCursorEvent("read-initial", "a", highWater));
    const unread = readCursorEvent("read-unread", "a", occurredAt, { updatedAt: at(3), manualUnreadFromSequence: 1 });
    assert.equal(cache.applyDurableEvent(unread).status, "applied");
    assert.deepEqual(cache.getState().currentUser.readStates.a, unread.payload.readState);
    assert.equal(cache.getState().metadata.realtimeCursor.eventId, unread.eventId);
    assert.equal(cache.getState().metadata.durableStreams[streamId].lastOccurredAt, highWater);

    for (const [name, readState] of [
      ["lower-sequence", { lastReadSequence: 1, updatedAt: at(4) }],
      ["older-timestamp", { updatedAt: at(2) }],
      ["equal-timestamp", { updatedAt: at(3) }],
    ]) {
      const older = readCursorEvent(`read-${name}`, "a", occurredAt, readState);
      assert.equal(cache.applyDurableEvent(older).status, "applied", "valid replay still advances transport metadata");
      const after = cache.getState();
      assert.deepEqual(after.currentUser.readStates.a, unread.payload.readState, name);
      assert.equal(after.metadata.realtimeCursor.eventId, older.eventId);
      assert.equal(after.metadata.durableStreams[streamId].lastEventId, older.eventId);
      assert.equal(after.metadata.durableStreams[streamId].lastOccurredAt, highWater);
      assert.equal(cache.applyDurableEvent(older).status, "duplicate");
      assert.equal(cache.getState(), after);
    }
  });

  test(`invalid read identity with ${clock} clocks leaves cache and cursor untouched`, () => {
    const cache = createNormalizedChatCache(identity);
    const otherStream = "user:user-other";
    for (const id of ["a", otherStream]) {
      cache.applyDurableEvent(event(`seed-${id}`, id, CHAT_DURABLE_EVENT_TYPES.conversationCreated,
        { conversation: conversation(id) }, 0, { occurredAt: highWater }));
    }
    cache.applyDurableEvent(event("message-a", "a", CHAT_DURABLE_EVENT_TYPES.messageCreated, { message: message("message-a", "a", 1) }, 2));
    cache.applyDurableEvent(readCursorEvent("read-valid", "a", highWater));
    const valid = readCursorEvent("read-invalid", "a", occurredAt, { updatedAt: at(3) });
    const wrongActor = readCursorEvent("read-wrong-actor", "a", occurredAt, { userId: "user-other", updatedAt: at(3) });
    for (const invalid of [
      wrongActor,
      { ...wrongActor, streamId },
      { ...valid, streamId: otherStream },
      { ...valid, tenantId: "tenant-other" },
    ]) {
      const before = cache.getState();
      assert.throws(() => cache.applyDurableEvent(invalid), (error) =>
        error instanceof DurableEventReductionError && error.diagnostic.reason === "event_invalid");
      assert.equal(cache.getState(), before, "invalid identity preserves the entire cache atomically");
      assert.equal(cache.getState().metadata.realtimeCursor, before.metadata.realtimeCursor);
      assert.equal(cache.getState().metadata.durableStreams, before.metadata.durableStreams);
    }
  });
}

for (const [clock, occurredAt] of [
  ["1ms older", "2026-08-26T06:00:05.122Z"],
  ["tied", "2026-08-26T06:00:05.123Z"],
  ["1ms newer", "2026-08-26T06:00:05.124Z"],
]) {
  const highWater = "2026-08-26T06:00:05.123Z";
  const id = membershipInputs.join.conversationId;
  const observerId = "user-b";
  const initialResult = appliedMembershipResult(membershipInputs.join);
  const seedObserver = () => {
    const cache = createNormalizedChatCache({ ...identity, userId: observerId });
    cache.applyDurableEvent(event("seed", id, CHAT_DURABLE_EVENT_TYPES.conversationCreated,
      { conversation: conversation(id) }));
    cache.applyDurableEvent(event("membership-initial", id, CHAT_DURABLE_EVENT_TYPES.membershipUpdated,
      { input: membershipInputs.join, result: initialResult }, 1));
    cache.applyDurableEvent(event("message-high-water", id, CHAT_DURABLE_EVENT_TYPES.messageCreated,
      { message: message("message-1", id, 1) }, 0, { occurredAt: highWater }));
    assert.equal(cache.getState().metadata.memberListRevisions[id], 5);
    return cache;
  };

  for (const fixture of [membershipInputs.leave, membershipInputs.changeRole]) {
    // Both operations affect the actor, so the observer receives no private repair copy.
    const input = { ...fixture, expectedMemberListRevision: 5,
      ...(fixture.intent === "change_member_role" ? { targetUserId: userId } : {}) };
    const result = { ...appliedMembershipResult(input), members: initialResult.members.map((member) =>
      member.userId !== userId ? member : {
        ...member,
        ...(input.intent === "leave" ? { state: "left" } : { role: input.requestedRole }),
      }) };
    const incoming = event("membership-rev-6", id, CHAT_DURABLE_EVENT_TYPES.membershipUpdated,
      { input, result }, 0, { occurredAt });
    const expectedMembers = Object.fromEntries(result.members.map((member) =>
      [member.userId, { ...member, tenantId, conversationId: id }]));
    const assertCanonical = (state) => {
      assert.deepEqual(state.entities.membersByConversation[id], expectedMembers);
      assert.deepEqual(state.entities.memberUserIdsByConversation[id],
        input.intent === "leave" ? [observerId] : [userId, observerId]);
      assert.equal(state.metadata.memberListRevisions[id], 6);
      assert.deepEqual(state.currentUser.memberships[id], expectedMembers[observerId]);
      assert.equal(state.currentUser.memberships[id].state, "active");
      assert.equal(state.currentUser.memberships[id].role, "owner");
    };

    test(`observer conversation membership ${input.intent} applies and survives replay with ${clock} clocks`, () => {
      const cache = seedObserver();
      const before = cache.getState();
      const lower = event("membership-lower-revision", id, CHAT_DURABLE_EVENT_TYPES.membershipUpdated,
        { input: membershipInputs.join, result: initialResult }, 7);
      for (const delivery of [incoming, lower]) {
        cache.beginConversationOperation({ logicalKey: "membership", family: "membership",
          conversationId: id, idempotencyKey: delivery.payload.input.idempotencyKey });
        assert.equal(cache.applyDurableEvent(delivery).status, "applied");
        const after = cache.getState();
        assertCanonical(after);
        assert.deepEqual(after.metadata.pendingConversationOperations, {});
        assert.equal(after.metadata.realtimeCursor.eventId, delivery.eventId);
        assert.equal(after.metadata.durableStreams[id].lastEventId, delivery.eventId);
        assert.equal(after.metadata.durableStreams[id].lastOccurredAt,
          delivery === lower ? at(7) : occurredAt > highWater ? occurredAt : highWater);
        assert.equal(after.metadata.durableStreams[id].recentEventIds.at(-1), delivery.eventId);
        assert.equal(cache.applyDurableEvent(delivery).status, "duplicate");
        assert.equal(cache.getState(), after, "exact replay preserves the whole cache and cursor");

        if (delivery === incoming) {
          assert.equal(after.entities.messages, before.entities.messages);
          assert.equal(after.timelines, before.timelines);
          cache.applyDurableEvent(event("message-later", id, CHAT_DURABLE_EVENT_TYPES.messageCreated,
            { message: message("message-2", id, 2) }, 6));
          const afterMessage = cache.getState();
          assertCanonical(afterMessage);
          assert.deepEqual(afterMessage.timelines[id].messageIds, ["message-1", "message-2"]);
          assert.equal(afterMessage.metadata.realtimeCursor.eventId, "message-later");
          assert.equal(afterMessage.metadata.durableStreams[id].lastEventId, "message-later");
          assert.equal(afterMessage.metadata.durableStreams[id].lastOccurredAt, at(6));
          assert.equal(cache.applyDurableEvent(incoming).status, "duplicate");
          assert.equal(cache.getState(), afterMessage, "replay after a later message cannot rewind the cursor");
        }
      }
      const afterLower = cache.getState();
      assert.equal(cache.applyDurableEvent(incoming).status, "duplicate");
      assert.equal(cache.getState(), afterLower, "lower revision arrival cannot restore obsolete membership or roles");
    });

    for (const wrongStream of ["conversation-other", `user:${observerId}`]) {
      test(`observer conversation membership ${input.intent} rejects ${wrongStream} atomically with ${clock} clocks`, () => {
        const cache = seedObserver();
        if (wrongStream === `user:${observerId}`) {
          const preferenceInput = { ...allUnmutedInput, conversationId: id };
          cache.applyDurableEvent(event("seed-private", wrongStream, CHAT_DURABLE_EVENT_TYPES.preferenceUpdated,
            { actorUserId: observerId, input: preferenceInput, result: settledPreferenceResult(preferenceInput) },
            0, { occurredAt: highWater }));
        } else {
          cache.applyDurableEvent(event("seed-other", wrongStream, CHAT_DURABLE_EVENT_TYPES.conversationCreated,
            { conversation: conversation(wrongStream) }, 0, { occurredAt: highWater }));
        }
        cache.beginConversationOperation({ logicalKey: "membership", family: "membership",
          conversationId: id, idempotencyKey: input.idempotencyKey });
        const invalid = { ...incoming, streamId: wrongStream };
        const before = cache.getState();
        const snapshot = structuredClone(before);
        assert.equal(before.metadata.durableStreams[wrongStream].lastOccurredAt, highWater);
        assert.throws(() => cache.applyDurableEvent(invalid), (error) =>
          error instanceof DurableEventReductionError && error.diagnostic.reason === "event_invalid" &&
          error.diagnostic.code === "incoherent_payload");
        assert.equal(cache.getState(), before, "wrong-stream rejection preserves the entire cache atomically");
        assert.deepEqual(cache.getState(), snapshot);
        assert.equal(cache.getState().metadata.realtimeCursor, before.metadata.realtimeCursor);
        assert.equal(cache.getState().metadata.durableStreams, before.metadata.durableStreams);
        assert.equal(cache.getState().metadata.durableStreams[wrongStream].recentEventIds.includes(incoming.eventId), false);
        assert.equal(cache.getState().metadata.durableStreams[id].recentEventIds.includes(incoming.eventId), false);
        assert.equal(cache.applyDurableEvent(incoming).status, "applied", "corrected delivery retains its event ID");
        assertCanonical(cache.getState());
        assert.deepEqual(cache.getState().metadata.pendingConversationOperations, {});
        assert.equal(cache.getState().metadata.durableStreams[wrongStream], before.metadata.durableStreams[wrongStream]);
      });
    }
  }
}

for (const [clock, occurredAt] of [
  ["tied", "2026-08-26T06:00:01.123Z"],
  ["1ms older", "2026-08-26T06:00:01.122Z"],
]) {
  const highWater = "2026-08-26T06:00:01.123Z";
  const streamId = `user:${userId}`;
  const id = membershipInputs.join.conversationId;
  const initialResult = appliedMembershipResult(membershipInputs.join);
  const seedPrivateMembership = () => {
    const cache = createNormalizedChatCache(identity);
    cache.applyDurableEvent(event("seed-private", id, CHAT_DURABLE_EVENT_TYPES.conversationCreated,
      { conversation: conversation(id, { visibility: "private" }) }));
    cache.applyDurableEvent(event("cached-message", id, CHAT_DURABLE_EVENT_TYPES.messageCreated,
      { message: message("cached-message", id, 1) }, 1));
    assert.equal(cache.applyDurableEvent(event("membership-initial", id, CHAT_DURABLE_EVENT_TYPES.membershipUpdated,
      { input: membershipInputs.join, result: initialResult }, 2)).status, "applied");
    cache.applyDurableEvent(event("seed-other", "other", CHAT_DURABLE_EVENT_TYPES.conversationCreated,
      { conversation: conversation("other") }));
    const preferenceInput = { ...allUnmutedInput, conversationId: "other" };
    assert.equal(cache.applyDurableEvent(event("preference-other", streamId, CHAT_DURABLE_EVENT_TYPES.preferenceUpdated,
      { actorUserId: userId, input: preferenceInput, result: settledPreferenceResult(preferenceInput) },
      0, { occurredAt: highWater })).status, "applied");
    const before = cache.getState();
    assert.equal(before.metadata.memberListRevisions[id], 5);
    assert.equal(before.currentUser.memberships[id].state, "active");
    assert.deepEqual(before.entities.memberUserIdsByConversation[id], [userId, "user-b"]);
    assert.equal(before.entities.messages["cached-message"].conversationId, id);
    assert.deepEqual(before.timelines[id].messageIds, ["cached-message"]);
    assert.equal(before.metadata.durableStreams[streamId].lastOccurredAt, highWater);
    return cache;
  };

  for (const [fixture, memberState] of [[membershipInputs.leave, "left"], [membershipInputs.removeMember, "removed"]]) {
    test(`private membership ${fixture.intent} applies with ${clock} user-stream clocks`, () => {
      const cache = seedPrivateMembership();
      const input = { ...fixture, expectedMemberListRevision: 5,
        ...(fixture.intent === "remove_member" ? { targetUserId: userId } : {}) };
      const result = { ...appliedMembershipResult(input), members: initialResult.members.map((member) =>
        member.userId === userId ? { ...member, state: memberState } : member) };
      const incoming = event("membership-rev-6", streamId, CHAT_DURABLE_EVENT_TYPES.membershipUpdated,
        { input, result }, 0, { occurredAt });
      const expectedMembers = Object.fromEntries(result.members.map((member) =>
        [member.userId, { ...member, tenantId, conversationId: id }]));
      const assertCanonicalMembership = () => {
        const state = cache.getState();
        assert.deepEqual(state.entities.membersByConversation[id], expectedMembers);
        assert.deepEqual(state.currentUser.memberships[id], expectedMembers[userId]);
        assert.deepEqual(state.entities.memberUserIdsByConversation[id], ["user-b"]);
        assert.equal(state.metadata.memberListRevisions[id], 6);
        assert.deepEqual(state.entities.messages, {});
        assert.equal(state.timelines[id], undefined);
      };

      const lower = event("membership-lower-revision", streamId, CHAT_DURABLE_EVENT_TYPES.membershipUpdated,
        { input: membershipInputs.join, result: initialResult }, 0, { occurredAt });
      for (const replay of [incoming, lower]) {
        assert.equal(cache.applyDurableEvent(replay).status, "applied", "valid replay advances transport metadata");
        assertCanonicalMembership();
        const after = cache.getState();
        assert.equal(after.metadata.realtimeCursor.eventId, replay.eventId);
        assert.equal(after.metadata.durableStreams[streamId].lastEventId, replay.eventId);
        assert.equal(after.metadata.durableStreams[streamId].lastOccurredAt, highWater);
        assert.equal(cache.applyDurableEvent(replay).status, "duplicate");
        assert.equal(cache.getState(), after, "exact replay preserves state and cursor");
      }
      const after = cache.getState();
      assert.equal(cache.applyDurableEvent(incoming).status, "duplicate");
      assert.equal(cache.getState(), after, "replaying an earlier event preserves the latest transport cursor");
    });
  }

  test(`invalid private membership affected user with ${clock} clocks leaves cache and cursor untouched`, () => {
    const cache = seedPrivateMembership();
    // The fixture coherently removes user-c; only delivery to this user's stream is invalid.
    const input = { ...membershipInputs.removeMember, expectedMemberListRevision: 5 };
    const invalid = event("membership-wrong-user", streamId, CHAT_DURABLE_EVENT_TYPES.membershipUpdated,
      { input, result: appliedMembershipResult(input) }, 0, { occurredAt });
    const before = cache.getState();
    assert.throws(() => cache.applyDurableEvent(invalid), (error) =>
      error instanceof DurableEventReductionError && error.diagnostic.reason === "event_invalid" &&
      error.diagnostic.code === "incoherent_payload");
    assert.equal(cache.getState(), before, "invalid affected user preserves the entire cache atomically");
    assert.equal(cache.getState().metadata.realtimeCursor, before.metadata.realtimeCursor);
    assert.equal(cache.getState().metadata.durableStreams, before.metadata.durableStreams);
  });
}

for (const [clock, occurredAt] of [
  ["tied", "2026-08-26T06:00:01.123Z"],
  ["1ms older", "2026-08-26T06:00:01.122Z"],
]) {
  test(`independent conversation preferences apply with ${clock} user-stream clocks`, () => {
    const cache = createNormalizedChatCache(identity);
    const streamId = `user:${userId}`;
    const highWater = "2026-08-26T06:00:01.123Z";
    const results = {};
    for (const id of ["a", "b"]) {
      cache.applyDurableEvent(event(`seed-${id}`, id, CHAT_DURABLE_EVENT_TYPES.conversationCreated, { conversation: conversation(id) }));
    }
    for (const id of ["a", "b"]) {
      const input = { ...allUnmutedInput, conversationId: id, idempotencyKey: `preference:${id}:1` };
      const result = settledPreferenceResult(input);
      results[id] = result;
      const incoming = event(`preference-${id}`, streamId, CHAT_DURABLE_EVENT_TYPES.preferenceUpdated,
        { actorUserId: userId, input, result }, 0, { occurredAt: id === "a" ? highWater : occurredAt });
      assert.equal(cache.applyDurableEvent(incoming).status, "applied");
      const after = cache.getState();
      assert.deepEqual(after.currentUser.preferences[id], { ...result.preference, conversationId: id, userId });
      assert.equal(after.currentUser.preferenceRevisions[id], 1);
      assert.equal(after.metadata.durableStreams[streamId].lastOccurredAt, highWater);
      assert.equal(cache.applyDurableEvent(incoming).status, "duplicate");
      assert.equal(cache.getState(), after, "exact preference replay preserves the entire cache state");
    }
    const state = cache.getState();
    for (const id of ["a", "b"]) {
      assert.deepEqual(state.currentUser.preferences[id], { ...results[id].preference, conversationId: id, userId });
      assert.equal(state.currentUser.preferenceRevisions[id], 1);
    }
    assert.equal(state.metadata.durableStreams[streamId].lastOccurredAt, highWater);
  });

  test(`invalid preference actor with a ${clock} clock leaves cache and cursor untouched`, () => {
    const cache = createNormalizedChatCache(identity);
    const id = "a";
    const streamId = `user:${userId}`;
    cache.applyDurableEvent(event("seed-a", id, CHAT_DURABLE_EVENT_TYPES.conversationCreated, { conversation: conversation(id) }));
    const input = { ...allUnmutedInput, conversationId: id };
    const result = settledPreferenceResult(input);
    assert.equal(cache.applyDurableEvent(event("preference-valid", streamId, CHAT_DURABLE_EVENT_TYPES.preferenceUpdated,
      { actorUserId: userId, input, result }, 0, { occurredAt: "2026-08-26T06:00:01.123Z" })).status, "applied");
    const invalidInput = { ...input, expectedPreferenceRevision: 1, idempotencyKey: "preference:invalid:2", notificationPreference: "none", isStarred: true };
    const invalid = event("preference-invalid-actor", streamId, CHAT_DURABLE_EVENT_TYPES.preferenceUpdated,
      { actorUserId: "user-other", input: invalidInput, result: settledPreferenceResult(invalidInput) }, 0, { occurredAt });
    const before = cache.getState();
    assert.throws(() => cache.applyDurableEvent(invalid), (error) =>
      error instanceof DurableEventReductionError &&
      error.diagnostic.reason === "event_invalid" &&
      error.diagnostic.code === "private_stream_mismatch");
    assert.equal(cache.getState(), before, "invalid actor preserves the entire cache state");
    assert.equal(cache.getState().metadata.realtimeCursor, before.metadata.realtimeCursor);
    assert.equal(cache.getState().metadata.durableStreams, before.metadata.durableStreams);
  });
}

test("lower preference revision with a distinct event ID cannot overwrite canonical preference", () => {
  const cache = createNormalizedChatCache(identity);
  const id = "a";
  const streamId = `user:${userId}`;
  cache.applyDurableEvent(event("seed-a", id, CHAT_DURABLE_EVENT_TYPES.conversationCreated, { conversation: conversation(id) }));
  const higherInput = { ...allUnmutedInput, conversationId: id, expectedPreferenceRevision: 1, idempotencyKey: "preference:a:2", notificationPreference: "mentions", isStarred: true, mute: { muted: true } };
  const higherResult = settledPreferenceResult(higherInput);
  assert.equal(cache.applyDurableEvent(event("preference-higher", streamId, CHAT_DURABLE_EVENT_TYPES.preferenceUpdated,
    { actorUserId: userId, input: higherInput, result: higherResult }, 1)).status, "applied");
  assert.deepEqual(cache.getState().currentUser.preferences[id], { ...higherResult.preference, conversationId: id, userId });
  assert.equal(cache.getState().currentUser.preferenceRevisions[id], 2);

  const lowerInput = { ...allUnmutedInput, conversationId: id, idempotencyKey: "preference:a:1" };
  const lowerResult = settledPreferenceResult(lowerInput);
  assert.notDeepEqual(lowerResult.preference, higherResult.preference);
  // A later clock ensures revision reconciliation itself prevents the rollback.
  const lower = event("preference-lower", streamId, CHAT_DURABLE_EVENT_TYPES.preferenceUpdated,
    { actorUserId: userId, input: lowerInput, result: lowerResult }, 2);
  assert.equal(cache.applyDurableEvent(lower).status, "applied");
  const after = cache.getState();
  assert.deepEqual(after.currentUser.preferences[id], { ...higherResult.preference, conversationId: id, userId });
  assert.equal(after.currentUser.preferenceRevisions[id], 2);
  assert.equal(cache.applyDurableEvent(lower).status, "duplicate");
  assert.equal(cache.getState(), after, "lower revision replay preserves the entire cache state");
});

for (const [clock, occurredAt] of [
  ["tied", "2026-08-26T06:00:01.123Z"],
  ["1ms older", "2026-08-26T06:00:01.122Z"],
]) {
  const highWater = "2026-08-26T06:00:01.123Z";
  const streamId = `user:${userId}`;

  test(`independent conversation drafts apply with ${clock} user-stream clocks`, () => {
    const cache = createNormalizedChatCache(identity);
    const results = {};
    for (const id of ["a", "b"]) {
      cache.applyDurableEvent(event(`seed-${id}`, id, CHAT_DURABLE_EVENT_TYPES.conversationCreated, { conversation: conversation(id) }));
    }
    for (const id of ["a", "b"]) {
      const input = { ...replaceDraftInput, conversationId: id, baseRevision: 0,
        deviceMutationId: `draft-${id}-1`, idempotencyKey: `draft:${id}:1`,
        content: { ...replaceDraftInput.content, text: `Draft for ${id}` } };
      const result = settledDraftResult(input);
      results[id] = result;
      const incoming = event(`draft-${id}`, streamId, CHAT_DURABLE_EVENT_TYPES.draftUpdated,
        { actorUserId: userId, input, result }, 0, { occurredAt: id === "a" ? highWater : occurredAt });
      assert.equal(cache.applyDurableEvent(incoming).status, "applied");
      const after = cache.getState();
      assert.deepEqual(after.currentUser.drafts[id], result.draft);
      assert.equal(after.currentUser.draftRevisions[id], 1);
      assert.deepEqual(after.metadata.realtimeCursor, { eventId: incoming.eventId });
      assert.equal(after.metadata.durableStreams[streamId].lastEventId, incoming.eventId);
      assert.equal(after.metadata.durableStreams[streamId].lastOccurredAt, highWater);
      assert.equal(cache.applyDurableEvent(incoming).status, "duplicate");
      assert.equal(cache.getState(), after, "exact draft replay preserves the entire cache state");
    }
    for (const id of ["a", "b"]) {
      assert.deepEqual(cache.getState().currentUser.drafts[id], results[id].draft);
      assert.equal(cache.getState().currentUser.draftRevisions[id], 1);
    }
  });

  test(`invalid draft actor with a ${clock} clock leaves cache and cursor untouched`, () => {
    const cache = createNormalizedChatCache(identity);
    for (const id of ["a", "b"]) {
      cache.applyDurableEvent(event(`seed-${id}`, id, CHAT_DURABLE_EVENT_TYPES.conversationCreated, { conversation: conversation(id) }));
    }
    const input = { ...replaceDraftInput, conversationId: "a", baseRevision: 0 };
    const valid = event("draft-valid", streamId, CHAT_DURABLE_EVENT_TYPES.draftUpdated,
      { actorUserId: userId, input, result: settledDraftResult(input) }, 0, { occurredAt: highWater });
    assert.equal(cache.applyDurableEvent(valid).status, "applied");
    const invalidInput = { ...input, conversationId: "b", deviceMutationId: "draft-b-1", idempotencyKey: "draft:b:1" };
    const invalid = event("draft-invalid-actor", streamId, CHAT_DURABLE_EVENT_TYPES.draftUpdated,
      { actorUserId: "user-other", input: invalidInput, result: settledDraftResult(invalidInput) }, 0, { occurredAt });
    const before = cache.getState();
    assert.throws(() => cache.applyDurableEvent(invalid), (error) =>
      error instanceof DurableEventReductionError &&
      error.diagnostic.reason === "event_invalid" &&
      error.diagnostic.code === "private_stream_mismatch");
    assert.equal(cache.getState(), before, "invalid actor preserves the entire cache state");
    assert.equal(cache.getState().metadata.realtimeCursor, before.metadata.realtimeCursor);
    assert.equal(cache.getState().metadata.durableStreams, before.metadata.durableStreams);
  });

  test(`preference then draft survives ${clock} clocks on the shared user stream`, () => {
    const cache = createNormalizedChatCache(identity);
    for (const id of ["a", "b"]) {
      cache.applyDurableEvent(event(`seed-${id}`, id, CHAT_DURABLE_EVENT_TYPES.conversationCreated, { conversation: conversation(id) }));
    }
    const preferenceInput = { ...allUnmutedInput, conversationId: "a" };
    const preferenceResult = settledPreferenceResult(preferenceInput);
    const preference = event("preference-first", streamId, CHAT_DURABLE_EVENT_TYPES.preferenceUpdated,
      { actorUserId: userId, input: preferenceInput, result: preferenceResult }, 0, { occurredAt: highWater });
    const draftInput = { ...replaceDraftInput, conversationId: "a", baseRevision: 0 };
    const draftResult = settledDraftResult(draftInput);
    const draft = event("draft-after-preference", streamId, CHAT_DURABLE_EVENT_TYPES.draftUpdated,
      { actorUserId: userId, input: draftInput, result: draftResult }, 0, { occurredAt });
    for (const incoming of [preference, draft]) {
      assert.equal(cache.applyDurableEvent(incoming).status, "applied");
      const after = cache.getState();
      assert.deepEqual(after.metadata.realtimeCursor, { eventId: incoming.eventId });
      assert.equal(after.metadata.durableStreams[streamId].lastEventId, incoming.eventId);
      assert.equal(after.metadata.durableStreams[streamId].lastOccurredAt, highWater);
    }
    const after = cache.getState();
    assert.deepEqual(after.currentUser.preferences.a, { ...preferenceResult.preference, conversationId: "a", userId });
    assert.equal(after.currentUser.preferenceRevisions.a, 1);
    assert.deepEqual(after.currentUser.drafts.a, draftResult.draft);
    assert.equal(after.currentUser.draftRevisions.a, 1);
    assert.equal(cache.applyDurableEvent(draft).status, "duplicate");
    assert.equal(cache.getState(), after, "mixed-stream replay preserves the entire cache state");
  });
}

test("lower draft revision with a distinct event ID cannot overwrite canonical draft", () => {
  const cache = createNormalizedChatCache(identity);
  const streamId = `user:${userId}`;
  for (const id of ["a", "b"]) {
    cache.applyDurableEvent(event(`seed-${id}`, id, CHAT_DURABLE_EVENT_TYPES.conversationCreated, { conversation: conversation(id) }));
  }
  const higherInput = { ...replaceDraftInput, conversationId: "a", baseRevision: 1,
    deviceMutationId: "draft-a-2", idempotencyKey: "draft:a:2", content: { ...replaceDraftInput.content, text: "Newer draft" } };
  const higherResult = settledDraftResult(higherInput);
  const higher = event("draft-higher", streamId, CHAT_DURABLE_EVENT_TYPES.draftUpdated,
    { actorUserId: userId, input: higherInput, result: higherResult }, 1);
  assert.equal(cache.applyDurableEvent(higher).status, "applied");
  assert.deepEqual(cache.getState().currentUser.drafts.a, higherResult.draft);
  assert.equal(cache.getState().currentUser.draftRevisions.a, 2);
  const lowerInput = { ...replaceDraftInput, conversationId: "a", baseRevision: 0,
    deviceMutationId: "draft-a-1", idempotencyKey: "draft:a:1", content: { ...replaceDraftInput.content, text: "Older draft" } };
  const lowerResult = settledDraftResult(lowerInput);
  assert.notDeepEqual(lowerResult.draft, higherResult.draft);
  // A later clock proves the revision check itself prevents rollback.
  const lower = event("draft-lower", streamId, CHAT_DURABLE_EVENT_TYPES.draftUpdated,
    { actorUserId: userId, input: lowerInput, result: lowerResult }, 2);
  assert.equal(cache.applyDurableEvent(lower).status, "applied");
  const after = cache.getState();
  assert.deepEqual(after.currentUser.drafts.a, higherResult.draft);
  assert.equal(after.currentUser.draftRevisions.a, 2);
  assert.deepEqual(after.metadata.realtimeCursor, { eventId: lower.eventId });
  assert.equal(after.metadata.durableStreams[streamId].lastEventId, lower.eventId);
  assert.equal(after.metadata.durableStreams[streamId].lastOccurredAt, lower.occurredAt);
  assert.equal(cache.applyDurableEvent(lower).status, "duplicate");
  assert.equal(cache.getState(), after, "lower revision replay preserves the entire cache state");
});

for (const collisionConversationId of ["conversation-1", "conversation-2"]) {
  test(`colliding teammate send in ${collisionConversationId} preserves the pending send until its own event`, () => {
    const cache = createNormalizedChatCache(identity);
    const localConversationId = "conversation-1";
    const clientMessageId = "shared-client-id";
    for (const id of [localConversationId, "conversation-2"]) {
      cache.applyDurableEvent(event(`seed-${id}`, id, CHAT_DURABLE_EVENT_TYPES.conversationCreated, { conversation: conversation(id) }, 0));
    }
    const optimistic = {
      ...message("optimistic:local", localConversationId, 1, { author: { type: "user", userId } }),
      isThreadRoot: false,
      reactions: [],
      attachmentMetadata: [],
      delivery: { state: "sending", clientMessageId, idempotencyKey: "local-send", retryable: false, attempt: 1 },
    };
    cache.insertOptimisticMessage(optimistic);

    const teammate = message("teammate-message", collisionConversationId, 1);
    const collision = event("teammate-created", collisionConversationId, CHAT_DURABLE_EVENT_TYPES.messageCreated, { clientMessageId, message: teammate }, 2);
    assert.equal(cache.applyDurableEvent(collision).status, "applied", "valid collision must not require recovery");
    const afterCollision = cache.getState();
    assert.equal(afterCollision.entities.messages[optimistic.id], optimistic);
    assert.equal(afterCollision.entities.messages[optimistic.id].delivery.state, "sending");
    assert.equal(afterCollision.entities.messages[teammate.id].conversationId, collisionConversationId);
    assert.deepEqual(afterCollision.timelines[localConversationId].messageIds,
      collisionConversationId === localConversationId ? [optimistic.id, teammate.id] : [optimistic.id]);
    assert.deepEqual(afterCollision.timelines["conversation-2"]?.messageIds ?? [],
      collisionConversationId === "conversation-2" ? [teammate.id] : []);
    assert.equal(afterCollision.metadata.realtimeCursor.eventId, collision.eventId);
    assert.equal(cache.applyDurableEvent(collision).status, "duplicate");
    assert.equal(cache.getState(), afterCollision);

    const ownSequence = collisionConversationId === localConversationId ? 2 : 1;
    const own = message("own-message", localConversationId, ownSequence, {
      author: { type: "user", userId }, createdAt: at(3), updatedAt: at(3),
    });
    const ownEvent = event("own-created", localConversationId, CHAT_DURABLE_EVENT_TYPES.messageCreated, { clientMessageId, message: own }, 3);
    assert.equal(cache.applyDurableEvent(ownEvent).status, "applied");
    const settled = cache.getState();
    assert.equal(settled.entities.messages[optimistic.id], undefined);
    assert.equal(settled.entities.messages[own.id].author.userId, userId);
    assert.deepEqual(settled.timelines[localConversationId].messageIds,
      collisionConversationId === localConversationId ? [teammate.id, own.id] : [own.id]);
    assert.deepEqual(settled.timelines["conversation-2"]?.messageIds ?? [],
      collisionConversationId === "conversation-2" ? [teammate.id] : []);
    assert.equal(settled.metadata.realtimeCursor.eventId, ownEvent.eventId);
    assert.equal(cache.applyDurableEvent(ownEvent).status, "duplicate");
    assert.equal(cache.getState(), settled, "replay must not reconcile the projection twice");
  });
}

test("realtime reducer failure triggers typed snapshot recovery without advancing cursor", async () => {
  const cache = createNormalizedChatCache();
  const sockets = [];
  const recoveries = [];
  const diagnostics = [];
  const session = createChatRealtimeSession({
    endpoint: "/chat",
    clientPackageVersion: "0.1.3",
    getAccessToken: () => "token",
    cache,
    onRecoveryDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    hydrateSnapshot: (input) => { recoveries.push(input); return new Promise(() => {}); },
    webSocketFactory() {
      const socket = { readyState: 0, onopen: null, onmessage: null, onerror: null, onclose: null, sent: [], send(data) { this.sent.push(JSON.parse(data)); }, close() {} };
      sockets.push(socket);
      return socket;
    },
  });
  session.start();
  await Promise.resolve(); await Promise.resolve();
  const socket = sockets[0];
  socket.onopen?.({});
  socket.onmessage?.({ data: JSON.stringify({ type: "chat.session.accepted", metadata: { packageVersion: "0.1.3", protocolVersion: 4, schemaVersion: 1, enabledFeatures: {}, supportedProtocolRange: { minimumVersion: 3, maximumVersion: 4 } }, tenantId, actorStreamId: `user:${userId}`, deviceId: "device-a", sessionId: "session-a" }) });
  socket.onmessage?.({ data: JSON.stringify(event("bad", "conversation-1", "future.event", {}, 1)) });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(session.state.state, "hydrating_snapshot");
  assert.equal(session.state.reason, "event_incompatible");
  assert.equal(diagnostics[0].code, "unknown_event_type");
  assert.equal(recoveries[0].diagnostic.eventId, "bad");
  assert.equal(cache.getState().metadata.realtimeCursor, undefined);
  session.close();
});

test("queued huddle events do not undo a newer HTTP membership snapshot", () => {
  const cache = createNormalizedChatCache(identity);
  const id = "conversation-1";
  cache.applyDurableEvent(event("seed", id, CHAT_DURABLE_EVENT_TYPES.conversationCreated, { conversation: conversation(id) }, 0));
  const starting = { status: "starting", conversationId: id, huddleSessionId: "huddle-1", startedAt: at(1), participants: [], screenShareOwnerUserId: null };
  const active = { ...starting, status: "active", participants: [{ userId, status: "joined", joinedAt: at(3) }] };
  cache.setHuddleState(active);
  cache.applyDurableEvent(event("queued-start", id, CHAT_DURABLE_EVENT_TYPES.huddleUpdated, { state: starting }, 1));
  assert.deepEqual(cache.getState().huddles[id], active);
  const left = { ...active, participants: [{ userId, status: "left", joinedAt: at(3), leftAt: at(5) }] };
  cache.setHuddleState(left);
  cache.applyDurableEvent(event("queued-join", id, CHAT_DURABLE_EVENT_TYPES.huddleUpdated, { state: active }, 3));
  assert.deepEqual(cache.getState().huddles[id], left);
});

function endedHuddleFixture() {
  const cache = createNormalizedChatCache(identity);
  const id = "conversation-1";
  const startedAt = "2030-01-01T00:00:00.000Z";
  const endedAt = "2030-01-01T00:00:01.123Z";
  const seed = event("seed", id, CHAT_DURABLE_EVENT_TYPES.conversationCreated,
    { conversation: conversation(id, { createdAt: startedAt, updatedAt: startedAt }) },
    0, { occurredAt: startedAt });
  assert.equal(cache.applyDurableEvent(seed).status, "applied");
  const ended = {
    status: "ended", conversationId: id, huddleSessionId: "huddle-a",
    startedAt, endedAt, endedByUserId: userId,
    participants: [{ userId, status: "left", joinedAt: endedAt, leftAt: endedAt }],
    screenShareOwnerUserId: null,
  };
  cache.setHuddleState(ended);
  assert.deepEqual(cache.getState().huddles[id], ended);
  // Installing the HTTP snapshot must leave the stream before the tied event.
  assert.deepEqual(cache.getState().metadata.durableStreams[id], {
    lastEventId: seed.eventId, lastOccurredAt: startedAt, recentEventIds: [seed.eventId],
  });
  return { cache, id, seed, ended };
}

function assertHuddleEventConsumed(cache, id, seed, incoming, expected) {
  assert.equal(cache.applyDurableEvent(incoming).status, "applied");
  const after = cache.getState();
  assert.deepEqual(after.huddles[id], expected);
  assert.deepEqual(after.metadata.realtimeCursor, { eventId: incoming.eventId });
  assert.deepEqual(after.metadata.durableStreams[id], {
    lastEventId: incoming.eventId,
    lastOccurredAt: incoming.occurredAt,
    recentEventIds: [seed.eventId, incoming.eventId],
  });
  assert.equal(cache.applyDurableEvent(incoming).status, "duplicate");
  assert.equal(cache.getState(), after, "replay must preserve the entire cache state");
}

for (const status of ["active", "starting"]) {
  for (const occurredAt of ["2030-01-01T00:00:01.123Z", "2030-01-01T00:00:02.123Z"]) {
    test(`ended huddle retains its full snapshot after same-session ${status} at ${occurredAt}`, () => {
      // Independent streams keep both tied cases valid without ambiguous event order.
      const { cache, id, seed, ended } = endedHuddleFixture();
      const live = {
        status, conversationId: id, huddleSessionId: ended.huddleSessionId,
        startedAt: ended.startedAt,
        participants: status === "active" ? [{ userId, status: "joined", joinedAt: ended.endedAt }] : [],
        screenShareOwnerUserId: null,
      };
      const incoming = event(`queued-${status}`, id, CHAT_DURABLE_EVENT_TYPES.huddleUpdated,
        { state: live }, 0, { occurredAt });
      assertHuddleEventConsumed(cache, id, seed, incoming, ended);
    });
  }
}

test("ended huddle accepts a later starting snapshot for a different session", () => {
  const { cache, id, seed } = endedHuddleFixture();
  const startedAt = "2030-01-01T00:00:02.123Z";
  const starting = {
    status: "starting", conversationId: id, huddleSessionId: "huddle-b",
    startedAt, participants: [], screenShareOwnerUserId: null,
  };
  const incoming = event("new-session", id, CHAT_DURABLE_EVENT_TYPES.huddleUpdated,
    { state: starting }, 0, { occurredAt: startedAt });
  assertHuddleEventConsumed(cache, id, seed, incoming, starting);
});
