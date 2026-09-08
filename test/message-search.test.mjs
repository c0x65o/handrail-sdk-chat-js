import assert from "node:assert/strict";
import test from "node:test";

import {
  MessageSearchParseError,
  normalizeMessageSearchQuery,
  parseMessageSearchRequest,
  parseMessageSearchResponse,
} from "../src/contracts/message-search.ts";

const filteredRequest = {
  query: "  Cafe\u0301\t order\n updates  ",
  filters: {
    conversationIds: ["conversation-1", "conversation-2"],
    authorUserIds: ["user-1"],
    sentAfter: "2026-08-01T10:00:00.000Z",
    sentBefore: "2026-08-28T10:00:00-05:00",
  },
  pageSize: 50,
  cursor: "opaque.page.2",
};

const validResponse = {
  hits: [
    {
      type: "message",
      conversationId: "conversation-1",
      messageId: "message-1",
      title: "Order coordination",
      snippet: "The café order is ready.",
      authorUserId: "user-1",
      authorDisplayName: "Ada",
      sentAt: "2026-08-20T12:30:00.000Z",
    },
    {
      type: "conversation",
      conversationId: "conversation-2",
      title: "Café planning",
      snippet: "Conversation about the café launch.",
    },
  ],
  nextCursor: "opaque.page.3",
};

function hasCode(code) {
  return (error) => error instanceof MessageSearchParseError && error.code === code;
}

test("normalizes queries and accepts filtered opaque pagination", () => {
  assert.equal(normalizeMessageSearchQuery(filteredRequest.query), "Café order updates");
  assert.deepEqual(parseMessageSearchRequest(filteredRequest), {
    ...filteredRequest,
    query: "Café order updates",
  });
  assert.throws(
    () => parseMessageSearchRequest({ query: " \t\n ", pageSize: 10 }),
    hasCode("malformed_request"),
  );
});

test("rejects malformed filters, identifiers, timestamps, and ranges", () => {
  const malformed = [
    [{ ...filteredRequest, filters: null }, "malformed_filters"],
    [{ ...filteredRequest, filters: [] }, "malformed_filters"],
    [{ ...filteredRequest, filters: { unsupported: true } }, "malformed_filters"],
    [{ ...filteredRequest, filters: { conversationIds: "conversation-1" } }, "malformed_filters"],
    [{ ...filteredRequest, filters: { conversationIds: [" "] } }, "invalid_identifier"],
    [{ ...filteredRequest, filters: { conversationIds: ["conversation-1", "conversation-1"] } }, "duplicate_identifier"],
    [{ ...filteredRequest, filters: { authorUserIds: ["user-1\n"] } }, "invalid_identifier"],
    [{ ...filteredRequest, filters: { sentAfter: "August 1" } }, "invalid_timestamp"],
    [{ ...filteredRequest, filters: { sentAfter: "2026-02-31T00:00:00Z" } }, "invalid_timestamp"],
    [{ ...filteredRequest, filters: { sentAfter: "2026-08-02T00:00:00Z", sentBefore: "2026-08-01T00:00:00Z" } }, "invalid_time_range"],
    [{ ...filteredRequest, filters: { sentAfter: "2026-08-01T00:00:00Z", sentBefore: "2026-08-01T00:00:00Z" } }, "invalid_time_range"],
  ];
  for (const [request, code] of malformed) {
    assert.throws(() => parseMessageSearchRequest(request), hasCode(code), code);
  }
});

test("rejects invalid page sizes and request or response cursors", () => {
  for (const pageSize of [0, 101, 1.5, "10", null]) {
    assert.throws(
      () => parseMessageSearchRequest({ query: "orders", pageSize }),
      hasCode("invalid_page_size"),
    );
  }
  for (const cursor of ["", " \n ", "x".repeat(2049), 42, null]) {
    assert.throws(
      () => parseMessageSearchRequest({ query: "orders", pageSize: 10, cursor }),
      hasCode("malformed_cursor"),
    );
    assert.throws(
      () => parseMessageSearchResponse({ hits: [], nextCursor: cursor }),
      hasCode("malformed_cursor"),
    );
  }
});

test("rejects normalized trusted identity aliases recursively before shape validation", () => {
  for (const alias of [
    "tenant-id",
    "ORGANIZATION_id",
    "Actor.User.ID",
    "current_user_id",
    "session-id",
    "AUTHORIZATION",
    "roles",
    "capabilities",
    "per-missions",
  ]) {
    assert.throws(
      () => parseMessageSearchRequest({ ...filteredRequest, [alias]: "spoofed" }),
      hasCode("trusted_identity_field"),
      alias,
    );
  }
  assert.throws(
    () => parseMessageSearchRequest({
      ...filteredRequest,
      filters: { conversationIds: ["conversation-1"], nested: { currentActorId: "spoofed" } },
    }),
    hasCode("trusted_identity_field"),
  );
});

test("preserves ordered strict conversation/message hits and optional metadata", () => {
  assert.deepEqual(parseMessageSearchResponse(JSON.parse(JSON.stringify(validResponse))), validResponse);
  assert.equal(parseMessageSearchResponse(validResponse).hits[0].type, "message");
  assert.equal(parseMessageSearchResponse(validResponse).hits[1].type, "conversation");
});

test("rejects malformed hit unions, blank snippets, invalid metadata, and duplicates", () => {
  const message = validResponse.hits[0];
  const conversation = validResponse.hits[1];
  const invalidHits = [
    [{ ...message, type: "file" }, "malformed_hit"],
    [{ ...message, messageId: undefined }, "invalid_identifier"],
    [{ ...message, snippet: "  " }, "malformed_hit"],
    [{ ...message, conversationId: " conversation-1" }, "invalid_identifier"],
    [{ ...message, authorDisplayName: "" }, "malformed_hit"],
    [{ ...message, sentAt: "not-a-time" }, "malformed_hit"],
    [{ ...message, extra: true }, "malformed_hit"],
    [{ ...conversation, messageId: "message-2" }, "malformed_hit"],
    [{ ...conversation, authorUserId: "user-1" }, "malformed_hit"],
  ];
  for (const [hit, code] of invalidHits) {
    assert.throws(
      () => parseMessageSearchResponse({ hits: [hit] }),
      hasCode(code),
    );
  }
  assert.throws(
    () => parseMessageSearchResponse({ hits: [message, { ...message, conversationId: "conversation-2" }] }),
    hasCode("duplicate_hit_identity"),
  );
  assert.throws(
    () => parseMessageSearchResponse({ hits: [conversation, { ...conversation, title: "Duplicate" }] }),
    hasCode("duplicate_hit_identity"),
  );
  assert.throws(
    () => parseMessageSearchResponse({ ...validResponse, unsupported: true }),
    hasCode("malformed_response"),
  );
});
