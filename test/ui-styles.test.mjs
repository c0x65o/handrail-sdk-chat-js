import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stylesheetPath = resolve(packageRoot, "src/ui/styles.css");
const chatLabStylesheetPath = resolve(
  packageRoot,
  "examples/drop-in-react/src/chat-lab.css",
);
const fixturePath = resolve(packageRoot, "test/fixtures/ui-styles.html");

const readStylesheet = () => readFile(stylesheetPath, "utf8");
const readChatLabStylesheet = () => readFile(chatLabStylesheetPath, "utf8");
const collectTokenDeclarations = (body) =>
  new Map(
    [...body.matchAll(/(--hr-chat-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(
      ([, name, value]) => [name, value.trim()],
    ),
  );
const isChatLabWorkspaceTokenSelector = (selector) => {
  const normalizedSelector = selector.replace(/\/\*[\s\S]*?\*\//g, "").trim();

  return /^(?:\.chat-lab__chat|\.chat-lab(?:\[[^\]]+\])*\s+\.chat-lab__chat)$/.test(
    normalizedSelector,
  );
};

test("every UI selector is scoped beneath the Handrail Chat root", async () => {
  const source = (await readStylesheet()).replace(/\/\*[\s\S]*?\*\//g, "");
  const sourceWithoutNativeHiddenRules = source.replace(
    /\.handrail-chat[^{}]*\[hidden\][^{}]*\{[^{}]*\}/g,
    "",
  ).replace(
    /\.handrail-chat \.handrail-chat__conversation-body--thread-open > \.handrail-chat__timeline,\s*\.handrail-chat \.handrail-chat__main:has\(\.handrail-chat__conversation-body--thread-open\) ~ \.handrail-chat__composer-region\s*{\s*display: none;\s*}/g,
    "", // Narrow screens show the thread; closing it restores the channel.
  );
  const selectorLines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith("{") && !line.startsWith("@"));

  assert.ok(selectorLines.length > 0);
  for (const selector of selectorLines) {
    const selectorWithoutBlock = selector.slice(0, -1).trim();
    assert.ok(
      selectorWithoutBlock === ".handrail-chat" ||
        selectorWithoutBlock.startsWith(".handrail-chat ") ||
        selectorWithoutBlock.startsWith(".handrail-chat[") ||
        selectorWithoutBlock.startsWith(".handrail-chat:"),
      `unscoped selector: ${selector}`,
    );
    assert.doesNotMatch(selector, /(^|[\s,>+~])(?::root|html\b|body\b|\*)/);
  }

  assert.doesNotMatch(
    sourceWithoutNativeHiddenRules,
    /display\s*:\s*none|visibility\s*:\s*hidden/,
  );
});

test("the stylesheet defines every documented token category with fallbacks", async () => {
  const source = await readStylesheet();
  const representativeTokens = [
    "--hr-chat-font-family",
    "--hr-chat-space-3",
    "--hr-chat-color-surface",
    "--hr-chat-border-width",
    "--hr-chat-radius-md",
    "--hr-chat-focus-color",
    "--hr-chat-motion-duration-fast",
    "--hr-chat-layer-overlay",
  ];

  for (const token of representativeTokens) {
    assert.match(source, new RegExp(`${token}\\s*:`));
  }

  assert.match(source, /var\(--hr-chat-font-family,\s*[^)]+\)/);
  assert.match(source, /var\(--hr-chat-space-3,\s*[^)]+\)/);
  assert.match(source, /var\(--hr-chat-color-surface,\s*[^)]+\)/);
  assert.match(source, /var\(--hr-chat-border-width,\s*[^)]+\)/);
  assert.match(source, /var\(--hr-chat-radius-md,\s*[^)]+\)/);
  assert.match(source, /var\(--hr-chat-focus-color,\s*[^)]+\)/);
  assert.match(source, /var\(--hr-chat-motion-duration-fast,\s*[^)]+\)/);
});

test("every consumed UI token is declared on the Handrail Chat root", async () => {
  const source = await readStylesheet();
  const rootRule = source.match(/^\.handrail-chat\s*\{([^}]*)\}/m);

  assert.ok(rootRule, "missing the Handrail Chat root token block");
  const consumedTokens = new Set(
    [...source.matchAll(/var\(\s*(--hr-chat-[a-z0-9-]+)/g)].map(
      ([, token]) => token,
    ),
  );
  const declaredTokens = collectTokenDeclarations(rootRule[1]);
  const missingTokens = [...consumedTokens]
    .filter((token) => !declaredTokens.has(token))
    .sort();

  assert.deepEqual(
    missingTokens,
    [],
    `consumed tokens missing from the root block: ${missingTokens.join(", ")}`,
  );
});

test("notification preferences use the shared dropdown layer below modal overlays", async () => {
  const source = await readStylesheet();
  const rootRule = source.match(/^\.handrail-chat\s*\{([^}]*)\}/m);
  const anchorRule = source.match(
    /\.handrail-chat\s+\.handrail-chat__notification-preferences\s*\{([^}]*)\}/s,
  );
  const panelRule = source.match(
    /\.handrail-chat\s+\.handrail-chat__notification-preferences-panel\s*\{([^}]*)\}/s,
  );

  assert.ok(rootRule, "missing the Handrail Chat root token block");
  assert.ok(anchorRule, "missing the notification preferences anchor rule");
  assert.ok(panelRule, "missing the notification preferences panel rule");

  const layerTokens = collectTokenDeclarations(rootRule[1]);
  const dropdownLayer = Number(layerTokens.get("--hr-chat-layer-dropdown"));
  const overlayLayer = Number(layerTokens.get("--hr-chat-layer-overlay"));
  assert.equal(dropdownLayer, 100);
  assert.equal(overlayLayer, 200);
  assert.ok(dropdownLayer < overlayLayer);
  assert.match(anchorRule[1], /position:\s*relative;/);
  assert.doesNotMatch(anchorRule[1], /z-index\s*:/);
  assert.match(
    panelRule[1],
    /z-index:\s*var\(--hr-chat-layer-dropdown,\s*100\);/,
  );
  assert.doesNotMatch(panelRule[1], /z-index:\s*20\s*;/);
});

test("Jump to latest is timeline-anchored below shared popup layers", async () => {
  const source = await readStylesheet();
  const rootRule = source.match(/^\.handrail-chat\s*\{([^}]*)\}/m);
  const timelineRule = source.match(
    /\.handrail-chat\s+\.handrail-chat__timeline\s*\{([^}]*)\}/s,
  );
  const controlRule = source.match(
    /\.handrail-chat\s+\.handrail-chat__timeline-jump-latest\s*\{([^}]*)\}/s,
  );

  assert.ok(rootRule, "missing the Handrail Chat root token block");
  assert.ok(timelineRule, "missing the timeline anchor rule");
  assert.ok(controlRule, "missing the Jump to latest control rule");
  assert.match(timelineRule[1], /position:\s*relative;/);
  assert.match(controlRule[1], /position:\s*absolute;/);
  assert.match(controlRule[1], /inset-block-end:/);

  const layerTokens = collectTokenDeclarations(rootRule[1]);
  const controlLayer = Number(controlRule[1].match(/z-index:\s*(\d+)\s*;/)?.[1]);
  assert.ok(controlLayer > 2, "control must stack above ordinary timeline actions");
  assert.ok(controlLayer < Number(layerTokens.get("--hr-chat-layer-dropdown")));
  assert.ok(controlLayer < Number(layerTokens.get("--hr-chat-layer-overlay")));
  assert.doesNotMatch(controlRule[1], /var\(--hr-chat-layer-(?:dropdown|overlay)/);
});

test("direct and group-direct creation reuse the channel workspace overlay layer", async () => {
  const source = await readStylesheet();
  const sharedOverlayRule = source.match(
    /\.handrail-chat\s+\.handrail-chat__channel-creation,\s*\.handrail-chat\s+\.handrail-chat__direct-creation--modal,\s*\.handrail-chat\s+\.handrail-chat__group-direct-creation--modal\s*\{([^}]*)\}/s,
  );
  const inlineDirectRule = source.match(
    /\.handrail-chat\s+\.handrail-chat__direct-creation:not\(\.handrail-chat__direct-creation--modal\)\s*\{([^}]*)\}/s,
  );
  const inlineGroupDirectRule = source.match(
    /\.handrail-chat\s+\.handrail-chat__group-direct-creation:not\(\.handrail-chat__group-direct-creation--modal\)\s*\{([^}]*)\}/s,
  );
  const sharedDialogRule = source.match(
    /\.handrail-chat\s+\.handrail-chat__channel-creation-dialog,\s*\.handrail-chat\s+\.handrail-chat__direct-creation-dialog,\s*\.handrail-chat\s+\.handrail-chat__group-direct-creation-dialog\s*\{([^}]*)\}/s,
  );
  const boundedGroupListsRule = source.match(
    /\.handrail-chat\s+\.handrail-chat__group-direct-creation-list,\s*\.handrail-chat\s+\.handrail-chat__group-direct-creation-selected-list\s*\{([^}]*)\}/s,
  );

  assert.ok(sharedOverlayRule, "all creation dialogs must share one overlay rule");
  assert.match(sharedOverlayRule[1], /inset:\s*0;/);
  assert.match(sharedOverlayRule[1], /place-items:\s*center;/);
  assert.match(sharedOverlayRule[1], /position:\s*absolute;/);
  assert.match(
    sharedOverlayRule[1],
    /z-index:\s*var\(--hr-chat-layer-overlay,\s*200\);/,
  );
  assert.ok(inlineDirectRule, "standalone direct creation retains its inline layout");
  assert.match(inlineDirectRule[1], /margin-block-end:/);
  assert.doesNotMatch(inlineDirectRule[1], /z-index\s*:/);
  assert.ok(inlineGroupDirectRule, "standalone group-direct creation retains its inline layout");
  assert.match(inlineGroupDirectRule[1], /margin-block-end:/);
  assert.doesNotMatch(inlineGroupDirectRule[1], /z-index\s*:/);
  assert.ok(sharedDialogRule, "group-direct creation shares the bounded dialog surface");
  assert.match(sharedDialogRule[1], /max-block-size:\s*min\(34rem,\s*100%\);/);
  assert.match(sharedDialogRule[1], /overflow:\s*auto;/);
  assert.ok(boundedGroupListsRule, "both group-direct participant lists are bounded");
  assert.match(boundedGroupListsRule[1], /max-block-size:\s*min\(10rem,\s*25vh\);/);
  assert.match(boundedGroupListsRule[1], /overflow-y:\s*auto;/);
  assert.match(boundedGroupListsRule[1], /overscroll-behavior:\s*contain;/);
});

