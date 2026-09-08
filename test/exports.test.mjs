import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { execFile } from "node:child_process";
import {
  access,
  readFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builtInSpecifiers = new Set([
  ...builtinModules,
  ...builtinModules.map((specifier) => `node:${specifier}`),
]);
const nodeBuiltInImportPattern =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](?:node:)?(?:fs|path|http|https|net|tls|crypto|stream)(?:\/[^"']*)?["']/;
const getBundledSource = (result) =>
  result.outputFiles
    .filter((output) => !output.path.endsWith(".map"))
    .map((output) => output.text)
    .join("\n");
const getFencedBlocks = (markdown) =>
  [...markdown.matchAll(/^```([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm)].map(
    ([, info, source]) => ({ info: info.trim(), source }),
  );
const getPackageSpecifier = (packageName, exportKey) =>
  exportKey === "." ? packageName : `${packageName}${exportKey.slice(1)}`;

test("README relative links point to repository files", async () => {
  const readme = await readFile(resolve(packageRoot, "README.md"), "utf8");
  const relativeLinks = [...readme.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)]
    .map(([, target]) => target.trim().replace(/^<|>$/g, ""))
    .filter(
      (target) =>
        !target.startsWith("#") &&
        !target.startsWith("/") &&
        !/^[a-z][a-z+.-]*:/i.test(target),
    );

  assert.ok(relativeLinks.length > 0, "README has no relative links");

  for (const link of relativeLinks) {
    const path = decodeURIComponent(link.split("#", 1)[0]);
    const linkedFile = resolve(packageRoot, path);
    const repositoryRelativePath = relative(packageRoot, linkedFile);

    assert.equal(
      repositoryRelativePath.startsWith("..") ||
        isAbsolute(repositoryRelativePath),
      false,
      `README link leaves the repository: ${link}`,
    );
    await access(linkedFile);
  }
});

test("README dependency and import snippets track the package manifest", async () => {
  const [readme, packageJsonSource] = await Promise.all([
    readFile(resolve(packageRoot, "README.md"), "utf8"),
    readFile(resolve(packageRoot, "package.json"), "utf8"),
  ]);
  const packageJson = JSON.parse(packageJsonSource);
  const fencedBlocks = getFencedBlocks(readme);
  const dependencyBlocks = fencedBlocks.filter(
    ({ info, source }) =>
      info.split(/\s+/, 1)[0] === "json" &&
      source.includes('"dependencies"'),
  );
  const installBlocks = fencedBlocks.filter(
    ({ info, source }) =>
      /^(?:sh|shell|bash)(?:\s|$)/.test(info) &&
      /\b(?:npm|pnpm|yarn)\b[^\n]*@handrail\/chat/.test(source),
  );

  assert.equal(
    dependencyBlocks.length + installBlocks.length,
    1,
    "README must contain one consumer dependency/install snippet",
  );

  for (const { source } of dependencyBlocks) {
    const snippet = JSON.parse(source);
    assert.deepEqual(Object.entries(snippet.dependencies ?? {}), [
      [packageJson.name, packageJson.version],
    ]);
  }

  for (const { source } of installBlocks) {
    assert.equal(
      [...source.matchAll(/@handrail\/chat@([^\s"']+)/g)].length,
      1,
      "install snippet must contain exactly one versioned package",
    );
    assert.ok(source.includes(packageJson.name + "@git+https://github.com/c0x65o/handrail-sdk-chat-js.git#${HANDRAIL_CHAT_JS_SHA}"));
  }

  const documentedImports = new Set(
    fencedBlocks.flatMap(({ source }) =>
      [...source.matchAll(/(?:\bfrom\s+|\bimport\s+)["'](@handrail\/chat(?:\/[^"']+)?)['"]/g)]
        .map(([, specifier]) => specifier),
    ),
  );
  const manifestSpecifiers = Object.keys(packageJson.exports).map((exportKey) =>
    getPackageSpecifier(packageJson.name, exportKey),
  );

  assert.deepEqual(
    [...documentedImports].sort(),
    [...manifestSpecifiers].sort(),
    "README import snippets must cover every public package export",
  );

  for (const specifier of documentedImports) {
    const exportKey =
      specifier === packageJson.name
        ? "."
        : `.${specifier.slice(packageJson.name.length)}`;

    assert.ok(
      Object.hasOwn(packageJson.exports, exportKey),
      `README import is not exported: ${specifier}`,
    );
    assert.doesNotThrow(() => import.meta.resolve(specifier));
  }

  assert.doesNotMatch(
    readme,
    /@handrail\/chat-(?:core|server|react|ui|media)\b/,
    "README must not recommend independently versioned package names",
  );
});

test("README platform and realtime claims remain source-backed", async () => {
  const [readme, packageJsonSource, testingSource, rootModule] = await Promise.all([
    readFile(resolve(packageRoot, "README.md"), "utf8"),
    readFile(resolve(packageRoot, "package.json"), "utf8"),
    readFile(resolve(packageRoot, "src/testing/index.ts"), "utf8"),
    import("@handrail/chat"),
  ]);
  const packageJson = JSON.parse(packageJsonSource);
  const containerImage = testingSource.match(
    /const DEFAULT_CONTAINER_IMAGE = "([^"]+)"/,
  )?.[1];

  assert.ok(containerImage, "testing source does not declare its default image");
  assert.ok(readme.includes(`\`${packageJson.engines.node}\``));
  assert.ok(readme.includes(`\`${packageJson.peerDependencies.react}\``));
  assert.ok(readme.includes("`TEST_DATABASE_URL`"));
  assert.ok(readme.includes(`\`${containerImage}\``));
  assert.ok(readme.includes(rootModule.CHAT_REFRESH_REQUIRED_MESSAGE));
  assert.match(readme, /current protocol and its immediately previous\s+version/);
  assert.match(readme, /replay cursor has expired[\s\S]*fresh snapshot/);
});

