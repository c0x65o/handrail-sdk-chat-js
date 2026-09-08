import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test, { afterEach } from "node:test";

process.env.NODE_ENV = "test";

const { Window } = await import("happy-dom");
const React = await import("react");
const { act, createElement } = React;
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ChatProvider } = await import("../dist/react/index.js");
const { ChatHuddleMediaSession } = await import("../dist/client/index.js");
const { HuddleControls } = await import("../dist/ui/index.js");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const window = new Window({ url: "https://huddle.example.test" });
Object.assign(globalThis, {
  document: window.document,
  Event: window.Event,
  HTMLElement: window.HTMLElement,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  Node: window.Node,
  PointerEvent: window.PointerEvent,
  window,
});

const conversationId = "conversation-huddle-controls";
const currentUserId = "user-current";
const otherUserId = "user-other";
const now = "2035-02-03T04:05:06.000Z";
const descriptorSentinel = "OPAQUE_HUDDLE_DESCRIPTOR_MUST_NOT_RENDER";
const allowAll = Object.freeze({
  canStart: true,
  canJoin: true,
  canLeave: true,
  canControlMicrophone: true,
  canShareScreen: true,
  canSelectDevices: true,
  canRetry: true,
  canRejoin: true,
  canEnd: true,
});
const readyClientState = (enabledFeatures = { huddles: true }) => Object.freeze({
  state: "ready",
  enabledFeatures: Object.freeze(enabledFeatures),
});
const participant = (userId, status = "joined") => Object.freeze({
  userId,
  status,
  joinedAt: now,
  ...(status === "left" ? { leftAt: now } : {}),
});
const canonical = (status, overrides = {}) => Object.freeze({
  status,
  conversationId,
  ...(status === "inactive" ? {} : {
    huddleSessionId: "huddle-session-controls",
    startedAt: now,
    participants: Object.freeze([]),
    screenShareOwnerUserId: null,
  }),
  ...(status === "ended" ? {
    endedAt: now,
    endedByUserId: currentUserId,
  } : {}),
  ...overrides,
});
const view = (state, overrides = {}) => Object.freeze({
  conversationId,
  hydrationStatus: "ready",
  media: Object.freeze({ state: "idle" }),
  canonicalState: state,
  ...overrides,
});

const createFixture = ({
  actionHandlers = {},
  clientState = readyClientState(),
  descriptor,
  initialView = view(canonical("inactive")),
} = {}) => {
  let currentView = initialView;
  const calls = [];
  const listeners = new Set();
  const client = {
    endpoint: "/chat",
    state: clientState,
    start: async () => clientState,
    close() {},
    subscribeLifecycle: () => () => undefined,
    getHuddleState: () => currentView,
    subscribeHuddle(_conversationId, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getHuddleMediaJoinDescriptor: () =>
      typeof descriptor === "function" ? descriptor() : descriptor,
  };
  for (const name of [
    "hydrateHuddle",
    "startHuddle",
    "joinHuddle",
    "leaveHuddle",
    "setHuddleScreenShare",
    "clearHuddleScreenShare",
    "endHuddle",
    "retryHuddle",
    "rejoinHuddle",
  ]) {
    client[name] = async (...args) => {
      calls.push({ name, args });
      const handler = actionHandlers[name];
      if (handler !== undefined) return handler(...args);
      const currentState = currentView.canonicalState ?? canonical("inactive");
      const state = name === "setHuddleScreenShare" &&
          (currentState.status === "starting" || currentState.status === "active")
        ? Object.freeze({ ...currentState, screenShareOwnerUserId: currentUserId })
        : name === "clearHuddleScreenShare" &&
            (currentState.status === "starting" || currentState.status === "active")
          ? Object.freeze({ ...currentState, screenShareOwnerUserId: null })
          : currentState;
      return Object.freeze({ status: "success", operation: name, state });
    };
  }
  return {
    calls,
    client,
    publish(next) {
      const previous = currentView;
      currentView = next;
      for (const listener of listeners) listener(next, previous);
    },
  };
};

const controls = (client, props = {}) => createElement(
  ChatProvider,
  { client },
  createElement(HuddleControls, {
    conversationId,
    currentUserId,
    permissions: allowAll,
    participantLabel: ({ userId }) => userId === currentUserId ? "Current user" : "Avery",
    ...props,
  }),
);

const mounted = [];
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
};
const mount = async (element) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => {
    root.render(element);
    await flush();
  });
  return container;
};
const rerender = async (container, element) => {
  const entry = mounted.find((candidate) => candidate.container === container);
  assert.ok(entry);
  await act(async () => {
    entry.root.render(element);
    await flush();
  });
};
const unmount = async (container) => {
  const index = mounted.findIndex((entry) => entry.container === container);
  if (index < 0) return;
  const [entry] = mounted.splice(index, 1);
  await act(async () => {
    entry.root.unmount();
    await flush();
  });
  entry.container.remove();
};
const click = async (element) => {
  await act(async () => {
    element.click();
    await flush();
  });
};
const keyDown = async (element, key) => {
  const event = new window.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
  });
  await act(async () => {
    element.dispatchEvent(event);
    await flush();
  });
  return event;
};
const pointerDown = async (element) => {
  assert.ok(element);
  await act(async () => {
    element.dispatchEvent(new window.PointerEvent("pointerdown", {
      bubbles: true,
      pointerType: "mouse",
    }));
    await flush();
  });
};
const button = (container, label) =>
  container.querySelector(`button[aria-label="${label}"]`);
const rawHuddleGlyphs = /(?:◖◗|•••|×)/u;
const assertDecorativeHuddleIcon = (icon, className) => {
  assert.ok(icon);
  assert.equal(icon.tagName, "svg");
  assert.equal(icon.classList.contains("handrail-chat__huddle-icon"), true);
  assert.equal(icon.classList.contains(className), true);
  assert.equal(icon.getAttribute("aria-hidden"), "true");
  assert.equal(icon.getAttribute("focusable"), "false");
  assert.equal(icon.getAttribute("fill"), "none");
  assert.equal(icon.getAttribute("stroke"), "currentColor");
  assert.equal(icon.getAttribute("stroke-linecap"), "round");
  assert.equal(icon.getAttribute("stroke-linejoin"), "round");
  assert.equal(icon.getAttribute("stroke-width"), "2");
  assert.equal(icon.getAttribute("viewBox"), "0 0 24 24");
};
const assertHuddleMarkIcon = (container) => {
  assertDecorativeHuddleIcon(
    container.querySelector(".handrail-chat__huddle-mark-icon"),
    "handrail-chat__huddle-mark-icon",
  );
  assert.doesNotMatch(container.textContent, rawHuddleGlyphs);
};
const assertLiveHuddleIcons = (container) => {
  assertHuddleMarkIcon(container);
  assertDecorativeHuddleIcon(
    button(container, "Open huddle details")?.querySelector("svg"),
    "handrail-chat__huddle-details-icon",
  );
  assertDecorativeHuddleIcon(
    button(container, "Close huddle details")?.querySelector("svg"),
    "handrail-chat__huddle-details-close-icon",
  );
  assert.doesNotMatch(container.textContent, rawHuddleGlyphs);
};