test("production chat state tokens cover every theme branch", async () => {
  const source = await readStylesheet();
  const rootRule = source.match(/^\.handrail-chat\s*\{([^}]*)\}/m);
  const explicitDarkRule = source.match(
    /\.handrail-chat\[data-handrail-theme="dark"\]\s*\{([^}]*)\}/s,
  );
  const systemDarkRule = source.match(
    /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*\.handrail-chat:not\(\[data-handrail-theme="light"\]\)\s*\{([^}]*)\}/s,
  );
  const forcedColorsRule = source.match(
    /@media\s*\(forced-colors:\s*active\)\s*\{\s*(\.handrail-chat[^{}]*)\{([^}]*)\}/s,
  );
  const semanticTokens = [
    "--hr-chat-color-success",
    "--hr-chat-color-success-background",
    "--hr-chat-color-warning",
    "--hr-chat-color-warning-background",
    "--hr-chat-color-danger",
    "--hr-chat-color-danger-background",
    "--hr-chat-color-navigation-background",
    "--hr-chat-color-navigation-text",
    "--hr-chat-color-navigation-text-muted",
    "--hr-chat-color-navigation-hover-background",
    "--hr-chat-color-conversation-background",
    "--hr-chat-color-selected-background",
    "--hr-chat-color-selected-text",
    "--hr-chat-color-hover-background",
    "--hr-chat-color-surface-composer",
    "--hr-chat-color-surface-menu",
    "--hr-chat-color-surface-action",
    "--hr-chat-color-border-subtle",
    "--hr-chat-color-border-strong",
    "--hr-chat-color-presence-online",
    "--hr-chat-color-presence-away",
    "--hr-chat-color-presence-offline",
    "--hr-chat-color-unread-background",
    "--hr-chat-color-unread-text",
    "--hr-chat-color-mention-background",
    "--hr-chat-color-mention-text",
    "--hr-chat-color-muted-background",
    "--hr-chat-color-muted-text",
    "--hr-chat-color-error",
    "--hr-chat-color-error-background",
    "--hr-chat-control-size-compact",
    "--hr-chat-icon-size-compact",
  ];

  assert.ok(rootRule, "missing the light-theme token block");
  assert.ok(explicitDarkRule, "missing the explicit dark-theme token block");
  assert.ok(systemDarkRule, "missing the system dark-theme token block");
  assert.ok(forcedColorsRule, "missing the forced-colors token block");

  const lightTokens = collectTokenDeclarations(rootRule[1]);
  const explicitDarkTokens = collectTokenDeclarations(explicitDarkRule[1]);
  const systemDarkTokens = collectTokenDeclarations(systemDarkRule[1]);
  const forcedColorsTokens = collectTokenDeclarations(forcedColorsRule[2]);
  for (const token of semanticTokens) {
    assert.ok(lightTokens.has(token), `${token} is missing from light mode`);
    assert.ok(
      explicitDarkTokens.has(token),
      `${token} is missing from explicit dark mode`,
    );
    assert.equal(
      systemDarkTokens.get(token),
      explicitDarkTokens.get(token),
      `${token} differs between explicit and system dark modes`,
    );
    assert.ok(
      forcedColorsTokens.has(token),
      `${token} is missing from forced-colors mode`,
    );
  }

  assert.equal(
    lightTokens.get("--hr-chat-color-error"),
    "var(--hr-chat-color-danger, #b42318)",
  );
  assert.equal(
    lightTokens.get("--hr-chat-color-error-background"),
    "var(--hr-chat-color-danger-background, #fef3f2)",
  );

  const selectorWeight = (selector) =>
    [...selector.matchAll(/\.[a-z0-9_-]+|\[[^\]]+\]/gi)].length;
  const forcedColorsSelector = forcedColorsRule[1].trim();
  const forcedColorsDeclaration = {
    index: forcedColorsRule.index,
    selector: forcedColorsSelector,
    tokens: forcedColorsTokens,
  };
  const themeCases = [
    {
      label: "light",
      declarations: [
        {
          index: rootRule.index,
          selector: ".handrail-chat",
          tokens: lightTokens,
        },
        forcedColorsDeclaration,
      ],
    },
    {
      label: "explicit dark",
      declarations: [
        {
          index: rootRule.index,
          selector: ".handrail-chat",
          tokens: lightTokens,
        },
        {
          index: explicitDarkRule.index,
          selector: '.handrail-chat[data-handrail-theme="dark"]',
          tokens: explicitDarkTokens,
        },
        forcedColorsDeclaration,
      ],
    },
    {
      label: "system dark",
      declarations: [
        {
          index: rootRule.index,
          selector: ".handrail-chat",
          tokens: lightTokens,
        },
        {
          index: systemDarkRule.index,
          selector: '.handrail-chat:not([data-handrail-theme="light"])',
          tokens: systemDarkTokens,
        },
        forcedColorsDeclaration,
      ],
    },
  ];
  const cascadeWinner = (declarations) =>
    declarations.reduce((winner, declaration) => {
      const weightDifference =
        selectorWeight(declaration.selector) - selectorWeight(winner.selector);
      return weightDifference > 0 ||
        (weightDifference === 0 && declaration.index > winner.index)
        ? declaration
        : winner;
    });

  for (const { label, declarations } of themeCases) {
    for (const token of semanticTokens) {
      const winner = cascadeWinner(
        declarations.filter(({ tokens }) => tokens.has(token)),
      );
      assert.equal(
        winner,
        forcedColorsDeclaration,
        `${token} does not resolve from forced colors over ${label}`,
      );
    }
  }

  const systemColors = new Set([
    "ButtonBorder",
    "ButtonFace",
    "ButtonText",
    "Canvas",
    "CanvasText",
    "GrayText",
    "Highlight",
    "HighlightText",
    "Mark",
    "MarkText",
  ]);
  for (const token of semanticTokens.filter((name) =>
    name.startsWith("--hr-chat-color-"),
  )) {
    assert.ok(
      systemColors.has(forcedColorsTokens.get(token)),
      `${token} must resolve to a system color in forced-colors mode`,
    );
  }
});

test("ChatWorkspace shell regions consume the scoped production hierarchy tokens", async () => {
  const source = await readStylesheet();
  const ruleBody = (selector) => {
    const start = source.indexOf(`${selector} {`);
    assert.notEqual(start, -1, `missing scoped selector: ${selector}`);
    const bodyStart = source.indexOf("{", start) + 1;
    return source.slice(bodyStart, source.indexOf("}", bodyStart));
  };
  const expectedDeclarations = new Map([
    [
      ".handrail-chat[data-handrail-chat-mode]",
      [
        ["background", "--hr-chat-color-conversation-background"],
        ["border", "--hr-chat-color-border-subtle"],
      ],
    ],
    [
      ".handrail-chat .handrail-chat__navigation",
      [
        ["background", "--hr-chat-color-navigation-background"],
        ["border-inline-end", "--hr-chat-color-border-subtle"],
        ["color", "--hr-chat-color-navigation-text"],
      ],
    ],
    [
      '.handrail-chat .handrail-chat__conversation-button[aria-current="page"]',
      [
        ["background", "--hr-chat-color-selected-background"],
        ["border-color", "--hr-chat-color-selected-background"],
        ["color", "--hr-chat-color-selected-text"],
      ],
    ],
    [
      ".handrail-chat .handrail-chat__detail",
      [["background", "--hr-chat-color-conversation-background"]],
    ],
    [
      ".handrail-chat .handrail-chat__conversation",
      [["background", "--hr-chat-color-conversation-background"]],
    ],
    [
      ".handrail-chat .handrail-chat__header",
      [
        ["background", "--hr-chat-color-conversation-background"],
        ["border-block-end", "--hr-chat-color-border-subtle"],
      ],
    ],
    [
      ".handrail-chat .handrail-chat__main",
      [["background", "--hr-chat-color-conversation-background"]],
    ],
    [
      ".handrail-chat .handrail-chat__timeline",
      [["background", "--hr-chat-color-conversation-background"]],
    ],
    [
      ".handrail-chat .handrail-chat__composer-region",
      [
        ["background", "--hr-chat-color-conversation-background"],
        ["border-block-start", "--hr-chat-color-border-subtle"],
      ],
    ],
    [
      ".handrail-chat .handrail-chat__composer",
      [
        ["background", "--hr-chat-color-surface-composer"],
        ["border", "--hr-chat-color-border-subtle"],
      ],
    ],
    [
      ".handrail-chat .handrail-chat__creation-menu",
      [
        ["background", "--hr-chat-color-surface-menu"],
        ["border", "--hr-chat-color-border-subtle"],
      ],
    ],
    [
      ".handrail-chat .handrail-chat__message-search",
      [
        ["background", "--hr-chat-color-surface-menu"],
        ["border", "--hr-chat-color-border-subtle"],
      ],
    ],
    [
      ".handrail-chat .handrail-chat__notification-preferences-panel",
      [
        ["background", "--hr-chat-color-surface-menu"],
        ["border", "--hr-chat-color-border-subtle"],
      ],
    ],
    [
      ".handrail-chat .handrail-chat__member-management-panel",
      [
        ["background", "--hr-chat-color-surface-menu"],
        ["border-inline-start", "--hr-chat-color-border-subtle"],
      ],
    ],
    [
      ".handrail-chat .handrail-chat__member-management-panel > .handrail-chat__member-management",
      [["background", "--hr-chat-color-surface-menu"]],
    ],
    [
      ".handrail-chat .handrail-chat__thread-panel",
      [
        ["background", "--hr-chat-color-surface-menu"],
        ["border", "--hr-chat-color-border-subtle"],
      ],
    ],
    [
      ".handrail-chat .handrail-chat__timeline-actions",
      [
        ["background", "--hr-chat-color-surface-action"],
        ["border", "--hr-chat-color-border-subtle"],
      ],
    ],
    [
      ".handrail-chat .handrail-chat__timeline-actions-overflow-panel",
      [
        ["background", "--hr-chat-color-surface-menu"],
        ["border", "--hr-chat-color-border-subtle"],
      ],
    ],
    [
      ".handrail-chat .handrail-chat__reaction-picker",
      [
        ["background", "--hr-chat-color-surface-menu"],
        ["border", "--hr-chat-color-border-subtle"],
      ],
    ],
  ]);

  for (const [selector, declarations] of expectedDeclarations) {
    assert.ok(
      selector === ".handrail-chat[data-handrail-chat-mode]" ||
        selector.startsWith(".handrail-chat "),
      `hierarchy selector is not root scoped: ${selector}`,
    );
    const body = ruleBody(selector);
    for (const [property, token] of declarations) {
      assert.match(
        body,
        new RegExp(`${property}\\s*:\\s*[^;]*var\\(${token},`),
        `${selector} must use ${token} for ${property}`,
      );
    }
  }
});

