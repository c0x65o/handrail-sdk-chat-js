import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";

process.env.NODE_ENV = "test";

const { createElement } = await import("react");
const { act, create } = await import("react-test-renderer");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const execFileAsync = promisify(execFile);
const packageRoot = resolve(import.meta.dirname, "..");
const guidePath = resolve(packageRoot, "docs/headless-client-react.md");
const exampleRoot = resolve(packageRoot, "examples/headless-react");
const exampleNames = [
  "provider-owned",
  "external-lifecycle",
  "normalized-persistence",
  "query-actions",
  "thread-receipt",
];

const readGuide = () => readFile(guidePath, "utf8");

const parseContract = (guide) => {
  const serialized = guide.match(
    /<!-- headless-api-contract\s*([\s\S]*?)\s*-->/u,
  )?.[1];
  assert.ok(serialized, "headless API contract marker is missing");
  return JSON.parse(serialized);
};

const extractExample = (guide, name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const marked = guide.match(
    new RegExp(
      `<!-- headless-example:${escaped}:start -->\\s*` +
        "```tsx\\s*\\n([\\s\\S]*?)^```\\s*\\n" +
        `<!-- headless-example:${escaped}:end -->`,
      "mu",
    ),
  )?.[1];
  assert.ok(marked, `marked TSX ${name} example is missing`);
  return marked;
};

const exportedFunctions = (source, fileName) => {
  const names = [...source.matchAll(/^export function ([A-Za-z][A-Za-z0-9]*)/gmu)]
    .map(([, name]) => name);
  assert.ok(names.length > 0, `no exported functions found in ${fileName}`);
  return names;
};

const interfaceMembers = (source, fileName, interfaceName) => {
  const escaped = interfaceName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const body = source.match(
    new RegExp(`export interface ${escaped} \\{([\\s\\S]*?)^\\}`, "mu"),
  )?.[1];
  assert.ok(body, `${interfaceName} was not found in ${fileName}`);
  return [...body.matchAll(/^\s{2}([a-z][A-Za-z0-9]*)(?:<|\(|:)/gmu)]
    .map(([, name]) => name);
};

const collectCodeFiles = async (root) => {
  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["dist", "node_modules"].includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if ([".js", ".jsx", ".mjs", ".ts", ".tsx"].includes(extname(entry.name))) {
        files.push(path);
      }
    }
  };
  await visit(root);
  return files;
};

test("headless guide links resolve inside the repository", async () => {
  const guide = await readGuide();
  const targets = [...guide.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)]
    .map(([, target]) => target.trim().replace(/^<|>$/gu, ""))
    .filter(
      (target) =>
        !target.startsWith("#") &&
        !target.startsWith("/") &&
        !/^[a-z][a-z+.-]*:/iu.test(target),
    );

  assert.ok(targets.length > 0, "headless guide has no repository links");
  for (const target of targets) {
    const linked = resolve(dirname(guidePath), decodeURIComponent(target.split("#", 1)[0]));
    const repositoryRelative = relative(packageRoot, linked);
    assert.equal(
      repositoryRelative.startsWith("..") || isAbsolute(repositoryRelative),
      false,
      `guide link leaves the repository: ${target}`,
    );
    await access(linked);
  }

  const readme = await readFile(resolve(packageRoot, "README.md"), "utf8");
  assert.match(readme, /\(docs\/headless-client-react\.md\)/u);
});