const createMediaFixture = ({
  connectMarkers = [],
  descriptors = [],
  failures = {},
  initial = {},
} = {}) => {
  const calls = [];
  const tracks = [];
  let currentConnection;
  const defaultState = {
    connectionStatus: "connected",
    microphoneMuted: true,
    screenShareActive: false,
    devices: {
      devices: [
        { id: "microphone-default", kind: "audio_input", label: "Desk microphone", isDefault: true },
        { id: "speaker-default", kind: "audio_output", label: "Desk speakers", isDefault: true },
      ],
      selectedAudioInputId: "microphone-default",
      selectedAudioOutputId: "speaker-default",
    },
    activeSpeakers: [],
    ...initial,
  };
  const fail = (operation) => {
    const remaining = failures[operation] ?? 0;
    if (remaining <= 0) return;
    failures[operation] = remaining - 1;
    throw new Error(`provider detail ${descriptorSentinel}`);
  };
  const adapter = {
    connect(descriptor) {
      calls.push("connect");
      const descriptorIndex = descriptors.findIndex((candidate) => candidate === descriptor);
      connectMarkers.push(descriptorIndex < 0 ? "unknown" : descriptorIndex);
      const listeners = new Set();
      const track = { stopped: false, stop() { this.stopped = true; } };
      tracks.push(track);
      let state = { ...defaultState };
      const publish = (next) => {
        state = { ...state, ...next };
        for (const listener of listeners) listener();
      };
      currentConnection = {
        publish,
        getState: () => state,
        getLocalTracks: () => [track],
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async setMicrophoneMuted(muted) {
          calls.push(muted ? "mute" : "unmute");
          fail("microphone");
          publish({ microphoneMuted: muted });
        },
        async startScreenShare() {
          calls.push("startScreenShare");
          fail("startScreenShare");
          publish({ screenShareActive: true });
        },
        async stopScreenShare() {
          calls.push("stopScreenShare");
          fail("stopScreenShare");
          publish({ screenShareActive: false });
        },
        async selectDevice(kind, deviceId) {
          calls.push(`selectDevice:${kind}:${deviceId ?? "default"}`);
          fail("selectDevice");
          publish({
            devices: {
              ...state.devices,
              ...(kind === "audio_input" ? { selectedAudioInputId: deviceId ?? undefined } : {}),
              ...(kind === "audio_output" ? { selectedAudioOutputId: deviceId ?? undefined } : {}),
              ...(kind === "video_input" ? { selectedVideoInputId: deviceId ?? undefined } : {}),
            },
          });
        },
        async disconnect() {
          calls.push("disconnect");
          publish({ connectionStatus: "disconnected", screenShareActive: false });
        },
      };
      return currentConnection;
    },
  };
  const session = new ChatHuddleMediaSession(adapter);
  return {
    calls,
    connectMarkers,
    failures,
    session,
    tracks,
    publish(next) { currentConnection?.publish(next); },
  };
};

const change = async (element, value) => {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
    await flush();
  });
};

afterEach(async () => {
  while (mounted.length > 0) {
    const entry = mounted.pop();
    await act(async () => entry.root.unmount());
    entry.container.remove();
  }
});

test("omits HuddleControls when negotiated huddles are disabled", () => {
  const fixture = createFixture({ clientState: readyClientState({ huddles: false }) });
  assert.equal(renderToStaticMarkup(controls(fixture.client)), "");
  const unavailable = createFixture({
    initialView: view(canonical("inactive"), {
      media: Object.freeze({ state: "unavailable", reason: "feature_disabled" }),
    }),
  });
  assert.equal(renderToStaticMarkup(controls(unavailable.client)), "");
});

test("maps the server-advertised media feature to the canonical huddles gate", () => {
  const serverMedia = createFixture({
    clientState: readyClientState({ media: true }),
  });
  assert.match(
    renderToStaticMarkup(controls(serverMedia.client)),
    /No huddle is active\./,
  );

  const explicitlyDisabled = createFixture({
    clientState: readyClientState({ huddles: false, media: true }),
  });
  assert.equal(renderToStaticMarkup(controls(explicitlyDisabled.client)), "");
});

test("renders loading, inactive, starting, active, and ended lifecycle actions", async () => {
  const fixture = createFixture({
    initialView: Object.freeze({
      conversationId,
      hydrationStatus: "loading",
      media: Object.freeze({ state: "idle" }),
    }),
  });
  const container = await mount(controls(fixture.client));
  assert.match(container.textContent, /Loading huddle/);
  assert.equal(container.querySelector("section")?.getAttribute("aria-busy"), "true");
  assertHuddleMarkIcon(container);

  await act(async () => fixture.publish(view(canonical("inactive"))));
  assert.match(container.textContent, /No huddle is active/);
  assert.ok(container.querySelector(".handrail-chat--huddle-inactive"));
  assert.equal(button(container, "Open huddle details"), null);
  assertHuddleMarkIcon(container);
  await click(button(container, "Start huddle"));

  await act(async () => fixture.publish(view(canonical("starting", {
    participants: Object.freeze([participant(otherUserId)]),
  }))));
  assert.match(container.textContent, /Huddle is starting/);
  assert.ok(container.querySelector(".handrail-chat--huddle-live"));
  assert.equal(container.querySelector('[aria-label="1 participant"]')?.textContent, "A1 participant");
  assertLiveHuddleIcons(container);
  await click(button(container, "Join huddle"));

  await act(async () => fixture.publish(view(canonical("active", {
    participants: Object.freeze([participant(currentUserId), participant(otherUserId)]),
  }))));
  assert.match(container.textContent, /Huddle is active/);
  assert.equal(container.querySelector(".handrail-chat__huddle-details")?.hidden, true);
  assertLiveHuddleIcons(container);
  await click(button(container, "Leave huddle"));
  await click(button(container, "Start screen sharing"));
  await click(button(container, "End huddle"));

  await act(async () => fixture.publish(view(canonical("ended", {
    participants: Object.freeze([
      participant(currentUserId, "left"),
      participant(otherUserId, "left"),
    ]),
  }))));
  assert.match(container.textContent, /Huddle ended/);
  assert.equal(container.querySelectorAll(".handrail-chat__huddle-button").length, 0);
  assertLiveHuddleIcons(container);
  assert.deepEqual(fixture.calls.map(({ name }) => name), [
    "startHuddle",
    "joinHuddle",
    "leaveHuddle",
    "setHuddleScreenShare",
    "endHuddle",
  ]);
});