test("the Chat Lab scopes workspace tokens and narrowly limits shell overrides", async () => {
  const [source, chatLabSource] = await Promise.all([
    readStylesheet(),
    readChatLabStylesheet(),
  ]);
  const requiredOverrides = [
    "--hr-chat-color-canvas",
    "--hr-chat-color-surface",
    "--hr-chat-color-surface-muted",
    "--hr-chat-color-text",
    "--hr-chat-color-text-muted",
    "--hr-chat-color-border",
    "--hr-chat-color-accent",
    "--hr-chat-color-on-accent",
    "--hr-chat-focus-color",
    "--hr-chat-space-1",
    "--hr-chat-space-2",
    "--hr-chat-space-3",
    "--hr-chat-space-4",
    "--hr-chat-space-5",
    "--hr-chat-space-6",
    "--hr-chat-radius-sm",
    "--hr-chat-radius-md",
    "--hr-chat-radius-lg",
  ];
  const declarationRules = [...chatLabSource.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const tokenRules = declarationRules.filter(
    ([, , body]) => collectTokenDeclarations(body).size > 0,
  );
  const workspaceTokenRules = tokenRules.filter(
    ([, selector]) => isChatLabWorkspaceTokenSelector(selector),
  );
  const shellTokenRules = tokenRules.filter(
    ([, selector]) => selector.trim() === ".chat-lab",
  );
  const expectedShellOverrides = new Map([
    ["--hr-chat-color-surface-raised", "Canvas"],
    ["--hr-chat-shadow-lg", "none"],
    ["--hr-chat-elevation-menu", "none"],
  ]);
  const forcedColorsBlock = chatLabSource.match(
    /@media\s*\(forced-colors:\s*active\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/s,
  );

  assert.equal(isChatLabWorkspaceTokenSelector(".chat-lab__chat"), true);
  assert.equal(
    isChatLabWorkspaceTokenSelector(
      '.chat-lab[data-chat-lab-effective-theme="light"] .chat-lab__chat',
    ),
    true,
  );
  for (const selector of [
    ":root .chat-lab__chat",
    ".outside-chat-lab .chat-lab__chat",
    ".chat-lab .chat-lab__chat-preview",
    ".chat-lab .chat-lab__chat .unrelated-descendant",
  ]) {
    assert.equal(
      isChatLabWorkspaceTokenSelector(selector),
      false,
      `invalid workspace token selector accepted: ${selector}`,
    );
  }

  assert.ok(tokenRules.length > 0);
  assert.equal(
    tokenRules.length,
    workspaceTokenRules.length + shellTokenRules.length,
    "token declarations must be scoped to the Chat Lab workspace or shell",
  );

  const compactThemeRule = workspaceTokenRules.find(([, , body]) =>
    body.includes("--hr-chat-space-1"),
  );
  if (workspaceTokenRules.length > 0) {
    assert.ok(compactThemeRule, "missing the compact workspace token block");
  }
  for (const token of requiredOverrides) {
    if (compactThemeRule !== undefined) {
      assert.match(compactThemeRule[2], new RegExp(`${token}\\s*:`));
    }
    assert.match(source, new RegExp(`var\\(${token}\\s*,\\s*[^)]+\\)`));
  }

  assert.ok(forcedColorsBlock, "missing the Chat Lab forced-colors block");
  assert.equal(
    shellTokenRules.length,
    1,
    "expected exactly one outer Chat Lab shell token rule",
  );
  assert.equal(
    forcedColorsBlock[1].includes(shellTokenRules[0][0]),
    true,
    "outer Chat Lab shell tokens must be declared in forced-colors mode",
  );
  assert.deepEqual(
    collectTokenDeclarations(shellTokenRules[0][2]),
    expectedShellOverrides,
    "outer Chat Lab shell tokens must remain the forced-color overlay set",
  );
  assert.doesNotMatch(chatLabSource, /--hr-chat-motion-/);
});

test("the DOM fixture demonstrates a host override and focus-visible opt-in", async () => {
  const [source, fixture] = await Promise.all([
    readStylesheet(),
    readFile(fixturePath, "utf8"),
  ]);

  assert.match(fixture, /class="handrail-chat"/);
  assert.match(fixture, /--hr-chat-color-accent:\s*rgb\(109 40 217\)/);
  assert.match(fixture, /--hr-chat-focus-color:\s*rgb\(190 24 93\)/);
  assert.match(fixture, /class="handrail-chat__button"[^>]*data-handrail-focus/);
  assert.match(
    source,
    /\.handrail-chat\s+:is\([^{}]*\):focus-visible\s*{[^}]*outline:\s*var\(--hr-chat-focus-width,[^;]+solid var\(--hr-chat-focus-color,/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__button\s*{[^}]*background:\s*var\(--hr-chat-color-accent,/s,
  );
});

test("dark, forced-color, and reduced-motion preferences stay root scoped", async () => {
  const source = await readStylesheet();
  const explicitDarkRule = source.match(
    /\.handrail-chat\[data-handrail-theme="dark"\]\s*\{([^}]*)\}/s,
  );
  const systemDarkRule = source.match(
    /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*\.handrail-chat:not\(\[data-handrail-theme="light"\]\)\s*\{([^}]*)\}/s,
  );
  const expectedDarkElevation = new Map([
    ["--hr-chat-color-surface-raised", "#22313d"],
    ["--hr-chat-shadow-sm", "0 1px 3px rgb(0 0 0 / 35%)"],
    ["--hr-chat-shadow-lg", "0 1rem 2rem rgb(0 0 0 / 55%)"],
    ["--hr-chat-elevation-menu", "0 0.75rem 2rem rgb(0 0 0 / 55%)"],
  ]);

  assert.ok(explicitDarkRule, "missing the explicit dark-theme token block");
  assert.ok(systemDarkRule, "missing the system dark-theme token block");
  const explicitDarkTokens = collectTokenDeclarations(explicitDarkRule[1]);
  const systemDarkTokens = collectTokenDeclarations(systemDarkRule[1]);
  for (const [token, value] of expectedDarkElevation) {
    assert.equal(explicitDarkTokens.get(token), value);
    assert.equal(systemDarkTokens.get(token), value);
  }

  assert.match(source, /@media\s*\(forced-colors:\s*active\)/);
  assert.match(source, /--hr-chat-focus-color:\s*Highlight/);
  assert.match(source, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(source, /--hr-chat-motion-duration-fast:\s*0ms/);
  assert.match(source, /--hr-chat-motion-duration-normal:\s*0ms/);
});

test("huddle details use their grid layout only while disclosed", async () => {
  const source = await readStylesheet();

  assert.match(
    source,
    /\.handrail-chat\[data-handrail-huddle-controls\]\s+\.handrail-chat__huddle-details\[hidden\]\s*{[^}]*display:\s*none;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\[data-handrail-huddle-controls\]\s+\.handrail-chat__huddle-details:not\(\[hidden\]\)\s*{[^}]*display:\s*grid;/s,
  );
  assert.doesNotMatch(
    source,
    /\.handrail-chat\[data-handrail-huddle-controls\]\s+\.handrail-chat__huddle-details\s*{[^}]*display:\s*grid;/s,
  );
});

test("link-preview cards bound long text and lazy images inside the timeline", async () => {
  const source = await readStylesheet();

  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__timeline-link-preview\s*{[^}]*inline-size:\s*min\(100%,\s*34rem\);[^}]*max-inline-size:\s*100%;[^}]*min-inline-size:\s*0;[^}]*overflow:\s*hidden;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__timeline-link-preview-image\s*{[^}]*inline-size:\s*100%;[^}]*max-block-size:\s*min\(14rem,\s*35vh\);[^}]*max-inline-size:\s*100%;[^}]*object-fit:\s*cover;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__timeline-link-preview-site,[\s\S]*?\.handrail-chat\s+\.handrail-chat__timeline-link-preview-url\s*{[^}]*max-inline-size:\s*100%;[^}]*min-inline-size:\s*0;[^}]*overflow-wrap:\s*anywhere;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__timeline-link-preview\s*{[^}]*var\(--hr-chat-color-surface-muted,[^)]+\)[^}]*var\(--hr-chat-border-width,[^)]+\)[^}]*var\(--hr-chat-color-border-subtle,[^)]+\)[^}]*var\(--hr-chat-radius-md,[^)]+\)/s,
  );
});

