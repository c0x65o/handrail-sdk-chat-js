import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

const React = await import("react");
const { StrictMode, createElement, useContext } = React;
const { renderToString } = await import("react-dom/server");
const { act, create } = await import("react-test-renderer");
const { ChatContext, ChatProvider } = await import("@handrail/chat/react");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const metadata = ({
  protocolVersion = 4,
  minimumVersion = 3,
  maximumVersion = 4,
} = {}) => ({
  packageVersion: "0.1.3",
  protocolVersion,
  schemaVersion: 1,
  enabledFeatures: { typing: true, presence: false },
  supportedProtocolRange: { minimumVersion, maximumVersion },
});

const response = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  async json() {
    return body;
  },
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

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

  send() {}

  close() {
    this.readyState = 3;
  }

  message(value) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

const createExternalClient = (initialState = Object.freeze({ state: "idle" })) => {
  let state = initialState;
  let starts = 0;
  let closes = 0;
  let subscriptions = 0;
  let unsubscriptions = 0;
  const listeners = new Set();
  const client = {
    endpoint: "/external/chat",
    get state() {
      return state;
    },
    subscribeLifecycle(listener) {
      subscriptions += 1;
      listeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        unsubscriptions += 1;
        listeners.delete(listener);
      };
    },
    start() {
      starts += 1;
      return Promise.resolve(state);
    },
    close() {
      closes += 1;
      state = Object.freeze({ state: "idle" });
    },
  };
  return {
    client,
    get starts() {
      return starts;
    },
    get closes() {
      return closes;
    },
    get subscriptions() {
      return subscriptions;
    },
    get unsubscriptions() {
      return unsubscriptions;
    },
    get activeListeners() {
      return listeners.size;
    },
    setState(nextState) {
      state = nextState;
      for (const listener of [...listeners]) listener(nextState);
    },
  };
};

const captureContext = (values, label) => {
  const Capture = () => {
    values.push({ label, value: useContext(ChatContext) });
    return null;
  };
  return Capture;
};

test("a supplied client remains externally owned and its context value is stable", async () => {
  const external = createExternalClient();
  const values = [];
  const Capture = captureContext(values, "external");
  let renderer;

  await act(async () => {
    renderer = create(
      createElement(ChatProvider, { client: external.client }, createElement(Capture)),
    );
  });

  const initialValue = values.at(-1).value;
  assert.equal(initialValue.client, external.client);
  assert.equal(initialValue.state.state, "idle");
  assert.equal(initialValue.readiness, "not_ready");
  assert.equal(initialValue.isReady, false);
  assert.equal(initialValue.refreshRequired, null);
  assert.equal(initialValue.error, null);
  assert.equal(external.starts, 0);
  assert.equal(external.subscriptions, 1);

  await act(async () => {
    renderer.update(
      createElement(ChatProvider, { client: external.client }, createElement(Capture)),
    );
  });
  assert.equal(values.at(-1).value, initialValue);
  assert.equal(external.subscriptions, 1);

  await act(async () => renderer.unmount());
  assert.equal(external.closes, 0);
  assert.equal(external.activeListeners, 0);
  assert.equal(external.unsubscriptions, external.subscriptions);
});

test("a supplied client publishes lifecycle transitions without a parent rerender", async () => {
  const ready = Object.freeze({ state: "ready" });
  const refreshRequired = Object.freeze({
    state: "refresh_required",
    reason: "unsupported_protocol",
    message: "Refresh required.",
  });
  const external = createExternalClient(ready);
  const values = [];
  const Capture = captureContext(values, "external-transition");
  let renderer;

  await act(async () => {
    renderer = create(
      createElement(ChatProvider, { client: external.client }, createElement(Capture)),
    );
  });

  const readyValue = values.at(-1).value;
  const renderCount = values.length;
  assert.equal(readyValue.state, ready);
  assert.equal(readyValue.readiness, "ready");

  await act(async () => external.setState(refreshRequired));

  const refreshValue = values.at(-1).value;
  assert.equal(values.length, renderCount + 1);
  assert.notEqual(refreshValue, readyValue);
  assert.equal(refreshValue.state, refreshRequired);
  assert.equal(refreshValue.readiness, "refresh_required");
  assert.equal(refreshValue.isReady, false);
  assert.equal(refreshValue.refreshRequired, refreshRequired);

  await act(async () => renderer.unmount());
  const unmountedRenderCount = values.length;
  external.setState(Object.freeze({ state: "idle" }));
  assert.equal(values.length, unmountedRenderCount);
  assert.equal(external.activeListeners, 0);
  assert.equal(external.unsubscriptions, external.subscriptions);
});