test("built public subpaths resolve and import independently", async () => {
  const expectedEntries = {
    client: "dist/client/index.js",
    react: "dist/react/index.js",
    server: "dist/server/index.js",
    testing: "dist/testing/index.js",
    ui: "dist/ui/index.js",
  };

  for (const [subpath, expectedEntry] of Object.entries(expectedEntries)) {
    const resolvedUrl = import.meta.resolve(`@handrail/chat/${subpath}`);
    assert.equal(fileURLToPath(resolvedUrl), resolve(packageRoot, expectedEntry));
    const loadedModule = await import(`@handrail/chat/${subpath}`);
    assert.equal(typeof loadedModule, "object");
  }

  assert.deepEqual(
    Object.keys(await import("@handrail/chat/testing")),
    [
      "createChatTestHarness",
      "createPostgresTestBackend",
      "createPostgresTestHarness",
    ],
  );
  const clientModule = await import("@handrail/chat/client");
  assert.equal(typeof clientModule.createApplicationChatStorage, "function");
  const serverModule = await import("@handrail/chat/server");
  assert.equal(
    typeof serverModule.createChatAttachmentCleanupDispatcher,
    "function",
  );
  assert.equal(
    typeof serverModule.ChatAttachmentCleanupProviderError,
    "function",
  );
  assert.equal(
    typeof serverModule.ChatAttachmentCleanupDispatcherError,
    "function",
  );
  assert.equal(
    typeof serverModule.normalizeChatAttachmentCleanupDispatcherOptions,
    "function",
  );
  assert.equal(
    typeof serverModule.DEFAULT_CHAT_ATTACHMENT_CLEANUP_MAX_ATTEMPTS,
    "number",
  );
  assert.equal(typeof serverModule.createChatAuditDispatcher, "function");
  assert.equal(typeof serverModule.ChatAuditDeliveryError, "function");
  assert.equal(typeof serverModule.ChatAuditDispatcherError, "function");
  assert.equal(typeof serverModule.createChatNotificationDispatcher, "function");
  assert.equal(typeof serverModule.createChatNotificationDeliveryId, "function");
  assert.equal(typeof serverModule.ChatNotificationDeliveryError, "function");
  assert.equal(typeof serverModule.createChatOutboxPublisher, "function");
  assert.equal(typeof serverModule.createLocalChatRealtimeHub, "function");
  assert.equal(typeof serverModule.createPostgresMigrationRunner, "function");
  assert.equal(
    typeof serverModule.PostgresMigrationIncompatibilityError,
    "function",
  );

  const stylesheetUrl = import.meta.resolve("@handrail/chat/ui/styles.css");
  assert.equal(
    fileURLToPath(stylesheetUrl),
    resolve(packageRoot, "dist/ui/styles.css"),
  );
});

