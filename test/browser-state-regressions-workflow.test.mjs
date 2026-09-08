import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const workflowPath = resolve(
  root,
  ".github/workflows/browser-state-regressions.yml",
);

const criticalTests = [
  "test/client-conversation-lifecycle.test.mjs",
  "test/client-canonical-state-persistence.test.mjs",
  "test/client-offline-send-message-queue.test.mjs",
  "test/client-durable-send-dispatch.test.mjs",
  "test/client-offline-send-recovery.test.mjs",
  "test/cross-tab-coordinator.test.mjs",
  "test/client-browser-graph.test.mjs",
  "test/ui-browser-graph.test.mjs",
];

test("browser state regression workflow preserves the focused CI gate contract", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /^on:\n  push:\n    branches:\n      - main\n  pull_request:\n\npermissions:/mu,
  );
  assert.match(workflow, /^permissions:\n  contents: read\n\nconcurrency:/mu);
  assert.match(
    workflow,
    /^concurrency:\n  group: browser-state-regressions-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true\n\njobs:/mu,
  );

  assert.match(workflow, /^    runs-on: ubuntu-latest$/mu);
  const timeout = workflow.match(/^    timeout-minutes: (\d+)$/mu);
  assert.ok(timeout, "the browser state job must declare a timeout");
  assert.ok(
    Number(timeout[1]) > 0 && Number(timeout[1]) <= 30,
    "the browser state job timeout must be bounded to 30 minutes",
  );

  const actions = [...workflow.matchAll(/^        uses: (.+)$/gmu)].map(
    (match) => match[1],
  );
  assert.deepEqual(actions, ["actions/checkout@v4", "actions/setup-node@v4"]);
  assert.match(workflow, /^          node-version: 22$/mu);
  assert.match(workflow, /^          cache: npm$/mu);
  assert.match(
    workflow,
    /^          cache-dependency-path: package-lock\.json$/mu,
  );

  const commands = [...workflow.matchAll(/^        run: (.+)$/gmu)].map(
    (match) => match[1],
  );
  assert.deepEqual(commands.slice(0, 2), ["npm ci", "npm run build"]);
  assert.equal(
    commands.filter((command) => command === "npm run build").length,
    1,
    "the package must be built exactly once",
  );

  const testCommands = commands.filter((command) =>
    command.startsWith("node --test "),
  );
  assert.equal(testCommands.length, 1, "tests must run in one node --test command");
  assert.deepEqual(testCommands[0].split(/\s+/u).slice(2), criticalTests);
  assert.deepEqual(commands, ["npm ci", "npm run build", testCommands[0]]);

  assert.doesNotMatch(workflow, /^\s*(?:services|env):$/mu);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./iu);
  assert.doesNotMatch(workflow, /^\s*continue-on-error:/mu);
  assert.doesNotMatch(
    workflow,
    /\b(?:postgres(?:ql)?|database|docker|flutter|dart|npm\s+publish|release|migrate|migration|deploy(?:ment)?|production|staging|kubectl|helm|terraform|pulumi|serverless|flyctl|vercel|netlify)\b|uses:\s*(?:aws-actions|azure|google-github-actions|cloudflare)\//iu,
  );
});
