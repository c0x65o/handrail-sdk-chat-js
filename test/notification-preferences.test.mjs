import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

process.env.NODE_ENV = "test";

const { Window } = await import("happy-dom");
const window = new Window({ url: "https://notification-preferences.example.test" });
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
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { act, createElement, useState } = React;
const { createRoot } = await import("react-dom/client");
const { NotificationPreferences } = await import(
  "../dist/ui/notification-preferences.js"
);

const mounted = [];
const preference = Object.freeze({
  conversationId: "conversation-notification-preferences",
  userId: "user-notification-preferences",
  notificationPreference: "mentions",
  isStarred: true,
  mute: Object.freeze({ muted: false }),
  updatedAt: "2035-02-03T04:05:06.000Z",
});

const success = Object.freeze({
  status: "success",
  value: Object.freeze({
    preference,
    preferenceRevision: 2,
    reconciliationStatus: "applied",
  }),
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
};

const mount = async (element) => {
  const container = document.createElement("div");
  document.body.append(container);
  const entry = { container, root: createRoot(container), mounted: true };
  mounted.push(entry);
  await act(async () => {
    entry.root.render(element);
    await flush();
  });
  return entry;
};

const unmount = async (entry) => {
  if (!entry.mounted) return;
  await act(async () => {
    entry.root.unmount();
    await flush();
  });
  entry.mounted = false;
  entry.container.remove();
};

const click = async (element) => {
  assert.ok(element);
  await act(async () => {
    element.click();
    await flush();
  });
};

const keyDown = async (element, key) => {
  assert.ok(element);
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

const renderPreferences = async ({
  actions,
  preference: renderedPreference = preference,
  readOnly = false,
} = {}) => {
  const calls = [];
  const resolvedActions = actions ?? {
    async updateConversationPreference(input) {
      calls.push(input);
      return success;
    },
  };
  const entry = await mount(createElement(
    "section",
    null,
    createElement(NotificationPreferences, {
      actions: resolvedActions,
      preference: renderedPreference,
      readOnly,
    }),
    createElement("button", { type: "button" }, "Outside control"),
  ));
  return { ...entry, calls };
};

const triggerFor = (container) => container.querySelector(
  ".handrail-chat__notification-preferences-trigger",
);
const panelFor = (container) => container.querySelector(
  '.handrail-chat__notification-preferences-panel[role="dialog"]',
);

afterEach(async () => {
  while (mounted.length > 0) await unmount(mounted.pop());
});

test("names and describes the icon trigger from every authoritative notification and mute state", async () => {
  const cases = [
    {
      level: "all",
      mute: { muted: false },
      muteState: "unmuted",
      summary: "All messages; Unmuted",
    },
    {
      level: "mentions",
      mute: { muted: true, mutedUntil: "2040-05-06T07:08:09.000Z" },
      muteState: "until",
      summary: "Mentions only; Muted until 2040-05-06T07:08:09.000Z",
    },
    {
      level: "none",
      mute: { muted: true },
      muteState: "indefinite",
      summary: "No notifications; Muted indefinitely",
    },
  ];

  for (const { level, mute, muteState, summary } of cases) {
    const { container } = await renderPreferences({
      preference: { ...preference, notificationPreference: level, mute },
    });
    const trigger = triggerFor(container);
    const label = `Notification preferences: ${summary}`;

    assert.equal(trigger.getAttribute("aria-label"), label);
    assert.equal(trigger.title, label, "the native tooltip mirrors the accessible name");
    assert.equal(trigger.getAttribute("data-notification-level"), level);
    assert.equal(trigger.getAttribute("data-mute-state"), muteState);
    assert.equal(trigger.getAttribute("data-muted"), String(mute.muted));
    assert.equal(trigger.textContent, "", "the compact control has no visible text label");
    assert.ok(trigger.querySelector(
      '.handrail-chat__notification-preferences-icon[aria-hidden="true"]',
    ));
  }
});

test("opens with dialog semantics, editable focus, and native logical Tab reachability", async () => {
  const { container, calls } = await renderPreferences();
  const trigger = triggerFor(container);

  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
  assert.equal(panelFor(container), null);

  trigger.focus();
  await click(trigger);
  const panel = panelFor(container);
  const select = panel.querySelector('select[name="notificationPreference"]');
  const controls = [...panel.querySelectorAll(
    'select, input[name="conversationMute"], button',
  )];

  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(trigger.getAttribute("aria-controls"), panel.id);
  assert.equal(panel.getAttribute("aria-modal"), null, "the popover remains non-modal");
  assert.equal(document.activeElement, select, "editable focus starts at the first choice");
  assert.deepEqual(
    controls.map((control) => control.name || control.textContent),
    [
      "notificationPreference",
      "conversationMute",
      "conversationMute",
      "conversationMute",
      "Close",
      "Save preferences",
    ],
  );
  assert.equal(controls.every((control) => control.tabIndex === 0), true);
  const tabEvent = await keyDown(select, "Tab");
  assert.equal(tabEvent.defaultPrevented, false, "Tab is not trapped or overridden");
  controls.at(-2).focus();
  assert.equal(document.activeElement, controls.at(-2), "later controls remain reachable");
  assert.equal(calls.length, 0, "opening and keyboard navigation never mutate preferences");
});

test("uses Close as the safe initial focus target for read-only preferences", async () => {
  const { container, calls } = await renderPreferences({ readOnly: true });
  const trigger = triggerFor(container);

  assert.equal(
    trigger.getAttribute("aria-label"),
    "Notification preferences: Mentions only; Unmuted; Read-only",
  );
  assert.equal(trigger.title, trigger.getAttribute("aria-label"));
  assert.equal(trigger.getAttribute("data-read-only"), "true");
  assert.equal(trigger.disabled, false, "read-only preferences remain inspectable");
  assert.equal(trigger.getAttribute("aria-disabled"), null);
  await click(trigger);
  const panel = panelFor(container);
  const close = panel.querySelector(".handrail-chat__notification-preferences-close");

  assert.equal(document.activeElement, close);
  assert.equal(panel.querySelector('select[name="notificationPreference"]').disabled, true);
  assert.equal(panel.querySelector('button[type="submit"]'), null);
  assert.equal(calls.length, 0);
});

test("updates the trigger only from successful authoritative saves and prop reconciliation", async () => {
  const calls = [];
  const savedPreference = {
    ...preference,
    notificationPreference: "none",
    mute: { muted: true },
  };
  const reconciledPreference = {
    ...preference,
    notificationPreference: "all",
    mute: { muted: true, mutedUntil: "2042-03-04T05:06:07.000Z" },
  };
  const actions = {
    async updateConversationPreference(input) {
      calls.push(input);
      return {
        status: "success",
        value: {
          preference: savedPreference,
          preferenceRevision: 3,
          reconciliationStatus: "preference_revision_conflict",
        },
      };
    },
  };
  const ReconciliationHarness = () => {
    const [currentPreference, setCurrentPreference] = useState(preference);
    return createElement(
      "section",
      null,
      createElement("button", {
        onClick: () => setCurrentPreference(reconciledPreference),
        type: "button",
      }, "Reconcile preference"),
      createElement(NotificationPreferences, {
        actions,
        preference: currentPreference,
        readOnly: false,
      }),
    );
  };
  const { container } = await mount(createElement(ReconciliationHarness));
  const trigger = triggerFor(container);
  const initialLabel = "Notification preferences: Mentions only; Unmuted";

  assert.equal(trigger.getAttribute("aria-label"), initialLabel);
  await click(trigger);
  const panel = panelFor(container);
  const select = panel.querySelector('select[name="notificationPreference"]');
  const indefinite = panel.querySelector('input[value="indefinite"]');
  await act(async () => {
    select.value = "all";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    indefinite.click();
    await flush();
  });
  assert.equal(
    trigger.getAttribute("aria-label"),
    initialLabel,
    "unsaved draft choices are not announced as authoritative",
  );

  await act(async () => {
    panel.querySelector("form").dispatchEvent(new window.Event("submit", {
      bubbles: true,
      cancelable: true,
    }));
    await flush();
  });
  assert.deepEqual(calls, [{
    notificationPreference: "all",
    isStarred: true,
    mute: { muted: true },
  }]);
  assert.equal(
    trigger.getAttribute("aria-label"),
    "Notification preferences: No notifications; Muted indefinitely",
  );
  assert.equal(trigger.title, trigger.getAttribute("aria-label"));
  assert.match(
    panel.textContent,
    /Authoritative preference loaded: No notifications; Muted indefinitely/u,
  );

  await click([...container.querySelectorAll("button")]
    .find(({ textContent }) => textContent === "Reconcile preference"));
  assert.equal(
    trigger.getAttribute("aria-label"),
    "Notification preferences: All messages; Muted until 2042-03-04T05:06:07.000Z",
  );
  assert.equal(trigger.title, trigger.getAttribute("aria-label"));
  assert.equal(trigger.getAttribute("data-notification-level"), "all");
  assert.equal(trigger.getAttribute("data-mute-state"), "until");
  assert.equal(document.activeElement, select, "reconciliation preserves panel focus");
});

test("dismisses by toggle, Close, Escape, and outside pointer while ignoring inside pointer", async () => {
  const { container, calls } = await renderPreferences();
  const trigger = triggerFor(container);
  const outside = [...container.querySelectorAll("button")]
    .find(({ textContent }) => textContent === "Outside control");

  await click(trigger);
  await pointerDown(panelFor(container));
  assert.ok(panelFor(container), "pointer presses in the panel do not dismiss");
  await pointerDown(trigger);
  assert.ok(panelFor(container), "trigger pointerdown does not race its click");
  await click(trigger);
  assert.equal(panelFor(container), null);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(document.activeElement, trigger);

  await click(trigger);
  await click(panelFor(container).querySelector(
    ".handrail-chat__notification-preferences-close",
  ));
  assert.equal(panelFor(container), null);
  assert.equal(document.activeElement, trigger);

  await click(trigger);
  const escape = await keyDown(panelFor(container), "Escape");
  assert.equal(escape.defaultPrevented, true);
  assert.equal(panelFor(container), null);
  assert.equal(document.activeElement, trigger);

  await click(trigger);
  await pointerDown(outside);
  assert.equal(panelFor(container), null);
  assert.equal(document.activeElement, trigger);
  assert.equal(calls.length, 0, "every dismissal route adds zero preference mutations");
});

test("ignores every dismissal route while a preference update is pending", async () => {
  const calls = [];
  let resolveUpdate;
  const actions = {
    updateConversationPreference(input) {
      calls.push(input);
      return new Promise((resolvePromise) => {
        resolveUpdate = resolvePromise;
      });
    },
  };
  const { container } = await renderPreferences({ actions });
  const trigger = triggerFor(container);
  const outside = [...container.querySelectorAll("button")]
    .find(({ textContent }) => textContent === "Outside control");
  await click(trigger);
  const form = panelFor(container).querySelector("form");

  await act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
  });
  assert.equal(calls.length, 1);
  assert.equal(panelFor(container).querySelector(
    ".handrail-chat__notification-preferences-close",
  ).disabled, true);

  const escape = await keyDown(panelFor(container), "Escape");
  assert.equal(escape.defaultPrevented, true, "pending dialog owns Escape so its host stays open");
  await pointerDown(outside);
  await pointerDown(panelFor(container));
  await click(trigger);
  await click(panelFor(container).querySelector(
    ".handrail-chat__notification-preferences-close",
  ));

  assert.ok(panelFor(container), "pending work keeps the panel visible");
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(calls.length, 1, "dismissal attempts add zero mutation calls");

  await act(async () => {
    resolveUpdate(success);
    await flush();
  });
  await click(trigger);
  assert.equal(panelFor(container), null);
  assert.equal(calls.length, 1);
});

