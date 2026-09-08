import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CHAT_CLIENT_PACKAGE_VERSION,
  ChatClientConfigurationError,
  createChatClient,
} from "../dist/client/index.js";
import {
  CHAT_PROTOCOL_VERSION,
  CHAT_REFRESH_REQUIRED_MESSAGE,
} from "../dist/index.js";

const packageManifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

const metadata = (overrides = {}) => ({
  packageVersion: packageManifest.version,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 7,
  enabledFeatures: {
    attachments: true,
    notifications: false,
    realtime: true,
  },
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION - 1,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
  ...overrides,
});

const response = (body, overrides = {}) => ({
  ok: true,
  status: 200,
  async json() {
    return body;
  },
  ...overrides,
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

class LifecycleSocket {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  sent = [];

  send(serialized) {
    this.sent.push(JSON.parse(serialized));
  }

  close() {
    this.readyState = 3;
  }

  message(value) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
}

test("normalizes endpoints and performs no work before start", async () => {
  const requests = [];
  let tokenCalls = 0;
  const client = createChatClient({
    endpoint: "  https://chat.example.test/api/chat////  ",
    async getAccessToken() {
      tokenCalls += 1;
      return "token-one";
    },
    async fetch(url, init) {
      requests.push({ url, init });
      return response(metadata());
    },
  });

  assert.equal(client.endpoint, "https://chat.example.test/api/chat");
  assert.deepEqual(client.state, { state: "idle" });
  assert.equal(tokenCalls, 0);
  assert.equal(requests.length, 0);

  const state = await client.start();
  assert.equal(state.state, "ready");
  assert.equal(requests[0].url, "https://chat.example.test/api/chat/_meta");
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.headers.authorization, "Bearer token-one");

  const rootRequests = [];
  const rootClient = createChatClient({
    endpoint: "/",
    getAccessToken: () => "root-token",
    async fetch(url) {
      rootRequests.push(url);
      return response(metadata());
    },
  });
  await rootClient.start();
  assert.deepEqual(rootRequests, ["/_meta"]);
});

test("binds the default browser fetch implementation to globalThis", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  const requests = [];
  globalThis.fetch = function defaultBrowserFetch(url, init) {
    assert.equal(this, globalThis);
    requests.push({ url, init });
    return Promise.resolve(response(metadata({
      enabledFeatures: {
        attachments: false,
        notifications: false,
        realtime: false,
      },
    })));
  };

  const client = createChatClient({
    endpoint: "/api/chat",
    getAccessToken: () => "browser-token",
  });

  assert.equal((await client.start()).state, "ready");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/chat/_meta");
});

test("starts successfully and exposes immutable negotiated metadata", async () => {
  const serverMetadata = metadata();
  const client = createChatClient({
    endpoint: "/api/chat/",
    features: {
      attachments: true,
      notifications: true,
      realtime: false,
      media: true,
    },
    getAccessToken: () => "access-token",
    fetch: async () => response(serverMetadata),
  });

  const state = await client.start();
  assert.deepEqual(state, {
    state: "ready",
    clientPackageVersion: packageManifest.version,
    protocolVersion: CHAT_PROTOCOL_VERSION,
    metadata: serverMetadata,
    enabledFeatures: {
      attachments: true,
      notifications: false,
      realtime: false,
      media: false,
    },
  });
  assert.equal(CHAT_CLIENT_PACKAGE_VERSION, packageManifest.version);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.metadata), true);
  assert.equal(Object.isFrozen(state.metadata.enabledFeatures), true);
  assert.equal(Object.isFrozen(state.enabledFeatures), true);
});

