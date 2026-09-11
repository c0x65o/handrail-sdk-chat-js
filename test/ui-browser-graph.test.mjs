import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");
const builtIns = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);

test("the public UI graph stays within browser-safe public boundaries", async () => {
  const workspaceSource = await readFile(
    resolve(packageRoot, "src/ui/chat-workspace.ts"),
    "utf8",
  );
  const workspaceImports = [
    ...workspaceSource.matchAll(/from "([^"]+)"/g),
  ].map(([, specifier]) => specifier);
  assert.deepEqual(new Set(workspaceImports), new Set([
    "react",
    "../contracts/index.js",
    "../react/index.js",
    "./direct-conversation-creation.js",
    "./group-direct-conversation-creation.js",
    "./huddle-controls.js",
    "./member-management.js",
    "./message-composer.js",
    "./message-timeline.js",
    "./notification-preferences.js",
    "./reply-style-settings.js",
    "./slots.js",
    "./thread-creation-dialog.js",
    "./thread-list.js",
    "./thread-panel.js",
    "./timeline-window.js",
  ]));
  assert.doesNotMatch(
    workspaceSource,
    /(?:normalized-cache|realtime-session|websocket|socket|\.\.\/client\/)/,
    "ChatWorkspace must consume public React hooks instead of private client internals",
  );
  assert.match(workspaceSource, /useMessageSearch/);
  assert.match(workspaceSource, /from "\.\.\/react\/index\.js"/);
  assert.doesNotMatch(workspaceSource, /dangerouslySetInnerHTML/);

  const composerSource = await readFile(
    resolve(packageRoot, "src/ui/message-composer.ts"),
    "utf8",
  );
  const composerImports = [
    ...composerSource.matchAll(/from "([^"]+)"/g),
  ].map(([, specifier]) => specifier);
  assert.deepEqual(new Set(composerImports), new Set([
    "react",
    "../react/index.js",
    "../contracts/index.js",
    "./reaction-picker.js",
    "./composer-rich-text-editor.js",
    "./composer-rich-text.js",
    "./slots.js",
  ]));
  for (const specifier of composerImports) {
    assert.doesNotMatch(
      specifier,
      /(?:server|testing|normalized-cache|transport|provider|credential|secret|token|node:)/,
      `MessageComposer includes a forbidden import ${specifier}`,
    );
    assert.doesNotMatch(
      specifier,
      /\.\.\/client\//,
      "MessageComposer must integrate through the public React surface",
    );
  }
  assert.doesNotMatch(composerSource, /dangerouslySetInnerHTML/);

  const reactionPickerSource = await readFile(
    resolve(packageRoot, "src/ui/reaction-picker.ts"),
    "utf8",
  );
  const reactionPickerImports = [
    ...reactionPickerSource.matchAll(/from "([^"]+)"/g),
  ].map(([, specifier]) => specifier);
  assert.deepEqual(new Set(reactionPickerImports), new Set(["react"]));
  for (const specifier of reactionPickerImports) {
    assert.doesNotMatch(
      specifier,
      /(?:server|client|contracts|testing|transport|provider|credential|secret|token|node:)/,
      `ReactionPicker includes a forbidden import ${specifier}`,
    );
  }
  const reactionPickerDeclaration = await readFile(
    resolve(packageRoot, "dist/ui/reaction-picker.d.ts"),
    "utf8",
  );
  const reactionPickerDeclarationImports = [
    ...reactionPickerDeclaration.matchAll(/from "([^"]+)"/g),
  ].map(([, specifier]) => specifier);
  assert.deepEqual(new Set(reactionPickerDeclarationImports), new Set(["react"]));

  const composerGraph = await build({
    absWorkingDir: packageRoot,
    bundle: true,
    entryPoints: ["dist/ui/message-composer.js"],
    external: ["react", "../react/index.js"],
    format: "esm",
    metafile: true,
    platform: "browser",
    write: false,
  });
  const composerInputs = Object.keys(composerGraph.metafile.inputs);
  assert.ok(composerInputs.some((input) => /dist\/ui\/message-composer\.js$/.test(input)));
  for (const input of composerInputs) {
    assert.doesNotMatch(
      input,
      /(?:server|testing|normalized-cache|command-dispatcher|attachment-uploader)/,
      `MessageComposer private dependency graph includes ${input}`,
    );
  }

  const declaration = await readFile(
    resolve(packageRoot, "dist/ui/slots.d.ts"),
    "utf8",
  );
  const declarationImports = [
    ...declaration.matchAll(/from "([^"]+)"/g),
  ].map(([, specifier]) => specifier);

  assert.deepEqual(new Set(declarationImports), new Set([
    "react",
    "../client/index.js",
    "../contracts/index.js",
    "../react/index.js",
  ]));

  const result = await build({
    absWorkingDir: packageRoot,
    bundle: true,
    entryPoints: ["dist/ui/index.js"],
    external: ["react"],
    format: "esm",
    metafile: true,
    platform: "browser",
    write: false,
  });

  const inputs = Object.entries(result.metafile.inputs);
  assert.ok(inputs.some(([input]) => /dist\/ui\/slots\.js$/.test(input)));
  assert.ok(inputs.some(([input]) => /dist\/ui\/chat-workspace\.js$/.test(input)));
  assert.ok(inputs.some(([input]) => /dist\/ui\/direct-conversation-creation\.js$/.test(input)));
  assert.ok(inputs.some(([input]) => /dist\/ui\/huddle-controls\.js$/.test(input)));
  assert.ok(inputs.some(([input]) => /dist\/ui\/message-timeline\.js$/.test(input)));
  assert.ok(inputs.some(([input]) => /dist\/ui\/message-composer\.js$/.test(input)));
  assert.ok(inputs.some(([input]) => /dist\/ui\/notification-preferences\.js$/.test(input)));
  assert.ok(inputs.some(([input]) => /dist\/ui\/reaction-picker\.js$/.test(input)));

  for (const [input, metadata] of inputs) {
    assert.doesNotMatch(
      input,
      /(?:^|\/)(?:dist|src)\/(?:server|testing|providers?)(?:\/|$)/,
    );
    assert.doesNotMatch(input, /node_modules\/(?:pg|ws|@testcontainers)(?:\/|$)/);

    for (const imported of metadata.imports) {
      assert.equal(
        builtIns.has(imported.path),
        false,
        `UI graph includes Node built-in ${imported.path}`,
      );
      assert.doesNotMatch(imported.path, /^(?:pg|ws|@testcontainers\/)/);
    }
  }
});