test("package conditions expose only browser-safe entries to browser resolvers", async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8"),
  );

  assert.equal(packageJson.exports["./client"].browser, "./dist/client/index.js");
  assert.equal(packageJson.exports["./react"].browser, "./dist/react/index.js");
  assert.equal(packageJson.exports["./ui"].browser, "./dist/ui/index.js");
  assert.equal(
    packageJson.exports["./ui/styles.css"],
    "./dist/ui/styles.css",
  );
  assert.deepEqual(packageJson.sideEffects, ["./dist/ui/styles.css"]);
  assert.equal(
    packageJson.exports["./testing"].import,
    "./dist/testing/index.js",
  );
  assert.equal(packageJson.exports["./server"].browser, undefined);
  assert.equal(packageJson.exports["./server"].import, undefined);
  assert.equal(packageJson.exports["./server"].default, undefined);
  assert.equal(
    packageJson.exports["./server"].node.import,
    "./dist/server/index.js",
  );
});

test("a browser resolver rejects the Node-only server subpath", async () => {
  await assert.rejects(
    build({
      absWorkingDir: packageRoot,
      bundle: true,
      format: "esm",
      logLevel: "silent",
      platform: "browser",
      stdin: {
        contents: 'import "@handrail/chat/server";',
        loader: "js",
        resolveDir: packageRoot,
        sourcefile: "browser-server.js",
      },
      write: false,
    }),
    /Could not resolve "@handrail\/chat\/server"/,
  );
});

test("each subpath emits runtime, declaration, and map artifacts", async () => {
  for (const subpath of ["client", "react", "server", "testing", "ui"]) {
    const artifactBase = resolve(packageRoot, "dist", subpath, "index");

    await Promise.all([
      access(`${artifactBase}.js`),
      access(`${artifactBase}.js.map`),
      access(`${artifactBase}.d.ts`),
      access(`${artifactBase}.d.ts.map`),
    ]);
  }

  await access(resolve(packageRoot, "dist/ui/styles.css"));
});

test("TypeScript resolves declarations for every public subpath", async () => {
  const tscPath = resolve(packageRoot, "node_modules/typescript/bin/tsc");

  await execFileAsync(
    process.execPath,
    [
      tscPath,
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      resolve(packageRoot, "test/fixtures/declarations.ts"),
    ],
    { cwd: packageRoot },
  );
});

test("the browser client bundle excludes testing, server, and Node graphs", async () => {
  const result = await build({
    absWorkingDir: packageRoot,
    bundle: true,
    entryPoints: ["test/fixtures/browser-client.ts"],
    format: "esm",
    metafile: true,
    platform: "browser",
    sourcemap: true,
    write: false,
  });

  const inputs = Object.entries(result.metafile.inputs);
  assert.ok(
    inputs.some(([input]) => /dist\/client\/index\.js$/.test(input)),
    "the browser build did not resolve the built client entry",
  );

  for (const [input, metadata] of inputs) {
    assert.doesNotMatch(input, /(?:^|\/)(?:dist|src)\/server(?:\/|$)/);
    assert.doesNotMatch(input, /(?:^|\/)(?:dist|src)\/testing(?:\/|$)/);
    assert.doesNotMatch(input, /(?:^|\/)ui\/styles\.css$/);

    for (const imported of metadata.imports) {
      assert.equal(
        builtInSpecifiers.has(imported.path),
        false,
        `browser graph includes Node built-in ${imported.path}`,
      );
    }
  }

  const bundledSource = getBundledSource(result);
  assert.doesNotMatch(
    bundledSource,
    nodeBuiltInImportPattern,
  );
});