test("a configured client starts, becomes ready, and closes on unmount", async () => {
  const request = deferred();
  let fetchCalls = 0;
  const values = [];
  const Capture = captureContext(values, "owned");
  let renderer;

  await act(async () => {
    renderer = create(
      createElement(
        ChatProvider,
        {
          config: {
            endpoint: "/api/chat/",
            getAccessToken: () => "access-token",
            fetch: async () => {
              fetchCalls += 1;
              return request.promise;
            },
          },
        },
        createElement(Capture),
      ),
    );
    await Promise.resolve();
  });

  assert.equal(fetchCalls, 1);
  assert.equal(values.at(-1).value.state.state, "starting");
  assert.equal(values.at(-1).value.readiness, "not_ready");

  await act(async () => {
    request.resolve(response(metadata()));
    await request.promise;
    await Promise.resolve();
  });

  const readyValue = values.at(-1).value;
  assert.equal(readyValue.client.endpoint, "/api/chat");
  assert.equal(readyValue.state.state, "ready");
  assert.equal(readyValue.readiness, "ready");
  assert.equal(readyValue.isReady, true);
  assert.deepEqual(readyValue.state.enabledFeatures, {
    presence: false,
    typing: true,
  });

  await act(async () => renderer.unmount());
  assert.equal(readyValue.client.state.state, "idle");
});

test("a configured client publishes realtime refresh-required without a parent rerender", async () => {
  const sockets = [];
  const values = [];
  const Capture = captureContext(values, "owned-transition");
  let renderer;

  await act(async () => {
    renderer = create(
      createElement(
        ChatProvider,
        {
          config: {
            endpoint: "/api/chat",
            getAccessToken: () => "access-token",
            fetch: async () => response(metadata()),
            realtime: {
              webSocketFactory() {
                const socket = new LifecycleSocket();
                sockets.push(socket);
                return socket;
              },
            },
          },
        },
        createElement(Capture),
      ),
    );
    await flush();
  });

  const readyValue = values.at(-1).value;
  const renderCount = values.length;
  assert.equal(readyValue.state.state, "ready");
  assert.equal(sockets.length, 1);

  await act(async () => {
    sockets[0].message({
      type: "chat.session.refresh_required",
      state: "refresh_required",
      reason: "unsupported_protocol",
      message: "Chat was updated; refresh to continue.",
      requestedProtocolVersion: 4,
      metadata: metadata(),
    });
  });

  const refreshValue = values.at(-1).value;
  assert.equal(values.length, renderCount + 1);
  assert.notEqual(refreshValue, readyValue);
  assert.equal(refreshValue.state.state, "refresh_required");
  assert.equal(refreshValue.readiness, "refresh_required");
  assert.equal(refreshValue.isReady, false);
  assert.equal(refreshValue.refreshRequired, refreshValue.state);

  await act(async () => renderer.unmount());
  assert.equal(readyValue.client.state.state, "idle");
});