test("renders only an available semantic Start or Join action in the header presentation", async () => {
  const media = createMediaFixture();
  const fixture = createFixture();
  const container = await mount(controls(fixture.client, {
    mediaSession: media.session,
    presentation: "header",
  }));

  const start = button(container, "Start huddle");
  assert.equal(container.querySelectorAll("button").length, 1);
  assert.equal(start?.title, "Start huddle");
  assert.equal(start?.type, "button");
  assert.equal(start?.querySelector("svg")?.getAttribute("aria-hidden"), "true");
  assert.equal(container.querySelector("section"), null);
  assert.equal(container.querySelector("[data-handrail-huddle-controls]"), null);
  assert.doesNotMatch(container.textContent, /Huddle|participant|Media connection:/);
  await click(start);
  assert.equal(fixture.calls.at(-1)?.name, "startHuddle");

  await act(async () => fixture.publish(view(canonical("starting", {
    participants: Object.freeze([participant(otherUserId)]),
  }))));
  const startingJoin = button(container, "Join huddle");
  assert.equal(container.querySelectorAll("button").length, 1);
  assert.equal(startingJoin?.title, "Join huddle");
  assert.doesNotMatch(container.textContent, /starting|participant|Media connection:/i);
  await click(startingJoin);
  assert.equal(fixture.calls.at(-1)?.name, "joinHuddle");

  await act(async () => fixture.publish(view(canonical("active", {
    participants: Object.freeze([participant(otherUserId)]),
  }))));
  assert.equal(container.querySelectorAll("button").length, 1);
  assert.equal(button(container, "Join huddle")?.title, "Join huddle");

  await act(async () => fixture.publish(view(canonical("active", {
    participants: Object.freeze([participant(currentUserId), participant(otherUserId)]),
  }))));
  assert.equal(container.querySelector("button"), null);
  assert.equal(container.textContent, "");
});

test("omits denied, host-disabled, and pending header huddle actions", async () => {
  const deniedStart = await mount(controls(createFixture().client, {
    permissions: Object.freeze({ ...allowAll, canStart: false }),
    presentation: "header",
  }));
  assert.equal(deniedStart.innerHTML, "");

  const deniedJoinFixture = createFixture({
    initialView: view(canonical("starting", {
      participants: Object.freeze([participant(otherUserId)]),
    })),
  });
  const deniedJoin = await mount(controls(deniedJoinFixture.client, {
    permissions: Object.freeze({ ...allowAll, canJoin: false }),
    presentation: "header",
  }));
  assert.equal(deniedJoin.innerHTML, "");

  const disabled = await mount(controls(createFixture().client, {
    disabled: true,
    presentation: "header",
  }));
  assert.equal(disabled.innerHTML, "");

  const pendingFixture = createFixture({
    initialView: view(canonical("inactive"), { pendingOperation: "start_huddle" }),
  });
  const pending = await mount(controls(pendingFixture.client, {
    presentation: "header",
  }));
  assert.equal(pending.innerHTML, "");
});

test("opens huddle details as a named non-modal dialog with ordinary focus traversal", async () => {
  const descriptor = Object.freeze({
    kind: "opaque_media_join",
    descriptor: "accessible-details-descriptor",
    expiresAt: "2035-02-03T04:09:06.000Z",
  });
  const media = createMediaFixture({ descriptors: [descriptor] });
  const fixture = createFixture({
    descriptor,
    initialView: view(canonical("active", {
      participants: Object.freeze([participant(currentUserId), participant(otherUserId)]),
    }), {
      media: Object.freeze({
        state: "ready",
        huddleSessionId: "huddle-session-controls",
        expiresAt: descriptor.expiresAt,
      }),
    }),
  });
  const container = await mount(controls(fixture.client, { mediaSession: media.session }));
  const trigger = button(container, "Open huddle details");
  const details = container.querySelector(".handrail-chat__huddle-details");
  const initialActionCalls = [...fixture.calls];
  const initialMediaCalls = [...media.calls];

  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(trigger.getAttribute("aria-controls"), details.id);
  assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
  assert.equal(details.hidden, true);
  assertLiveHuddleIcons(container);
  await click(trigger);

  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(details.hidden, false);
  assert.equal(details.getAttribute("role"), "dialog");
  assert.equal(details.getAttribute("aria-modal"), null);
  assertLiveHuddleIcons(container);
  assert.equal(
    details.getAttribute("aria-labelledby"),
    details.querySelector(".handrail-chat__huddle-details-title").id,
  );
  assert.equal(
    details.querySelector(`#${details.getAttribute("aria-labelledby")}`).textContent,
    "Huddle details",
  );

  const close = button(container, "Close huddle details");
  const microphone = details.querySelector('select[aria-label="Microphone device"]');
  const startSharing = button(container, "Start screen sharing");
  const focusableControls = [...details.querySelectorAll(
    "button:not(:disabled), select:not(:disabled)",
  )];
  assert.equal(document.activeElement, close);
  assert.deepEqual(
    focusableControls.map((control) =>
      control.getAttribute("aria-label") ?? control.textContent),
    [
      "Close huddle details",
      "Microphone device",
      "Speaker device",
      "Start screen sharing",
      "End huddle",
    ],
  );
  assert.equal(focusableControls.every((control) => control.tabIndex === 0), true);
  const tab = await keyDown(close, "Tab");
  assert.equal(tab.defaultPrevented, false, "Tab remains native and untrapped");
  microphone.focus();
  assert.equal(document.activeElement, microphone);
  startSharing.focus();
  assert.equal(document.activeElement, startSharing);
  assert.deepEqual(fixture.calls, initialActionCalls);
  assert.deepEqual(media.calls, initialMediaCalls);
});

