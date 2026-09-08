import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test, { afterEach } from "node:test";

process.env.NODE_ENV = "test";

const { Window } = await import("happy-dom");
const window = new Window({ url: "https://reaction-picker.example.test" });
Object.assign(globalThis, {
  document: window.document,
  Event: window.Event,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  InputEvent: window.InputEvent,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  Node: window.Node,
  PointerEvent: window.PointerEvent,
  window,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { act, createElement, useRef, useState } = React;
const { createRoot } = await import("react-dom/client");
const {
  REACTION_PICKER_CATALOG,
  ReactionPicker,
  isReactionPickerReactionKey,
} = await import("../dist/ui/index.js");

const packageRoot = resolve(import.meta.dirname, "..");
const mounted = [];

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
};

const PickerHarness = ({
  ariaLabel,
  bubbledKeys,
  dismissed,
  initialCategory,
  labels,
  selected,
  topLayer,
}) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  return createElement(
    "section",
    {
      "aria-label": "Message from Grace Hopper",
      className: "handrail-chat",
      onKeyDown: (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          bubbledKeys.push(event.key);
        }
      },
      tabIndex: -1,
    },
    createElement(
      "button",
      {
        "aria-expanded": open,
        "aria-label": "Open reaction picker",
        onClick: () => setOpen(true),
        ref: triggerRef,
        type: "button",
      },
      "React",
    ),
    createElement(
      "button",
      { "aria-label": "Outside control", type: "button" },
      "Outside",
    ),
    open
      ? createElement(ReactionPicker, {
          ...(ariaLabel === undefined ? {} : { ariaLabel }),
          ...(initialCategory === undefined ? {} : { initialCategory }),
          ...(labels === undefined ? {} : { labels }),
          onDismiss: (reason) => {
            dismissed.push(reason);
            setOpen(false);
          },
          onSelect: (reactionKey) => selected.push(reactionKey),
          restoreFocus: () => triggerRef.current?.focus(),
          ...(topLayer === undefined ? {} : { topLayer }),
        })
      : null,
  );
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

const keyDown = async (element, key) => {
  assert.ok(element);
  await act(async () => {
    element.dispatchEvent(new window.KeyboardEvent("keydown", {
      bubbles: true,
      key,
    }));
    await flush();
  });
};

const pointerDown = async (element) => {
  assert.ok(element);
  const scheduledTasks = [];
  const scheduleTask = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    if (delay === 0) {
      scheduledTasks.push(() => callback(...args));
      return scheduledTasks.length;
    }
    return scheduleTask(callback, delay, ...args);
  };
  try {
    await act(async () => {
      element.dispatchEvent(new window.PointerEvent("pointerdown", {
        bubbles: true,
        pointerType: "mouse",
      }));
      await flush();
    });
  } finally {
    globalThis.setTimeout = scheduleTask;
  }

  // Native pointer focus follows listener microtasks but precedes the next
  // task. The picker must defer exactly one restore beyond that default action.
  element.focus();
  assert.equal(scheduledTasks.length, 1);
  await act(async () => {
    scheduledTasks[0]();
    await flush();
  });
};

const openPicker = async (options = {}) => {
  const bubbledKeys = [];
  const selected = [];
  const dismissed = [];
  const container = await mount(createElement(PickerHarness, {
    ...options,
    bubbledKeys,
    dismissed,
    selected,
  }));
  const trigger = container.querySelector('[aria-label="Open reaction picker"]');
  await click(trigger);
  return { bubbledKeys, container, dismissed, selected, trigger };
};

const reactionButtons = (container) => [
  ...container.querySelectorAll("button[data-reaction-key]"),
];

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

test("filters the built-in catalog by accessible names and reports empty searches", async () => {
  const { container } = await openPicker();
  const search = container.querySelector('input[aria-label="Search reactions"]');
  assert.equal(document.activeElement, search, "initial focus moves into search");
  assert.equal(reactionButtons(container).length, REACTION_PICKER_CATALOG.length);

  await input(search, "rocket");
  const results = reactionButtons(container);
  assert.equal(results.length, 1);
  assert.equal(results[0].dataset.reactionKey, "🚀");
  assert.equal(results[0].getAttribute("aria-label"), "Rocket");
  assert.equal(
    container.querySelector('[role="grid"]')?.getAttribute("aria-label"),
    "Reaction search results for rocket",
  );

  await input(search, "not-a-catalog-reaction");
  assert.equal(reactionButtons(container).length, 0);
  assert.match(
    container.querySelector('[role="status"]')?.textContent ?? "",
    /No reactions found/,
  );
});

