import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

const React = await import("react");
const { act, createElement } = React;
const ReactTestRenderer = await import("react-test-renderer");
const { create } = ReactTestRenderer.default;
const { ChatProvider, useMessageSearch } = await import("@handrail/chat/react");
const {
  CHAT_CLIENT_PACKAGE_VERSION,
  createChatClient,
  createNormalizedChatCache,
} = await import("@handrail/chat/client");
const { CHAT_PROTOCOL_VERSION } = await import("@handrail/chat");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const metadata = {
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: {},
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
};
const response = (body) => ({
  ok: true,
  status: 200,
  async json() { return body; },
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

test("useMessageSearch exposes blank, debounced, and paginated external-store state", async () => {
  const tasks = [];
  const searchBodies = [];
  const cursor = "opaque-react-page-2";
  const client = createChatClient({
    endpoint: "/chat",
    cache: createNormalizedChatCache({
      tenantId: "tenant-react-search",
      userId: "actor-react-search",
      sessionId: "session-react-search",
    }),
    getAccessToken: () => "token",
    messageSearch: {
      debounceMs: 300,
      schedule(task, delayMs) {
        const entry = { task, delayMs, cancelled: false };
        tasks.push(entry);
        return () => { entry.cancelled = true; };
      },
    },
    async fetch(url, init) {
      if (url === "/chat/_meta") return response(metadata);
      const body = JSON.parse(init.body);
      searchBodies.push(body);
      return body.cursor === undefined
        ? response({
            hits: [{
              type: "message",
              conversationId: "conversation-react",
              messageId: "message-react-1",
              snippet: "First hit",
            }],
            nextCursor: cursor,
          })
        : response({
            hits: [
              {
                type: "message",
                conversationId: "conversation-react",
                messageId: "message-react-1",
                snippet: "Duplicate hit",
              },
              {
                type: "message",
                conversationId: "conversation-react",
                messageId: "message-react-2",
                snippet: "Second hit",
              },
            ],
          });
    },
  });
  assert.equal((await client.start()).state, "ready");

  const results = [];
  const Capture = ({ query }) => {
    results.push(useMessageSearch(query, { pageSize: 5 }));
    return null;
  };
  let renderer;
  await act(async () => {
    renderer = create(createElement(
      ChatProvider,
      { client },
      createElement(Capture, { query: "   " }),
    ));
    await flush();
  });
  assert.equal(results.at(-1).status, "empty");
  assert.deepEqual(results.at(-1).data.hits, []);
  assert.equal(searchBodies.length, 0);

  await act(async () => {
    renderer.update(createElement(
      ChatProvider,
      { client },
      createElement(Capture, { query: "  project   alpha " }),
    ));
    await Promise.resolve();
  });
  assert.equal(results.at(-1).status, "loading");
  assert.equal(tasks[0].delayMs, 300);
  await act(async () => {
    tasks[0].task();
    await flush();
  });
  assert.equal(results.at(-1).status, "ready");
  assert.equal(results.at(-1).data.query, "project alpha");
  assert.deepEqual(results.at(-1).data.hits.map((hit) => hit.messageId), [
    "message-react-1",
  ]);
  assert.equal(results.at(-1).data.hasNextPage, true);

  let nextPage;
  await act(async () => {
    nextPage = results.at(-1).data.loadNextPage();
    await Promise.resolve();
  });
  assert.equal(results.at(-1).data.isLoadingMore, true);
  assert.equal(tasks[1].delayMs, 0);
  await act(async () => {
    tasks[1].task();
    await nextPage;
    await flush();
  });
  assert.equal(results.at(-1).status, "ready");
  assert.deepEqual(results.at(-1).data.hits.map((hit) => hit.messageId), [
    "message-react-1",
    "message-react-2",
  ]);
  assert.equal(results.at(-1).data.hasNextPage, false);
  assert.equal(searchBodies[1].cursor, cursor);

  await act(async () => renderer.unmount());
  client.close();
});
