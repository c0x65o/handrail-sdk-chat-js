import assert from "node:assert/strict";
import test from "node:test";

import {
  MESSAGE_SEARCH_MAX_CANDIDATE_SCAN_COUNT,
  MessageSearchQueryError,
  queryMessageSearch,
} from "@handrail/chat/server";

const actor = {
  tenantId: "tenant-a",
  userId: "user-a",
  roles: ["employee"],
};

const makeRow = (messageId, conversationId, createdAt, entityId = null) => ({
  id: conversationId,
  entity_type: entityId === null ? null : "budget",
  entity_id: entityId,
  message_id: messageId,
  author_user_id: "author-a",
  forwarded_author_display_name: null,
  content_text: "Budgetprobe",
  conversation_name: "Budget conversation",
  created_at: createdAt,
  relevance: 1,
});

const createRankedCandidates = () => {
  const rows = [
    makeRow(
      "budget-allowed-leading",
      "budget-allowed",
      "2032-01-01T00:00:00.000Z",
    ),
  ];
  const deniedCount = MESSAGE_SEARCH_MAX_CANDIDATE_SCAN_COUNT * 2 + 1;
  for (let index = 0; index < deniedCount; index += 1) {
    const conversationIndex = index % 17;
    rows.push(
      makeRow(
        `budget-denied-${String(index).padStart(6, "0")}`,
        `budget-denied-conversation-${conversationIndex}`,
        new Date(Date.UTC(2031, 0, 2) - index * 1_000).toISOString(),
        `deny-${conversationIndex}`,
      ),
    );
  }
  rows.push(
    makeRow(
      "budget-allowed-trailing-a",
      "budget-allowed",
      "2030-01-01T00:00:02.000Z",
    ),
    makeRow(
      "budget-allowed-trailing-b",
      "budget-allowed",
      "2030-01-01T00:00:01.000Z",
    ),
  );
  return rows;
};

const createRankedCandidateDatabase = (rows) => {
  const batches = [];
  return {
    batches,
    database: {
      async query(text, values) {
        assert.match(text, /WITH search_input AS/u);
        const limit = values.at(-1);
        const cursorMessageId = values.length === 7 ? values.at(-2) : undefined;
        const start = cursorMessageId === undefined
          ? 0
          : rows.findIndex(({ message_id: messageId }) => messageId === cursorMessageId) + 1;
        assert.ok(start >= 0);
        const selected = rows.slice(start, start + limit);
        batches.push({ limit, messageIds: selected.map(({ message_id: messageId }) => messageId) });
        return { rows: selected };
      },
    },
  };
};

test("message search stops at its candidate budget and resumes after the last scanned row", async () => {
  const candidates = createRankedCandidates();
  const tracked = createRankedCandidateDatabase(candidates);
  const authorizationCalls = [];
  const permissions = {
    async authorizeEntity(input) {
      authorizationCalls.push(input);
      return !input.entity.id.startsWith("deny-");
    },
  };
  const pages = [];
  const scannedMessageIds = [];
  const candidateCounts = [];
  const authorizationCallCounts = [];
  let cursor;

  do {
    const batchStart = tracked.batches.length;
    const authorizationStart = authorizationCalls.length;
    const page = await queryMessageSearch({
      database: tracked.database,
      permissions,
      actor,
      input: {
        query: "budgetprobe",
        pageSize: 33,
        ...(cursor === undefined ? {} : { cursor }),
      },
    });
    const requestBatches = tracked.batches.slice(batchStart);
    const requestMessageIds = requestBatches.flatMap(({ messageIds }) => messageIds);
    const requestAuthorizationCalls = authorizationCalls.slice(authorizationStart);

    assert.ok(requestMessageIds.length <= MESSAGE_SEARCH_MAX_CANDIDATE_SCAN_COUNT);
    assert.ok(
      requestBatches.reduce((total, { limit }) => total + limit, 0) <=
        MESSAGE_SEARCH_MAX_CANDIDATE_SCAN_COUNT,
    );
    assert.equal(
      new Set(requestAuthorizationCalls.map(({ entity }) => `${entity.type}:${entity.id}`)).size,
      requestAuthorizationCalls.length,
    );
    assert.ok(requestAuthorizationCalls.length <= MESSAGE_SEARCH_MAX_CANDIDATE_SCAN_COUNT);

    pages.push(page);
    scannedMessageIds.push(...requestMessageIds);
    candidateCounts.push(requestMessageIds.length);
    authorizationCallCounts.push(requestAuthorizationCalls.length);
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  assert.deepEqual(pages.map((page) => page.hits.map(({ messageId }) => messageId)), [
    ["budget-allowed-leading"],
    [],
    ["budget-allowed-trailing-a", "budget-allowed-trailing-b"],
  ]);
  assert.ok(pages[0].nextCursor);
  assert.ok(pages[1].nextCursor);
  assert.equal(pages[2].nextCursor, undefined);
  assert.deepEqual(candidateCounts, [
    MESSAGE_SEARCH_MAX_CANDIDATE_SCAN_COUNT,
    MESSAGE_SEARCH_MAX_CANDIDATE_SCAN_COUNT,
    4,
  ]);
  assert.deepEqual(authorizationCallCounts, [17, 17, 2]);
  assert.equal(scannedMessageIds.length, candidates.length);
  assert.equal(new Set(scannedMessageIds).size, scannedMessageIds.length);
});

test("scan-budget cursors remain bound to trusted identity, normalized query, and filters", async () => {
  const candidates = createRankedCandidates();
  const tracked = createRankedCandidateDatabase(candidates);
  const permissions = {
    async authorizeEntity() {
      return false;
    },
  };
  const first = await queryMessageSearch({
    database: tracked.database,
    permissions,
    actor,
    input: { query: "budgetprobe", pageSize: 1 },
  });
  assert.equal(typeof first.nextCursor, "string");

  await queryMessageSearch({
    database: tracked.database,
    permissions,
    actor,
    input: { query: "  budgetprobe  ", pageSize: 1, cursor: first.nextCursor },
  });

  for (const [input, requestActor] of [
    [{ query: "different", pageSize: 1, cursor: first.nextCursor }, actor],
    [{ query: "budgetprobe", pageSize: 1, cursor: first.nextCursor }, { ...actor, tenantId: "tenant-b" }],
    [{ query: "budgetprobe", pageSize: 1, cursor: first.nextCursor }, { ...actor, userId: "user-b" }],
    [{ query: "budgetprobe", filters: { conversationIds: ["conversation-a"] }, pageSize: 1, cursor: first.nextCursor }, actor],
    [{ query: "budgetprobe", filters: { authorUserIds: ["author-a"] }, pageSize: 1, cursor: first.nextCursor }, actor],
    [{ query: "budgetprobe", filters: { sentAfter: "2029-01-01T00:00:00.000Z" }, pageSize: 1, cursor: first.nextCursor }, actor],
    [{ query: "budgetprobe", filters: { sentBefore: "2033-01-01T00:00:00.000Z" }, pageSize: 1, cursor: first.nextCursor }, actor],
  ]) {
    await assert.rejects(
      queryMessageSearch({
        database: tracked.database,
        permissions,
        actor: requestActor,
        input,
      }),
      (error) => error instanceof MessageSearchQueryError && error.code === "invalid_cursor",
    );
  }
});