test("supports host-specific visible copy and labels without changing reaction defaults", async () => {
  const defaults = await openPicker();
  assert.equal(
    defaults.container.querySelector('[role="dialog"]')?.getAttribute("aria-label"),
    "Choose a reaction",
  );
  assert.equal(defaults.container.querySelector("h2")?.textContent, "Add reaction");
  assert.ok(defaults.container.querySelector('input[aria-label="Search reactions"]'));
  assert.ok(defaults.container.querySelector('nav[aria-label="Reaction categories"]'));
  assert.ok(defaults.container.querySelector('button[aria-label="All reactions"]'));
  const close = defaults.container.querySelector('button[aria-label="Close reaction picker"]');
  assert.ok(close);
  assert.ok(close.querySelector('svg.handrail-chat__reaction-picker-close-icon[aria-hidden="true"]'));
  assert.doesNotMatch(close.textContent, /×/u);

  const labels = {
    title: "Choose emoji",
    search: "Find emoji",
    searchPlaceholder: "Search the emoji catalog",
    categories: "Emoji categories",
    category: (categoryLabel) => `${categoryLabel} emoji`,
    grid: ({ categoryLabel, query }) => query.length > 0
      ? `Emoji matching ${query}`
      : `${categoryLabel} emoji grid`,
    empty: (query) => `No emoji match ${query}.`,
    close: "Close emoji chooser",
  };
  const custom = await openPicker({ ariaLabel: "Choose emoji", labels });
  const dialog = custom.container.querySelector('[role="dialog"]');
  const search = custom.container.querySelector('input[aria-label="Find emoji"]');
  assert.equal(dialog?.getAttribute("aria-label"), "Choose emoji");
  assert.equal(dialog?.querySelector("h2")?.textContent, "Choose emoji");
  assert.equal(search?.placeholder, "Search the emoji catalog");
  assert.ok(dialog?.querySelector('nav[aria-label="Emoji categories"]'));
  assert.ok(dialog?.querySelector('button[aria-label="All emoji"]'));
  assert.ok(dialog?.querySelector('button[aria-label="Close emoji chooser"]'));
  assert.equal(
    dialog?.querySelector('[role="grid"]')?.getAttribute("aria-label"),
    "All emoji grid",
  );

  await input(search, "rocket");
  assert.equal(
    dialog?.querySelector('[role="grid"]')?.getAttribute("aria-label"),
    "Emoji matching rocket",
  );
  await input(search, "not-an-emoji");
  assert.equal(dialog?.querySelector('[role="status"]')?.textContent, "No emoji match not-an-emoji.");
});

test("promotes a host-positioned picker into the browser top layer", async () => {
  const originalShowPopover = window.HTMLElement.prototype.showPopover;
  const originalHidePopover = window.HTMLElement.prototype.hidePopover;
  let showCount = 0;
  let hideCount = 0;
  window.HTMLElement.prototype.showPopover = function showPopover() {
    showCount += 1;
  };
  window.HTMLElement.prototype.hidePopover = function hidePopover() {
    hideCount += 1;
  };
  try {
    const { container } = await openPicker({ topLayer: true });
    const picker = container.querySelector('.handrail-chat__reaction-picker');
    assert.equal(picker.getAttribute("popover"), "manual");
    assert.equal(showCount, 1);

    await click(picker.querySelector('button[aria-label="Close reaction picker"]'));
    assert.equal(hideCount, 1);
  } finally {
    if (originalShowPopover === undefined) {
      delete window.HTMLElement.prototype.showPopover;
    } else {
      window.HTMLElement.prototype.showPopover = originalShowPopover;
    }
    if (originalHidePopover === undefined) {
      delete window.HTMLElement.prototype.hidePopover;
    } else {
      window.HTMLElement.prototype.hidePopover = originalHidePopover;
    }
  }
});

test("category navigation exposes catalog metadata and screen-reader names", async () => {
  const { container } = await openPicker();
  const category = container.querySelector(
    'button[aria-label="Nature and food reactions"]',
  );
  await click(category);

  assert.equal(category.getAttribute("aria-pressed"), "true");
  assert.equal(
    container.querySelector('[role="grid"]')?.getAttribute("aria-label"),
    "Nature and food reactions",
  );
  const expected = REACTION_PICKER_CATALOG.filter(
    (entry) => entry.category === "nature_food",
  );
  const buttons = reactionButtons(container);
  assert.equal(buttons.length, expected.length);
  assert.deepEqual(
    buttons.map((button) => button.dataset.reactionKey),
    expected.map((entry) => entry.reactionKey),
  );
  for (const [index, button] of buttons.entries()) {
    assert.equal(button.getAttribute("aria-label"), expected[index].name);
    assert.equal(button.querySelector("span")?.getAttribute("aria-hidden"), "true");
  }

  assert.equal(new Set(REACTION_PICKER_CATALOG.map((entry) => entry.reactionKey)).size,
    REACTION_PICKER_CATALOG.length, "canonical keys are unique");
  assert.ok(new Set(REACTION_PICKER_CATALOG.map((entry) => entry.category)).size >= 6);
});