test("the root JavaScript bundle excludes the optional stylesheet", async () => {
  const result = await build({
    absWorkingDir: packageRoot,
    bundle: true,
    entryPoints: ["dist/index.js"],
    format: "esm",
    metafile: true,
    platform: "browser",
    write: false,
  });

  assert.ok(
    Object.keys(result.metafile.inputs).some((input) =>
      /dist\/index\.js$/.test(input),
    ),
    "the browser build did not resolve the package root entry",
  );
  for (const input of Object.keys(result.metafile.inputs)) {
    assert.doesNotMatch(input, /(?:^|\/)ui\/styles\.css$/);
  }
});

test("the production server bundle excludes the testing graph", async () => {
  const result = await build({
    absWorkingDir: packageRoot,
    bundle: true,
    entryPoints: ["dist/server/index.js"],
    format: "esm",
    metafile: true,
    platform: "node",
    sourcemap: true,
    write: false,
  });

  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(
    inputs.some((input) => /dist\/server\/index\.js$/.test(input)),
    "the Node build did not resolve the built server entry",
  );

  for (const input of inputs) {
    assert.doesNotMatch(input, /(?:^|\/)(?:dist|src)\/testing(?:\/|$)/);
    assert.doesNotMatch(input, /(?:^|\/)ui\/styles\.css$/);
  }
});

test("an explicit stylesheet import emits CSS and remains in the bundle graph", async () => {
  const result = await build({
    absWorkingDir: packageRoot,
    bundle: true,
    format: "esm",
    logLevel: "silent",
    metafile: true,
    outdir: resolve(packageRoot, ".test-output"),
    platform: "browser",
    stdin: {
      contents: 'import "@handrail/chat/ui/styles.css";',
      loader: "js",
      resolveDir: packageRoot,
      sourcefile: "explicit-ui-styles.js",
    },
    write: false,
  });

  assert.ok(
    Object.keys(result.metafile.inputs).some((input) =>
      /dist\/ui\/styles\.css$/.test(input),
    ),
    "the explicit CSS import was removed from the bundle graph",
  );
  const cssOutput = result.outputFiles.find((output) =>
    output.path.endsWith(".css"),
  );
  assert.ok(cssOutput, "the explicit CSS import did not emit a stylesheet");
  assert.match(cssOutput.text, /\.handrail-chat/);
});

for (const browserSurface of ["react", "ui"]) {
  test(`the browser ${browserSurface} bundle excludes React, server, testing, and Node graphs`, async () => {
    const result = await build({
      absWorkingDir: packageRoot,
      bundle: true,
      entryPoints: [`test/fixtures/browser-${browserSurface}.ts`],
      external: ["react"],
      format: "esm",
      metafile: true,
      platform: "browser",
      sourcemap: true,
      write: false,
    });

    const inputs = Object.entries(result.metafile.inputs);
    assert.ok(
      inputs.some(([input]) =>
        new RegExp(`dist/${browserSurface}/index\\.js$`).test(input),
      ),
      `the browser build did not resolve the built ${browserSurface} entry`,
    );
    assert.equal(
      inputs.some(([input]) => /node_modules\/react(?:\/|$)/.test(input)),
      false,
      "the host-provided React runtime was bundled into the SDK graph",
    );

    for (const [input, metadata] of inputs) {
      assert.doesNotMatch(
        input,
        /(?:^|\/)(?:dist|src)\/(?:server|testing)(?:\/|$)/,
      );
      assert.doesNotMatch(input, /(?:^|\/)ui\/styles\.css$/);

      for (const imported of metadata.imports) {
        assert.equal(
          builtInSpecifiers.has(imported.path),
          false,
          `browser graph includes Node built-in ${imported.path}`,
        );
      }
    }

    const bundledSource = getBundledSource(result);
    assert.match(bundledSource, /from \"react\"/);
    assert.doesNotMatch(
      bundledSource,
      nodeBuiltInImportPattern,
    );
  });
}