test("compact ChatWorkspace styles keep a single pane and uniformly sized header actions", async () => {
  const source = await readStylesheet();
  const forcedColors = source.slice(source.lastIndexOf("@media (forced-colors: active)"));

  assert.match(
    source,
    /\.handrail-chat\[data-handrail-chat-mode\]\[data-handrail-compact-layout="true"\]\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*inline-size:\s*100%;[^}]*max-inline-size:\s*100%;[^}]*min-inline-size:\s*0;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\[data-handrail-compact-layout="true"\]\s+\.handrail-chat__compact-back\s*>\s*span:last-child\s*{[^}]*clip-path:\s*inset\(50%\);[^}]*position:\s*absolute;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__pane-control-icon\s*{[^}]*block-size:\s*var\(--hr-chat-icon-size-compact,\s*1rem\);[^}]*color:\s*currentColor;[^}]*display:\s*block;[^}]*fill:\s*none;[^}]*inline-size:\s*var\(--hr-chat-icon-size-compact,\s*1rem\);[^}]*pointer-events:\s*none;[^}]*stroke:\s*currentColor;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\[data-handrail-compact-layout="true"\]\s+\.handrail-chat__header-actions\s*{[^}]*flex:\s*none;[^}]*flex-wrap:\s*nowrap;[^}]*white-space:\s*nowrap;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\[data-handrail-compact-layout="true"\]\s+\.handrail-chat__notification-preferences-trigger\s*{[^}]*block-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*inline-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*min-block-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*min-inline-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__member-management-trigger\s*{[^}]*block-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*inline-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*min-block-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*min-inline-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*padding:\s*0;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__member-management-icon\s*{[^}]*block-size:\s*var\(--hr-chat-icon-size-compact,\s*1rem\);[^}]*inline-size:\s*var\(--hr-chat-icon-size-compact,\s*1rem\);[^}]*pointer-events:\s*none;[^}]*stroke:\s*currentColor;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__huddle-header-button\s*{[^}]*block-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*inline-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*min-block-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*min-inline-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*padding:\s*0;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__message-search-trigger\s*{[^}]*block-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*inline-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*min-block-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*min-inline-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*padding:\s*0;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__message-search-trigger-icon\s*{[^}]*block-size:\s*var\(--hr-chat-icon-size-compact,\s*1rem\);[^}]*inline-size:\s*var\(--hr-chat-icon-size-compact,\s*1rem\);[^}]*pointer-events:\s*none;/s,
  );
  assert.match(
    source,
    /@media\s*\(pointer:\s*coarse\)\s*{[\s\S]*?\.handrail-chat\s+\.handrail-chat__message-search-close,[^}]*\.handrail-chat\s+\.handrail-chat__member-management-panel-close,[^}]*\.handrail-chat\s+\.handrail-chat__compact-back\s*{[^}]*inline-size:\s*2\.75rem;[^}]*min-inline-size:\s*2\.75rem;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__pane-control-icon\s*{[^}]*color:\s*currentColor;[^}]*forced-color-adjust:\s*auto;[^}]*stroke:\s*currentColor;/s,
  );
  assert.doesNotMatch(source, /header-actions\s*>\s*\.handrail-chat--huddle-inactive/);
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__navigation\[hidden\],[^{}]*\.handrail-chat\s+\.handrail-chat__detail\[hidden\]\s*{[^}]*display:\s*none;/s,
  );
  assert.doesNotMatch(
    source,
    /@media\s*\(max-width:\s*40rem\)[\s\S]*?grid-template-columns:\s*minmax\(8rem, 35%\)\s+minmax\(0, 1fr\)/,
  );
});

test("narrow split-pane headers compact actions against the conversation width", async () => {
  const source = await readStylesheet();
  const containerStart = source.indexOf("@container (max-width: 40rem)");
  const containerEnd = source.indexOf(
    '.handrail-chat[data-handrail-compact-layout="true"] .handrail-chat__header',
    containerStart,
  );
  const containerRule = source.slice(containerStart, containerEnd);

  assert.notEqual(containerStart, -1, "missing the narrow conversation container rule");
  assert.notEqual(containerEnd, -1, "missing the end of the narrow conversation rule");
  assert.match(
    containerRule,
    /\.handrail-chat\s+\.handrail-chat__notification-preferences-trigger\s*\{[^}]*block-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*inline-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*min-block-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*min-inline-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);/s,
  );
  assert.doesNotMatch(containerRule, /handrail-chat__member-management-trigger/);
  assert.doesNotMatch(containerRule, /\\1f465|👥/u);
  assert.doesNotMatch(containerRule, /handrail-chat--huddle-inactive/);
});

test("conversation state panels stay detail-scoped with accessible motion and color fallbacks", async () => {
  const source = await readStylesheet();
  const reducedMotionStart = source.indexOf("@media (prefers-reduced-motion: reduce)");
  const forcedColorsStart = source.lastIndexOf("@media (forced-colors: active)");
  const reducedMotion = source.slice(reducedMotionStart, forcedColorsStart);
  const forcedColors = source.slice(forcedColorsStart);
  const statePanelSelectors = [...source.matchAll(/([^{}]+handrail-chat__state-panel[^{}]*)\{/g)]
    .map((match) => match[1].trim())
    .filter((selector) => !selector.startsWith("animation:"));

  assert.ok(statePanelSelectors.length > 0);
  assert.ok(statePanelSelectors.every((selector) =>
    selector.includes(".handrail-chat__detail"),
  ));
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__detail\s*>\s*\.handrail-chat__state-panel\s*\{[^}]*align-items:\s*center;[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*justify-content:\s*center;[^}]*min-block-size:\s*100%;[^}]*text-align:\s*center;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__detail\s*>\s*\.handrail-chat__state-panel--error\s*\{[^}]*background:\s*color-mix/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__detail[^{}]*\.handrail-chat__state-panel-progress-dot\s*\{[^}]*animation:\s*handrail-chat-state-panel-pulse/s,
  );
  assert.match(
    reducedMotion,
    /\.handrail-chat\s+\.handrail-chat__detail[^{}]*\.handrail-chat__state-panel-progress-dot\s*\{[^}]*animation:\s*none;[^}]*transform:\s*none;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__detail\s*>\s*\.handrail-chat__state-panel\s*\{[^}]*background:\s*Canvas;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__detail\s*>\s*\.handrail-chat__state-panel--error[^{}]*\{[^}]*border-color:\s*Mark;[^}]*color:\s*Mark;/s,
  );
});

test("timeline panes solely own bounded conversation scrolling", async () => {
  const source = await readStylesheet();

  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__detail\s*{[^}]*block-size:\s*100%;[^}]*min-block-size:\s*0;[^}]*overflow:\s*hidden;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation\s*{[^}]*block-size:\s*100%;[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto;[^}]*min-block-size:\s*0;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__main\s*{[^}]*block-size:\s*100%;[^}]*box-sizing:\s*border-box;[^}]*display:\s*grid;[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto;[^}]*min-block-size:\s*0;[^}]*overflow:\s*hidden;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-body\s*{[^}]*block-size:\s*100%;[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*min-block-size:\s*0;[^}]*overflow:\s*hidden;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-body\s*>\s*\.handrail-chat__timeline\s*{[^}]*block-size:\s*100%;[^}]*min-block-size:\s*0;[^}]*overflow:\s*hidden;/s,
  );
  assert.doesNotMatch(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-body\s*>\s*\.handrail-chat__timeline\s*{[^}]*overflow-y:\s*auto;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-body\s*>\s*\.handrail-chat__timeline\s+\.handrail-chat__timeline-viewport\s*{[^}]*flex:\s*1 1 auto;[^}]*min-block-size:\s*0;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__timeline-viewport\s*{[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;[^}]*scrollbar-gutter:\s*stable;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__thread\s*{[^}]*block-size:\s*100%;[^}]*box-sizing:\s*border-box;[^}]*min-block-size:\s*0;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;[^}]*scrollbar-gutter:\s*stable;/s,
  );
  assert.match(
    source,
    /@media\s*\(max-width:\s*63\.999rem\)\s*{\s*\.handrail-chat\s+\.handrail-chat__conversation-body--thread-open\s*{[^}]*grid-template-rows:\s*minmax\(0, 1fr\);[^}]*overflow:\s*hidden;[^}]*}.*?\.handrail-chat\s+\.handrail-chat__conversation-body--thread-open\s*>\s*\.handrail-chat__thread\s*{[^}]*margin-block-start:\s*0;[^}]*padding-block-start:\s*0;/s,
  );
  assert.doesNotMatch(
    source,
    /@media\s*\(max-width:\s*63\.999rem\)\s*{\s*\.handrail-chat\s+\.handrail-chat__conversation-body--thread-open\s*{[^}]*overflow-y:\s*auto;/s,
  );
  assert.match(
    source,
    /@media\s*\(min-width:\s*64rem\)\s*{\s*\.handrail-chat\s+\.handrail-chat__conversation-body--thread-open\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(20rem, 26rem\);/s,
  );
  assert.match(
    source,
    /\.handrail-chat__conversation-body--thread-open\s*>\s*\.handrail-chat__thread\s*{[^}]*border-inline-start:[^}]*margin-block-start:\s*0;[^}]*padding-block-start:\s*0;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__member-management-panel\s*>\s*\.handrail-chat__member-management\s*{[^}]*min-block-size:\s*0;[^}]*overflow-y:\s*auto;/s,
  );
});

