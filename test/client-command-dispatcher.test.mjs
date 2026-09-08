import assert from "node:assert/strict";
import test from "node:test";

import { createChatClient } from "../dist/client/index.js";

const errorBody = (code, extra = {}) => ({
  error: { code, message: "A deliberately generic server message", ...extra },
});

const response = (status, body, extra = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() {
    return body;
  },
  ...extra,
});

const sendMessage = (overrides = {}) => ({
  name: "message.send",
  method: "POST",
  path: "/messages",
  retry: "safe",
  validateInput(input) {
    if (
      typeof input !== "object" ||
      input === null ||
      typeof input.message !== "string" ||
      input.message.length === 0
    ) {
      throw new TypeError("invalid message");
    }
    return { message: input.message };
  },
  parseResult(value) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      typeof value.messageId !== "string"
    ) {
      throw new TypeError("invalid result");
    }
    return Object.freeze({ messageId: value.messageId });
  },
  ...overrides,
});

test("dispatch validates before transport and returns only the parsed canonical result", async () => {
  const requests = [];
  let tokenCalls = 0;
  const rawResponse = response(200, { messageId: "message-1" }, {
    rawSecret: "raw-response-must-not-escape",
  });
  const client = createChatClient({
    endpoint: "/api/chat/",
    getAccessToken() {
      tokenCalls += 1;
      return "access-token";
    },
    async fetch(url, init) {
      requests.push({ url, init });
      return rawResponse;
    },
  });

  assert.deepEqual(await client.dispatch(sendMessage(), { message: "" }), {
    status: "validation",
    message: "The command input is invalid.",
  });
  assert.equal(tokenCalls, 0);
  assert.equal(requests.length, 0);

  const before = client.state;
  const result = await client.dispatch(
    sendMessage(),
    { message: "sensitive message content" },
    { idempotencyKey: "caller-key-123" },
  );

  assert.deepEqual(result, {
    status: "success",
    value: { messageId: "message-1" },
  });
  assert.equal(result === rawResponse, false);
  assert.equal("rawSecret" in result, false);
  assert.equal(requests[0].url, "/api/chat/messages");
  assert.deepEqual(requests[0].init.headers, {
    accept: "application/json",
    authorization: "Bearer access-token",
    "idempotency-key": "caller-key-123",
    "content-type": "application/json",
  });
  assert.equal(requests[0].init.body, JSON.stringify({ message: "sensitive message content" }));
  assert.equal(client.state, before);
  assert.equal("cache" in client, false);
});

test("refreshes authentication at most once and reuses one generated idempotency key", async () => {
  const requests = [];
  let tokenCalls = 0;
  let keyCalls = 0;
  const client = createChatClient({
    endpoint: "/api/chat",
    getAccessToken() {
      tokenCalls += 1;
      return `token-${tokenCalls}`;
    },
    commands: {
      generateIdempotencyKey() {
        keyCalls += 1;
        return "generated-key";
      },
    },
    async fetch(_url, init) {
      requests.push(init);
      return requests.length === 1
        ? response(401, errorBody("CHAT_ACCESS_TOKEN_EXPIRED", { refreshable: true }))
        : response(200, { messageId: "message-2" });
    },
  });

  assert.equal((await client.dispatch(sendMessage(), { message: "hello" })).status, "success");
  assert.equal(tokenCalls, 2);
  assert.equal(keyCalls, 1);
  assert.deepEqual(
    requests.map((request) => request.headers.authorization),
    ["Bearer token-1", "Bearer token-2"],
  );
  assert.deepEqual(
    requests.map((request) => request.headers["idempotency-key"]),
    ["generated-key", "generated-key"],
  );

  let rejectedTokenCalls = 0;
  let rejectedFetchCalls = 0;
  const rejected = createChatClient({
    endpoint: "/api/chat",
    getAccessToken() {
      rejectedTokenCalls += 1;
      return `rejected-token-${rejectedTokenCalls}`;
    },
    fetch: async () => {
      rejectedFetchCalls += 1;
      return response(
        401,
        errorBody("CHAT_ACCESS_TOKEN_EXPIRED", { refreshable: true }),
      );
    },
  });
  assert.deepEqual(await rejected.dispatch(sendMessage(), { message: "hello" }), {
    status: "authentication",
    message: "Chat authentication failed.",
    httpStatus: 401,
  });
  assert.equal(rejectedTokenCalls, 2);
  assert.equal(rejectedFetchCalls, 2);

  let nonRefreshableTokenCalls = 0;
  let nonRefreshableFetchCalls = 0;
  const nonRefreshable = createChatClient({
    endpoint: "/api/chat",
    getAccessToken() {
      nonRefreshableTokenCalls += 1;
      return "token";
    },
    fetch: async () => {
      nonRefreshableFetchCalls += 1;
      return response(401, errorBody("CHAT_AUTHENTICATION_FAILED"));
    },
  });
  assert.equal(
    (await nonRefreshable.dispatch(sendMessage(), { message: "hello" })).status,
    "authentication",
  );
  assert.equal(nonRefreshableTokenCalls, 1);
  assert.equal(nonRefreshableFetchCalls, 1);
});

