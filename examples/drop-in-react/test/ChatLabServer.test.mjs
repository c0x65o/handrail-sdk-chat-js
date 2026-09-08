import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MAX_ATTACHMENT_SIZE_BYTES } from "@handrail/chat";
import { createChatClient } from "@handrail/chat/client";
import { WebSocket } from "ws";
import { chatLabBackendProvenance } from "../scripts/chat-lab-provenance.mjs";

import {
  CHAT_LAB_DELETED_GROUP_DIRECT_MESSAGE,
  CHAT_LAB_EDITED_PUBLIC_MESSAGE,
  CHAT_LAB_GROUP_DIRECT_MESSAGES,
  CHAT_LAB_PUBLIC_LINK_PREVIEW,
  CHAT_LAB_PUBLIC_MESSAGES,
  CHAT_LAB_PUBLIC_THREAD_REPLY_TEXT,
} from "../scripts/chat-lab-backend.mjs";
import {
  createChatLabLoopbackStorage,
  startChatLab,
} from "../scripts/chat-lab.mjs";

const waitFor = async (predicate, message, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(typeof message === "function" ? message() : message);
};

const requireSuccess = (operation, result) => {
  assert.equal(result.status, "success", `${operation}: ${JSON.stringify(result)}`);
  return result.value;
};

// The SDK consumes the browser WebSocket shape, where text frames arrive as
// strings. `ws` intentionally exposes Node Buffers, so this test boundary only
// normalizes the event representation; it does not bypass the network.
const createNodeBrowserSocketFactory = ({ onMessage, onSend } = {}) => (url, protocols) => {
  const socket = new WebSocket(url, protocols);
  const adapter = {
    get readyState() { return socket.readyState; },
    send(value) {
      onSend?.(value);
      socket.send(value);
    },
    close(code, reason) {
      if (socket.readyState === WebSocket.CONNECTING) {
        socket.once("error", () => undefined);
        socket.terminate();
        return;
      }
      socket.close(code, reason);
    },
  };
  for (const property of ["onopen", "onerror", "onclose"]) {
    Object.defineProperty(adapter, property, {
      get: () => socket[property],
      set: (listener) => { socket[property] = listener; },
      enumerable: true,
    });
  }
  Object.defineProperty(adapter, "onmessage", {
    get: () => socket.onmessage,
    set: (listener) => {
      socket.onmessage = listener === null
        ? null
        : (event) => {
          const data = event.data.toString();
          onMessage?.(data);
          listener({ data });
        };
    },
    enumerable: true,
  });
  return adapter;
};

const nodeBrowserSocketFactory = createNodeBrowserSocketFactory();

test("Chat Lab loopback storage accepts the public per-attachment limit within a bounded total budget", async () => {
  const storage = createChatLabLoopbackStorage();
  storage.setOrigin("http://127.0.0.1:4167");
  const actor = { tenantId: "chat-lab", userId: "ada", roles: ["employee"] };
  try {
    const formerlyOversized = await storage.createUploadUrl({
      actor,
      attachmentId: "formerly-oversized",
      fileName: "automation.png",
      contentType: "image/png",
      contentLengthBytes: (10 * 1024 * 1024) + 1,
    });
    assert.equal(new URL(formerlyOversized.url).pathname, "/__chat-lab/storage/upload");

    for (const attachmentId of ["contract-maximum-1", "contract-maximum-2"]) {
      await storage.createUploadUrl({
        actor,
        attachmentId,
        fileName: `${attachmentId}.png`,
        contentType: "image/png",
        contentLengthBytes: MAX_ATTACHMENT_SIZE_BYTES,
      });
    }
    await assert.rejects(
      storage.createUploadUrl({
        actor,
        attachmentId: "over-total-budget",
        fileName: "over-total-budget.png",
        contentType: "image/png",
        contentLengthBytes: MAX_ATTACHMENT_SIZE_BYTES,
      }),
      /storage capacity is exhausted/u,
    );
  } finally {
    await storage.teardown();
  }
});

const createControllableNetwork = () => {
  let online = true;
  const listeners = {
    offline: new Set(),
    online: new Set(),
  };
  return {
    network: {
      isOnline: () => online,
      addEventListener(type, listener) { listeners[type].add(listener); },
      removeEventListener(type, listener) { listeners[type].delete(listener); },
    },
    setOnline(nextOnline) {
      if (online === nextOnline) return;
      online = nextOnline;
      for (const listener of listeners[nextOnline ? "online" : "offline"]) listener();
    },
  };
};