test("marked headless TypeScript and TSX examples compile against public subpaths", async () => {
  const guide = await readGuide();
  const temporaryRoot = await mkdtemp(resolve(packageRoot, ".headless-docs-"));
  const tscPath = resolve(packageRoot, "node_modules/typescript/bin/tsc");

  try {
    const sources = await Promise.all(exampleNames.map(async (name) => {
      const sourcePath = resolve(temporaryRoot, `${name}.tsx`);
      await writeFile(sourcePath, extractExample(guide, name), "utf8");
      return sourcePath;
    }));
    await execFileAsync(
      process.execPath,
      [
        tscPath,
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--exactOptionalPropertyTypes",
        "--skipLibCheck",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--jsx",
        "react-jsx",
        "--lib",
        "ES2022,DOM,DOM.Iterable",
        ...sources,
      ],
      { cwd: packageRoot },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("external lifecycle example observes post-start transitions and cleans up", async () => {
  const guide = await readGuide();
  const source = extractExample(guide, "external-lifecycle");
  const temporaryRoot = await mkdtemp(resolve(packageRoot, ".headless-lifecycle-"));
  const harnessKey = "__handrailExternalLifecycleDocsHarness";
  const outputPath = resolve(temporaryRoot, "external-lifecycle.mjs");
  const events = [];
  const providers = [];
  let lifecycleState = Object.freeze({ state: "idle" });
  let lifecycleListener;
  let renderer;

  const client = {
    get state() {
      return lifecycleState;
    },
    subscribeLifecycle(listener) {
      events.push("subscribe");
      lifecycleListener = listener;
      return () => {
        events.push("unsubscribe");
        if (lifecycleListener === listener) lifecycleListener = undefined;
      };
    },
    start() {
      events.push("start");
      lifecycleState = Object.freeze({ state: "ready" });
      lifecycleListener?.(lifecycleState);
      return Promise.resolve(lifecycleState);
    },
    close() {
      events.push("close");
      lifecycleState = Object.freeze({ state: "idle" });
    },
  };

  assert.doesNotMatch(source, /\b(?:new\s+)?WebSocket\s*\(/u);
  assert.doesNotMatch(
    source,
    /\bon(?:message|open|close|error)\b|\.(?:on|addEventListener)\s*\(\s*["'](?:message|open|close|error)["']/u,
  );

  globalThis[harnessKey] = {
    createClient: () => client,
    renderProvider(receivedClient, children) {
      providers.push(receivedClient);
      return createElement("section", { "data-chat-provider": true }, children);
    },
  };

  try {
    await build({
      absWorkingDir: packageRoot,
      bundle: true,
      external: ["react", "react/jsx-runtime"],
      format: "esm",
      jsx: "automatic",
      outfile: outputPath,
      platform: "node",
      plugins: [{
        name: "external-lifecycle-docs-harness",
        setup(buildApi) {
          buildApi.onResolve(
            { filter: /^@handrail\/chat\/client$/ },
            () => ({ path: "client", namespace: "lifecycle-docs" }),
          );
          buildApi.onResolve(
            { filter: /^@handrail\/chat\/react$/ },
            () => ({ path: "react", namespace: "lifecycle-docs" }),
          );
          buildApi.onLoad(
            { filter: /^client$/, namespace: "lifecycle-docs" },
            () => ({
              contents:
                `export const createChatClient = () => ` +
                `globalThis[${JSON.stringify(harnessKey)}].createClient();`,
              loader: "js",
            }),
          );
          buildApi.onLoad(
            { filter: /^react$/, namespace: "lifecycle-docs" },
            () => ({
              contents:
                `export const ChatProvider = ({ client, children }) => ` +
                `globalThis[${JSON.stringify(harnessKey)}]` +
                `.renderProvider(client, children);`,
              loader: "js",
            }),
          );
        },
      }],
      stdin: {
        contents: source,
        loader: "tsx",
        resolveDir: packageRoot,
        sourcefile: "external-lifecycle.tsx",
      },
    });

    const { ExternallyOwnedChatRoot } = await import(pathToFileURL(outputPath).href);
    await act(async () => {
      renderer = create(createElement(ExternallyOwnedChatRoot, null, "Chat content"));
    });

    assert.deepEqual(events, ["subscribe", "start"]);
    assert.ok(providers.every((providerClient) => providerClient === client));
    assert.deepEqual(renderer.toJSON(), {
      type: "section",
      props: { "data-chat-provider": true },
      children: ["Chat content"],
    });

    await act(async () => {
      lifecycleState = Object.freeze({
        state: "refresh_required",
        reason: "unsupported_protocol",
        message: "Refresh required.",
      });
      lifecycleListener?.(lifecycleState);
    });
    assert.deepEqual(renderer.toJSON(), {
      type: "p",
      props: {},
      children: ["Refresh this page to continue."],
    });

    await act(async () => renderer.unmount());
    assert.deepEqual(events, ["subscribe", "start", "unsubscribe", "close"]);
    assert.equal(lifecycleListener, undefined);
  } finally {
    if (renderer !== undefined) await act(async () => renderer.unmount());
    delete globalThis[harnessKey];
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("normalized persistence guide preserves its public security and lifecycle contract", async () => {
  const [guide, storageSource, clientSource] = await Promise.all([
    readGuide(),
    readFile(resolve(packageRoot, "src/client/application-chat-storage.ts"), "utf8"),
    readFile(resolve(packageRoot, "src/client/create-chat-client.ts"), "utf8"),
  ]);
  const example = extractExample(guide, "normalized-persistence");
  const persistenceSection = guide.match(
    /## Persist normalized state and retained sends[\s\S]*?(?=\n## )/u,
  )?.[0];
  assert.ok(persistenceSection, "normalized persistence section is missing");

  for (const symbol of [
    "ApplicationChatStorageAdapter",
    "createApplicationChatStorage",
    "CreateChatClientConfig",
    "normalizedCachePersistence",
    "getSendMessageQueueState",
    "subscribeSendMessageQueue",
    "cancelQueuedMessage",
  ]) {
    assert.match(
      persistenceSection,
      new RegExp(`\\b${symbol}\\b`, "u"),
      `${symbol} is undocumented`,
    );
  }

  assert.match(
    storageSource,
    /export interface ApplicationChatStorageAdapter/u,
    "documented adapter is no longer public",
  );
  assert.match(
    storageSource,
    /export function createApplicationChatStorage\(/u,
    "documented storage constructor is no longer public",
  );
  assert.match(
    clientSource,
    /readonly normalizedCachePersistence\?: ChatNormalizedCachePersistenceOptions/u,
    "documented client option is no longer public",
  );
  for (const member of [
    "getSendMessageQueueState",
    "subscribeSendMessageQueue",
    "cancelQueuedMessage",
  ]) {
    assert.match(
      clientSource,
      new RegExp(`^  ${member}\\(`, "mu"),
      `documented ChatClient.${member} is no longer public`,
    );
  }

  assert.match(
    persistenceSection,
    /Omitting `normalizedCachePersistence`[\s\S]*memory-only/u,
  );
  assert.match(
    persistenceSection,
    /`tenantId \+ userId \+ deviceId \+ record kind` key/u,
  );
  assert.match(
    example,
    /\[identity\.tenantId, identity\.userId, identity\.deviceId, kind\]/u,
  );
  assert.match(
    persistenceSection,
    /atomically[\s\S]*replace the whole encoded record/u,
  );
  assert.match(
    persistenceSection,
    /persisted clients may run across tabs[\s\S]*whole-record `replace`[\s\S]*alone is insufficient/u,
  );
  assert.match(
    persistenceSection,
    /`compareExchange`[\s\S]*one[\s\S]*exact-key atomic transaction/u,
  );
  assert.match(
    example,
    /compareExchangeAtomically\([\s\S]*expectedValue: string \| null[\s\S]*replacementValue: string \| null[\s\S]*Promise<boolean>/u,
  );
  assert.match(
    example,
    /withExactKeyTransaction\(key, async \(transaction\) =>[\s\S]*transaction\.read\(\)[\s\S]*currentValue !== expectedValue[\s\S]*return false[\s\S]*replacementValue === null[\s\S]*transaction\.remove\(\)[\s\S]*transaction\.replace\(replacementValue\)[\s\S]*return true/u,
  );
  assert.match(
    example,
    /compareExchange: \(identity, kind, expectedValue, replacementValue\) =>[\s\S]*hostRecords\.compareExchangeAtomically\([\s\S]*recordKey\(identity, kind\)[\s\S]*expectedValue[\s\S]*replacementValue/u,
  );
  assert.match(
    example,
    /crossTab:[\s\S]*getSessionFingerprint/u,
  );
  assert.match(persistenceSection, /rejected[\s\S]*removed\/quarantined/u);
  assert.match(
    persistenceSection,
    /re-resolves identity across every `close\(\)`\/`start\(\)` cycle[\s\S]*provider remount/u,
  );
  assert.match(
    persistenceSection,
    /identity[\s\S]*switches[\s\S]*do not[\s\S]*reuse/u,
  );
  assert.match(
    persistenceSection,
    /clearForLogout\(exactTrustedIdentity\)[\s\S]*before discarding/u,
  );
  assert.match(
    persistenceSection,
    /not a shared[\s\S]*cross-device source of truth/u,
  );
  assert.match(persistenceSection, /trusted host\/session boundary/u);
  assert.match(persistenceSection, /Never decode or trust an access-token payload/u);
  assert.match(persistenceSection, /Online startup remains usable/u);
  assert.match(persistenceSection, /static redacted message/u);
  assert.match(persistenceSection, /Hosts must handle adapter durability failures/u);

  for (const excluded of [
    /access and refresh credentials/u,
    /cookies/u,
    /attachment bytes or byte sources/u,
    /upload URLs or temporary preview resources/u,
    /provider descriptors or credentials/u,
  ]) assert.match(persistenceSection, excluded);
});

test("documented hooks and actions exactly match the shipped React source", async () => {
  const [guide, querySource, actionSource] = await Promise.all([
    readGuide(),
    readFile(resolve(packageRoot, "src/react/query-hooks.ts"), "utf8"),
    readFile(resolve(packageRoot, "src/react/action-hooks.ts"), "utf8"),
  ]);
  const contract = parseContract(guide);
  const hooks = exportedFunctions(querySource, "query-hooks.ts")
    .filter((name) => name.startsWith("use"));
  const actions = interfaceMembers(actionSource, "action-hooks.ts", "ChatActions");

  assert.deepEqual(contract.hooks, hooks, "documented hooks drifted from public exports");
  assert.deepEqual(contract.actions, actions, "documented actions drifted from ChatActions");
  for (const name of [...contract.hooks, ...contract.actions]) {
    assert.match(guide, new RegExp(`\\b${name}\\b`, "u"), `${name} is absent from guide prose`);
  }
});

test("headless examples and their browser graph exclude server, UI, raw sockets, and internals", async () => {
  const guide = await readGuide();
  const files = [
    ...await collectCodeFiles(resolve(exampleRoot, "src")),
    ...await collectCodeFiles(resolve(exampleRoot, "test")),
  ];
  const sources = await Promise.all(files.map(async (path) => ({
    path,
    source: await readFile(path, "utf8"),
  })));
  sources.push(...exampleNames.map((name) => ({
    path: `${relative(packageRoot, guidePath)}#${name}`,
    source: extractExample(guide, name),
  })));

  const allowed = new Set(["@handrail/chat/client", "@handrail/chat/react"]);
  for (const { path, source } of sources) {
    for (const match of source.matchAll(
      /(?:from\s+|import\s*\()["'](@handrail\/chat(?:\/[^"']*)?)["']/gu,
    )) {
      assert.ok(allowed.has(match[1]), `disallowed Handrail import ${match[1]} in ${path}`);
    }
    assert.doesNotMatch(source, /\b(?:new\s+)?WebSocket\s*\(/u, `raw socket in ${path}`);
    assert.doesNotMatch(
      source,
      /(?:from\s+|import\s*\()["'](?:\.\.\/){2,}(?:src|dist)\//u,
      `package-internal relative import in ${path}`,
    );
  }

  const result = await build({
    absWorkingDir: packageRoot,
    alias: {
      "@handrail/chat/client": "./src/client/index.ts",
      "@handrail/chat/react": "./src/react/index.ts",
    },
    bundle: true,
    entryPoints: ["examples/headless-react/src/main.tsx"],
    format: "esm",
    metafile: true,
    outdir: ".headless-docs-build",
    platform: "browser",
    write: false,
  });
  const packageInputs = Object.keys(result.metafile.inputs)
    .map((input) => input.replaceAll("\\", "/"));
  assert.ok(packageInputs.some((input) => /src\/react\/index\.ts$/u.test(input)));
  assert.ok(packageInputs.some((input) => /src\/client\/create-chat-client\.ts$/u.test(input)));
  assert.deepEqual(
    packageInputs.filter((input) => /(?:^|\/)src\/(?:server|ui)(?:\/|$)/u.test(input)),
    [],
  );
});