test("retries safe network and explicit transient failures with deterministic bounded backoff", async () => {
  const waits = [];
  const keys = [];
  let fetchCalls = 0;
  const client = createChatClient({
    endpoint: "/api/chat",
    getAccessToken: () => "token",
    commands: {
      generateIdempotencyKey: () => "stable-key",
      retry: {
        maxAttempts: 3,
        backoffMs: (retry) => retry * 17,
        async wait(delay, signal) {
          assert.equal(signal.aborted, false);
          waits.push(delay);
        },
      },
    },
    async fetch(_url, init) {
      fetchCalls += 1;
      keys.push(init.headers["idempotency-key"]);
      if (fetchCalls === 1) throw new Error("network detail must stay private");
      if (fetchCalls === 2) return response(503, errorBody("CHAT_TEMPORARY"));
      return response(200, { messageId: "message-3" });
    },
  });

  assert.equal((await client.dispatch(sendMessage(), { message: "hello" })).status, "success");
  assert.deepEqual(waits, [17, 34]);
  assert.deepEqual(keys, ["stable-key", "stable-key", "stable-key"]);

  let neverCalls = 0;
  const never = createChatClient({
    endpoint: "/api/chat",
    getAccessToken: () => "token",
    fetch: async () => {
      neverCalls += 1;
      throw new Error("offline");
    },
  });
  assert.equal(
    (await never.dispatch(sendMessage({ retry: "never" }), { message: "hello" })).status,
    "transport",
  );
  assert.equal(neverCalls, 1);

  let ordinaryCalls = 0;
  const ordinary = createChatClient({
    endpoint: "/api/chat",
    getAccessToken: () => "token",
    fetch: async () => {
      ordinaryCalls += 1;
      return response(422, errorBody("CHAT_INVALID_COMMAND"));
    },
  });
  assert.equal(
    (await ordinary.dispatch(sendMessage(), { message: "hello" })).status,
    "rejected",
  );
  assert.equal(ordinaryCalls, 1);
});

test("returns canonical conflict, auth, feature-disabled, and unsupported outcomes without retry", async () => {
  const cases = [
    [409, "CHAT_IDEMPOTENCY_CONFLICT", "conflict"],
    [401, "CHAT_AUTHENTICATION_FAILED", "authentication"],
    [403, "CHAT_AUTHORIZATION_FAILED", "rejected"],
    [403, "CHAT_FORBIDDEN", "rejected"],
    [403, "CHAT_FEATURE_DISABLED", "feature_disabled"],
    [404, "CHAT_COMMAND_UNSUPPORTED", "unsupported"],
  ];

  for (const [httpStatus, code, expected] of cases) {
    let calls = 0;
    let tokenCalls = 0;
    const diagnostics = [];
    const client = createChatClient({
      endpoint: "/api/chat",
      getAccessToken: () => { tokenCalls += 1; return "token"; },
      commands: { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
      fetch: async () => {
        calls += 1;
        return response(httpStatus, errorBody(code));
      },
    });
    const result = await client.dispatch(sendMessage(), { message: "hello" });
    assert.equal(result.status, expected);
    assert.equal(result.httpStatus, httpStatus);
    assert.equal(calls, 1);
    assert.equal(tokenCalls, 1, "permission failures must not refresh valid credentials");
    assert.equal(diagnostics.at(-1).category, expected);
  }
});

test("rejects malformed JSON and structurally malformed successful and error payloads", async () => {
  const malformedJson = createChatClient({
    endpoint: "/api/chat",
    getAccessToken: () => "token",
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        throw new SyntaxError("full response text must stay private");
      },
    }),
  });
  assert.equal(
    (await malformedJson.dispatch(sendMessage(), { message: "hello" })).status,
    "malformed_response",
  );

  const malformedSuccess = createChatClient({
    endpoint: "/api/chat",
    getAccessToken: () => "token",
    fetch: async () => response(200, { messageId: 42, content: "secret body" }),
  });
  assert.equal(
    (await malformedSuccess.dispatch(sendMessage(), { message: "hello" })).status,
    "malformed_response",
  );

  const malformedError = createChatClient({
    endpoint: "/api/chat",
    getAccessToken: () => "token",
    fetch: async () => response(409, { error: { code: "CONFLICT", leaked: "secret" } }),
  });
  assert.equal(
    (await malformedError.dispatch(sendMessage(), { message: "hello" })).status,
    "malformed_response",
  );
});

test("caller abort and close interrupt active fetches with distinct canonical outcomes", async () => {
  for (const mode of ["abort", "close"]) {
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    let requestSignal;
    const client = createChatClient({
      endpoint: "/api/chat",
      getAccessToken: () => "token",
      fetch: async (_url, init) => {
        requestSignal = init.signal;
        markStarted();
        return new Promise(() => {});
      },
    });
    const controller = new AbortController();
    const pending = client.dispatch(
      sendMessage(),
      { message: "hello" },
      { signal: controller.signal },
    );
    await started;
    if (mode === "abort") controller.abort();
    else client.close();
    assert.equal((await pending).status, mode === "abort" ? "aborted" : "closed");
    assert.equal(requestSignal.aborted, true);
    assert.deepEqual(client.state, { state: "idle" });
  }
});