test("the conversation header separates shrinkable identity from bounded, non-wrapping actions", async () => {
  const source = await readStylesheet();
  const forcedColors = source.slice(source.lastIndexOf("@media (forced-colors: active)"));

  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation\s*{[^}]*container-type:\s*inline-size;[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto;[^}]*min-inline-size:\s*0;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__header\s*{[^}]*background:\s*var\(--hr-chat-color-conversation-background,[^}]*border-block-end:[^}]*var\(--hr-chat-color-border-subtle,[^}]*block-size:\s*3\.25rem;[^}]*box-shadow:\s*var\(--hr-chat-shadow-sm,[^}]*display:\s*flex;[^}]*gap:\s*var\(--hr-chat-space-2,[^}]*padding:\s*var\(--hr-chat-space-1,/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__header-identity\s*{[^}]*display:\s*flex;[^}]*flex:\s*1 1 auto;[^}]*min-inline-size:\s*0;[^}]*overflow:\s*hidden;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__header-actions\s*{[^}]*display:\s*flex;[^}]*flex:\s*none;[^}]*flex-wrap:\s*nowrap;[^}]*min-inline-size:\s*0;[^}]*white-space:\s*nowrap;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__channel-title\s*{[^}]*line-height:\s*1\.25;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__header-identity\s*>\s*\.handrail-chat__timeline-avatar\s*{[^}]*align-self:\s*center;[^}]*block-size:\s*1\.75rem;[^}]*inline-size:\s*1\.75rem;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__header-identity\s*>\s*\.handrail-chat__user\s*{[^}]*max-inline-size:\s*min\(14rem, 35%\);[^}]*min-inline-size:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__notification-preferences-panel\s*{[^}]*box-sizing:\s*border-box;[^}]*inline-size:\s*min\(22rem, calc\(100cqi - var\(--hr-chat-space-6, 2rem\)\)\);/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__member-management-panel\s*{[^}]*inline-size:\s*min\(24rem, 100%\);[^}]*max-inline-size:\s*100%;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\[data-handrail-huddle-controls\]\s+\.handrail-chat__huddle-details\s*{[^}]*box-sizing:\s*border-box;[^}]*inline-size:\s*min\(28rem, calc\(100cqi - var\(--hr-chat-space-6, 2rem\)\)\);/s,
  );
  assert.doesNotMatch(
    source,
    /handrail-chat__(?:notification-preferences-panel|huddle-details)[^{]*{[^}]*inline-size:[^;]*100vw/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__notification-preferences-trigger\s*{[^}]*background:\s*transparent;[^}]*block-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*border-color:\s*transparent;[^}]*inline-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*min-block-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*min-inline-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*padding:\s*0;[^}]*transition:[^}]*var\(--hr-chat-motion-duration-fast,/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__notification-preferences-icon\s*{[^}]*block-size:\s*var\(--hr-chat-icon-size-compact,\s*1rem\);[^}]*inline-size:\s*var\(--hr-chat-icon-size-compact,\s*1rem\);[^}]*pointer-events:\s*none;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__notification-preferences-trigger:is\(\[data-muted="true"\],\s*\[data-notification-level="none"\]\)\s+\.handrail-chat__notification-preferences-icon\s*{[^}]*opacity:\s*0\.72;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__notification-preferences-trigger\[data-read-only="true"\]\s*{[^}]*opacity:\s*0\.72;/s,
  );
  assert.doesNotMatch(
    source,
    /handrail-chat__notification-preferences-trigger::before/,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__notification-preferences-trigger\[aria-expanded="true"\]\s*{[^}]*background:\s*var\(--hr-chat-color-hover-background,[^}]*border-color:\s*var\(--hr-chat-color-border-subtle,[^}]*box-shadow:\s*inset/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__notification-preferences-trigger:not\(:disabled\):not\(\[aria-disabled="true"\]\):active\s*{[^}]*transform:\s*translateY\(1px\);/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__notification-preferences-trigger:focus-visible\s*{[^}]*outline:\s*var\(--hr-chat-focus-width,[^;]+solid var\(--hr-chat-focus-color,[^}]*outline-offset:/s,
  );
  assert.match(
    source,
    /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)\s*{[\s\S]*?\.handrail-chat\s+\.handrail-chat__notification-preferences-trigger:not\(:disabled\):not\(\[aria-disabled="true"\]\):hover\s*{[^}]*background:\s*var\(--hr-chat-color-hover-background,[^}]*border-color:\s*var\(--hr-chat-color-border-subtle,[^}]*color:\s*var\(--hr-chat-color-text,/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__header\s*{[^}]*border-block-end-color:\s*ButtonText;[^}]*box-shadow:\s*none;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__notification-preferences-trigger\[aria-expanded="true"\]\s*{[^}]*background:\s*Highlight;[^}]*border-color:\s*Highlight;[^}]*box-shadow:\s*none;[^}]*color:\s*HighlightText;[^}]*forced-color-adjust:\s*none;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__notification-preferences-trigger:focus-visible\s*{[^}]*outline-color:\s*Highlight;/s,
  );
});

test("the conversation navigation keeps dense hover, focus, selection, and forced-color states scoped", async () => {
  const source = await readStylesheet();
  const forcedColors = source.slice(source.lastIndexOf("@media (forced-colors: active)"));

  assert.doesNotMatch(
    source,
    /data-conversation-section=["']starred["']/,
    "Starred reuses the same dense, responsive section and row styles as every projection",
  );

  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__navigation\s*{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;[^}]*scrollbar-gutter:\s*stable;[^}]*scrollbar-width:\s*thin;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-sections\s*{[^}]*display:\s*grid;[^}]*gap:\s*var\(--hr-chat-space-3,[^}]*margin-block-start:\s*var\(--hr-chat-space-2,[^}]*min-inline-size:\s*0;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-section\s*{[^}]*display:\s*grid;[^}]*gap:\s*var\(--hr-chat-space-1,[^}]*min-inline-size:\s*0;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-section-heading\s*{[^}]*color:\s*var\(--hr-chat-color-navigation-text-muted,[^}]*font-size:\s*var\(--hr-chat-font-size-xs,[^}]*font-weight:\s*var\(--hr-chat-font-weight-strong,[^}]*text-transform:\s*uppercase;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-list\s*{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*list-style:\s*none;[^}]*margin:\s*0;[^}]*padding:\s*0;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-button\s*{[^}]*min-block-size:\s*2rem;[^}]*padding:[^}]*padding-inline-start:\s*calc\(\s*var\(--hr-chat-space-3,\s*0\.75rem\)\s*\+\s*var\(--hr-chat-space-4,\s*1rem\)\s*\+\s*var\(--hr-chat-space-3,\s*0\.75rem\)\s*\);/s,
    "conversation rows retain the compact 32px minimum and visibly nest below section headings",
  );
  assert.match(
    source,
    /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)\s*{[\s\S]*?\.handrail-chat\s+\.handrail-chat__conversation-button:not\(:disabled\):not\(\[aria-disabled="true"\]\):not\(\[aria-current="page"\]\):hover\s*{[^}]*background:\s*var\(--hr-chat-color-navigation-hover-background,/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-button\[aria-current="page"\]\s*{[^}]*background:\s*var\(--hr-chat-color-selected-background,[^}]*border-color:\s*var\(--hr-chat-color-selected-background,[^}]*color:\s*var\(--hr-chat-color-selected-text,/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-button:focus-visible\s*{[^}]*outline:\s*var\(--hr-chat-focus-width,[^;]+solid var\(--hr-chat-focus-color,[^}]*position:\s*relative;[^}]*z-index:\s*1;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-icon\s*{[^}]*color:\s*var\(--hr-chat-color-navigation-text-muted,[^}]*display:\s*inline-flex;[^}]*flex:\s*none;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__navigation-icon\s*{[^}]*block-size:\s*var\(--hr-chat-icon-size-compact,\s*1rem\);[^}]*color:\s*currentColor;[^}]*display:\s*block;[^}]*flex:\s*none;[^}]*inline-size:\s*var\(--hr-chat-icon-size-compact,\s*1rem\);[^}]*stroke:\s*currentColor;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-unread-badge\s*{[^}]*background:\s*var\(--hr-chat-color-accent,[^}]*display:\s*inline-flex;[^}]*flex:\s*none;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-mention-badge\s*{[^}]*background:\s*var\(--hr-chat-color-mention-background,[^}]*color:\s*var\(--hr-chat-color-mention-text,[^}]*display:\s*inline-flex;[^}]*flex:\s*none;[^}]*max-inline-size:\s*3rem;[^}]*overflow:\s*hidden;[^}]*white-space:\s*nowrap;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-button\[aria-current="page"\]\s+\.handrail-chat__conversation-mention-badge\s*{[^}]*box-shadow:\s*inset[^}]*var\(--hr-chat-color-selected-text,/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-load-more-button\[aria-busy="true"\]\s*{[^}]*cursor:\s*wait;[^}]*opacity:/s,
  );
  assert.match(
    source,
    /@media\s*\(pointer:\s*coarse\)\s*{[\s\S]*?\.handrail-chat\s+\.handrail-chat__conversation-button,[^}]*\.handrail-chat\s+\.handrail-chat__conversation-load-more-button\s*{[^}]*min-block-size:\s*2\.75rem;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__navigation\s*{[^}]*scrollbar-color:\s*auto;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__navigation-icon\s*{[^}]*color:\s*currentColor;[^}]*forced-color-adjust:\s*auto;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__conversation-button\[aria-current="page"\]\s*{[^}]*background:\s*Highlight;[^}]*border-color:\s*Highlight;[^}]*color:\s*HighlightText;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__conversation-unread-badge,[^}]*\.handrail-chat\s+\.handrail-chat__conversation-mention-badge,[^}]*\.handrail-chat\s+\.handrail-chat__conversation-button\[aria-current="page"\]\s+\.handrail-chat__conversation-unread-badge,[^}]*\.handrail-chat\s+\.handrail-chat__conversation-button\[aria-current="page"\]\s+\.handrail-chat__conversation-mention-badge\s*{[^}]*background:\s*Highlight;[^}]*box-shadow:\s*none;[^}]*color:\s*HighlightText;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__conversation-button:focus-visible,[^}]*\.handrail-chat\s+\.handrail-chat__conversation-load-more-button:focus-visible\s*{[^}]*outline-color:\s*Highlight;/s,
  );
});

