import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseKnownDurableEvent } from "../dist/index.js";
import {
  DurableEventReductionError,
  createNormalizedChatCache,
} from "../dist/client/index.js";

const fixture = JSON.parse(await readFile(
  "conformance-tests/normalized-reducer-outcomes/fixtures.json",
  "utf8",
));

const by = (key) => (left, right) => String(left[key]).localeCompare(String(right[key]));
const values = (record, key) => Object.values(record).sort(by(key));

function project(state) {
  return {
    cursorEventId: state.metadata.realtimeCursor?.eventId,
    conversations: values(state.entities.conversations, "id").map((conversation) => ({
      id: conversation.id,
      type: conversation.type,
      visibility: conversation.visibility,
      ...(conversation.type === "thread" ? {
        parentConversationId: conversation.parentConversationId,
        rootMessageId: conversation.rootMessageId,
      } : {}),
    })),
    memberships: Object.keys(state.entities.membersByConversation).sort().map((conversationId) => ({
      conversationId,
      revision: state.metadata.memberListRevisions[conversationId],
      userIds: [...state.entities.memberUserIdsByConversation[conversationId]].sort(),
      members: values(state.entities.membersByConversation[conversationId], "userId").map((member) => ({
        userId: member.userId,
        role: member.role,
        state: member.state,
      })),
    })),
    timelines: Object.keys(state.timelines).sort().map((conversationId) => ({
      conversationId,
      messageIds: [...state.timelines[conversationId].messageIds],
    })),
    messages: values(state.entities.messages, "id").map((message) => ({
      id: message.id,
      conversationId: message.conversationId,
      sequence: message.sequence,
      revision: message.revision.revision,
      deleted: message.content === null,
      isThreadRoot: message.isThreadRoot,
      ...(message.threadSummary === undefined ? {} : {
        threadSummary: {
          ...message.threadSummary,
          participantIds: [...message.threadSummary.participantIds].sort(),
        },
      }),
      reactions: [...message.reactions].sort(by("reactionKey")).map((reaction) => ({ ...reaction })),
      attachmentIds: message.attachmentMetadata.map((attachment) => attachment.attachmentId).sort(),
    })),
    readStates: values(state.currentUser.readStates, "conversationId").map((read) => ({
      conversationId: read.conversationId,
      userId: read.userId,
      lastReadSequence: read.lastReadSequence,
    })),
    preferences: Object.keys(state.currentUser.preferences).sort().map((conversationId) => {
      const preference = state.currentUser.preferences[conversationId];
      return {
        conversationId,
        userId: preference.userId,
        revision: state.currentUser.preferenceRevisions[conversationId],
        notificationPreference: preference.notificationPreference,
        isStarred: preference.isStarred,
        muted: preference.mute.muted,
      };
    }),
    threadFollows: Object.keys(state.currentUser.threadFollows).sort().map((threadId) => ({
      threadId,
      revision: state.currentUser.threadFollowRevisions[threadId],
      isFollowing: state.currentUser.threadFollows[threadId].isFollowing,
      source: state.currentUser.threadFollows[threadId].source,
    })),
    savedMessages: Object.keys(state.currentUser.savedMessages).sort().map((messageId) => ({
      messageId,
      revision: state.currentUser.savedMessageRevisions[messageId],
      isSaved: state.currentUser.savedMessages[messageId].isSaved,
      ...(state.currentUser.savedMessages[messageId].privateNote === undefined ? {} : {
        privateNote: state.currentUser.savedMessages[messageId].privateNote,
      }),
    })),
    messageReminders: Object.keys(state.currentUser.messageReminders).sort().map((messageId) => ({
      conversationId: state.currentUser.messageReminderConversationIds[messageId],
      messageId,
      revision: state.currentUser.messageReminderRevisions[messageId],
      state: state.currentUser.messageReminders[messageId].state,
      ...(state.currentUser.messageReminders[messageId].dueAt === undefined ? {} : {
        dueAt: state.currentUser.messageReminders[messageId].dueAt,
      }),
    })),
    drafts: Object.keys(state.currentUser.drafts).sort().map((conversationId) => ({
      conversationId,
      revision: state.currentUser.draftRevisions[conversationId],
      kind: state.currentUser.drafts[conversationId].kind,
      ...(state.currentUser.drafts[conversationId].content === null ? {} : {
        text: state.currentUser.drafts[conversationId].content.text,
      }),
    })),
    attachments: values(state.entities.attachments, "attachmentId").map((attachment) => ({
      attachmentId: attachment.attachmentId,
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
    })),
    huddles: values(state.huddles, "conversationId").map((huddle) => ({
      conversationId: huddle.conversationId,
      status: huddle.status,
    })),
  };
}

function runFixture() {
  const cache = createNormalizedChatCache(fixture.trustedIdentity);
  for (const step of fixture.steps) {
    const before = cache.getState();
    const event = parseKnownDurableEvent(structuredClone(step.event), fixture.trustedIdentity);
    let reduction;
    try {
      reduction = cache.applyDurableEvent(event);
    } catch (error) {
      error.message = `${step.event.eventId}: ${error.message}`;
      throw error;
    }
    assert.equal(reduction.status, step.expectedStatus, step.event.eventId);
    if (step.expectedStatus !== "applied") assert.equal(cache.getState(), before);
  }
  return cache;
}

test("shared ordered durable events produce the canonical normalized projection", () => {
  const cache = runFixture();
  assert.deepEqual(project(cache.getState()), fixture.expected);

  for (const rejection of fixture.rejections) {
    const before = cache.getState();
    const event = parseKnownDurableEvent(structuredClone(rejection.event), rejection.parseAs);
    assert.throws(
      () => cache.applyDurableEvent(event),
      (error) => error instanceof DurableEventReductionError &&
        error.diagnostic.code === rejection.diagnostic.code &&
        error.diagnostic.reason === rejection.diagnostic.reason &&
        error.diagnostic.message === rejection.diagnostic.message,
      rejection.id,
    );
    assert.equal(cache.getState(), before, `${rejection.id} must be atomic`);
  }
});

test("mutating a shared expected revision is detected", () => {
  const actual = project(runFixture().getState());
  const mutated = structuredClone(fixture.expected);
  mutated.messages[0].revision += 1;
  assert.throws(() => assert.deepEqual(actual, mutated));
});