test("dismisses huddle details without lifecycle or media mutations", async () => {
  const descriptor = Object.freeze({
    kind: "opaque_media_join",
    descriptor: "dismiss-details-descriptor",
    expiresAt: "2035-02-03T04:09:06.000Z",
  });
  const media = createMediaFixture({ descriptors: [descriptor] });
  const fixture = createFixture({
    descriptor,
    initialView: view(canonical("active", {
      participants: Object.freeze([participant(currentUserId), participant(otherUserId)]),
    }), {
      media: Object.freeze({
        state: "ready",
        huddleSessionId: "huddle-session-controls",
        expiresAt: descriptor.expiresAt,
      }),
    }),
  });
  const container = await mount(controls(fixture.client, { mediaSession: media.session }));
  const trigger = button(container, "Open huddle details");
  const details = container.querySelector(".handrail-chat__huddle-details");
  const outside = button(container, "Leave huddle");
  const initialActionCalls = [...fixture.calls];
  const initialMediaCalls = [...media.calls];

  await click(trigger);
  await pointerDown(details.querySelector('select[aria-label="Microphone device"]'));
  assert.equal(details.hidden, false, "inside pointer presses do not dismiss");
  assertLiveHuddleIcons(container);
  await pointerDown(trigger);
  assert.equal(details.hidden, false, "trigger pointerdown does not race its click");
  await click(trigger);
  assert.equal(details.hidden, true, "the trigger toggles the dialog closed");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(document.activeElement, trigger);
  assertLiveHuddleIcons(container);

  await click(trigger);
  await click(button(container, "Close huddle details"));
  assert.equal(details.hidden, true);
  assert.equal(document.activeElement, trigger);
  assertLiveHuddleIcons(container);

  await click(trigger);
  const escape = await keyDown(details, "Escape");
  assert.equal(escape.defaultPrevented, true);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(details.hidden, true);
  assert.equal(document.activeElement, trigger);
  assertLiveHuddleIcons(container);

  await click(trigger);
  await pointerDown(outside);
  assert.equal(details.hidden, true);
  assert.equal(document.activeElement, trigger);
  assert.deepEqual(fixture.calls, initialActionCalls);
  assert.deepEqual(media.calls, initialMediaCalls);
});

test("cleans up open-dialog listeners and skips disconnected trigger focus", async () => {
  const fixture = createFixture({
    initialView: view(canonical("active", {
      participants: Object.freeze([participant(currentUserId)]),
    })),
  });
  const container = await mount(controls(fixture.client, { key: "first" }));
  const tracked = { keydown: new Set(), pointerdown: new Set() };
  const originalAdd = document.addEventListener;
  const originalRemove = document.removeEventListener;
  document.addEventListener = function (type, listener, options) {
    if ((type === "keydown" || type === "pointerdown") && options === true) {
      tracked[type].add(listener);
    }
    return originalAdd.call(this, type, listener, options);
  };
  document.removeEventListener = function (type, listener, options) {
    if ((type === "keydown" || type === "pointerdown") && options === true) {
      tracked[type].delete(listener);
    }
    return originalRemove.call(this, type, listener, options);
  };

  try {
    const oldTrigger = button(container, "Open huddle details");
    await click(oldTrigger);
    assert.equal(tracked.keydown.size, 1);
    assert.equal(tracked.pointerdown.size, 1);

    await rerender(container, controls(fixture.client, { key: "second" }));
    const trigger = button(container, "Open huddle details");
    assert.equal(oldTrigger.isConnected, false);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.notEqual(document.activeElement, trigger);
    assert.equal(tracked.keydown.size, 0);
    assert.equal(tracked.pointerdown.size, 0);

    await click(trigger);
    assert.equal(tracked.keydown.size, 1);
    assert.equal(tracked.pointerdown.size, 1);
    const close = button(container, "Close huddle details");
    trigger.remove();
    close.focus();
    await click(close);
    assert.equal(trigger.isConnected, false);
    assert.notEqual(document.activeElement, trigger);
    assert.equal(tracked.keydown.size, 0);
    assert.equal(tracked.pointerdown.size, 0);

    await rerender(container, controls(fixture.client, { key: "third" }));
    await click(button(container, "Open huddle details"));
    assert.equal(tracked.keydown.size, 1);
    assert.equal(tracked.pointerdown.size, 1);
    await unmount(container);
    assert.equal(tracked.keydown.size, 0);
    assert.equal(tracked.pointerdown.size, 0);
    assert.deepEqual(fixture.calls, []);
  } finally {
    document.addEventListener = originalAdd;
    document.removeEventListener = originalRemove;
  }
});

test("updates the participant roster and current screen-share owner", async () => {
  const fixture = createFixture({
    initialView: view(canonical("active", {
      participants: Object.freeze([participant(currentUserId)]),
      screenShareOwnerUserId: currentUserId,
    })),
  });
  const container = await mount(controls(fixture.client));
  assert.match(container.textContent, /Current user is sharing their screen/);
  assert.ok(button(container, "Stop screen sharing"));

  await act(async () => fixture.publish(view(canonical("active", {
    participants: Object.freeze([participant(currentUserId), participant(otherUserId)]),
    screenShareOwnerUserId: otherUserId,
  }))));
  assert.deepEqual(
    [...container.querySelectorAll('[aria-label="Huddle participants"] li')]
      .map((item) => item.textContent),
    ["Current user", "Avery"],
  );
  assert.match(container.textContent, /Avery is sharing their screen/);
  assert.equal(button(container, "Start screen sharing").disabled, true);
});

test("reflects explicit permissions, host disabling, and canonical pending operations", async () => {
  const permissions = Object.freeze({
    ...allowAll,
    canLeave: false,
    canShareScreen: false,
    canEnd: false,
  });
  const fixture = createFixture({
    initialView: view(canonical("active", {
      participants: Object.freeze([participant(currentUserId)]),
    })),
  });
  const container = await mount(controls(fixture.client, { permissions }));
  for (const label of ["Leave huddle", "Start screen sharing", "End huddle"]) {
    const element = button(container, label);
    assert.equal(element.disabled, true);
    assert.match(element.title, /do not have permission/);
  }

  await act(async () => fixture.publish(view(canonical("active", {
    participants: Object.freeze([participant(currentUserId)]),
  }), { pendingOperation: "leave_huddle" })));
  assert.equal(container.querySelector("section")?.getAttribute("aria-busy"), "true");
  assert.match(container.textContent, /Leaving huddle/);
  assert.ok([
    ...container.querySelectorAll(".handrail-chat__huddle-button, select"),
  ].every((element) => element.disabled));

  const hostDisabled = createFixture({
    initialView: view(canonical("active", {
      participants: Object.freeze([participant(currentUserId)]),
    })),
  });
  const disabledContainer = await mount(controls(hostDisabled.client, { disabled: true }));
  assert.ok(
    [...disabledContainer.querySelectorAll(".handrail-chat__huddle-button, select")]
      .every((element) => element.disabled),
  );
});