test("conversation rows reserve only the star action and render a passive mute indicator", async () => {
  const source = await readStylesheet();
  const hoverStart = source.indexOf("@media (hover: hover) and (pointer: fine)");
  const coarseStart = source.indexOf("@media (pointer: coarse)", hoverStart);
  const preferenceStart = source.indexOf("@media (prefers-color-scheme: dark)", coarseStart);
  const coarsePointer = source.slice(coarseStart, preferenceStart);
  const forcedColors = source.slice(source.lastIndexOf("@media (forced-colors: active)"));

  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-item\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;[^}]*min-block-size:\s*2rem;[^}]*min-inline-size:\s*0;[^}]*position:\s*relative;/s,
    "the host-scoped row reserves only the compact star action",
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-star\s*\{[^}]*align-items:\s*center;[^}]*block-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*grid-column:\s*2;[^}]*grid-row:\s*1;[^}]*inline-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*min-block-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*min-inline-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-star-icon\s*\{[^}]*fill:\s*none;[^}]*pointer-events:\s*none;[^}]*stroke:\s*currentColor;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-star\[aria-pressed="true"\]\s+\.handrail-chat__conversation-star-icon\s*\{[^}]*fill:\s*currentColor;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-star:focus-visible\s*\{[^}]*outline:\s*var\(--hr-chat-focus-width,[^;]+solid var\(--hr-chat-focus-color,[^}]*outline-offset:/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-star:disabled\s*\{[^}]*cursor:\s*not-allowed;[^}]*opacity:\s*0\.5;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-muted-indicator\s*\{[^}]*color:\s*var\(--hr-chat-color-navigation-text-muted,[^}]*display:\s*inline-flex;[^}]*flex:\s*none;[^}]*inline-size:\s*1rem;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-muted-indicator\s*>\s*svg\s*\{[^}]*block-size:\s*0\.875rem;[^}]*inline-size:\s*0\.875rem;/s,
  );
  assert.doesNotMatch(
    source,
    /handrail-chat__conversation-notification-preferences/,
    "navigation rows do not retain an editable notification or mute selector",
  );
  assert.match(
    coarsePointer,
    /\.handrail-chat\s+\.handrail-chat__member-management-trigger,\s*\.handrail-chat\s+\.handrail-chat__conversation-star,\s*\.handrail-chat\s+\.handrail-chat__notification-preferences-trigger\s*\{[^}]*block-size:\s*2\.75rem;[^}]*inline-size:\s*2\.75rem;[^}]*min-block-size:\s*2\.75rem;[^}]*min-inline-size:\s*2\.75rem;/s,
    "coarse pointers retain visible 44px row-action targets",
  );
  assert.match(
    coarsePointer,
    /\.handrail-chat\s+\.handrail-chat__conversation-item,\s*\.handrail-chat\s+\.handrail-chat__conversation-star\s*\{[^}]*min-block-size:\s*2\.75rem;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__conversation-star\s*\{[^}]*background:\s*Canvas;[^}]*border-color:\s*ButtonText;[^}]*color:\s*ButtonText;[^}]*forced-color-adjust:\s*none;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__conversation-star\[aria-pressed="true"\]\s*\{[^}]*background:\s*Highlight;[^}]*border-color:\s*Highlight;[^}]*color:\s*HighlightText;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__conversation-star:focus-visible\s*\{[^}]*outline-color:\s*Highlight;/s,
  );
});

test("the conversation filter positions a quiet currentColor icon without weakening focus or forced colors", async () => {
  const source = await readStylesheet();
  const forcedColors = source.slice(source.lastIndexOf("@media (forced-colors: active)"));

  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-filter\s*{[^}]*display:\s*block;[^}]*inline-size:\s*100%;[^}]*position:\s*relative;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-filter-icon\s*{[^}]*block-size:\s*var\(--hr-chat-icon-size-compact,\s*1rem\);[^}]*color:\s*var\(--hr-chat-color-navigation-text-muted,[^}]*inline-size:\s*var\(--hr-chat-icon-size-compact,\s*1rem\);[^}]*inset-block-start:\s*50%;[^}]*inset-inline-start:\s*calc\([^}]*pointer-events:\s*none;[^}]*position:\s*absolute;[^}]*stroke:\s*currentColor;[^}]*transform:\s*translateY\(-50%\);/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-filter-input\s*{[^}]*border:[^}]*var\(--hr-chat-color-border-subtle,[^}]*min-block-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*padding-block:[^}]*padding-inline-end:\s*calc\(var\(--hr-chat-icon-size-compact,[^}]*padding-inline-start:\s*calc\(var\(--hr-chat-icon-size-compact,/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-filter-input::placeholder\s*{[^}]*color:\s*var\(--hr-chat-color-navigation-text-muted,[^}]*opacity:\s*0\.75;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__conversation-filter-input:focus-visible\s*{[^}]*border-color:\s*var\(--hr-chat-focus-color,[^}]*outline:\s*var\(--hr-chat-focus-width,[^;]+solid var\(--hr-chat-focus-color,[^}]*outline-offset:\s*var\(--hr-chat-focus-offset,/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__conversation-filter-icon\s*{[^}]*color:\s*CanvasText;[^}]*forced-color-adjust:\s*auto;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__conversation-filter-input\s*{[^}]*background:\s*Canvas;[^}]*border-color:\s*ButtonText;[^}]*color:\s*CanvasText;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__conversation-filter-input:focus-visible\s*{[^}]*border-color:\s*Highlight;[^}]*outline-color:\s*Highlight;/s,
  );
});