test("refresh-required compatibility and startup failures expose safe typed state", async () => {
  for (const scenario of [
    {
      name: "refresh",
      fetch: async () =>
        response(metadata({ protocolVersion: 5, minimumVersion: 5, maximumVersion: 5 })),
      expectedState: "refresh_required",
      expectedReadiness: "refresh_required",
    },
    {
      name: "error",
      fetch: async () => response(null, { ok: false, status: 503 }),
      expectedState: "error",
      expectedReadiness: "error",
    },
  ]) {
    const values = [];
    const Capture = captureContext(values, scenario.name);
    let renderer;

    await act(async () => {
      renderer = create(
        createElement(
          ChatProvider,
          {
            config: {
              endpoint: "/api/chat",
              getAccessToken: () => "access-token",
              fetch: scenario.fetch,
            },
          },
          createElement(Capture),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const value = values.at(-1).value;
    assert.equal(value.state.state, scenario.expectedState);
    assert.equal(value.readiness, scenario.expectedReadiness);
    assert.equal(value.isReady, false);
    if (scenario.name === "refresh") {
      assert.equal(value.refreshRequired, value.state);
      assert.equal(value.error, null);
      assert.equal(value.refreshRequired.reason, "unsupported_protocol");
    } else {
      assert.equal(value.refreshRequired, null);
      assert.deepEqual(value.error, {
        code: "metadata_request_failed",
        message: "Chat server metadata could not be requested.",
        httpStatus: 503,
      });
      assert.equal(Object.hasOwn(value.error, "cause"), false);
    }

    await act(async () => renderer.unmount());
  }
});

test("StrictMode effect replay ignores stale startup and leaves the owned client ready", async () => {
  const firstToken = deferred();
  let tokenCalls = 0;
  let fetchCalls = 0;
  const values = [];
  const Capture = captureContext(values, "strict");
  let renderer;

  await act(async () => {
    renderer = create(
      createElement(
        StrictMode,
        null,
        createElement(
          ChatProvider,
          {
            config: {
              endpoint: "/api/chat",
              getAccessToken: () => {
                tokenCalls += 1;
                return tokenCalls === 1 ? firstToken.promise : "current-token";
              },
              fetch: async () => {
                fetchCalls += 1;
                return response(metadata());
              },
            },
          },
          createElement(Capture),
        ),
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.equal(tokenCalls, 2);
  assert.equal(fetchCalls, 1);
  const readyValue = values.at(-1).value;
  assert.equal(readyValue.state.state, "ready");

  await act(async () => {
    firstToken.resolve("stale-token");
    await firstToken.promise;
    await Promise.resolve();
  });
  assert.equal(values.at(-1).value.state.state, "ready");
  assert.equal(fetchCalls, 1);

  await act(async () => renderer.unmount());
  assert.equal(readyValue.client.state.state, "idle");
});

test("StrictMode replay balances lifecycle subscriptions and removes stale listeners", async () => {
  const external = createExternalClient();
  const values = [];
  const Capture = captureContext(values, "strict-subscription");
  let renderer;

  await act(async () => {
    renderer = create(
      createElement(
        StrictMode,
        null,
        createElement(
          ChatProvider,
          { client: external.client },
          createElement(Capture),
        ),
      ),
    );
  });

  assert.equal(external.subscriptions >= 2, true);
  assert.equal(external.activeListeners, 1);
  assert.equal(external.unsubscriptions, external.subscriptions - 1);

  await act(async () => renderer.unmount());
  assert.equal(external.activeListeners, 0);
  assert.equal(external.unsubscriptions, external.subscriptions);

  const unmountedRenderCount = values.length;
  external.setState(Object.freeze({ state: "ready" }));
  assert.equal(values.length, unmountedRenderCount);
});

test("an unmounted provider suppresses a late startup completion", async () => {
  const request = deferred();
  const values = [];
  const Capture = captureContext(values, "stale");
  let renderer;

  await act(async () => {
    renderer = create(
      createElement(
        ChatProvider,
        {
          config: {
            endpoint: "/api/chat",
            getAccessToken: () => "access-token",
            fetch: async () => request.promise,
          },
        },
        createElement(Capture),
      ),
    );
    await Promise.resolve();
  });
  const ownedClient = values.at(-1).value.client;

  await act(async () => renderer.unmount());
  assert.equal(ownedClient.state.state, "idle");

  await act(async () => {
    request.resolve(response(metadata()));
    await request.promise;
    await Promise.resolve();
  });
  assert.equal(ownedClient.state.state, "idle");
});

test("missing and nested providers follow explicit null and nearest-provider policies", async () => {
  const outer = createExternalClient();
  const inner = createExternalClient();
  const values = [];
  const Missing = captureContext(values, "missing");
  const Outer = captureContext(values, "outer");
  const Inner = captureContext(values, "inner");
  let renderer;

  await act(async () => {
    renderer = create(
      createElement(
        React.Fragment,
        null,
        createElement(Missing),
        createElement(
          ChatProvider,
          { client: outer.client },
          createElement(Outer),
          createElement(
            ChatProvider,
            { client: inner.client },
            createElement(Inner),
          ),
        ),
      ),
    );
  });

  assert.equal(values.find(({ label }) => label === "missing").value, null);
  assert.equal(values.find(({ label }) => label === "outer").value.client, outer.client);
  assert.equal(values.find(({ label }) => label === "inner").value.client, inner.client);

  await act(async () => renderer.unmount());
  assert.equal(outer.closes, 0);
  assert.equal(inner.closes, 0);
});

test("the React entry and provider rendering are Node/SSR safe", () => {
  assert.equal(typeof ChatProvider, "function");
  assert.equal(typeof ChatContext, "object");
  assert.equal("window" in globalThis, false);
  assert.equal("document" in globalThis, false);

  let fetchCalls = 0;
  const Consumer = () => {
    const value = useContext(ChatContext);
    return createElement("span", null, value?.state.state ?? "missing");
  };
  const output = renderToString(
    createElement(
      ChatProvider,
      {
        config: {
          endpoint: "/api/chat",
          getAccessToken: () => "access-token",
          fetch: async () => {
            fetchCalls += 1;
            return response(metadata());
          },
        },
      },
      createElement(Consumer),
    ),
  );

  assert.equal(output, "<span>idle</span>");
  assert.equal(fetchCalls, 0);
});