test("Chat Lab serves the browser and exercises persisted HTTP, realtime, and actor switching", async () => {
  const flutterWebRoot = await mkdtemp(
    path.join(tmpdir(), "handrail-flutter-chat-lab-"),
  );
  await writeFile(
    path.join(flutterWebRoot, "index.html"),
    '<!doctype html><script src="flutter_bootstrap.js" async></script>',
  );
  const lab = await startChatLab({
    host: "127.0.0.1",
    port: 0,
    flutterWebRoot,
  });
  const clients = [];

  try {
    const [
      rootPage,
      page,
      reminderPage,
      reactPage,
      flutterPage,
      health,
      instance,
      adaSession,
      graceSession,
      margaretSession,
      unknownSession,
    ] = await Promise.all([
      fetch(`${lab.origin}/`, { redirect: "manual" }),
      fetch(`${lab.origin}/chat-lab.html`),
      fetch(`${lab.origin}/reminder-chat-lab.html`),
      fetch(`${lab.origin}/react-chat-lab.html`),
      fetch(`${lab.origin}/__flutter-chat-lab/`),
      fetch(`${lab.origin}/__chat-lab/health`),
      fetch(`${lab.origin}/__chat-lab/instance`),
      fetch(`${lab.origin}/__chat-lab/session?actor=ada`),
      fetch(`${lab.origin}/__chat-lab/session?actor=grace`),
      fetch(`${lab.origin}/__chat-lab/session?actor=margaret`),
      fetch(`${lab.origin}/__chat-lab/session?actor=unknown`),
    ]);
    assert.equal(rootPage.status, 302);
    assert.equal(rootPage.headers.get("location"), "/chat-lab.html");
    assert.equal(rootPage.headers.get("cache-control"), "no-store");
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /src="\/src\/chat-lab-main\.tsx(?:\?[^"]*)?"/u);
    assert.doesNotMatch(pageHtml, /reminder-chat-lab-main\.tsx/u);
    assert.equal(reminderPage.status, 200);
    assert.match(
      await reminderPage.text(),
      /src="\/src\/reminder-chat-lab-main\.tsx(?:\?[^"]*)?"/u,
    );
    assert.equal(reactPage.status, 200);
    assert.match(
      await reactPage.text(),
      /src="\/src\/chat-lab-main\.tsx(?:\?[^"]*)?"/u,
    );
    assert.equal(flutterPage.status, 200);
    assert.match(await flutterPage.text(), /flutter_bootstrap\.js/u);
    assert.deepEqual(await health.json(), { status: "ready" });
    assert.equal(instance.status, 200);
    assert.equal(instance.headers.get("cache-control"), "no-store");
    assert.deepEqual(await instance.json(), {
      instanceId: lab.instanceId,
      backend: chatLabBackendProvenance,
    });
    assert.match(chatLabBackendProvenance.fingerprint, /^[a-f0-9]{64}$/u);
    assert.match(lab.instanceId, /^[a-f0-9]{32}$/u);
    assert.equal(unknownSession.status, 404);
    assert.equal(adaSession.status, 200);
    assert.equal(graceSession.status, 200);
    assert.equal(margaretSession.status, 200);
    const adaToken = await adaSession.text();
    const graceToken = await graceSession.text();
    const margaretToken = await margaretSession.text();
    assert.equal(new Set([adaToken, graceToken, margaretToken]).size, 3);

    const createClient = (token) => {
      const client = createChatClient({
        endpoint: `${lab.origin}/api/chat`,
        getAccessToken: () => token,
        realtime: { webSocketFactory: nodeBrowserSocketFactory },
      });
      clients.push(client);
      return client;
    };
    const ada = createClient(adaToken);
    const grace = createClient(graceToken);
    const margaret = createClient(margaretToken);
    const starts = await Promise.all([ada.start(), grace.start(), margaret.start()]);
    assert.deepEqual(starts.map(({ state }) => state), ["ready", "ready", "ready"]);
    assert.equal(ada.state.enabledFeatures.media, true);
    await Promise.all([
      waitFor(
        () => ada.cache.getState().identity?.userId === "ada",
        "Ada's browser-compatible realtime session did not establish identity",
      ),
      waitFor(
        () => grace.cache.getState().identity?.userId === "grace",
        "Grace's browser-compatible realtime session did not establish identity",
      ),
      waitFor(
        () => margaret.cache.getState().identity?.userId === "margaret",
        "Margaret's browser-compatible realtime session did not establish identity",
      ),
    ]);

    const startHuddleInput = {
      operation: "start_huddle",
      conversationId: lab.conversationIds.direct,
      idempotencyKey: "chat-lab-integrated-huddle-start",
    };
    const startHuddleResponse = await fetch(
      `${lab.origin}/api/chat/conversations/${encodeURIComponent(lab.conversationIds.direct)}/huddles`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adaToken}`,
          "content-type": "application/json",
          "idempotency-key": startHuddleInput.idempotencyKey,
        },
        body: JSON.stringify(startHuddleInput),
      },
    );
    const startedHuddle = await startHuddleResponse.json();
    assert.equal(
      startHuddleResponse.status,
      200,
      JSON.stringify({
        response: startedHuddle,
        mediaCalls: lab.harness.calls.all().filter(({ boundary }) =>
          boundary.startsWith("media.")
        ),
      }),
    );
    assert.equal(startedHuddle.operation, "start_huddle");
    assert.equal(startedHuddle.outcome, "ok");
    assert.equal(startedHuddle.state.status, "starting");
    assert.equal(startedHuddle.state.conversationId, lab.conversationIds.direct);
    assert.equal(startedHuddle.mediaJoin.kind, "opaque_media_join");

    const hydratedHuddle = await ada.hydrateHuddle(lab.conversationIds.direct);
    assert.equal(
      hydratedHuddle.status,
      "success",
      `Ada huddle hydration: ${JSON.stringify(hydratedHuddle)}`,
    );
    const joinedHuddle = await ada.joinHuddle(lab.conversationIds.direct);
    assert.equal(
      joinedHuddle.status,
      "success",
      `Ada integrated huddle join: ${JSON.stringify(joinedHuddle)}`,
    );
    assert.equal(joinedHuddle.state.status, "active");
    assert.equal(joinedHuddle.state.participants[0]?.userId, "ada");
    const endedHuddle = await ada.endHuddle(lab.conversationIds.direct);
    assert.equal(
      endedHuddle.status,
      "success",
      `Ada integrated huddle end: ${JSON.stringify(endedHuddle)}`,
    );
    assert.equal(endedHuddle.state.status, "ended");

    const directorySearch = requireSuccess(
      "Ada directory search",
      await ada.searchDirectoryUsers({ query: "a", limit: 25 }),
    );
    assert.deepEqual(
      directorySearch.users.map(({ userId }) => userId).sort(),
      ["ada", "grace", "margaret"],
    );

    const [adaSeedTimeline, graceSeedTimeline, threadTimeline] = await Promise.all([
      ada.getMessageTimeline({
        conversationId: lab.conversationIds.direct,
        direction: "backward",
        limit: 50,
      }),
      grace.getMessageTimeline({
        conversationId: lab.conversationIds.direct,
        direction: "backward",
        limit: 50,
      }),
      ada.getMessageTimeline({
        conversationId: lab.threadConversationId,
        direction: "backward",
        limit: 50,
      }),
    ]).then(([adaResult, graceResult, threadResult]) => [
      requireSuccess("Ada seed timeline", adaResult),
      requireSuccess("Grace seed timeline", graceResult),
      requireSuccess("thread seed timeline", threadResult),
    ]);
    const rootFor = (timeline) => timeline.messages.find(
      ({ id }) => id === lab.rootMessageId,
    );
    const reactionFor = (message, reactionKey) => message?.reactions.find(
      (reaction) => reaction.reactionKey === reactionKey,
    );
    const adaRoot = rootFor(adaSeedTimeline);
    const graceRoot = rootFor(graceSeedTimeline);
    assert.ok(adaRoot);
    assert.ok(graceRoot);
    assert.equal(adaRoot.reactions.length, 2);
    assert.equal(graceRoot.reactions.length, 2);
    assert.deepEqual(reactionFor(adaRoot, "👍"), {
      reactionKey: "👍",
      count: 1,
      reactedByCurrentUser: true,
    });
    assert.deepEqual(reactionFor(adaRoot, "👀"), {
      reactionKey: "👀",
      count: 1,
      reactedByCurrentUser: false,
    });
    assert.deepEqual(reactionFor(graceRoot, "👍"), {
      reactionKey: "👍",
      count: 1,
      reactedByCurrentUser: false,
    });
    assert.deepEqual(reactionFor(graceRoot, "👀"), {
      reactionKey: "👀",
      count: 1,
      reactedByCurrentUser: true,
    });
    assert.equal(adaRoot.isThreadRoot, true);
    assert.equal(adaRoot.threadSummary.threadId, lab.threadConversationId);
    assert.equal(adaRoot.threadSummary.replyCount, 1);
    assert.equal(graceRoot.isThreadRoot, true);
    assert.equal(graceRoot.threadSummary.threadId, lab.threadConversationId);
    assert.equal(graceRoot.threadSummary.replyCount, 1);
    assert.deepEqual(
      threadTimeline.messages.map(({ id }) => id),
      [lab.threadReplyMessageId],
    );
    assert.equal(
      threadTimeline.messages[0]?.content.text,
      "Thread replies stay attached to their canonical root message.",
    );

    const openedThread = await ada.openThread(lab.rootMessageId);
    assert.equal(
      openedThread.state,
      "ready",
      `seeded thread opening failed: ${JSON.stringify(openedThread)}`,
    );
    assert.equal(openedThread.threadConversationId, lab.threadConversationId);
    assert.equal(openedThread.reconciliationStatus, "existing_for_root");
    assert.equal(ada.getThreadOpeningState(lab.rootMessageId).state, "ready");
    assert.deepEqual(
      ada.cache.getState().timelines[lab.threadConversationId].messageIds,
      [lab.threadReplyMessageId],
    );

    const [
      adaPublicTimeline,
      gracePublicTimeline,
      margaretPublicTimeline,
      publicThreadTimeline,
      groupDirectTimeline,
      emptyChannelTimeline,
    ] = await Promise.all([
      ada.getMessageTimeline({
        conversationId: lab.conversationIds.publicChannel,
        direction: "backward",
        limit: 50,
      }),
      grace.getMessageTimeline({
        conversationId: lab.conversationIds.publicChannel,
        direction: "backward",
        limit: 50,
      }),
      margaret.getMessageTimeline({
        conversationId: lab.conversationIds.publicChannel,
        direction: "backward",
        limit: 50,
      }),
      ada.getMessageTimeline({
        conversationId: lab.publicThreadConversationId,
        direction: "backward",
        limit: 50,
      }),
      ada.getMessageTimeline({
        conversationId: lab.conversationIds.groupDirect,
        direction: "backward",
        limit: 50,
      }),
      ada.getMessageTimeline({
        conversationId: lab.conversationIds.emptyChannel,
        direction: "backward",
        limit: 50,
      }),
    ]).then((results) => results.map((result, index) => requireSuccess(
      [
        "Ada public timeline",
        "Grace public timeline",
        "Margaret public timeline",
        "public thread timeline",
        "group direct timeline",
        "empty channel timeline",
      ][index],
      result,
    )));
    const messageProjection = ({ id, author, content }) => ({
      id,
      authorId: author.userId,
      text: content.text,
    });
    const publicMessageProjection = (message) => ({
      ...messageProjection(message),
      blocks: message.content.blocks ?? [],
      revision: message.revision.revision,
    });
    const expectedPublicMessages = [
      ...CHAT_LAB_PUBLIC_MESSAGES.map((fixture, index) => ({
        id: lab.publicMessageIds[index],
        authorId: fixture.authorId,
        text: fixture.text,
        blocks: fixture.blocks ?? [],
        revision: 1,
      })),
      {
        id: lab.editedPublicMessage.id,
        authorId: CHAT_LAB_EDITED_PUBLIC_MESSAGE.authorId,
        text: CHAT_LAB_EDITED_PUBLIC_MESSAGE.editedText,
        blocks: [],
        revision: 2,
      },
    ];
    assert.deepEqual(lab.editedPublicMessage, {
      id: lab.editedPublicMessage.id,
      text: CHAT_LAB_EDITED_PUBLIC_MESSAGE.editedText,
      revision: 2,
    });
    for (const timeline of [
      adaPublicTimeline,
      gracePublicTimeline,
      margaretPublicTimeline,
    ]) {
      assert.deepEqual(
        timeline.messages.map(publicMessageProjection),
        expectedPublicMessages,
      );
      assert.deepEqual(
        timeline.messages.flatMap(({ content }) =>
          (content?.blocks ?? []).filter(({ type }) => type === "link_preview")),
        [{ type: "link_preview", data: CHAT_LAB_PUBLIC_LINK_PREVIEW }],
      );
      const editedPublicMessage = timeline.messages.find(
        ({ id }) => id === lab.editedPublicMessage.id,
      );
      assert.ok(editedPublicMessage);
      assert.equal(
        editedPublicMessage.content.text,
        CHAT_LAB_EDITED_PUBLIC_MESSAGE.editedText,
      );
      assert.equal(editedPublicMessage.revision.revision, 2);
      const persistedTimes = timeline.messages.map(({ createdAt }) => Date.parse(createdAt));
      assert.equal(persistedTimes.every(Number.isFinite), true);
      assert.equal(
        persistedTimes.every((instant, index) =>
          index === 0 || instant >= persistedTimes[index - 1]),
        true,
      );
    }
    const publicRootFor = (timeline) => timeline.messages.find(
      ({ id }) => id === lab.publicMessageIds[0],
    );
    for (const [timeline, reactsWithThumbsUp, reactsWithEyes] of [
      [adaPublicTimeline, false, true],
      [gracePublicTimeline, true, false],
      [margaretPublicTimeline, true, false],
    ]) {
      const publicRoot = publicRootFor(timeline);
      assert.ok(publicRoot);
      assert.deepEqual(reactionFor(publicRoot, "👍"), {
        reactionKey: "👍",
        count: 2,
        reactedByCurrentUser: reactsWithThumbsUp,
      });
      assert.deepEqual(reactionFor(publicRoot, "👀"), {
        reactionKey: "👀",
        count: 1,
        reactedByCurrentUser: reactsWithEyes,
      });
      assert.equal(publicRoot.isThreadRoot, true);
      assert.equal(
        publicRoot.threadSummary.threadId,
        lab.publicThreadConversationId,
      );
      assert.equal(publicRoot.threadSummary.replyCount, 1);
    }
    assert.deepEqual(
      publicThreadTimeline.messages.map(messageProjection),
      [{
        id: lab.publicThreadReplyMessageId,
        authorId: "ada",
        text: CHAT_LAB_PUBLIC_THREAD_REPLY_TEXT,
      }],
    );
    const ordinaryGroupDirectMessages = groupDirectTimeline.messages.filter(
      ({ id }) => lab.groupDirectMessageIds.includes(id),
    );
    assert.equal(
      groupDirectTimeline.messages.length,
      CHAT_LAB_GROUP_DIRECT_MESSAGES.length + 1,
    );
    assert.deepEqual(
      ordinaryGroupDirectMessages.map(messageProjection),
      CHAT_LAB_GROUP_DIRECT_MESSAGES.map((fixture, index) => ({
        id: lab.groupDirectMessageIds[index],
        authorId: fixture.authorId,
        text: fixture.text,
      })),
    );
    const deletedGroupDirectMessage = groupDirectTimeline.messages.find(
      ({ id }) => id === lab.deletedGroupDirectMessage.id,
    );
    assert.ok(deletedGroupDirectMessage);
    assert.equal(deletedGroupDirectMessage.content, null);
    assert.equal(
      deletedGroupDirectMessage.author.userId,
      CHAT_LAB_DELETED_GROUP_DIRECT_MESSAGE.authorId,
    );
    assert.equal(
      deletedGroupDirectMessage.deletedAt,
      lab.deletedGroupDirectMessage.deletedAt,
    );
    assert.equal(Number.isFinite(Date.parse(deletedGroupDirectMessage.deletedAt)), true);
    assert.equal(
      deletedGroupDirectMessage.deletedByUserId,
      CHAT_LAB_DELETED_GROUP_DIRECT_MESSAGE.authorId,
    );
    assert.equal(
      deletedGroupDirectMessage.revision.revision,
      lab.deletedGroupDirectMessage.revision,
    );
    assert.equal(lab.deletedGroupDirectMessage.revision, 2);
    assert.equal(
      lab.deletedGroupDirectMessage.originalText,
      CHAT_LAB_DELETED_GROUP_DIRECT_MESSAGE.originalText,
    );
    assert.equal(Object.isFrozen(lab.deletedGroupDirectMessage), true);
    assert.equal(
      groupDirectTimeline.messages.some(
        (message) => message.content?.text ===
          CHAT_LAB_DELETED_GROUP_DIRECT_MESSAGE.originalText,
      ),
      false,
    );
    assert.deepEqual(emptyChannelTimeline.messages, []);

    const [adaList, graceList, margaretList] = await Promise.all([
      ada.listConversations({ scope: { type: "organization" }, limit: 20 }),
      grace.listConversations({ scope: { type: "organization" }, limit: 20 }),
      margaret.listConversations({ scope: { type: "organization" }, limit: 20 }),
    ]).then(([adaResult, graceResult, margaretResult]) => [
      requireSuccess("Ada list", adaResult),
      requireSuccess("Grace list", graceResult),
      requireSuccess("Margaret list", margaretResult),
    ]);
    const ids = (list) => list.items.map(({ id }) => id).sort();
    const topLevelConversationIds = Object.values(lab.conversationIds).sort();
    assert.deepEqual(ids(adaList), topLevelConversationIds);
    assert.deepEqual(ids(graceList), topLevelConversationIds);
    assert.deepEqual(ids(margaretList), [
      lab.conversationIds.emptyChannel,
      lab.conversationIds.groupDirect,
      lab.conversationIds.publicChannel,
    ].sort());
    for (const list of [adaList, graceList, margaretList]) {
      assert.ok(ids(list).includes(lab.conversationIds.publicChannel));
      assert.equal(ids(list).includes(lab.threadConversationId), false);
      assert.equal(ids(list).includes(lab.publicThreadConversationId), false);
    }
    assert.ok(ids(adaList).includes(lab.conversationIds.privateChannel));
    assert.ok(ids(graceList).includes(lab.conversationIds.privateChannel));
    assert.equal(ids(margaretList).includes(lab.conversationIds.privateChannel), false);

    const adaPrivateTimeline = requireSuccess(
      "Ada private timeline",
      await ada.getMessageTimeline({
        conversationId: lab.conversationIds.privateChannel,
        direction: "backward",
        limit: 50,
      }),
    );
    const gracePrivateTimeline = requireSuccess(
      "Grace private timeline",
      await grace.getMessageTimeline({
        conversationId: lab.conversationIds.privateChannel,
        direction: "backward",
        limit: 50,
      }),
    );
    for (const timeline of [adaPrivateTimeline, gracePrivateTimeline]) {
      assert.deepEqual(
        timeline.messages.map(({ id, content }) => ({ id, text: content.text })),
        [{ id: lab.privateSearchMessageId, text: lab.privateSearchText }],
      );
    }
    const deniedPrivateTimeline = await margaret.getMessageTimeline({
      conversationId: lab.conversationIds.privateChannel,
      direction: "backward",
      limit: 50,
    });
    assert.equal(deniedPrivateTimeline.status, "authentication");
    assert.equal(deniedPrivateTimeline.httpStatus, 403);

    const groupDetail = requireSuccess(
      "group direct detail",
      await ada.getConversation({ conversationId: lab.conversationIds.groupDirect }),
    );
    assert.deepEqual(groupDetail.conversation.memberUserIds, [
      "ada",
      "grace",
      "margaret",
    ]);

    const recreatedDirect = requireSuccess(
      "recreated Ada and Grace direct",
      await ada.createDirect({ intendedMemberUserIds: ["grace"] }),
    );
    assert.equal(recreatedDirect.reconciliationStatus, "existing_equivalent");
    assert.equal(recreatedDirect.conversation.conversation.id, lab.conversationIds.direct);
    const adaAfterRecreate = requireSuccess(
      "Ada list after direct recreation",
      await ada.listConversations({ scope: { type: "organization" }, limit: 20 }),
    );
    assert.equal(
      adaAfterRecreate.items.filter(({ id }) => id === lab.conversationIds.direct).length,
      1,
    );

    requireSuccess(
      "Grace timeline",
      await grace.getMessageTimeline({
        conversationId: lab.conversationIds.direct,
        direction: "backward",
        limit: 50,
      }),
    );
    const releaseConversation = grace.realtime?.subscribeConversation(lab.conversationIds.direct);
    assert.equal(typeof releaseConversation, "function");
    await waitFor(
      () => grace.realtime?.state.state === "connected",
      "Grace's browser-compatible realtime session did not settle after hydration",
    );

    const sendingAda = lab.harness.createClient(adaToken);
    assert.equal((await sendingAda.start()).state, "ready");
    const sent = requireSuccess(
      "Ada send",
      await sendingAda.sendMessage({
        conversationId: lab.conversationId,
        content: { format: "plain", text: "Live message through the Vite proxy." },
      }),
    );
    const delivered = await waitFor(
      () => Object.values(grace.cache.getState().entities.messages).find(
        (message) => message.id === sent.message.id,
      ),
      "Grace did not receive Ada's durable realtime message",
    );
    assert.equal(delivered.content.text, "Live message through the Vite proxy.");

    requireSuccess(
      "Grace read cursor",
      await grace.markRead({
        conversationId: lab.conversationId,
        throughSequence: sent.message.sequence,
      }),
    );
    grace.close();
    const reloadedGrace = createClient(graceToken);
    assert.equal((await reloadedGrace.start()).state, "ready");
    await waitFor(
      () => reloadedGrace.cache.getState().identity?.userId === "grace",
      "Reloaded Grace session did not establish identity",
    );
    const detail = requireSuccess(
      "Grace persisted detail",
      await reloadedGrace.getConversation({ conversationId: lab.conversationId }),
    );
    assert.equal(
      detail.conversation.currentReadState.lastReadSequence,
      sent.message.sequence,
    );
    releaseConversation();
  } finally {
    for (const client of clients) client.close();
    await lab.close();
    await rm(flutterWebRoot, { recursive: true, force: true });
  }
});

test("Chat Lab managed realtime delivers reactions and replays once after reconnect", async () => {
  const lab = await startChatLab({ host: "127.0.0.1", port: 0 });
  const clients = [];
  const releases = [];

  try {
    let seedBatch;
    do {
      seedBatch = await lab.harness.runtime.outboxPublisher.runOnce();
    } while (seedBatch.claimed > 0);
    const [adaToken, graceToken] = await Promise.all([
      fetch(`${lab.origin}/__chat-lab/session?actor=ada`).then((response) => response.text()),
      fetch(`${lab.origin}/__chat-lab/session?actor=grace`).then((response) => response.text()),
    ]);
    const graceNetwork = createControllableNetwork();
    const graceStates = [];
    const graceRecoveryDiagnostics = [];
    const adaIncoming = [];
    const graceIncoming = [];
    const graceOutgoing = [];
    const parseFrame = (frames, value) => {
      try {
        frames.push(JSON.parse(value));
      } catch {
        frames.push(value);
      }
    };
    const createManagedClient = (token, realtime) => {
      const client = createChatClient({
        endpoint: `${lab.origin}/api/chat`,
        getAccessToken: () => token,
        realtime,
      });
      clients.push(client);
      return client;
    };
    const ada = createManagedClient(adaToken, {
      webSocketFactory: createNodeBrowserSocketFactory({
        onMessage: (value) => parseFrame(adaIncoming, value),
      }),
    });
    const grace = createManagedClient(graceToken, {
      network: graceNetwork.network,
      onRecoveryDiagnostic: (diagnostic) => graceRecoveryDiagnostics.push(diagnostic),
      onStateChange: (state) => graceStates.push(state.state),
      webSocketFactory: createNodeBrowserSocketFactory({
        onMessage: (value) => parseFrame(graceIncoming, value),
        onSend: (value) => parseFrame(graceOutgoing, value),
      }),
    });

    assert.deepEqual(
      (await Promise.all([ada.start(), grace.start()])).map(({ state }) => state),
      ["ready", "ready"],
    );
    await Promise.all([
      waitFor(
        () => ada.cache.getState().identity?.userId === "ada",
        "Ada's managed realtime session did not establish identity",
      ),
      waitFor(
        () => grace.cache.getState().identity?.userId === "grace",
        "Grace's managed realtime session did not establish identity",
      ),
    ]);
    await Promise.all([ada, grace].map(async (client) => {
      requireSuccess(
        "managed realtime conversation hydration",
        await client.getConversation({ conversationId: lab.conversationIds.direct }),
      );
      requireSuccess(
        "managed realtime seed timeline",
        await client.getMessageTimeline({
          conversationId: lab.conversationIds.direct,
          direction: "backward",
          limit: 50,
        }),
      );
      releases.push(client.realtime.subscribeConversation(lab.conversationIds.direct));
    }));
    const subscribedToDirect = (frames) => frames.some((frame) =>
      frame?.type === "chat.subscription.accepted" &&
      frame.streamId === lab.conversationIds.direct
    );
    await Promise.all([
      waitFor(() => subscribedToDirect(adaIncoming), "Ada subscription was not accepted"),
      waitFor(() => subscribedToDirect(graceIncoming), "Grace subscription was not accepted"),
    ]);

    const first = requireSuccess(
      "Ada first live send",
      await ada.sendMessage({
        conversationId: lab.conversationIds.direct,
        content: { format: "plain", text: "Managed realtime live delivery." },
      }),
    );
    await waitFor(
      () => graceIncoming.some((frame) => frame?.payload?.message?.id === first.message.id),
      "Grace did not receive Ada's live managed frame",
    );
    await waitFor(
      () => grace.cache.getState().entities.messages[first.message.id],
      () => `Grace did not reduce Ada's live managed message: ${JSON.stringify(graceRecoveryDiagnostics)}`,
    );
    requireSuccess(
      "Ada first live reaction",
      await ada.setReaction({
        messageId: first.message.id,
        reactionKey: "🚀",
        reacted: true,
      }),
    );
    const reactionFor = (client, messageId, reactionKey) =>
      client.cache.getState().entities.messages[messageId]?.reactions.find(
        (reaction) => reaction.reactionKey === reactionKey,
      );
    await waitFor(
      () => reactionFor(grace, first.message.id, "🚀")?.count === 1,
      "Grace did not receive Ada's canonical live reaction",
    );
    assert.deepEqual(reactionFor(grace, first.message.id, "🚀"), {
      reactionKey: "🚀",
      count: 1,
      reactedByCurrentUser: false,
    });

    const replayFrom = grace.cache.getState().metadata.realtimeCursor;
    assert.ok(replayFrom?.eventId);
    graceNetwork.setOnline(false);
    await waitFor(
      () => grace.realtime.state.state === "offline",
      "Grace's managed session did not enter offline state",
    );

    const second = requireSuccess(
      "Ada disconnected-window send",
      await ada.sendMessage({
        conversationId: lab.conversationIds.direct,
        content: { format: "plain", text: "Replay this message exactly once." },
      }),
    );
    requireSuccess(
      "Ada disconnected-window reaction",
      await ada.setReaction({
        messageId: second.message.id,
        reactionKey: "🔥",
        reacted: true,
      }),
    );
    let disconnectedBatch;
    do {
      disconnectedBatch = await lab.harness.runtime.outboxPublisher.runOnce();
    } while (disconnectedBatch.claimed > 0);
    assert.equal(grace.cache.getState().entities.messages[second.message.id], undefined);

    graceNetwork.setOnline(true);
    await waitFor(
      () => grace.realtime.state.state === "connected",
      "Grace's managed session did not reconnect",
    );
    await waitFor(
      () => reactionFor(grace, second.message.id, "🔥")?.count === 1,
      "Grace's managed session did not replay the disconnected-window events",
    );

    const handshakes = graceOutgoing.filter((frame) =>
      typeof frame?.clientPackageVersion === "string"
    );
    assert.ok(handshakes.length >= 2);
    assert.deepEqual(handshakes.at(-1).resumeFrom, replayFrom);
    const offlineIndex = graceStates.lastIndexOf("offline");
    assert.ok(offlineIndex >= 0);
    assert.deepEqual(
      graceStates.slice(offlineIndex, offlineIndex + 3),
      ["offline", "connecting", "connected"],
    );
    assert.deepEqual(graceRecoveryDiagnostics, []);

    for (const [client, reactedByCurrentUser] of [[ada, true], [grace, false]]) {
      const messageIds = client.cache.getState()
        .timelines[lab.conversationIds.direct].messageIds;
      for (const message of [first.message, second.message]) {
        assert.equal(
          messageIds.filter((messageId) => messageId === message.id).length,
          1,
          `${message.id} must appear once in the converged timeline`,
        );
      }
      for (const [messageId, reactionKey] of [
        [first.message.id, "🚀"],
        [second.message.id, "🔥"],
      ]) {
        const reactions = client.cache.getState().entities.messages[messageId].reactions;
        assert.equal(
          reactions.filter((reaction) => reaction.reactionKey === reactionKey).length,
          1,
          `${reactionKey} must have one canonical projection`,
        );
        assert.deepEqual(reactionFor(client, messageId, reactionKey), {
          reactionKey,
          count: 1,
          reactedByCurrentUser,
        });
      }
    }
  } finally {
    for (const release of releases) release();
    for (const client of clients) client.close();
    await lab.close();
  }
});

