import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  createApplicationChatQueuedSendMessageIntent,
  createApplicationChatQueuedSendMessageIntentsRecord,
  createApplicationChatStorage,
  createChatClient,
  createConversationMessagesSelector,
  createNormalizedChatCache,
  selectDirectMessageOtherUserRead,
} from "@handrail/chat/client";
import {
  createChatTestHarness,
  createPostgresTestBackend,
} from "@handrail/chat/testing";
import { WebSocket } from "ws";

const tenantId = "reconnect-tenant";
const actorUserId = "reconnect-actor";
const peerUserId = "reconnect-peer";
const conversationId = "reconnect-direct";
const logicalClientMessageId = "reconnect-logical-message";
const logicalIdempotencyKey = "reconnect-logical-send";

const actor = {
  credential: "reconnect-actor-token",
  actor: {
    tenantId,
    userId: actorUserId,
    roles: ["employee"],
  },
  capabilities: ["message.send"],
  user: {
    tenantId,
    userId: actorUserId,
    displayName: "Reconnect Actor",
  },
};

const peer = {
  credential: "reconnect-peer-token",
  actor: {
    tenantId,
    userId: peerUserId,
    roles: ["employee"],
  },
  capabilities: ["message.send"],
  user: {
    tenantId,
    userId: peerUserId,
    displayName: "Reconnect Peer",
  },
};

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const createBarrier = () => {
  const values = [];
  const waiters = new Set();
  return {
    values,
    observe(value) {
      values.push(value);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(value)) continue;
        waiters.delete(waiter);
        waiter.resolve(value);
      }
    },
    waitFor(predicate) {
      const existing = values.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.add({ predicate, resolve }));
    },
  };
};

const createSocketProbe = () => {
  const frames = createBarrier();
  const closes = createBarrier();
  const sockets = [];
  return {
    frames,
    closes,
    sockets,
    factory(url, protocols) {
      const socketIndex = sockets.length;
      const socket = new WebSocket(url, [...protocols]);
      sockets.push(socket);
      socket.on("message", (data) => {
        const observed = {
          socketIndex,
          frame: JSON.parse(data.toString()),
        };
        frames.observe(observed);
      });
      socket.on("close", (code, reason) => {
        closes.observe({ socketIndex, code, reason: reason.toString() });
      });
      return socket;
    },
  };
};

const seedDirectConversation = async (harness) => {
  const schema = quoteIdentifier(harness.schema);
  await harness.pool.query(
    `INSERT INTO ${schema}.chat_conversations
       (tenant_id, id, type, visibility, current_message_sequence,
        created_at, updated_at)
     VALUES ($1, $2, 'direct', 'private', 0, clock_timestamp(), clock_timestamp())`,
    [tenantId, conversationId],
  );
  await harness.pool.query(
    `INSERT INTO ${schema}.chat_conversation_members
       (tenant_id, conversation_id, user_id, role, state)
     VALUES
       ($1, $2, $3, 'owner', 'active'),
       ($1, $2, $4, 'member', 'active')`,
    [tenantId, conversationId, actorUserId, peerUserId],
  );
  await harness.pool.query(
    `INSERT INTO ${schema}.chat_read_cursors
       (tenant_id, conversation_id, user_id, last_read_sequence)
     VALUES
       ($1, $2, $3, 0),
       ($1, $2, $4, 0)`,
    [tenantId, conversationId, actorUserId, peerUserId],
  );
  await harness.pool.query(
    `INSERT INTO ${schema}.chat_conversation_preferences
       (tenant_id, conversation_id, user_id)
     VALUES
       ($1, $2, $3),
       ($1, $2, $4)`,
    [tenantId, conversationId, actorUserId, peerUserId],
  );
};

const frameIs = (socketIndex, type, eventId) => ({
  socketIndex: observedSocketIndex,
  frame,
}) =>
  observedSocketIndex === socketIndex &&
  frame.type === type &&
  (eventId === undefined || frame.eventId === eventId);

const countFrames = (probe, type, eventId) =>
  probe.frames.values.filter(
    ({ frame }) =>
      frame.type === type &&
      (eventId === undefined || frame.eventId === eventId),
  ).length;

