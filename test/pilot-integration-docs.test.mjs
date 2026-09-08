import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const guidePath = resolve(root, "docs/pilot-integration.md");

test("pilot guide links stay in the repository and README exposes it", async () => {
  const guide = await readFile(guidePath, "utf8");
  for (const [, targetValue] of guide.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
    const target = targetValue.trim().replace(/^<|>$/gu, "");
    if (target.startsWith("#") || /^[a-z][a-z+.-]*:/iu.test(target)) continue;
    const linked = resolve(dirname(guidePath), decodeURIComponent(target.split("#", 1)[0]));
    const repositoryRelative = relative(root, linked);
    assert.equal(
      repositoryRelative.startsWith("..") || isAbsolute(repositoryRelative),
      false,
      `pilot guide link leaves the repository: ${target}`,
    );
    await access(linked);
  }
  assert.match(await readFile(resolve(root, "README.md"), "utf8"), /docs\/pilot-integration\.md/u);
});

test("pilot guide keeps framework, lifecycle, feature, and deferral boundaries explicit", async () => {
  const guide = (await readFile(guidePath, "utf8")).replace(/\s+/gu, " ");
  for (const required of [
    "Vite is the build tool, not the UI framework.",
    "No standards-based custom element/Web Component is shipped.",
    "full-screen`, `side-panel`, `modal`, and `record`",
    "The host owns the portal, backdrop, and open state",
    "responds to `ChatWorkspace`'s close-request callback by changing mode or unmounting.",
    "`ChatWorkspace` owns root-local initial focus, Tab/Shift+Tab containment",
    "requests dismissal through that callback for an unhandled Escape",
    "restores captured opener focus only when the opener remains connected and focus still belongs to the workspace.",
    "A pop-out is a host-created browser window",
    "same-tenant, two-actor direct-message flow",
    "Storage includes `verifyObject`",
    "not broad Slack parity",
    "handrail-sdk-chat-flutter",
  ]) {
    assert.ok(guide.includes(required), `missing pilot boundary: ${required}`);
  }
  assert.doesNotMatch(
    guide,
    /\bhost (?:owns|must implement|implements|is responsible for)[^.]{0,160}\b(?:focus trap(?:ping)?(?:\/return)?|focus return|focus restoration)\b/iu,
  );
  assert.doesNotMatch(guide, /@handrail\/chat\/(?:src|dist)/u);
});

test("pilot guide documents the implemented authorized message-search boundary", async () => {
  const guide = (await readFile(guidePath, "utf8")).replace(/\s+/gu, " ");
  for (const required of [
    "Message/content search",
    "PostgreSQL-backed `POST /messages/search`",
    "headless TypeScript `searchMessages` API",
    "React `useMessageSearch` hook and `ChatWorkspace`",
    "Flutter client/workspace search surfaces",
    "chat-workspace-customization.md#message-search-and-result-routing",
    "normalized, nonblank queries",
    "page sizes from 1 through 100",
    "opaque cursors bounded to 2,048 characters",
    "trusted authentication",
    "permission-adapter authorization for entity-backed conversations",
    "host-controlled feature gating",
  ]) {
    assert.ok(guide.includes(required), `missing message-search boundary: ${required}`);
  }

  assert.doesNotMatch(
    guide,
    /Message\/content search \| Not built into the server in this release/iu,
  );
  assert.doesNotMatch(
    guide,
    /\b(?:Elasticsearch|OpenSearch|Algolia)\b|\b(?:external|third-party|pluggable) search providers?\b|\b(?:alternative|custom|pluggable) indexing\b/iu,
  );
});