test("Chat Lab loopback storage securely prepares, uploads, finalizes, and downloads attachments", async () => {
  const lab = await startChatLab({ host: "127.0.0.1", port: 0 });
  const bytes = Buffer.from("loopback attachment bytes\n", "utf8");
  let client;

  try {
    const token = await fetch(`${lab.origin}/__chat-lab/session?actor=ada`)
      .then((response) => response.text());
    const prepareInput = {
      operation: "prepare_attachment",
      metadata: {
        fileName: "loopback-notes.txt",
        contentType: "text/plain",
        sizeBytes: bytes.length,
      },
      idempotencyKey: "chat-lab-loopback-prepare",
    };
    const prepareResponse = await fetch(
      `${lab.origin}/api/chat/conversations/${encodeURIComponent(lab.conversationIds.direct)}/attachments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": prepareInput.idempotencyKey,
        },
        body: JSON.stringify(prepareInput),
      },
    );
    const prepared = await prepareResponse.json();
    assert.equal(prepareResponse.status, 200, JSON.stringify(prepared));
    assert.equal(prepared.operation, "prepare_attachment");
    assert.equal(prepared.attachment.status, "pending");
    const upload = JSON.parse(
      Buffer.from(prepared.upload.descriptor, "base64url").toString("utf8"),
    );
    const uploadUrl = new URL(upload.url);
    assert.equal(upload.method, "PUT");
    assert.equal(uploadUrl.origin, lab.origin);
    assert.equal(uploadUrl.pathname, "/__chat-lab/storage/upload");
    assert.deepEqual([...uploadUrl.searchParams.keys()].sort(), ["key", "tenant", "token"]);

    const malformedUrl = new URL(uploadUrl);
    malformedUrl.searchParams.delete("token");
    assert.equal((await fetch(malformedUrl, { method: "PUT" })).status, 400);

    const unknownKeyUrl = new URL(uploadUrl);
    unknownKeyUrl.searchParams.set("key", "chat-lab/unknown/object");
    assert.equal((await fetch(unknownKeyUrl, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: bytes,
    })).status, 404);

    const crossTenantUrl = new URL(uploadUrl);
    crossTenantUrl.searchParams.set("tenant", "other-tenant");
    assert.equal((await fetch(crossTenantUrl, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: bytes,
    })).status, 404);

    const unknownTokenUrl = new URL(uploadUrl);
    unknownTokenUrl.searchParams.set("token", "unknown-capability");
    assert.equal((await fetch(unknownTokenUrl, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: bytes,
    })).status, 404);

    assert.equal((await fetch(uploadUrl, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: bytes,
    })).status, 405);
    assert.equal((await fetch(uploadUrl, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: bytes,
    })).status, 415);
    assert.equal((await fetch(uploadUrl, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: bytes.subarray(0, bytes.length - 1),
    })).status, 400);

    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: bytes,
    });
    assert.equal(uploadResponse.status, 204);
    assert.equal((await fetch(uploadUrl, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: bytes,
    })).status, 404);

    const objectKey = uploadUrl.searchParams.get("key");
    assert.deepEqual(
      await lab.harness.adapters.storage.verifyObject({
        actor: { tenantId: "other-tenant", userId: "ada", roles: ["employee"] },
        attachmentId: prepared.attachment.attachmentId,
        objectKey,
      }),
      { status: "rejected", reason: "missing_object" },
    );

    const finalizeInput = {
      operation: "finalize_attachment",
      attachmentId: prepared.attachment.attachmentId,
      idempotencyKey: "chat-lab-loopback-finalize",
    };
    const finalizeResponse = await fetch(
      `${lab.origin}/api/chat/attachments/${encodeURIComponent(prepared.attachment.attachmentId)}/lifecycle`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": finalizeInput.idempotencyKey,
        },
        body: JSON.stringify(finalizeInput),
      },
    );
    const finalized = await finalizeResponse.json();
    assert.equal(finalizeResponse.status, 200, JSON.stringify(finalized));
    assert.equal(finalized.outcome, "finalized");
    assert.equal(finalized.attachment.status, "finalized");

    const sendInput = {
      operation: "send",
      conversationId: lab.conversationIds.direct,
      clientMessageId: "chat-lab-loopback-client-message",
      idempotencyKey: "chat-lab-loopback-send",
      content: {
        format: "plain",
        text: "Canonical loopback attachment",
        attachments: [{ attachmentId: prepared.attachment.attachmentId }],
      },
    };
    const sendResponse = await fetch(
      `${lab.origin}/api/chat/conversations/${encodeURIComponent(lab.conversationIds.direct)}/messages`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": sendInput.idempotencyKey,
        },
        body: JSON.stringify(sendInput),
      },
    );
    const sent = await sendResponse.json();
    assert.equal(sendResponse.status, 201, JSON.stringify(sent));

    client = lab.harness.createClient(token);
    assert.equal((await client.start()).state, "ready");
    const timeline = requireSuccess(
      "attachment timeline",
      await client.getMessageTimeline({
        conversationId: lab.conversationIds.direct,
        direction: "backward",
        limit: 50,
      }),
    );
    const message = timeline.messages.find(({ id }) => id === sent.message.id);
    assert.ok(message);
    assert.equal(message.content.text, "Canonical loopback attachment");
    assert.deepEqual(message.content.attachments, [
      { attachmentId: prepared.attachment.attachmentId },
    ]);
    assert.equal(message.attachmentMetadata.length, 1);
    const attachment = message.attachmentMetadata[0];
    assert.equal(attachment.fileName, "loopback-notes.txt");
    assert.equal(attachment.contentType, "text/plain");
    assert.equal(attachment.sizeBytes, bytes.length);
    const downloadUrl = new URL(attachment.downloadUrl);
    assert.equal(downloadUrl.origin, lab.origin);
    assert.equal(downloadUrl.pathname, "/__chat-lab/storage/download");

    const downloadResponse = await fetch(downloadUrl);
    assert.equal(downloadResponse.status, 200);
    assert.equal(downloadResponse.headers.get("content-type"), "text/plain");
    assert.equal(downloadResponse.headers.get("x-content-type-options"), "nosniff");
    assert.equal(downloadResponse.headers.get("cache-control"), "private, no-store");
    assert.equal(
      downloadResponse.headers.get("content-disposition"),
      'attachment; filename="loopback-notes.txt"',
    );
    assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), bytes);
    assert.equal(lab.storageSnapshot().objectCount, 1);
    assert.equal(lab.storageSnapshot().byteCount, bytes.length);

    client.close();
    client = undefined;
    await lab.close();
    assert.deepEqual(lab.storageSnapshot(), {
      objectCount: 0,
      byteCount: 0,
      uploadCapabilityCount: 0,
      downloadCapabilityCount: 0,
    });
    await lab.close();
  } finally {
    client?.close();
    await lab.close();
  }
});