test(
  "real clients converge after an acknowledgement-lost send retry, reconnect replay, and cross-device read",
  { timeout: 30_000 },
  async () => {
    const backend = await createPostgresTestBackend();
    let harness;
    const clients = [];
    const releases = [];

    try {
      harness = await createChatTestHarness({
        backend,
        actors: [actor, peer],
        schemaPrefix: "reconnect_idempotency",
      });
      await seedDirectConversation(harness);

      const actorFirstProbe = createSocketProbe();
      const actorSecondProbe = createSocketProbe();
      const peerProbe = createSocketProbe();
      const actorFirstEvents = createBarrier();
      const actorSecondEvents = createBarrier();
      const peerEvents = createBarrier();
      const actorFirstStates = createBarrier();
      const actorSecondStates = createBarrier();
      const peerStates = createBarrier();
      const sendRequests = [];
      let firstSendEntered;
      let releaseFirstSend;
      const firstSendAtCommitBoundary = new Promise((resolve) => {
        firstSendEntered = resolve;
      });
      const firstSendMayProceed = new Promise((resolve) => {
        releaseFirstSend = resolve;
      });
      let dropCommittedResponse = true;

      const actorFirst = createChatClient({
        endpoint: harness.endpoint,
        getAccessToken: () => actor.credential,
        commands: { retry: { maxAttempts: 1 } },
        optimisticMessages: {
          generateClientMessageId: () => logicalClientMessageId,
          generateIdempotencyKey: () => logicalIdempotencyKey,
        },
        async fetch(url, init) {
          const isLogicalSend =
            init?.method === "POST" &&
            String(url).endsWith(`/conversations/${conversationId}/messages`);
          if (!isLogicalSend) return fetch(url, init);
          sendRequests.push({
            idempotencyKey: init.headers["idempotency-key"],
            body: JSON.parse(init.body),
          });
          if (sendRequests.length === 1) {
            firstSendEntered();
            await firstSendMayProceed;
          }
          const response = await fetch(url, init);
          if (dropCommittedResponse) {
            dropCommittedResponse = false;
            assert.equal(response.status, 201);
            throw new Error("deterministic acknowledgement loss after commit");
          }
          return response;
        },
        realtime: {
          webSocketFactory: actorFirstProbe.factory,
          onStateChange: actorFirstStates.observe,
          onCanonicalEvent: actorFirstEvents.observe,
        },
      });
      const actorSecond = createChatClient({
        endpoint: harness.endpoint,
        getAccessToken: () => actor.credential,
        readState: {
          generateIdempotencyKey: () => "reconnect-actor-read",
        },
        realtime: {
          webSocketFactory: actorSecondProbe.factory,
          onStateChange: actorSecondStates.observe,
          onCanonicalEvent: actorSecondEvents.observe,
        },
      });
      const peerClient = createChatClient({
        endpoint: harness.endpoint,
        getAccessToken: () => peer.credential,
        optimisticMessages: {
          generateClientMessageId: () => "reconnect-baseline-message",
          generateIdempotencyKey: () => "reconnect-baseline-send",
        },
        realtime: {
          webSocketFactory: peerProbe.factory,
          onStateChange: peerStates.observe,
          onCanonicalEvent: peerEvents.observe,
        },
      });
      clients.push(actorFirst, actorSecond, peerClient);

      const stateBarriers = [actorFirstStates, actorSecondStates, peerStates];
      for (const client of clients) {
        assert.equal((await client.start()).state, "ready");
      }
      await Promise.all(
        stateBarriers.map((barrier) =>
          barrier.waitFor((state) => state.state === "connected"),
        ),
      );

      for (const client of clients) {
        assert.equal(
          (await client.getConversation({ conversationId })).status,
          "success",
        );
        releases.push(client.realtime.subscribeConversation(conversationId));
      }
      await Promise.all([
        actorFirstProbe.frames.waitFor(
          ({ socketIndex, frame }) =>
            socketIndex === 0 &&
            frame.type === "chat.subscription.accepted" &&
            frame.streamId === conversationId,
        ),
        actorSecondProbe.frames.waitFor(
          ({ socketIndex, frame }) =>
            socketIndex === 0 &&
            frame.type === "chat.subscription.accepted" &&
            frame.streamId === conversationId,
        ),
        peerProbe.frames.waitFor(
          ({ socketIndex, frame }) =>
            socketIndex === 0 &&
            frame.type === "chat.subscription.accepted" &&
            frame.streamId === conversationId,
        ),
      ]);

      const baselineSend = await peerClient.sendMessage({
        conversationId,
        content: { format: "plain", text: "baseline cursor event" },
      });
      assert.equal(baselineSend.status, "success");
      const baselineMessageId = baselineSend.value.message.id;
      await Promise.all([
        actorFirstProbe.frames.waitFor(frameIs(0, "message.created")),
        actorSecondProbe.frames.waitFor(frameIs(0, "message.created")),
        peerProbe.frames.waitFor(frameIs(0, "message.created")),
      ]);
      const baselineEvent = actorFirstProbe.frames.values.find(
        ({ frame }) =>
          frame.type === "message.created" &&
          frame.payload.message.id === baselineMessageId,
      ).frame;

      const logicalEventOnSecond = actorSecondEvents.waitFor(
        (event) =>
          event.type === "message.created" &&
          event.payload.clientMessageId === logicalClientMessageId,
      );
      const logicalEventOnPeer = peerEvents.waitFor(
        (event) =>
          event.type === "message.created" &&
          event.payload.clientMessageId === logicalClientMessageId,
      );
      const firstAttempt = actorFirst.sendMessage({
        conversationId,
        content: { format: "markdown", text: "persist once across reconnect" },
      });
      const pending = createConversationMessagesSelector(conversationId)(
        actorFirst.cache.getState(),
      ).find((message) => "delivery" in message);
      assert.equal(pending.delivery.state, "sending");
      assert.equal(pending.delivery.clientMessageId, logicalClientMessageId);

      await firstSendAtCommitBoundary;
      actorFirst.realtime.close();
      await actorFirstProbe.closes.waitFor(({ socketIndex }) => socketIndex === 0);
      releaseFirstSend();

      const failed = await firstAttempt;
      assert.equal(failed.status, "transport");
      const failedProjection = createConversationMessagesSelector(conversationId)(
        actorFirst.cache.getState(),
      ).find((message) => "delivery" in message);
      assert.deepEqual(
        {
          state: failedProjection.delivery.state,
          clientMessageId: failedProjection.delivery.clientMessageId,
          idempotencyKey: failedProjection.delivery.idempotencyKey,
          retryable: failedProjection.delivery.retryable,
        },
        {
          state: "failed",
          clientMessageId: logicalClientMessageId,
          idempotencyKey: logicalIdempotencyKey,
          retryable: true,
        },
      );

      const [secondLiveEvent, peerLiveEvent] = await Promise.all([
        logicalEventOnSecond,
        logicalEventOnPeer,
      ]);
      assert.equal(secondLiveEvent.eventId, peerLiveEvent.eventId);
      const logicalEventId = secondLiveEvent.eventId;

      const retried = await actorFirst.retryMessage(logicalClientMessageId);
      assert.equal(retried.status, "success");
      assert.equal(retried.value.reconciliationStatus, "replayed");
      assert.equal(retried.value.message.sequence, 2);
      assert.deepEqual(sendRequests, [
        {
          idempotencyKey: logicalIdempotencyKey,
          body: {
            operation: "send",
            conversationId,
            clientMessageId: logicalClientMessageId,
            idempotencyKey: logicalIdempotencyKey,
            content: {
              format: "markdown",
              text: "persist once across reconnect",
            },
          },
        },
        {
          idempotencyKey: logicalIdempotencyKey,
          body: {
            operation: "send",
            conversationId,
            clientMessageId: logicalClientMessageId,
            idempotencyKey: logicalIdempotencyKey,
            content: {
              format: "markdown",
              text: "persist once across reconnect",
            },
          },
        },
      ]);

      actorFirst.realtime.restart();
      const acceptedAfterReconnect = await actorFirstProbe.frames.waitFor(
        ({ socketIndex, frame }) =>
          socketIndex === 1 && frame.type === "chat.session.accepted",
      );
      assert.deepEqual(acceptedAfterReconnect.frame.resumeFrom, {
        eventId: baselineEvent.eventId,
      });
      const replayedLogical = await actorFirstProbe.frames.waitFor(
        frameIs(1, "message.created", logicalEventId),
      );
      assert.equal(replayedLogical.frame.payload.clientMessageId, logicalClientMessageId);
      assert.ok(
        actorFirstProbe.frames.values.indexOf(acceptedAfterReconnect) <
          actorFirstProbe.frames.values.indexOf(replayedLogical),
      );
      await harness.runtime.realtimeHub.publish(secondLiveEvent);
      assert.equal(
        countFrames(actorFirstProbe, "message.created", logicalEventId),
        1,
        "the server suppresses a live duplicate of the replayed event",
      );

      const readOnFirst = actorFirstProbe.frames.waitFor(
        ({ frame }) => frame.type === "conversation.read_cursor_updated",
      );
      const readOnSecond = actorSecondProbe.frames.waitFor(
        ({ frame }) => frame.type === "conversation.read_cursor_updated",
      );
      const markedRead = await actorSecond.markRead({
        conversationId,
        throughSequence: retried.value.message.sequence,
      });
      assert.equal(markedRead.status, "success");
      const [firstReadFrame, secondReadFrame] = await Promise.all([
        readOnFirst,
        readOnSecond,
      ]);
      assert.equal(firstReadFrame.frame.streamId, `user:${actorUserId}`);
      assert.equal(secondReadFrame.frame.streamId, `user:${actorUserId}`);
      assert.equal(
        firstReadFrame.frame.payload.readState.lastReadSequence,
        retried.value.message.sequence,
      );

      const peerSubscriptionResponses = peerProbe.frames.values.filter(
        ({ frame }) =>
          frame.type === "chat.subscription.accepted" &&
          frame.streamId === conversationId,
      ).length;
      releases[2]();
      releases[2] = peerClient.realtime.subscribeConversation(conversationId);
      await peerProbe.frames.waitFor(
        ({ frame }) =>
          frame.type === "chat.subscription.accepted" &&
          frame.streamId === conversationId &&
          peerProbe.frames.values.filter(
            ({ frame: candidate }) =>
              candidate.type === "chat.subscription.accepted" &&
              candidate.streamId === conversationId,
          ).length > peerSubscriptionResponses,
      );
      assert.equal(
        peerProbe.frames.values.some(
          ({ frame }) => frame.type === "conversation.read_cursor_updated",
        ),
        false,
      );

      const schema = quoteIdentifier(harness.schema);
      const persisted = (
        await harness.pool.query(
          `SELECT
             conversation.current_message_sequence::integer AS current_sequence,
             (SELECT array_agg(message.sequence::integer ORDER BY message.sequence)
                FROM ${schema}.chat_messages AS message
               WHERE message.tenant_id = $1
                 AND message.conversation_id = $2) AS sequences,
             (SELECT count(*)::integer
                FROM ${schema}.chat_messages AS message
               WHERE message.tenant_id = $1
                 AND message.author_user_id = $3
                 AND message.client_message_id = $4) AS logical_messages,
             (SELECT count(*)::integer
                FROM ${schema}.chat_idempotency_keys AS outcome
               WHERE outcome.tenant_id = $1
                 AND outcome.user_id = $3
                 AND outcome.operation_name = 'message.send'
                 AND outcome.client_key = $5
                 AND outcome.state = 'completed') AS completed_outcomes,
             (SELECT count(*)::integer
                FROM ${schema}.chat_audit_events AS audit
               WHERE audit.tenant_id = $1
                 AND audit.action = 'message.created'
                 AND audit.target_id = $6) AS logical_audit_effects,
             (SELECT count(*)::integer
                FROM ${schema}.chat_outbox_events AS event
               WHERE event.tenant_id = $1
                 AND event.type = 'message.created'
                 AND event.payload ->> 'clientMessageId' = $4) AS logical_outbox_effects,
             (SELECT count(*)::integer
                FROM ${schema}.chat_outbox_events AS event
               WHERE event.tenant_id = $1
                 AND event.type = 'message.created'
                 AND event.payload ->> 'clientMessageId' = $4
                 AND event.published_at IS NOT NULL) AS published_logical_effects
           FROM ${schema}.chat_conversations AS conversation
          WHERE conversation.tenant_id = $1 AND conversation.id = $2`,
          [
            tenantId,
            conversationId,
            actorUserId,
            logicalClientMessageId,
            logicalIdempotencyKey,
            retried.value.message.id,
          ],
        )
      ).rows[0];
      assert.deepEqual(persisted, {
        current_sequence: 2,
        sequences: [1, 2],
        logical_messages: 1,
        completed_outcomes: 1,
        logical_audit_effects: 1,
        logical_outbox_effects: 1,
        published_logical_effects: 1,
      });
      assert.equal(
        harness.calls
          .all("realtime.publish")
          .filter(
            ({ input }) =>
              input.type === "message.created" &&
              input.payload.clientMessageId === logicalClientMessageId,
          ).length,
        1,
      );

      const logicalMessageId = retried.value.message.id;
      for (const client of clients) {
        const state = client.cache.getState();
        assert.equal(state.entities.messages[logicalMessageId].sequence, 2);
        assert.equal(
          Object.values(state.entities.messages).filter(
            (message) => message.id === logicalMessageId,
          ).length,
          1,
        );
        assert.equal(
          Object.values(state.entities.messages).some(
            (message) =>
              "delivery" in message &&
              message.delivery.clientMessageId === logicalClientMessageId,
          ),
          false,
        );
      }

      assert.equal(
        actorFirst.cache.getState().currentUser.readStates[conversationId]
          .lastReadSequence,
        2,
      );
      assert.equal(
        actorSecond.cache.getState().currentUser.readStates[conversationId]
          .lastReadSequence,
        2,
      );
      assert.deepEqual(
        peerClient.cache.getState().currentUser.readStates[conversationId],
        {
          conversationId,
          userId: peerUserId,
          lastReadSequence: 0,
          updatedAt:
            peerClient.cache.getState().currentUser.readStates[conversationId]
              .updatedAt,
        },
      );

      const authoritativeActorCursor = (
        await harness.pool.query(
          `SELECT conversation_id AS "conversationId", user_id AS "userId",
                  last_read_sequence::integer AS "lastReadSequence",
                  updated_at AS "updatedAt"
             FROM ${schema}.chat_read_cursors
            WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3`,
          [tenantId, conversationId, actorUserId],
        )
      ).rows[0];
      authoritativeActorCursor.updatedAt =
        authoritativeActorCursor.updatedAt.toISOString();
      assert.equal(
        selectDirectMessageOtherUserRead(peerClient.cache.getState(), {
          conversationId,
          otherMemberReadState: authoritativeActorCursor,
          messageSequence: 2,
        }),
        true,
      );
      assert.equal(
        peerClient.cache.getState().currentUser.readStates[conversationId]
          .userId,
        peerUserId,
      );

      assert.equal(countFrames(actorFirstProbe, "message.created", logicalEventId), 1);
      assert.equal(
        actorFirstEvents.values.filter((event) => event.eventId === logicalEventId)
          .length,
        1,
        "the replay advances the cursor while the later live copy is suppressed",
      );
      assert.equal(
        actorSecondEvents.values.filter((event) => event.eventId === logicalEventId)
          .length,
        1,
      );
      assert.equal(
        peerEvents.values.filter((event) => event.eventId === logicalEventId)
          .length,
        1,
      );
    } finally {
      for (const release of releases) release();
      for (const client of clients) client.close();
      await harness?.teardown();
      await backend.teardown();
    }
  },
);