test("message action toolbars reveal on hover or keyboard focus without sticking after pointer clicks", async () => {
  const source = await readStylesheet();
  const hoverStart = source.indexOf("@media (hover: hover) and (pointer: fine)");
  const coarseStart = source.indexOf("@media (pointer: coarse)", hoverStart);
  const preferenceStart = source.indexOf("@media (prefers-color-scheme: dark)", coarseStart);
  const hoverFine = source.slice(hoverStart, coarseStart);
  const coarsePointer = source.slice(coarseStart, preferenceStart);
  const forcedColors = source.slice(source.lastIndexOf("@media (forced-colors: active)"));

  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__timeline-item\s*{[^}]*border-radius:[^}]*position:\s*relative;[^}]*transition:\s*background-color/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__timeline-actions\s*{[^}]*background:\s*var\(--hr-chat-color-surface-action,[^}]*border:[^}]*var\(--hr-chat-color-border-subtle,[^}]*box-shadow:[^}]*position:\s*absolute;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__timeline-actions\s*{[^}]*box-sizing:\s*border-box;[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*inline-size:\s*max-content;[^}]*max-inline-size:\s*calc\(100%\s*-\s*var\(--hr-chat-space-4,\s*1rem\)\);[^}]*min-inline-size:\s*0;/s,
    "the compact toolbar wraps within the message row instead of causing horizontal overflow",
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__timeline-actions\s+\.handrail-chat__timeline-action--icon\s*{[^}]*align-items:\s*center;[^}]*block-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*display:\s*inline-flex;[^}]*inline-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*min-inline-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*padding:\s*0;/s,
    "every direct icon control shares the same compact hit area",
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__timeline-action-icon\s*{[^}]*block-size:\s*var\(--hr-chat-icon-size-compact,\s*1rem\);[^}]*color:\s*currentColor;[^}]*display:\s*block;[^}]*fill:\s*none;[^}]*inline-size:\s*var\(--hr-chat-icon-size-compact,\s*1rem\);[^}]*stroke:\s*currentColor;/s,
    "message action SVGs use the shared 16px currentColor treatment",
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__timeline-actions\s+\.handrail-chat__timeline-action:disabled\s*{[^}]*cursor:\s*not-allowed;[^}]*opacity:\s*0\.45;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__timeline-item-body,\s*\.handrail-chat\s+\.handrail-chat__timeline-message\s*{[^}]*max-inline-size:\s*100%;[^}]*min-inline-size:\s*0;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__timeline-text,\s*\.handrail-chat\s+\.handrail-chat__timeline-tombstone\s*{[^}]*max-inline-size:\s*100%;[^}]*min-inline-size:\s*0;[^}]*overflow-wrap:\s*anywhere;/s,
    "long message content stays inside the timeline column",
  );
  assert.match(
    hoverFine,
    /\.handrail-chat\s+\.handrail-chat__timeline-actions\s*{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;[^}]*transform:\s*translateY\(-0\.25rem\);/s,
  );
  assert.match(
    hoverFine,
    /\.handrail-chat\s+\.handrail-chat__timeline-item--reaction-eligible\s+\.handrail-chat__timeline-reaction-picker-anchor\s*{[^}]*position:\s*absolute;[^}]*z-index:\s*3;/s,
    "the fine-pointer reaction trigger joins the hover toolbar without reserving a blank reactions row",
  );
  assert.match(
    hoverFine,
    /\.handrail-chat\s+\.handrail-chat__timeline-item--reaction-eligible\s+\.handrail-chat__timeline-actions\s*{[^}]*padding-inline-end:\s*calc\(/s,
    "the hover toolbar reserves an inline slot for the overlaid reaction trigger",
  );
  assert.match(
    hoverFine,
    /\.handrail-chat\s+\.handrail-chat__timeline-item:hover\s*{[^}]*background:\s*color-mix/s,
  );
  assert.match(
    hoverFine,
    /\.handrail-chat\s+\.handrail-chat__timeline-item:hover\s+\.handrail-chat__timeline-actions,\s*\.handrail-chat\s+\.handrail-chat__timeline-item:has\(\.handrail-chat__timeline-action:focus-visible\)\s+\.handrail-chat__timeline-actions,\s*\.handrail-chat\s+\.handrail-chat__timeline-actions\[data-actions-expanded="true"\]\s*{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/s,
  );
  assert.doesNotMatch(
    hoverFine,
    /\.handrail-chat__timeline-item:focus-within\s+\.handrail-chat__timeline-(?:actions|reaction-picker-trigger)/s,
    "pointer focus must not pin a previously clicked message toolbar open",
  );
  assert.match(
    hoverFine,
    /\.handrail-chat\s+\.handrail-chat__timeline-reaction-picker-trigger:focus-visible,\s*\.handrail-chat\s+\.handrail-chat__timeline-reaction-picker-anchor\[data-picker-open="true"\]/s,
  );
  assert.match(
    coarsePointer,
    /\.handrail-chat\s+\.handrail-chat__timeline-actions\s*{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;[^}]*position:\s*static;[^}]*transform:\s*none;/s,
  );
  assert.match(
    coarsePointer,
    /\.handrail-chat\s+\.handrail-chat__timeline-actions\s+\.handrail-chat__timeline-action\s*{[^}]*min-block-size:\s*2\.75rem;/s,
  );
  assert.match(
    coarsePointer,
    /\.handrail-chat\s+\.handrail-chat__timeline-actions\s+\.handrail-chat__timeline-action--icon\s*{[^}]*block-size:\s*2\.75rem;[^}]*inline-size:\s*2\.75rem;[^}]*min-inline-size:\s*2\.75rem;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__timeline-actions,\s*\.handrail-chat\s+\.handrail-chat__timeline-actions-overflow-panel\s*{[^}]*background:\s*Canvas;[^}]*border-color:\s*ButtonText;[^}]*box-shadow:\s*none;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__timeline-actions\s+\.handrail-chat__timeline-action:focus-visible\s*{[^}]*outline-color:\s*Highlight;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__timeline-action-icon\s*{[^}]*color:\s*currentColor;[^}]*forced-color-adjust:\s*auto;[^}]*stroke:\s*currentColor;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__timeline-actions\s+\.handrail-chat__timeline-action:disabled\s*{[^}]*color:\s*GrayText;[^}]*opacity:\s*1;/s,
  );
});

test("reaction picker controls use compact currentColor SVGs without narrowing overflow", async () => {
  const source = await readStylesheet();
  const forcedColors = source.slice(source.lastIndexOf("@media (forced-colors: active)"));

  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__timeline-reaction\s*{[^}]*align-items:\s*center;[^}]*display:\s*inline-flex;[^}]*font-size:\s*var\(--hr-chat-font-size-sm,\s*0\.875rem\);[^}]*gap:\s*0\.125rem;[^}]*line-height:\s*1;[^}]*min-block-size:\s*1\.75rem;[^}]*padding:\s*0\.125rem 0\.375rem;/s,
    "reaction aggregates use a compact 28px chip instead of full action sizing",
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__timeline-reaction-picker-icon,\s*\.handrail-chat\s+\.handrail-chat__reaction-picker-close-icon\s*{[^}]*block-size:\s*var\(--hr-chat-icon-size-compact,\s*1rem\);[^}]*color:\s*currentColor;[^}]*display:\s*block;[^}]*fill:\s*none;[^}]*flex:\s*none;[^}]*inline-size:\s*var\(--hr-chat-icon-size-compact,\s*1rem\);[^}]*pointer-events:\s*none;[^}]*stroke:\s*currentColor;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__reaction-picker\s*{[^}]*box-sizing:\s*border-box;[^}]*inline-size:\s*min\(22rem,\s*calc\(100vw\s*-\s*2rem\)\);[^}]*overflow:\s*hidden;/s,
    "the picker remains bounded by the narrow viewport",
  );
  assert.match(
    source,
    /@media\s*\(pointer:\s*coarse\)\s*{[\s\S]*?\.handrail-chat\s+\.handrail-chat__reaction-picker-close,[\s\S]*?\.handrail-chat\s+\.handrail-chat__timeline-reaction-picker-trigger\s*{[^}]*min-inline-size:\s*2\.75rem;[\s\S]*?\.handrail-chat\s+\.handrail-chat__timeline-reaction-picker-trigger\s*{[^}]*min-block-size:\s*2\.75rem;/s,
    "coarse pointers retain the existing 44px hit areas",
  );
  assert.match(
    source,
    /@media\s*\(pointer:\s*coarse\)\s*{[\s\S]*?\.handrail-chat\s+\.handrail-chat__timeline-reaction\s*{[^}]*min-block-size:\s*2\.75rem;/s,
    "reaction chips retain a 44px touch target on coarse pointers",
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__timeline-reaction-picker-icon,\s*\.handrail-chat\s+\.handrail-chat__reaction-picker-close-icon\s*{[^}]*color:\s*currentColor;[^}]*forced-color-adjust:\s*auto;[^}]*stroke:\s*currentColor;/s,
  );
});

test("the thread close control uses a compact currentColor SVG in forced colors", async () => {
  const source = await readStylesheet();
  const forcedColors = source.slice(source.lastIndexOf("@media (forced-colors: active)"));

  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__thread-close-icon\s*{[^}]*block-size:\s*var\(--hr-chat-icon-size-compact,\s*1rem\);[^}]*color:\s*currentColor;[^}]*display:\s*block;[^}]*fill:\s*none;[^}]*inline-size:\s*var\(--hr-chat-icon-size-compact,\s*1rem\);[^}]*pointer-events:\s*none;[^}]*stroke:\s*currentColor;/s,
  );
  assert.doesNotMatch(
    source,
    /\.handrail-chat\s+\.handrail-chat__thread-close\s*{[^}]*font-size:/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__thread-close-icon\s*{[^}]*color:\s*currentColor;[^}]*forced-color-adjust:\s*auto;[^}]*stroke:\s*currentColor;/s,
  );
});

test("the thread conversation keeps its composer outside scrollable controls and history", async () => {
  const source = await readStylesheet();

  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__thread-conversation\s*{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*minmax\(4rem,\s*1fr\) auto auto;[^}]*min-block-size:\s*0;[^}]*overflow-y:\s*auto;/s,
    "the conversation scrolls when controls and composer cannot fit, keeping a usable controls viewport",
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__timeline-viewport\s*{[^}]*overflow-y:\s*auto;/s,
    "the timeline viewport scrolls message history",
  );
});