test("uses roving tabindex with Arrow, Home, and End grid movement", async () => {
  const { bubbledKeys, container } = await openPicker();
  let buttons = reactionButtons(container);
  assert.equal(buttons[0].tabIndex, 0);
  assert.ok(buttons.slice(1).every((button) => button.tabIndex === -1));

  buttons[0].focus();
  await keyDown(buttons[0], "ArrowRight");
  buttons = reactionButtons(container);
  assert.equal(document.activeElement, buttons[1]);
  assert.equal(buttons[1].tabIndex, 0);

  await keyDown(buttons[1], "ArrowDown");
  buttons = reactionButtons(container);
  assert.equal(document.activeElement, buttons[7]);

  await keyDown(buttons[7], "ArrowUp");
  buttons = reactionButtons(container);
  assert.equal(document.activeElement, buttons[1]);
  assert.deepEqual(bubbledKeys, []);

  await keyDown(buttons[1], "Home");
  buttons = reactionButtons(container);
  assert.equal(document.activeElement, buttons[0]);

  await keyDown(buttons[0], "End");
  buttons = reactionButtons(container);
  assert.equal(document.activeElement, buttons.at(-1));
});

test("moves from reaction search into filtered results with arrow keys", async () => {
  const { bubbledKeys, container } = await openPicker();
  const messageRow = container.querySelector('[aria-label="Message from Grace Hopper"]');
  const search = container.querySelector('input[aria-label="Search reactions"]');
  await input(search, "heart");
  let buttons = reactionButtons(container);
  assert.ok(buttons.length > 1);

  await keyDown(search, "ArrowDown");
  buttons = reactionButtons(container);
  assert.equal(document.activeElement, buttons[0]);
  assert.notEqual(document.activeElement, messageRow);
  assert.equal(buttons[0].tabIndex, 0);
  assert.deepEqual(bubbledKeys, []);

  search.focus();
  await keyDown(search, "ArrowUp");
  buttons = reactionButtons(container);
  assert.equal(document.activeElement, buttons.at(-1));
  assert.notEqual(document.activeElement, messageRow);
  assert.equal(buttons.at(-1).tabIndex, 0);
  assert.deepEqual(bubbledKeys, []);

  search.focus();
  await input(search, "not-a-catalog-reaction");
  await keyDown(search, "ArrowDown");
  assert.equal(document.activeElement, search);
});

test("selects only a catalog-backed key, dismisses, and restores trigger focus", async () => {
  const { container, dismissed, selected, trigger } = await openPicker();
  const search = container.querySelector('input[aria-label="Search reactions"]');
  await input(search, "ship");
  await click(container.querySelector('button[data-reaction-key="🚀"]'));

  assert.deepEqual(selected, ["🚀"]);
  assert.deepEqual(dismissed, ["selection"]);
  assert.equal(container.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, trigger);
  assert.equal(isReactionPickerReactionKey(selected[0]), true);
  assert.equal(isReactionPickerReactionKey("custom-reaction"), false);
});

test("Escape and outside pointer dismissal both return focus to the trigger", async () => {
  const { container, dismissed, trigger } = await openPicker();
  const search = container.querySelector('input[aria-label="Search reactions"]');
  await keyDown(search, "Escape");
  assert.deepEqual(dismissed, ["escape"]);
  assert.equal(document.activeElement, trigger);

  await click(trigger);
  assert.ok(container.querySelector('[role="dialog"]'));
  await pointerDown(container.querySelector('[aria-label="Outside control"]'));
  assert.deepEqual(dismissed, ["escape", "outside_pointer"]);
  assert.equal(container.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, trigger);
});

test("styles remain root-scoped with explicit dark and coarse-pointer coverage", async () => {
  const styles = await readFile(resolve(packageRoot, "src/ui/styles.css"), "utf8");
  assert.doesNotMatch(styles, /^\.handrail-chat__reaction-picker/m);
  assert.match(
    styles,
    /\.handrail-chat\[data-handrail-theme="dark"\] \.handrail-chat__reaction-picker\s*\{/,
  );

  const systemDarkStart = styles.indexOf("@media (prefers-color-scheme: dark)");
  const reducedMotionStart = styles.indexOf("@media (prefers-reduced-motion: reduce)");
  const systemDark = styles.slice(systemDarkStart, reducedMotionStart);
  assert.match(
    systemDark,
    /\.handrail-chat:not\(\[data-handrail-theme="light"\]\) \.handrail-chat__reaction-picker/,
  );

  const coarseStart = styles.indexOf("@media (pointer: coarse)");
  const darkStart = styles.indexOf("@media (prefers-color-scheme: dark)");
  const coarse = styles.slice(coarseStart, darkStart);
  assert.match(coarse, /handrail-chat__reaction-picker-emoji[\s\S]*min-block-size: 2\.75rem/);
  assert.match(coarse, /handrail-chat__reaction-picker-emoji[\s\S]*min-inline-size: 2\.75rem/);
  assert.match(styles, /var\(--hr-chat-elevation-menu/);
  assert.match(styles, /var\(--hr-chat-focus-color/);
});