test("concurrent and repeated starts are deterministic", async () => {
  let resolveFetch;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    markFetchStarted = resolve;
  });
  let fetchCalls = 0;
  let tokenCalls = 0;
  const client = createChatClient({
    endpoint: "/api/chat",
    getAccessToken() {
      tokenCalls += 1;
      return `token-${tokenCalls}`;
    },
    fetch() {
      fetchCalls += 1;
      markFetchStarted();
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    },
  });

  const first = client.start();
  const concurrent = client.start();
  assert.equal(first, concurrent);
  assert.deepEqual(client.state, { state: "starting" });
  await fetchStarted;
  assert.equal(tokenCalls, 1);
  assert.equal(fetchCalls, 1);

  resolveFetch(response(metadata()));
  const ready = await first;
  assert.equal(ready.state, "ready");
  assert.equal(await client.start(), ready);
  assert.equal(tokenCalls, 1);
  assert.equal(fetchCalls, 1);
});

test("close is idempotent and permits a fresh-token restart", async () => {
  const seenTokens = [];
  let tokenCalls = 0;
  const client = createChatClient({
    endpoint: "/api/chat/",
    getAccessToken() {
      tokenCalls += 1;
      return `fresh-token-${tokenCalls}`;
    },
    async fetch(_url, init) {
      seenTokens.push(init.headers.authorization);
      return response(metadata());
    },
  });

  assert.equal((await client.start()).state, "ready");
  client.close();
  client.close();
  assert.deepEqual(client.state, { state: "idle" });
  assert.equal((await client.start()).state, "ready");
  assert.deepEqual(seenTokens, [
    "Bearer fresh-token-1",
    "Bearer fresh-token-2",
  ]);
});