test("the compact composer keeps focus feedback on its individual controls", async () => {
  const source = await readStylesheet();
  const forcedColors = source.slice(source.lastIndexOf("@media (forced-colors: active)"));

  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__composer-formatting-toolbar\s*\{[^}]*align-items:\s*center;[^}]*border-block-end:[^}]*display:\s*flex;[^}]*gap:\s*0\.125rem;[^}]*overflow-x:\s*auto;[^}]*padding:/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__composer-format\s*\{[^}]*align-items:\s*center;[^}]*background:\s*transparent;[^}]*border:[^}]*transparent;[^}]*cursor:\s*pointer;[^}]*display:\s*inline-flex;[^}]*flex:\s*none;[^}]*inline-size:\s*1\.75rem;[^}]*min-block-size:\s*1\.75rem;[^}]*padding:\s*0;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__composer-format-icon\s*\{[^}]*block-size:\s*1rem;[^}]*display:\s*block;[^}]*inline-size:\s*1rem;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__composer-action\s*\{[^}]*align-items:\s*center;[^}]*block-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*display:\s*inline-flex;[^}]*inline-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*min-block-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*min-inline-size:\s*var\(--hr-chat-control-size-compact,\s*2rem\);[^}]*padding:\s*0;/s,
    "attachment, emoji, and mention actions share a compact 32px target",
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__composer-action-icon\s*\{[^}]*block-size:\s*var\(--hr-chat-icon-size-compact,\s*1rem\);[^}]*color:\s*currentColor;[^}]*display:\s*block;[^}]*fill:\s*none;[^}]*flex:\s*none;[^}]*inline-size:\s*var\(--hr-chat-icon-size-compact,\s*1rem\);[^}]*stroke:\s*currentColor;/s,
  );
  assert.doesNotMatch(source, /handrail-chat__composer-(?:emoji|mention)-glyph/u);
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__composer-format:not\(:disabled\):active\s*\{[^}]*transform:\s*translateY\(1px\);/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__composer-format:focus-visible\s*\{[^}]*outline:[^}]*var\(--hr-chat-focus-color,[^}]*outline-offset:\s*var\(--hr-chat-focus-offset,/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__composer-format:disabled\s*\{[^}]*cursor:\s*not-allowed;[^}]*opacity:\s*0\.55;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__composer-send:not\(:disabled\)\s*\{[^}]*background:\s*var\(--hr-chat-color-accent,[^}]*border-color:\s*var\(--hr-chat-color-accent,[^}]*color:\s*var\(--hr-chat-color-on-accent,/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__composer-toolbar\s*{[^}]*grid-column:\s*1;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__composer-feedback\s*{[^}]*grid-column:\s*2;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__composer-send\s*{[^}]*grid-column:\s*3;[^}]*justify-self:\s*end;/s,
    "the send control stays content-sized when the optional feedback column is empty",
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__composer-send:disabled\s*\{[^}]*background:\s*var\(--hr-chat-color-surface-muted,[^}]*border-color:\s*var\(--hr-chat-color-border,[^}]*box-shadow:\s*none;[^}]*color:\s*var\(--hr-chat-color-text-muted,[^}]*cursor:\s*not-allowed;[^}]*filter:\s*none;[^}]*opacity:\s*0\.65;[^}]*transform:\s*none;/s,
  );
  assert.match(
    source,
    /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)\s*\{[\s\S]*?\.handrail-chat\s+\.handrail-chat__composer-send:not\(:disabled\):hover\s*\{[^}]*box-shadow:/s,
  );
  assert.doesNotMatch(
    source,
    /\.handrail-chat\s+\.handrail-chat__composer-send:disabled:hover\s*\{/s,
  );
  assert.match(
    source,
    /@media\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?\.handrail-chat\s+\.handrail-chat__composer-format\s*\{[^}]*inline-size:\s*2\.75rem;/s,
  );
  assert.match(
    source,
    /@media\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?\.handrail-chat\s+\.handrail-chat__composer-action\s*\{[^}]*inline-size:\s*2\.75rem;[^}]*min-block-size:\s*2\.75rem;[^}]*min-inline-size:\s*2\.75rem;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__composer-format\s*\{[^}]*border-color:\s*ButtonText;[^}]*color:\s*ButtonText;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__composer-action-icon\s*\{[^}]*color:\s*currentColor;[^}]*forced-color-adjust:\s*auto;[^}]*stroke:\s*currentColor;/s,
  );

  const composerRegionRule = source.match(
    /\.handrail-chat\s+\.handrail-chat__composer-region\s*\{([^}]*)\}/s,
  );
  assert.ok(composerRegionRule, "missing the composer region rule");
  assert.match(
    composerRegionRule[1],
    /box-sizing:\s*border-box;\s*inline-size:\s*100%;\s*max-inline-size:\s*100%;\s*min-inline-size:\s*0;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__composer-region\s*{[^}]*border-block-start:[^}]*padding:/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__composer\s*{[^}]*background:\s*var\(--hr-chat-color-surface-composer,[^}]*border:\s*var\(--hr-chat-border-width,[^}]*var\(--hr-chat-color-border-subtle,[^}]*border-radius:[^}]*gap:\s*var\(--hr-chat-space-1,/s,
  );
  assert.doesNotMatch(
    source,
    /\.handrail-chat\s+\.handrail-chat__composer:focus-within\s*{/s,
    "focusing the editor must not highlight the entire composer box",
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__composer-input\s*{[^}]*background:\s*transparent;[^}]*border:\s*0;[^}]*box-sizing:\s*border-box;[^}]*max-block-size:\s*9rem;[^}]*min-block-size:\s*2\.5rem;[^}]*overflow-y:\s*auto;[^}]*resize:\s*none;/s,
  );
  assert.match(
    source,
    /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)\s*{[\s\S]*?\.handrail-chat\s+\.handrail-chat__composer-format:not\(:disabled\):hover,[^}]*\.handrail-chat\s+\.handrail-chat__composer-attach:not\(\[aria-disabled="true"\]\):hover\s*{[^}]*background:\s*var\(--hr-chat-color-hover-background,/s,
  );
  assert.match(
    source,
    /@media\s*\(pointer:\s*coarse\)\s*{[\s\S]*?\.handrail-chat\s+\.handrail-chat__composer-format,[^}]*\.handrail-chat\s+\.handrail-chat__composer-attach,[^}]*\.handrail-chat\s+\.handrail-chat__composer-send,[^}]*\.handrail-chat\s+\.handrail-chat__attachment-action\s*{[^}]*min-block-size:\s*2\.75rem;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__composer\[aria-disabled="true"\]\s*{[^}]*background:\s*var\(--hr-chat-color-surface-muted,/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__composer\[data-read-only="true"\][^{]*{[^}]*cursor:\s*not-allowed;[^}]*opacity:/s,
  );
  assert.doesNotMatch(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__composer:focus-within\s*{/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__composer-send:disabled\s*\{[^}]*background:\s*Canvas;[^}]*border-color:\s*GrayText;[^}]*box-shadow:\s*none;[^}]*color:\s*GrayText;[^}]*forced-color-adjust:\s*none;[^}]*opacity:\s*1;/s,
  );
});

test("the forwarding picker has a compact bounded modal with complete interaction states", async () => {
  const source = await readStylesheet();
  const forcedColors = source.slice(source.lastIndexOf("@media (forced-colors: active)"));

  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__forward-dialog\s*{[^}]*backdrop-filter:\s*blur\(2px\);[^}]*inset:\s*0;[^}]*overflow:\s*auto;[^}]*position:\s*absolute;[^}]*z-index:\s*var\(--hr-chat-layer-overlay,/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__forward-form\s*{[^}]*inline-size:\s*min\(28rem, 100%\);[^}]*max-block-size:\s*min\(34rem, 100%\);[^}]*overflow:\s*hidden;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__forward-preview\s*{[^}]*-webkit-line-clamp:\s*2;[^}]*color:\s*var\(--hr-chat-color-text-muted,[^}]*overflow:\s*hidden;[^}]*overflow-wrap:\s*anywhere;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__forward-destinations\s*{[^}]*max-block-size:\s*min\(16rem, 40vh\);[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;[^}]*scrollbar-gutter:\s*stable;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__forward-choice:focus-within\s*{[^}]*border-color:\s*var\(--hr-chat-focus-color,[^}]*outline:\s*var\(--hr-chat-focus-width,/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__forward-choice:has\(input:checked\)\s*{[^}]*background:\s*color-mix\([^}]*border-color:\s*var\(--hr-chat-color-accent,/s,
  );
  assert.match(
    source,
    /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)\s*{[\s\S]*?\.handrail-chat\s+\.handrail-chat__forward-choice:hover\s*{[^}]*background:\s*var\(--hr-chat-color-surface-muted,/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__forward-action--secondary\s*{[^}]*background:\s*var\(--hr-chat-color-surface-action,[^}]*border-color:\s*var\(--hr-chat-color-border-subtle,[^}]*color:\s*var\(--hr-chat-color-text,/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__forward-action--primary\s*{[^}]*background:\s*var\(--hr-chat-color-accent,[^}]*color:\s*var\(--hr-chat-color-on-accent,/s,
  );
  assert.match(
    source,
    /@media\s*\(pointer:\s*coarse\)\s*{[\s\S]*?\.handrail-chat\s+\.handrail-chat__forward-choice,[^}]*\.handrail-chat\s+\.handrail-chat__forward-action\s*{[^}]*min-block-size:\s*2\.75rem;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__forward-choice\s*{[^}]*transition:[^}]*var\(--hr-chat-motion-duration-fast,/s,
  );
  assert.match(
    source,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*{[^}]*\.handrail-chat\s*{[^}]*--hr-chat-motion-duration-fast:\s*0ms;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__forward-dialog\s*{[^}]*backdrop-filter:\s*none;[^}]*background:\s*Canvas;/s,
  );
  assert.match(
    forcedColors,
    /\.handrail-chat\s+\.handrail-chat__forward-choice:has\(input:checked\)\s*{[^}]*background:\s*Highlight;[^}]*border-color:\s*Highlight;[^}]*color:\s*HighlightText;/s,
  );
});

test("timeline image attachments are constrained without horizontal overflow", async () => {
  const source = await readStylesheet();

  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__timeline-attachment\s*{[^}]*max-inline-size:\s*100%;[^}]*min-inline-size:\s*0;[^}]*overflow:\s*hidden;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__timeline-attachment-preview\s*{[^}]*max-inline-size:\s*min\(100%,\s*32rem\);[^}]*min-inline-size:\s*0;[^}]*overflow:\s*hidden;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__timeline-attachment-image\s*{[^}]*max-block-size:\s*min\(24rem,\s*50vh\);[^}]*max-inline-size:\s*100%;[^}]*object-fit:\s*contain;/s,
  );
  assert.match(
    source,
    /\.handrail-chat\s+\.handrail-chat__timeline-attachment-name\s*{[^}]*max-inline-size:\s*100%;[^}]*overflow-wrap:\s*anywhere;/s,
  );
});