test("renders only the provider's sanitized public diagnostic", async () => {
  const fixture = createFixture({
    clientState: Object.freeze({
      state: "error",
      diagnostic: Object.freeze({
        code: "startup_failed",
        message: "Chat is temporarily unavailable.",
      }),
    }),
  });
  const container = await mount(controls(fixture.client));
  assert.equal(
    container.querySelector('[role="alert"]')?.textContent,
    "Chat is temporarily unavailable.",
  );
  assert.doesNotMatch(container.innerHTML, /provider body|token|secret/i);
});

test("renders sanitized huddle errors and retries through the public action", async () => {
  const fixture = createFixture({
    initialView: view(canonical("inactive"), {
      media: Object.freeze({
        state: "error",
        code: "transport",
        message: "The huddle action could not be completed.",
        retryable: true,
      }),
    }),
  });
  const container = await mount(controls(fixture.client));
  assert.equal(
    container.querySelector('[role="alert"]')?.textContent,
    "The huddle action could not be completed.",
  );
  assert.doesNotMatch(container.innerHTML, /provider|token|secret/i);
  await click(button(container, "Retry huddle"));
  assert.equal(fixture.calls.at(-1)?.name, "retryHuddle");
});

test("offers rejoin only when canonical membership requires new media material", async () => {
  const fixture = createFixture({
    initialView: view(canonical("active", {
      participants: Object.freeze([participant(currentUserId)]),
    }), {
      media: Object.freeze({ state: "rejoin_required", reason: "descriptor_expired" }),
    }),
  });
  const container = await mount(controls(fixture.client));
  const details = container.querySelector(".handrail-chat__huddle-details");
  assert.equal(details.hidden, true);
  assert.equal(details.contains(button(container, "Rejoin huddle")), false);
  assert.equal(details.contains([...container.querySelectorAll("p")]
    .find(({ textContent }) => textContent === "Media rejoin required.")), false);
  await click(button(container, "Rejoin huddle"));
  assert.equal(fixture.calls.at(-1)?.name, "rejoinHuddle");
});

test("hands opaque descriptors only to the named media renderer callback", async () => {
  const descriptor = Object.freeze({
    kind: "opaque_media_join",
    descriptor: descriptorSentinel,
    expiresAt: "2035-02-03T04:09:06.000Z",
  });
  const received = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args);
  try {
    const fixture = createFixture({
      descriptor,
      initialView: view(canonical("active", {
        participants: Object.freeze([participant(currentUserId)]),
      }), {
        media: Object.freeze({
          state: "ready",
          huddleSessionId: "huddle-session-controls",
          expiresAt: descriptor.expiresAt,
        }),
      }),
    });
    const container = await mount(controls(fixture.client, {
      mediaRenderer: {
        receiveHuddleMediaJoinDescriptor(value) { received.push(value); },
      },
    }));
    assert.deepEqual(received, [descriptor]);
    assert.equal(container.innerHTML.includes(descriptorSentinel), false);
    assert.equal(container.textContent.includes(descriptorSentinel), false);
    assert.equal([...container.querySelectorAll("*")].some((element) =>
      [...element.attributes].some(({ value }) => value.includes(descriptorSentinel))), false);
    assert.equal(JSON.stringify(logs).includes(descriptorSentinel), false);
  } finally {
    console.log = originalLog;
  }
});

test("hands opaque descriptors to the media session without public-state or DOM leakage", async () => {
  const descriptor = Object.freeze({
    kind: "opaque_media_join",
    descriptor: descriptorSentinel,
    expiresAt: "2035-02-03T04:09:06.000Z",
  });
  const media = createMediaFixture({ descriptors: [descriptor] });
  const fixture = createFixture({
    descriptor,
    initialView: view(canonical("active", {
      participants: Object.freeze([participant(currentUserId)]),
    }), {
      media: Object.freeze({
        state: "ready",
        huddleSessionId: "huddle-session-controls",
        expiresAt: descriptor.expiresAt,
      }),
    }),
  });
  const logs = [];
  const originals = [console.log, console.warn, console.error];
  console.log = (...args) => logs.push(args);
  console.warn = (...args) => logs.push(args);
  console.error = (...args) => logs.push(args);
  try {
    const rendered = controls(fixture.client, { mediaSession: media.session });
    assert.equal(JSON.stringify(rendered).includes(descriptorSentinel), false);
    const container = await mount(rendered);
    assert.deepEqual(media.connectMarkers, [0]);
    assert.match(container.textContent, /Media connection: Connected/);
    assert.equal(container.innerHTML.includes(descriptorSentinel), false);
    assert.equal([...container.querySelectorAll("*")].some((element) =>
      [...element.attributes].some(({ value }) => value.includes(descriptorSentinel))), false);
    assert.equal(JSON.stringify(media.session.getState()).includes(descriptorSentinel), false);
    assert.equal(JSON.stringify(logs).includes(descriptorSentinel), false);
  } finally {
    [console.log, console.warn, console.error] = originals;
  }
});

test("custom renderer remains the selected handoff when a media session is also supplied", async () => {
  const descriptor = Object.freeze({
    kind: "opaque_media_join",
    descriptor: descriptorSentinel,
    expiresAt: "2035-02-03T04:09:06.000Z",
  });
  const received = [];
  const media = createMediaFixture({ descriptors: [descriptor] });
  const fixture = createFixture({
    descriptor,
    initialView: view(canonical("active", {
      participants: Object.freeze([participant(currentUserId)]),
    }), {
      media: Object.freeze({
        state: "ready",
        huddleSessionId: "huddle-session-controls",
        expiresAt: descriptor.expiresAt,
      }),
    }),
  });
  await mount(controls(fixture.client, {
    mediaSession: media.session,
    mediaRenderer: {
      receiveHuddleMediaJoinDescriptor(value) {
        received.push(value === descriptor ? "expected" : "unexpected");
      },
    },
  }));
  assert.deepEqual(received, ["expected"]);
  assert.deepEqual(media.calls, []);
});