test(
  "a retained request replay creates one message and one completed send outcome",
  { timeout: 30_000 },
  async () => {
    const backend = await createPostgresTestBackend();
    let harness;
    let client;
    try {
      harness = await createChatTestHarness({
        backend,
        actors: [actor, peer],
        schemaPrefix: "retained_request_replay",
      });
      await seedDirectConversation(harness);

      const storageIdentity = {
        tenantId,
        userId: actorUserId,
        deviceId: "retained-device",
      };
      const retainedRequest = {
        operation: "send",
        conversationId,
        clientMessageId: "retained-replay-client-message",
        idempotencyKey: "retained-replay-idempotency",
        content: { format: "plain", text: "one retained request, delivered twice" },
      };
      const records = new Map();
      const recordKey = (identity, kind) =>
        `${identity.tenantId}\0${identity.userId}\0${identity.deviceId}\0${kind}`;
      const storage = createApplicationChatStorage({
        async read(identity, kind) {
          return records.get(recordKey(identity, kind)) ?? null;
        },
        async replace(identity, kind, encoded) {
          records.set(recordKey(identity, kind), encoded);
        },
        async remove(identity, kind) {
          records.delete(recordKey(identity, kind));
        },
        async clearForLogout(identity) {
          for (const kind of Object.values(ApplicationChatStorageRecordKind)) {
            records.delete(recordKey(identity, kind));
          }
        },
      });
      await storage.replace(createApplicationChatQueuedSendMessageIntentsRecord(
        storageIdentity,
        [createApplicationChatQueuedSendMessageIntent(retainedRequest, {
          enqueueOrder: 1,
          enqueuedAt: "2026-09-03T12:00:00.000Z",
        })],
      ));

      const deliveries = [];
      let dropFirstCommittedResponse = true;
      client = createChatClient({
        endpoint: harness.endpoint,
        getAccessToken: () => actor.credential,
        cache: createNormalizedChatCache({
          tenantId,
          userId: actorUserId,
          sessionId: "retained-session",
        }),
        commands: { retry: { maxAttempts: 1 } },
        normalizedCachePersistence: {
          storage,
          resolveIdentity: () => storageIdentity,
          retainedSendRecovery: {
            initialDelayMs: 0,
            maximumDelayMs: 0,
            wait: async () => {},
          },
        },
        async fetch(url, init) {
          const isRetainedSend =
            init?.method === "POST" &&
            String(url).endsWith(`/conversations/${conversationId}/messages`);
          if (!isRetainedSend) return fetch(url, init);
          deliveries.push({
            body: JSON.parse(init.body),
            idempotencyKey: init.headers["idempotency-key"],
          });
          const result = await fetch(url, init);
          if (dropFirstCommittedResponse) {
            dropFirstCommittedResponse = false;
            assert.equal(result.status, 201);
            throw new Error("retained replay acknowledgement lost after commit");
          }
          return result;
        },
      });

      assert.equal((await client.start()).state, "ready");
      await new Promise((resolve, reject) => {
        let release = () => {};
        const timeout = setTimeout(() => {
          release();
          reject(new Error("retained replay did not settle"));
        }, 10_000);
        release = client.subscribeSendMessageQueue((state) => {
          if (deliveries.length !== 2 || !state.isHydrated || state.intents.length !== 0) {
            return;
          }
          clearTimeout(timeout);
          queueMicrotask(release);
          resolve();
        });
      });

      assert.deepEqual(deliveries, [
        { body: retainedRequest, idempotencyKey: retainedRequest.idempotencyKey },
        { body: retainedRequest, idempotencyKey: retainedRequest.idempotencyKey },
      ]);
      assert.equal(records.has(recordKey(
        storageIdentity,
        ApplicationChatStorageRecordKind.queuedSendMessageIntents,
      )), false);

      const schema = quoteIdentifier(harness.schema);
      const persisted = (
        await harness.pool.query(
          `SELECT
             (SELECT count(*)::integer
                FROM ${schema}.chat_messages
               WHERE tenant_id = $1
                 AND conversation_id = $2
                 AND client_message_id = $3) AS messages,
             (SELECT count(*)::integer
                FROM ${schema}.chat_idempotency_keys
               WHERE tenant_id = $1
                 AND user_id = $4
                 AND operation_name = 'message.send'
                 AND client_key = $5
                 AND state = 'completed') AS completed_outcomes`,
          [
            tenantId,
            conversationId,
            retainedRequest.clientMessageId,
            actorUserId,
            retainedRequest.idempotencyKey,
          ],
        )
      ).rows[0];
      assert.deepEqual(persisted, { messages: 1, completed_outcomes: 1 });
    } finally {
      client?.close();
      await harness?.teardown();
      await backend.teardown();
    }
  },
);
