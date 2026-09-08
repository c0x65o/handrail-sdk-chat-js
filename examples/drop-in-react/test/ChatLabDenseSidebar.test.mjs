import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_LAB_ACTORS,
  CHAT_LAB_DENSE_ACTORS,
  CHAT_LAB_DENSE_LONG_CHANNEL_NAME,
  CHAT_LAB_DENSE_LONG_PARTICIPANT_NAME,
  CHAT_LAB_DENSE_SIDEBAR_PROFILE,
  startChatLabBackend,
} from "../scripts/chat-lab-backend.mjs";

const requireSuccess = (operation, result) => {
  assert.equal(result.status, "success", `${operation}: ${JSON.stringify(result)}`);
  return result.value;
};

const startAda = async (lab) => {
  const client = lab.harness.createClient("chat-lab-ada");
  assert.equal((await client.start()).state, "ready");
  return client;
};

test("the dense-sidebar profile is opt-in and projects mixed canonical sidebar state", async () => {
  const standard = await startChatLabBackend();
  let standardClient;
  try {
    standardClient = await startAda(standard);
    const standardList = requireSuccess(
      "standard conversation list",
      await standardClient.listConversations({
        scope: { type: "organization" },
        limit: 100,
      }),
    );
    assert.equal(standard.denseSidebar, undefined);
    assert.equal(standard.actors, CHAT_LAB_ACTORS);
    assert.equal(standardList.items.length, 5);
    assert.deepEqual(
      new Set(standardList.items.map(({ id }) => id)),
      new Set(Object.values(standard.conversationIds)),
    );
  } finally {
    standardClient?.close();
    await standard.harness.teardown();
  }

  const dense = await startChatLabBackend({
    seedProfile: CHAT_LAB_DENSE_SIDEBAR_PROFILE,
  });
  let denseClient;
  try {
    denseClient = await startAda(dense);
    const fixture = dense.denseSidebar;
    assert.ok(fixture);
    assert.equal(fixture.profile, CHAT_LAB_DENSE_SIDEBAR_PROFILE);
    assert.equal(fixture.seededConversationCount, 59);
    assert.equal(Object.values(fixture.conversationIds).flat().length, 54);
    assert.equal(dense.actors.length, CHAT_LAB_ACTORS.length + CHAT_LAB_DENSE_ACTORS.length);
    assert.deepEqual(
      Object.fromEntries(Object.entries(fixture.conversationIds).map(
        ([kind, ids]) => [kind, ids.length],
      )),
      { publicChannels: 30, privateChannels: 8, directs: 8, groupDirects: 8 },
    );
    const expectedConversationIds = new Set([
      ...Object.values(dense.conversationIds),
      ...Object.values(fixture.conversationIds).flat(),
    ]);
    assert.equal(expectedConversationIds.size, 59);

    const firstPage = requireSuccess(
      "dense first pagination page",
      await denseClient.listConversations({
        scope: { type: "organization" },
        limit: 50,
      }),
    );
    assert.equal(firstPage.items.length, 50);
    assert.equal(typeof firstPage.page.nextCursor, "string");
    const secondPage = requireSuccess(
      "dense second pagination page",
      await denseClient.listConversations({
        scope: { type: "organization" },
        limit: 50,
        cursor: firstPage.page.nextCursor,
      }),
    );
    assert.equal(secondPage.items.length, 9);
    assert.equal(secondPage.page.nextCursor, undefined);
    const firstPageIds = firstPage.items.map(({ id }) => id);
    const secondPageIds = secondPage.items.map(({ id }) => id);
    const secondPageIdSet = new Set(secondPageIds);
    assert.equal(new Set(firstPageIds).size, firstPageIds.length);
    assert.equal(secondPageIdSet.size, secondPageIds.length);
    assert.deepEqual(
      firstPageIds.filter((id) => secondPageIdSet.has(id)),
      [],
    );
    assert.deepEqual(
      new Set([...firstPageIds, ...secondPageIds]),
      expectedConversationIds,
    );

    const items = [];
    let cursor;
    do {
      const page = requireSuccess(
        "dense paginated conversation list",
        await denseClient.listConversations({
          scope: { type: "organization" },
          limit: 17,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      items.push(...page.items);
      cursor = page.page.nextCursor;
    } while (cursor !== undefined);

    assert.equal(items.length, 59);
    assert.equal(new Set(items.map(({ id }) => id)).size, items.length);
    assert.deepEqual(new Set(items.map(({ id }) => id)), expectedConversationIds);
    assert.deepEqual(
      Object.fromEntries(["channel", "direct", "group_direct"].map((type) => [
        type,
        items.filter((item) => item.type === type).length,
      ])),
      { channel: 41, direct: 9, group_direct: 9 },
    );
    const itemById = new Map(items.map((item) => [item.id, item]));
    for (const id of Object.values(fixture.states)) assert.ok(itemById.has(id));
    assert.equal(
      itemById.get(fixture.states.longChannel).name,
      CHAT_LAB_DENSE_LONG_CHANNEL_NAME,
    );
    assert.equal(itemById.get(fixture.states.unread).latestSequence, 2);
    assert.equal(itemById.get(fixture.states.unread).unreadMentionCount, 0);
    assert.equal(
      itemById.get(fixture.states.unread).currentReadState.lastReadSequence,
      2,
    );
    assert.equal(
      itemById.get(fixture.states.unread).currentReadState.manualUnreadFromSequence,
      1,
    );
    assert.equal(itemById.get(fixture.states.mention).latestSequence, 1);
    assert.equal(itemById.get(fixture.states.mention).unreadMentionCount, 1);
    assert.equal(
      itemById.get(fixture.states.muted).currentPreference.notificationPreference,
      "all",
    );
    assert.deepEqual(
      itemById.get(fixture.states.muted).currentPreference.mute,
      { muted: true },
    );
    assert.equal(
      itemById.get(fixture.states.mentionsOnly).currentPreference.notificationPreference,
      "mentions",
    );
    assert.equal(itemById.get(fixture.states.privateChannel).visibility, "private");
    assert.equal(itemById.get(fixture.states.activeHuddle).hasActiveHuddle, true);
    assert.deepEqual(
      items.filter(({ hasActiveHuddle }) => hasActiveHuddle).map(({ id }) => id),
      [fixture.states.activeHuddle],
    );
    assert.equal(
      fixture.pagination.initialConversationIds[0],
      fixture.states.selected,
    );
    assert.equal(
      fixture.pagination.initialConversationIds.includes(
        fixture.pagination.laterConversationId,
      ),
      false,
    );

    const directory = await denseClient.hydrateDirectoryUsers([
      fixture.participants.longNameUserId,
      fixture.participants.offlineUserId,
    ]);
    assert.equal(directory.status, "success", JSON.stringify(directory));
    assert.equal(
      denseClient.selectDirectoryUser(fixture.participants.longNameUserId).displayName,
      CHAT_LAB_DENSE_LONG_PARTICIPANT_NAME,
    );
    assert.equal(
      denseClient.selectDirectoryUser(fixture.participants.onlineUserId).status.availability,
      "online",
    );
    assert.equal(
      denseClient.selectDirectoryUser(fixture.participants.offlineUserId).status.availability,
      "offline",
    );
  } finally {
    denseClient?.close();
    await dense.harness.teardown();
  }
});