test("renders session microphone, device, active-speaker, and sanitized failure state", async () => {
  const descriptor = Object.freeze({
    kind: "opaque_media_join",
    descriptor: descriptorSentinel,
    expiresAt: "2035-02-03T04:09:06.000Z",
  });
  const media = createMediaFixture({ descriptors: [descriptor] });
  const fixture = createFixture({
    descriptor,
    initialView: view(canonical("active", {
      participants: Object.freeze([participant(currentUserId), participant(otherUserId)]),
    }), {
      media: Object.freeze({
        state: "ready",
        huddleSessionId: "huddle-session-controls",
        expiresAt: descriptor.expiresAt,
      }),
    }),
  });
  const container = await mount(controls(fixture.client, { mediaSession: media.session }));

  await act(async () => {
    media.publish({ connectionStatus: "reconnecting" });
    await flush();
  });
  assert.match(container.textContent, /Media connection: Reconnecting/);
  assertLiveHuddleIcons(container);
  await act(async () => {
    media.publish({ connectionStatus: "connected" });
    await flush();
  });

  await click(button(container, "Unmute microphone"));
  assert.match(container.textContent, /Microphone unmuted/);
  await click(button(container, "Mute microphone"));
  assert.deepEqual(media.calls.filter((name) => name === "unmute" || name === "mute"), [
    "unmute",
    "mute",
  ]);

  await change(container.querySelector('select[aria-label="Microphone device"]'), "");
  assert.ok(media.calls.includes("selectDevice:audio_input:default"));

  await act(async () => {
    media.publish({
      activeSpeakers: [{ participantId: otherUserId, isSpeaking: true, audioLevel: 0.75 }],
    });
    await flush();
  });
  assert.equal(
    container.querySelector('[aria-label="Avery is speaking"]')?.textContent,
    " (speaking)",
  );

  media.failures.microphone = 1;
  await click(button(container, "Unmute microphone"));
  assert.match(container.querySelector('[role="alert"]')?.textContent, /media provider could not/);
  assert.equal(container.innerHTML.includes(descriptorSentinel), false);
});

test("converges screen-share start and stop across canonical and local state", async () => {
  const descriptor = Object.freeze({
    kind: "opaque_media_join",
    descriptor: "screen-share-descriptor",
    expiresAt: "2035-02-03T04:09:06.000Z",
  });
  let fixture;
  const shareState = (owner) => canonical("active", {
    participants: Object.freeze([participant(currentUserId)]),
    screenShareOwnerUserId: owner,
  });
  const actionHandlers = {
    setHuddleScreenShare: async () => {
      const state = shareState(currentUserId);
      fixture.publish(view(state, fixture.client.getHuddleState().media === undefined
        ? {}
        : { media: fixture.client.getHuddleState().media }));
      return Object.freeze({ status: "success", operation: "set_huddle_screen_share", state });
    },
    clearHuddleScreenShare: async () => {
      const state = shareState(null);
      fixture.publish(view(state, { media: fixture.client.getHuddleState().media }));
      return Object.freeze({ status: "success", operation: "set_huddle_screen_share", state });
    },
  };
  fixture = createFixture({
    actionHandlers,
    descriptor,
    initialView: view(shareState(null), {
      media: Object.freeze({
        state: "ready",
        huddleSessionId: "huddle-session-controls",
        expiresAt: descriptor.expiresAt,
      }),
    }),
  });
  const media = createMediaFixture({ descriptors: [descriptor] });
  const container = await mount(controls(fixture.client, { mediaSession: media.session }));

  await click(button(container, "Start screen sharing"));
  assert.equal(media.session.getState().screenShareActive, true);
  assert.ok(button(container, "Stop screen sharing"));
  await click(button(container, "Stop screen sharing"));
  assert.equal(media.session.getState().screenShareActive, false);
  assert.deepEqual(fixture.calls.map(({ name }) => name), [
    "setHuddleScreenShare",
    "clearHuddleScreenShare",
  ]);
  assert.ok(media.calls.includes("startScreenShare"));
  assert.ok(media.calls.includes("stopScreenShare"));
});

test("rejects screen-share ownership conflicts before local capture", async () => {
  const descriptor = Object.freeze({
    kind: "opaque_media_join",
    descriptor: "ownership-conflict-descriptor",
    expiresAt: "2035-02-03T04:09:06.000Z",
  });
  const fixture = createFixture({
    descriptor,
    initialView: view(canonical("active", {
      participants: Object.freeze([participant(currentUserId), participant(otherUserId)]),
      screenShareOwnerUserId: otherUserId,
    }), {
      media: Object.freeze({
        state: "ready",
        huddleSessionId: "huddle-session-controls",
        expiresAt: descriptor.expiresAt,
      }),
    }),
  });
  const media = createMediaFixture({ descriptors: [descriptor] });
  const container = await mount(controls(fixture.client, { mediaSession: media.session }));
  assert.equal(button(container, "Start screen sharing").disabled, true);
  await click(button(container, "Start screen sharing"));
  assert.equal(media.calls.includes("startScreenShare"), false);
  assert.equal(fixture.calls.some(({ name }) => name === "setHuddleScreenShare"), false);
});

test("rolls canonical ownership back when local screen-share start fails", async () => {
  const descriptor = Object.freeze({
    kind: "opaque_media_join",
    descriptor: descriptorSentinel,
    expiresAt: "2035-02-03T04:09:06.000Z",
  });
  let fixture;
  const stateFor = (owner) => canonical("active", {
    participants: Object.freeze([participant(currentUserId)]),
    screenShareOwnerUserId: owner,
  });
  const actionHandlers = {
    setHuddleScreenShare: async () => {
      const state = stateFor(currentUserId);
      fixture.publish(view(state, { media: fixture.client.getHuddleState().media }));
      return Object.freeze({ status: "success", operation: "set_huddle_screen_share", state });
    },
    clearHuddleScreenShare: async () => {
      const state = stateFor(null);
      fixture.publish(view(state, { media: fixture.client.getHuddleState().media }));
      return Object.freeze({ status: "success", operation: "set_huddle_screen_share", state });
    },
  };
  fixture = createFixture({
    actionHandlers,
    descriptor,
    initialView: view(stateFor(null), {
      media: Object.freeze({
        state: "ready",
        huddleSessionId: "huddle-session-controls",
        expiresAt: descriptor.expiresAt,
      }),
    }),
  });
  const media = createMediaFixture({
    descriptors: [descriptor],
    failures: { startScreenShare: 1 },
  });
  const container = await mount(controls(fixture.client, { mediaSession: media.session }));
  await click(button(container, "Start screen sharing"));
  assert.deepEqual(fixture.calls.map(({ name }) => name), [
    "setHuddleScreenShare",
    "clearHuddleScreenShare",
  ]);
  assert.equal(media.session.getState().screenShareActive, false);
  assert.equal(fixture.client.getHuddleState().canonicalState.screenShareOwnerUserId, null);
  assert.doesNotMatch(container.innerHTML, new RegExp(descriptorSentinel));
});