test("lifecycle subscriptions publish canonical transitions safely", async () => {
  const sockets = [];
  const client = createChatClient({
    endpoint: "/api/chat",
    getAccessToken: () => "lifecycle-token",
    fetch: async () => response(metadata()),
    realtime: {
      webSocketFactory() {
        const socket = new LifecycleSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });

  const transitions = [];
  const unsubscribe = client.subscribeLifecycle((state) => {
    transitions.push(state);
  });
  client.subscribeLifecycle(() => {
    throw new Error("observer detail");
  });

  const reentrantTransitions = [];
  let unsubscribeReentrant = () => {};
  client.subscribeLifecycle((state) => {
    if (state.state === "starting") {
      unsubscribeReentrant();
      unsubscribeReentrant();
    }
  });
  unsubscribeReentrant = client.subscribeLifecycle((state) => {
    reentrantTransitions.push(state.state);
  });

  const firstStart = client.start();
  assert.equal(client.start(), firstStart);
  assert.equal((await firstStart).state, "ready");
  assert.equal((await client.start()).state, "ready");
  assert.deepEqual(
    transitions.map(({ state }) => state),
    ["starting", "ready"],
  );
  assert.deepEqual(reentrantTransitions, ["starting"]);
  assert.equal(transitions.every(Object.isFrozen), true);

  await flush();
  assert.equal(sockets.length, 1);
  sockets[0].open();
  assert.deepEqual(sockets[0].sent[0], {
    clientPackageVersion: packageManifest.version,
    protocolVersion: CHAT_PROTOCOL_VERSION,
  });
  const refreshRequired = {
    type: "chat.session.refresh_required",
    state: "refresh_required",
    reason: "unsupported_protocol",
    message: CHAT_REFRESH_REQUIRED_MESSAGE,
    requestedProtocolVersion: CHAT_PROTOCOL_VERSION,
    metadata: metadata(),
  };
  sockets[0].message(refreshRequired);
  sockets[0].message(refreshRequired);
  assert.equal(client.state.state, "refresh_required");

  client.close();
  client.close();
  assert.equal((await client.start()).state, "ready");
  assert.equal((await client.start()).state, "ready");
  assert.deepEqual(
    transitions.map(({ state }) => state),
    [
      "starting",
      "ready",
      "refresh_required",
      "idle",
      "starting",
      "ready",
    ],
  );

  unsubscribe();
  unsubscribe();
  const transitionCount = transitions.length;
  client.close();
  await client.start();
  assert.equal(transitions.length, transitionCount);
});

test("error retries obtain fresh tokens and diagnostics redact thrown values", async () => {
  const secretOne = "secret-token-from-provider-error";
  const secretTwo = "secret-token-from-fetch-error";
  let attempt = 0;
  const client = createChatClient({
    endpoint: "/api/chat",
    getAccessToken() {
      attempt += 1;
      if (attempt === 1) {
        throw new Error(`provider exposed ${secretOne}`);
      }
      return secretTwo;
    },
    async fetch() {
      throw new Error(`transport exposed ${secretTwo}`);
    },
  });
  const lifecycleStates = [];
  client.subscribeLifecycle((state) => lifecycleStates.push(state.state));

  const tokenError = await client.start();
  assert.deepEqual(tokenError, {
    state: "error",
    diagnostic: {
      code: "access_token_failed",
      message: "Chat credentials could not be obtained.",
    },
  });
  assert.doesNotMatch(JSON.stringify(client), new RegExp(`${secretOne}|${secretTwo}`));

  const requestError = await client.start();
  assert.deepEqual(requestError, {
    state: "error",
    diagnostic: {
      code: "metadata_request_failed",
      message: "Chat server metadata could not be requested.",
    },
  });
  assert.equal(attempt, 2);
  assert.deepEqual(lifecycleStates, ["starting", "error", "starting", "error"]);
  assert.doesNotMatch(JSON.stringify(requestError), new RegExp(secretTwo));
});

test("strictly rejects malformed metadata with safe diagnostics", async () => {
  const malformedBodies = [
    null,
    { ...metadata(), unexpected: true },
    metadata({ packageVersion: "" }),
    metadata({ schemaVersion: -1 }),
    metadata({ enabledFeatures: { realtime: "yes" } }),
    metadata({
      supportedProtocolRange: {
        minimumVersion: CHAT_PROTOCOL_VERSION + 1,
        maximumVersion: CHAT_PROTOCOL_VERSION + 2,
      },
    }),
  ];

  for (const body of malformedBodies) {
    const client = createChatClient({
      endpoint: "/api/chat",
      getAccessToken: () => "malformed-secret",
      fetch: async () => response(body),
    });
    assert.deepEqual(await client.start(), {
      state: "error",
      diagnostic: {
        code: "malformed_metadata",
        message: "The chat server returned invalid metadata.",
      },
    });
    assert.doesNotMatch(JSON.stringify(client.state), /malformed-secret/);
  }
});

test("unsupported client protocol produces the existing refresh-required contract", async () => {
  const serverMetadata = metadata({
    protocolVersion: CHAT_PROTOCOL_VERSION + 2,
    supportedProtocolRange: {
      minimumVersion: CHAT_PROTOCOL_VERSION + 1,
      maximumVersion: CHAT_PROTOCOL_VERSION + 2,
    },
  });
  const client = createChatClient({
    endpoint: "/api/chat",
    getAccessToken: () => "access-token",
    fetch: async () => response(serverMetadata),
  });

  const state = await client.start();
  assert.deepEqual(state, {
    state: "refresh_required",
    reason: "unsupported_protocol",
    message: CHAT_REFRESH_REQUIRED_MESSAGE,
    requestedProtocolVersion: CHAT_PROTOCOL_VERSION,
    clientPackageVersion: packageManifest.version,
    metadata: serverMetadata,
  });
  assert.equal(await client.start(), state);
});

test("package skew remains diagnostic when the advertised protocol is compatible", async () => {
  const serverMetadata = metadata({ packageVersion: "0.1.1" });
  const client = createChatClient({
    endpoint: "/api/chat",
    getAccessToken: () => "access-token",
    fetch: async () => response(serverMetadata),
  });

  const state = await client.start();
  assert.equal(state.state, "ready");
  assert.equal(state.clientPackageVersion, packageManifest.version);
  assert.equal(state.metadata.packageVersion, "0.1.1");
});

test("close aborts an in-flight metadata request and leaves idle state", async () => {
  let requestSignal;
  let fetchStarted;
  const started = new Promise((resolve) => {
    fetchStarted = resolve;
  });
  const client = createChatClient({
    endpoint: "/api/chat",
    getAccessToken: () => "abort-secret",
    fetch(_url, init) {
      requestSignal = init.signal;
      fetchStarted();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("request aborted", "AbortError")),
          { once: true },
        );
      });
    },
  });

  const startup = client.start();
  await started;
  client.close();
  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(await startup, { state: "idle" });
  assert.deepEqual(client.state, { state: "idle" });
  assert.doesNotMatch(JSON.stringify(client), /abort-secret/);
});