test("caller abort and close interrupt deterministic backoff and prevent retries", async () => {
  for (const mode of ["abort", "close"]) {
    let markWaiting;
    const waiting = new Promise((resolve) => {
      markWaiting = resolve;
    });
    let waitSignal;
    let calls = 0;
    const client = createChatClient({
      endpoint: "/api/chat",
      getAccessToken: () => "token",
      commands: {
        retry: {
          maxAttempts: 3,
          backoffMs: () => 500,
          wait(_delay, signal) {
            waitSignal = signal;
            markWaiting();
            return new Promise(() => {});
          },
        },
      },
      fetch: async () => {
        calls += 1;
        throw new Error("offline");
      },
    });
    const controller = new AbortController();
    const pending = client.dispatch(
      sendMessage(),
      { message: "hello" },
      { signal: controller.signal },
    );
    await waiting;
    if (mode === "abort") controller.abort();
    else client.close();
    assert.equal((await pending).status, mode === "abort" ? "aborted" : "closed");
    assert.equal(waitSignal.aborted, true);
    assert.equal(calls, 1);
  }
});

test("diagnostics structurally redact tokens, authorization, thrown secrets, and content", async () => {
  const secrets = [
    "provider-secret",
    "access-token-secret",
    "authorization-secret",
    "full sensitive message content",
    "response-content-secret",
  ];
  const diagnostics = [];
  let providerCalls = 0;
  const client = createChatClient({
    endpoint: "/api/chat",
    getAccessToken() {
      providerCalls += 1;
      if (providerCalls === 1) throw new Error(secrets[0]);
      return secrets[1];
    },
    commands: {
      generateIdempotencyKey: () => "redaction-key",
      onDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
        if (diagnostic.event === "request_failed") {
          throw new Error("logger-thrown-secret");
        }
      },
      retry: { maxAttempts: 1 },
    },
    fetch: async (_url, init) => {
      assert.equal(init.headers.authorization, `Bearer ${secrets[1]}`);
      throw new Error(`${secrets[2]} ${secrets[3]} ${secrets[4]}`);
    },
  });

  const auth = await client.dispatch(sendMessage(), { message: secrets[3] });
  const transport = await client.dispatch(sendMessage(), { message: secrets[3] });
  const serialized = JSON.stringify({ auth, transport, diagnostics, client });
  for (const secret of [...secrets, "logger-thrown-secret", "Bearer"]) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  for (const diagnostic of diagnostics) {
    assert.deepEqual(
      Object.keys(diagnostic).sort(),
      Object.keys(diagnostic).filter((key) =>
        ["event", "command", "attempt", "category", "httpStatus", "delayMs"].includes(key)
      ).sort(),
    );
  }
});

for (const duringRefresh of [false, true]) {
  test(`token-provider outage ${duringRefresh ? "during refresh" : "before dispatch"} is transport and allows manual retry`, async () => {
    let offline = true;
    let tokenCalls = 0;
    let requests = 0;
    const diagnostics = [];
    const client = createChatClient({
      endpoint: "/api/chat",
      getAccessToken() {
        tokenCalls += 1;
        if (offline && (!duringRefresh || tokenCalls > 1)) throw new TypeError("Failed to fetch");
        return "valid-token";
      },
      commands: { onDiagnostic: (entry) => diagnostics.push(entry) },
      fetch: async () => {
        requests += 1;
        return offline
          ? response(401, errorBody("CHAT_ACCESS_TOKEN_EXPIRED", { refreshable: true }))
          : response(200, { messageId: "message-retried" });
      },
    });
    try {
      const result = await client.dispatch(sendMessage(), { message: "hello" });
      assert.equal(result.status, "transport");
      assert.equal(result.httpStatus, undefined);
      assert.equal(requests, duringRefresh ? 1 : 0);
      assert.equal(diagnostics.find((entry) => entry.event === "token_failed").category, "transport");
      offline = false;
      assert.equal((await client.dispatch(sendMessage(), { message: "hello" })).status, "success");
      assert.equal(requests, duringRefresh ? 2 : 1);
    } finally {
      client.close();
    }
  });
}

for (const token of ["", "   ", null, undefined, 123]) {
  test(`invalid returned token ${JSON.stringify(token)} remains an authentication failure`, async () => {
    const client = createChatClient({
      endpoint: "/api/chat",
      getAccessToken: () => token,
      fetch: async () => assert.fail("invalid token must not reach the chat server"),
    });
    try {
      assert.equal((await client.dispatch(sendMessage(), { message: "hello" })).status, "authentication");
    } finally {
      client.close();
    }
  });
}