test("keeps local capture unchanged when the canonical screen-share mutation fails", async () => {
  const descriptor = Object.freeze({
    kind: "opaque_media_join",
    descriptor: "server-failure-descriptor",
    expiresAt: "2035-02-03T04:09:06.000Z",
  });
  const failure = Object.freeze({
    status: "error",
    operation: "set_huddle_screen_share",
    code: "conflict",
    message: "The huddle action could not be completed.",
    retryable: false,
  });
  const fixture = createFixture({
    actionHandlers: { setHuddleScreenShare: async () => failure },
    descriptor,
    initialView: view(canonical("active", {
      participants: Object.freeze([participant(currentUserId)]),
    }), {
      media: Object.freeze({
        state: "ready",
        huddleSessionId: "huddle-session-controls",
        expiresAt: descriptor.expiresAt,
      }),
    }),
  });
  const media = createMediaFixture({ descriptors: [descriptor] });
  const container = await mount(controls(fixture.client, { mediaSession: media.session }));
  await click(button(container, "Start screen sharing"));
  assert.equal(media.calls.includes("startScreenShare"), false);
  assert.equal(media.session.getState().screenShareActive, false);
});

test("keeps capture on a failed canonical stop, then stops stale capture after ownership changes", async () => {
  const descriptor = Object.freeze({
    kind: "opaque_media_join",
    descriptor: "external-owner-descriptor",
    expiresAt: "2035-02-03T04:09:06.000Z",
  });
  const ownedState = canonical("active", {
    participants: Object.freeze([participant(currentUserId), participant(otherUserId)]),
    screenShareOwnerUserId: currentUserId,
  });
  const failure = Object.freeze({
    status: "error",
    operation: "set_huddle_screen_share",
    code: "transport",
    message: "The huddle action could not be completed.",
    retryable: true,
  });
  const fixture = createFixture({
    actionHandlers: { clearHuddleScreenShare: async () => failure },
    descriptor,
    initialView: view(ownedState, {
      media: Object.freeze({
        state: "ready",
        huddleSessionId: "huddle-session-controls",
        expiresAt: descriptor.expiresAt,
      }),
    }),
  });
  const media = createMediaFixture({
    descriptors: [descriptor],
    initial: { screenShareActive: true },
  });
  const container = await mount(controls(fixture.client, { mediaSession: media.session }));
  await click(button(container, "Stop screen sharing"));
  assert.equal(media.session.getState().screenShareActive, true);
  assert.equal(media.calls.includes("stopScreenShare"), false);

  await act(async () => {
    fixture.publish(view(canonical("active", {
      participants: Object.freeze([participant(currentUserId), participant(otherUserId)]),
      screenShareOwnerUserId: otherUserId,
    }), { media: fixture.client.getHuddleState().media }));
    await flush();
  });
  assert.equal(media.session.getState().screenShareActive, false);
  assert.ok(media.calls.includes("stopScreenShare"));
});

test("fails closed when local screen-share stop fails after canonical clear", async () => {
  const descriptor = Object.freeze({
    kind: "opaque_media_join",
    descriptor: "stop-failure-descriptor",
    expiresAt: "2035-02-03T04:09:06.000Z",
  });
  let fixture;
  const stateFor = (owner) => canonical("active", {
    participants: Object.freeze([participant(currentUserId)]),
    screenShareOwnerUserId: owner,
  });
  const actionHandlers = {
    clearHuddleScreenShare: async () => {
      const state = stateFor(null);
      fixture.publish(view(state, { media: fixture.client.getHuddleState().media }));
      return Object.freeze({ status: "success", operation: "set_huddle_screen_share", state });
    },
  };
  fixture = createFixture({
    actionHandlers,
    descriptor,
    initialView: view(stateFor(currentUserId), {
      media: Object.freeze({
        state: "ready",
        huddleSessionId: "huddle-session-controls",
        expiresAt: descriptor.expiresAt,
      }),
    }),
  });
  const media = createMediaFixture({
    descriptors: [descriptor],
    initial: { screenShareActive: true },
    failures: { stopScreenShare: 1 },
  });
  const container = await mount(controls(fixture.client, { mediaSession: media.session }));
  await click(button(container, "Stop screen sharing"));
  assert.equal(fixture.client.getHuddleState().canonicalState.screenShareOwnerUserId, null);
  assert.equal(media.session.getState().screenShareActive, false);
  assert.equal(media.session.getState().connectionStatus, "idle");
  assert.ok(media.calls.includes("disconnect"));
});

test("disconnects reusable media on leave, end, external end, and unmount without closing it", async () => {
  const descriptor = Object.freeze({
    kind: "opaque_media_join",
    descriptor: "cleanup-descriptor",
    expiresAt: "2035-02-03T04:09:06.000Z",
  });
  const activeView = () => view(canonical("active", {
    participants: Object.freeze([participant(currentUserId)]),
  }), {
    media: Object.freeze({
      state: "ready",
      huddleSessionId: "huddle-session-controls",
      expiresAt: descriptor.expiresAt,
    }),
  });

  for (const lifecycle of ["Leave huddle", "End huddle"]) {
    const fixture = createFixture({ descriptor, initialView: activeView() });
    const media = createMediaFixture({ descriptors: [descriptor] });
    const container = await mount(controls(fixture.client, { mediaSession: media.session }));
    await click(button(container, lifecycle));
    assert.equal(media.session.getState().connectionStatus, "idle");
    assert.notEqual(media.session.getState().connectionStatus, "closed");
    await unmount(container);
  }

  const endedFixture = createFixture({ descriptor, initialView: activeView() });
  const endedMedia = createMediaFixture({ descriptors: [descriptor] });
  const endedContainer = await mount(controls(endedFixture.client, {
    mediaSession: endedMedia.session,
  }));
  await act(async () => {
    endedFixture.publish(view(canonical("ended", {
      participants: Object.freeze([participant(currentUserId, "left")]),
    })));
    await flush();
  });
  assert.equal(endedMedia.session.getState().connectionStatus, "idle");
  await unmount(endedContainer);

  const unmountFixture = createFixture({ descriptor, initialView: activeView() });
  const unmountMedia = createMediaFixture({ descriptors: [descriptor] });
  const unmountContainer = await mount(controls(unmountFixture.client, {
    mediaSession: unmountMedia.session,
  }));
  await unmount(unmountContainer);
  assert.equal(unmountMedia.session.getState().connectionStatus, "idle");
  assert.notEqual(unmountMedia.session.getState().connectionStatus, "closed");
  assert.ok(unmountMedia.tracks.every((track) => track.stopped));
});