test("validates endpoint and callback configuration synchronously", () => {
  assert.throws(
    () => createChatClient({ endpoint: " ", getAccessToken: () => "token" }),
    ChatClientConfigurationError,
  );
  assert.throws(
    () =>
      createChatClient({
        endpoint: "/api/chat?token=secret",
        getAccessToken: () => "token",
      }),
    ChatClientConfigurationError,
  );
  assert.throws(
    () => createChatClient({ endpoint: "/api/chat", getAccessToken: null }),
    ChatClientConfigurationError,
  );
});

test("requires atomic storage only for cross-tab persisted clients", () => {
  const secretToken = "credential-that-must-not-leak";
  const secretIdentity = "identity-that-must-not-leak";
  const secretRecord = "record-content-that-must-not-leak";
  const callerControlledValue = "adapter-value-that-must-not-leak";
  let compareExchangeCalls = 0;
  const baseConfig = {
    endpoint: "/api/chat",
    getAccessToken: () => secretToken,
    fetch: async () => response(metadata()),
  };
  const legacyStorage = {
    async read() { return secretRecord; },
    async replace() {},
    async remove() {},
    async mutate(_identity, _kind, updater) { return updater(null); },
    async clearForLogout() {},
  };
  const persistence = (storage) => ({
    storage,
    resolveIdentity: () => ({
      tenantId: secretIdentity,
      userId: secretIdentity,
      deviceId: secretIdentity,
    }),
  });

  assert.doesNotThrow(() => createChatClient({
    ...baseConfig,
    normalizedCachePersistence: persistence(legacyStorage),
  }));
  assert.doesNotThrow(() => createChatClient({
    ...baseConfig,
    crossTab: { sessionFingerprint: "non-secret-session-scope" },
  }));
  assert.doesNotThrow(() => createChatClient({
    ...baseConfig,
    crossTab: { sessionFingerprint: "non-secret-session-scope" },
    normalizedCachePersistence: persistence({
      ...legacyStorage,
      async compareExchange() {
        compareExchangeCalls += 1;
        return true;
      },
    }),
  }));
  assert.equal(compareExchangeCalls, 0, "construction must only check the capability");

  const expectedMessage =
    "Invalid chat client configuration: normalizedCachePersistence.storage.compareExchange must be a function when crossTab is configured";
  const throwingCapability = { ...legacyStorage };
  Object.defineProperty(throwingCapability, "compareExchange", {
    get() { throw new Error(callerControlledValue); },
  });
  for (const storage of [
    legacyStorage,
    { ...legacyStorage, compareExchange: callerControlledValue },
    throwingCapability,
  ]) {
    assert.throws(
      () => createChatClient({
        ...baseConfig,
        crossTab: { sessionFingerprint: "non-secret-session-scope" },
        normalizedCachePersistence: persistence(storage),
      }),
      (error) => {
        assert.ok(error instanceof ChatClientConfigurationError);
        assert.equal(error.message, expectedMessage);
        assert.equal(error.message.includes(secretToken), false);
        assert.equal(error.message.includes(secretIdentity), false);
        assert.equal(error.message.includes(secretRecord), false);
        assert.equal(error.message.includes(callerControlledValue), false);
        return true;
      },
    );
  }
});
