import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

process.env.NODE_ENV = "test";

const { Window } = await import("happy-dom");
const window = new Window({ url: "https://user-status.example.test" });
Object.assign(globalThis, {
  document: window.document,
  Event: window.Event,
  HTMLElement: window.HTMLElement,
  InputEvent: window.InputEvent,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  Node: window.Node,
  window,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { act, createElement } = React;
const { createRoot } = await import("react-dom/client");
const { UserStatusSelector } = await import("../dist/ui/index.js");

const mounted = [];

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
};

const mount = async (element) => {
  const container = document.createElement("div");
  container.className = "handrail-chat";
  document.body.append(container);
  const entry = { container, root: createRoot(container) };
  mounted.push(entry);
  await act(async () => {
    entry.root.render(element);
    await flush();
  });
  return entry;
};

const click = async (element) => {
  assert.ok(element);
  await act(async () => {
    element.click();
    await flush();
  });
};

const input = async (element, value) => {
  assert.ok(element);
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new window.InputEvent("input", {
      bubbles: true,
      data: value,
      inputType: "insertText",
    }));
    await flush();
  });
};

const change = async (element, value) => {
  assert.ok(element);
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
    await flush();
  });
};

const triggerFor = (container) => container.querySelector(
  ".handrail-chat__user-status-trigger",
);

const dialogFor = (container) => container.querySelector(
  '.handrail-chat__user-status-dialog[role="dialog"]',
);

afterEach(async () => {
  while (mounted.length > 0) {
    const entry = mounted.pop();
    await act(async () => {
      entry.root.unmount();
      await flush();
    });
    entry.container.remove();
  }
});

test("shows availability and custom status with icons from the compact trigger", async () => {
  const { container } = await mount(createElement(UserStatusSelector, {
    defaultStatus: {
      availability: "away",
      emoji: "🥗",
      text: "At lunch",
    },
  }));
  const trigger = triggerFor(container);

  assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(trigger.getAttribute("aria-label"), "Set your status: Away · 🥗 At lunch");
  assert.equal(trigger.textContent, "🥗At lunch");
  assert.equal(container.querySelector(
    ".handrail-chat__user-status-selector",
  ).dataset.availability, "away");

  trigger.focus();
  await click(trigger);
  const dialog = dialogFor(container);
  assert.ok(dialog);
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(trigger.getAttribute("aria-controls"), dialog.id);
  assert.equal(document.activeElement.getAttribute("aria-label"), "Custom status");

  const availabilityOptions = [...dialog.querySelectorAll(
    '.handrail-chat__user-status-availability-option input[type="radio"]',
  )];
  assert.deepEqual(availabilityOptions.map(({ value }) => value), [
    "online",
    "away",
    "busy",
    "offline",
  ]);
  assert.equal(availabilityOptions.find(({ value }) => value === "away").checked, true);
  assert.deepEqual(
    [...dialog.querySelectorAll(".handrail-chat__user-status-availability-icon")]
      .map(({ dataset }) => dataset.availability),
    ["online", "away", "busy", "offline"],
  );
});

test("applies a suggestion, allows a custom icon and message, and saves a timer", async () => {
  const changes = [];
  const beforeSave = Date.now();
  const { container } = await mount(createElement(UserStatusSelector, {
    onStatusChange: (status) => changes.push(status),
  }));

  await click(triggerFor(container));
  const dialog = dialogFor(container);
  const meetingPreset = [...dialog.querySelectorAll(
    ".handrail-chat__user-status-preset",
  )].find((button) => button.textContent.includes("In a meeting"));
  await click(meetingPreset);
  assert.equal(dialog.querySelector('[aria-label="Status icon"]').value, "📅");
  assert.equal(dialog.querySelector('[aria-label="Custom status"]').value, "In a meeting");
  assert.equal(dialog.querySelector('input[value="busy"]').checked, true);
  assert.equal(dialog.querySelector('select[name="statusTimer"]').value, "one-hour");

  await input(dialog.querySelector('[aria-label="Status icon"]'), "🎧");
  await input(dialog.querySelector('[aria-label="Custom status"]'), "Focus time");
  await click(dialog.querySelector('input[value="online"]'));
  await click(dialog.querySelector(".handrail-chat__user-status-save"));

  assert.equal(changes.length, 1);
  assert.deepEqual({
    availability: changes[0].availability,
    emoji: changes[0].emoji,
    text: changes[0].text,
  }, {
    availability: "online",
    emoji: "🎧",
    text: "Focus time",
  });
  assert.ok(Date.parse(changes[0].expiresAt) >= beforeSave + 60 * 60_000);
  assert.ok(Date.parse(changes[0].expiresAt) <= Date.now() + 60 * 60_000);
  assert.equal(dialogFor(container), null);
  assert.equal(triggerFor(container).textContent, "🎧Focus time");
  assert.equal(document.activeElement, triggerFor(container));
});

test("validates custom expiry and preserves the draft when persistence fails", async () => {
  const { container } = await mount(createElement(UserStatusSelector, {
    onStatusChange: async () => {
      throw new Error("offline");
    },
  }));
  await click(triggerFor(container));
  let dialog = dialogFor(container);
  await change(dialog.querySelector('select[name="statusTimer"]'), "custom");
  await click(dialog.querySelector(".handrail-chat__user-status-save"));
  assert.match(dialog.querySelector('[role="alert"]').textContent, /future date and time/u);

  const future = new Date(Date.now() + 5 * 60_000);
  const localFuture = [
    future.getFullYear(),
    "-",
    String(future.getMonth() + 1).padStart(2, "0"),
    "-",
    String(future.getDate()).padStart(2, "0"),
    "T",
    String(future.getHours()).padStart(2, "0"),
    ":",
    String(future.getMinutes()).padStart(2, "0"),
  ].join("");
  await input(dialog.querySelector('input[type="datetime-local"]'), localFuture);
  await input(dialog.querySelector('[aria-label="Custom status"]'), "Heads down");
  await click(dialog.querySelector(".handrail-chat__user-status-save"));

  dialog = dialogFor(container);
  assert.ok(dialog, "a failed save leaves the draft dialog open");
  assert.equal(dialog.querySelector('[aria-label="Custom status"]').value, "Heads down");
  assert.match(dialog.querySelector('[role="alert"]').textContent, /could not be saved/u);
});

test("automatically clears an uncontrolled status when its timer expires", async () => {
  const changes = [];
  const { container } = await mount(createElement(UserStatusSelector, {
    defaultStatus: {
      availability: "busy",
      emoji: "⏱️",
      text: "Brief focus",
      expiresAt: new Date(Date.now() + 40).toISOString(),
    },
    onStatusChange: (status) => changes.push(status),
  }));
  assert.equal(triggerFor(container).textContent, "⏱️Brief focus");

  await act(async () => {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 90));
    await flush();
  });

  assert.deepEqual(changes, [undefined]);
  assert.equal(triggerFor(container).textContent, "Online");
  assert.equal(triggerFor(container).querySelector(
    '[data-availability="online"]',
  ) !== null, true);
});