test("rejoins with fresh descriptor material and replaces the previous connection", async () => {
  const first = Object.freeze({
    kind: "opaque_media_join",
    descriptor: `${descriptorSentinel}-first`,
    expiresAt: "2035-02-03T04:09:06.000Z",
  });
  const second = Object.freeze({
    kind: "opaque_media_join",
    descriptor: `${descriptorSentinel}-second`,
    expiresAt: "2035-02-03T04:10:06.000Z",
  });
  let currentDescriptor = first;
  let fixture;
  const liveState = canonical("active", {
    participants: Object.freeze([participant(currentUserId)]),
  });
  fixture = createFixture({
    actionHandlers: {
      rejoinHuddle: async () => {
        currentDescriptor = second;
        fixture.publish(view(liveState, {
          media: Object.freeze({
            state: "ready",
            huddleSessionId: "huddle-session-controls",
            expiresAt: second.expiresAt,
          }),
        }));
        return Object.freeze({ status: "success", operation: "join_huddle", state: liveState });
      },
    },
    descriptor: () => currentDescriptor,
    initialView: view(liveState, {
      media: Object.freeze({
        state: "ready",
        huddleSessionId: "huddle-session-controls",
        expiresAt: first.expiresAt,
      }),
    }),
  });
  const media = createMediaFixture({ descriptors: [first, second] });
  const container = await mount(controls(fixture.client, { mediaSession: media.session }));
  await act(async () => {
    fixture.publish(view(liveState, {
      media: Object.freeze({ state: "rejoin_required", reason: "descriptor_expired" }),
    }));
    await flush();
  });
  await click(button(container, "Rejoin huddle"));
  assert.deepEqual(media.connectMarkers, [0, 1]);
  assert.ok(media.calls.includes("disconnect"));
  assert.equal(container.innerHTML.includes(descriptorSentinel), false);
  assert.equal(JSON.stringify(media.session.getState()).includes(descriptorSentinel), false);
});

test("fails media controls closed for permissions, pending work, and disconnection", async () => {
  const descriptor = Object.freeze({
    kind: "opaque_media_join",
    descriptor: "disabled-controls-descriptor",
    expiresAt: "2035-02-03T04:09:06.000Z",
  });
  const liveState = canonical("active", {
    participants: Object.freeze([participant(currentUserId)]),
  });
  const fixture = createFixture({
    descriptor,
    initialView: view(liveState, {
      media: Object.freeze({
        state: "ready",
        huddleSessionId: "huddle-session-controls",
        expiresAt: descriptor.expiresAt,
      }),
    }),
  });
  const media = createMediaFixture({ descriptors: [descriptor] });
  const permissions = Object.freeze({
    ...allowAll,
    canControlMicrophone: false,
    canSelectDevices: false,
  });
  const container = await mount(controls(fixture.client, {
    mediaSession: media.session,
    permissions,
  }));
  assert.equal(button(container, "Unmute microphone").disabled, true);
  assert.equal(container.querySelector('select[aria-label="Microphone device"]').disabled, true);

  await act(async () => {
    fixture.publish(view(liveState, {
      media: fixture.client.getHuddleState().media,
      pendingOperation: "leave_huddle",
    }));
    await flush();
  });
  assert.ok([
    ...container.querySelectorAll(".handrail-chat__huddle-button, select"),
  ].every((element) => element.disabled));

  await act(async () => {
    fixture.publish(view(liveState, {
      media: Object.freeze({ state: "rejoin_required", reason: "realtime_disconnected" }),
    }));
    await media.session.disconnect();
    await flush();
  });
  assert.equal(button(container, "Unmute microphone").disabled, true);
  assert.equal(button(container, "Start screen sharing").disabled, true);
  assert.equal(button(container, "Rejoin huddle").disabled, false);
  assert.match(container.textContent, /Media rejoin required/);

  const disabledFixture = createFixture({
    descriptor,
    initialView: view(liveState, {
      media: Object.freeze({
        state: "ready",
        huddleSessionId: "huddle-session-controls-disabled",
        expiresAt: descriptor.expiresAt,
      }),
    }),
  });
  const disabledMedia = createMediaFixture({ descriptors: [descriptor] });
  const disabledContainer = await mount(controls(disabledFixture.client, {
    disabled: true,
    mediaSession: disabledMedia.session,
  }));
  assert.ok(
    [...disabledContainer.querySelectorAll(".handrail-chat__huddle-button, select")]
      .every((element) => element.disabled),
  );
});

test("uses semantic keyboard-focusable controls with stable accessible labels", async () => {
  const fixture = createFixture();
  const container = await mount(controls(fixture.client));
  const start = button(container, "Start huddle");
  assert.equal(start.tagName, "BUTTON");
  assert.equal(start.type, "button");
  assert.equal(start.tabIndex, 0);
  start.focus();
  assert.equal(document.activeElement, start);
  assert.equal(start.getAttribute("aria-label"), "Start huddle");
  await click(start);
  assert.equal(start.getAttribute("aria-label"), "Start huddle");
});

test("huddle SVGs share compact currentColor sizing and remain visible in forced colors", async () => {
  const source = await readFile(
    resolve(import.meta.dirname, "../src/ui/styles.css"),
    "utf8",
  );
  const forcedColors = source.slice(source.lastIndexOf("@media (forced-colors: active)"));

  assert.match(
    source,
    /\.handrail-chat\[data-handrail-huddle-controls\]\s+\.handrail-chat__huddle-icon\s*\{[^}]*block-size:\s*var\(--hr-chat-icon-size-compact,\s*1rem\);[^}]*color:\s*currentColor;[^}]*display:\s*block;[^}]*fill:\s*none;[^}]*flex:\s*none;[^}]*inline-size:\s*var\(--hr-chat-icon-size-compact,\s*1rem\);[^}]*pointer-events:\s*none;[^}]*stroke:\s*currentColor;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\[data-handrail-huddle-controls\]\s+\.handrail-chat__huddle-icon\s*\{[^}]*color:\s*currentColor;[^}]*forced-color-adjust:\s*auto;[^}]*stroke:\s*currentColor;/s,
  );
});

test("imports runtime behavior only from React and the public React entry point", async () => {
  const source = await readFile(
    resolve(import.meta.dirname, "../src/ui/huddle-controls.ts"),
    "utf8",
  );
  const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(new Set(imports), new Set([
    "react",
    "../client/index.js",
    "../contracts/index.js",
    "../react/index.js",
  ]));
  assert.doesNotMatch(
    source,
    /(?:normalized-cache|runtime|transport|websocket|socket|server\/|ChatContext)/,
  );
  assert.doesNotMatch(source, /(?:console\.|JSON\.stringify|dangerouslySetInnerHTML)/);
});