test("removes document listeners and does not restore focus across keyed identity replacement", async () => {
  const calls = [];
  const actions = {
    async updateConversationPreference(input) {
      calls.push(input);
      return success;
    },
  };
  const IdentityHarness = () => {
    const [identity, setIdentity] = useState("first");
    return createElement(
      "section",
      null,
      createElement("button", {
        onClick: () => setIdentity("second"),
        type: "button",
      }, "Replace conversation"),
      createElement(NotificationPreferences, {
        actions,
        key: identity,
        preference: { ...preference, conversationId: identity },
        readOnly: false,
      }),
    );
  };
  const entry = await mount(createElement(IdentityHarness));
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
    const oldTrigger = triggerFor(entry.container);
    await click(oldTrigger);
    assert.equal(tracked.keydown.size, 1);
    assert.equal(tracked.pointerdown.size, 1);

    await click([...entry.container.querySelectorAll("button")]
      .find(({ textContent }) => textContent === "Replace conversation"));
    const newTrigger = triggerFor(entry.container);
    assert.equal(oldTrigger.isConnected, false);
    assert.equal(newTrigger.getAttribute("aria-expanded"), "false");
    assert.notEqual(document.activeElement, newTrigger);
    assert.equal(tracked.keydown.size, 0);
    assert.equal(tracked.pointerdown.size, 0);

    await click(newTrigger);
    assert.equal(tracked.keydown.size, 1);
    assert.equal(tracked.pointerdown.size, 1);
    await unmount(entry);
    assert.equal(tracked.keydown.size, 0);
    assert.equal(tracked.pointerdown.size, 0);
    assert.equal(calls.length, 0);
  } finally {
    document.addEventListener = originalAdd;
    document.removeEventListener = originalRemove;
  }
});
