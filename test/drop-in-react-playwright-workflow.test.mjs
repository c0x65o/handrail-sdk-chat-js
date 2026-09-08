import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const workflowPath = resolve(
  root,
  ".github/workflows/drop-in-react-playwright.yml",
);

const stepBlock = (workflow, name) => {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const next = workflow.indexOf("      - name: ", start + marker.length);
  return workflow.slice(start, next === -1 ? undefined : next);
};

test("drop-in React Playwright workflow preserves the browser gate contract", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /^on:\n  push:\n    branches:\n      - main\n  pull_request:\n\npermissions:/mu,
  );
  assert.match(workflow, /^permissions:\n  contents: read\n\nconcurrency:/mu);
  assert.equal(
    [...workflow.matchAll(/^[ \t]*permissions:$/gmu)].length,
    1,
    "only the workflow-level read permission block may be declared",
  );
  assert.match(
    workflow,
    /^concurrency:\n  group: drop-in-react-playwright-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true\n\njobs:/mu,
  );

  assert.match(workflow, /^    runs-on: ubuntu-latest$/mu);
  const timeout = workflow.match(/^    timeout-minutes: (\d+)$/mu);
  assert.ok(timeout, "the Playwright job must declare a timeout");
  assert.ok(
    Number(timeout[1]) > 0 && Number(timeout[1]) <= 30,
    "the Playwright job timeout must be positive and bounded to 30 minutes",
  );

  assert.deepEqual(
    [...workflow.matchAll(/^        (uses|run): (.+)$/gmu)].map((match) =>
      match.slice(1),
    ),
    [
      ["uses", "actions/checkout@v4"],
      ["uses", "actions/setup-node@v4"],
      ["run", "npm ci --include=dev"],
      ["run", "node scripts/read-flutter-revision.mjs"],
      ["uses", "actions/checkout@v4"],
      ["uses", "subosito/flutter-action@v2"],
      ["run", "npm ci --include=dev"],
      ["run", "npm run build"],
      ["run", "npm run build:flutter:lab"],
      ["run", "npx playwright install --with-deps chromium"],
      ["run", "npm run test:browser -- --workers=1"],
      ["uses", "actions/upload-artifact@v4"],
    ],
    "actions and commands must remain in the required deterministic order",
  );

  const setup = stepBlock(workflow, "Set up Node.js");
  assert.match(setup, /^          node-version: 22$/mu);
  assert.match(setup, /^          cache: npm$/mu);
  assert.match(
    setup,
    /^          cache-dependency-path: \|\n            package-lock\.json\n            examples\/drop-in-react\/package-lock\.json$/mu,
  );

  const rootInstall = stepBlock(workflow, "Install root dependencies");
  assert.match(rootInstall, /^        run: npm ci --include=dev$/mu);
  assert.doesNotMatch(rootInstall, /working-directory:/u);

  const exampleInstall = stepBlock(
    workflow,
    "Install drop-in React dependencies",
  );
  assert.match(exampleInstall, /^        run: npm ci --include=dev$/mu);
  assert.match(
    exampleInstall,
    /^        working-directory: examples\/drop-in-react$/mu,
  );

  const build = stepBlock(workflow, "Build package");
  assert.match(build, /^        run: npm run build$/mu);
  assert.doesNotMatch(build, /working-directory:/u);
  assert.equal(
    [...workflow.matchAll(/^        run: npm run build$/gmu)].length,
    1,
    "the root package must be built exactly once",
  );

  const browserInstall = stepBlock(workflow, "Install locked Chromium browser");
  assert.match(
    browserInstall,
    /^        run: npx playwright install --with-deps chromium$/mu,
  );
  assert.match(
    browserInstall,
    /^        working-directory: examples\/drop-in-react$/mu,
  );

  const browserTest = stepBlock(workflow, "Run drop-in React browser journeys");
  assert.match(browserTest, /^        id: browser-tests$/mu);
  assert.match(
    browserTest,
    /^        run: npm run test:browser -- --workers=1$/mu,
  );
  assert.match(
    browserTest,
    /^        working-directory: examples\/drop-in-react$/mu,
  );

  const artifact = stepBlock(workflow, "Upload Playwright failure artifacts");
  assert.match(
    artifact,
    /^        if: failure\(\) && steps\.browser-tests\.outcome == 'failure'$/mu,
  );
  assert.match(artifact, /^        uses: actions\/upload-artifact@v4$/mu);
  assert.match(
    artifact,
    /^          path: \|\n            examples\/drop-in-react\/test-results\/playwright\n            examples\/drop-in-react\/playwright-report$/mu,
  );
  const retention = artifact.match(/^          retention-days: (\d+)$/mu);
  assert.ok(retention, "failure artifacts must declare a retention period");
  assert.ok(
    Number(retention[1]) > 0 && Number(retention[1]) <= 5,
    "failure artifact retention must be short and no more than five days",
  );

  assert.doesNotMatch(workflow, /^\s*services:$/mu);
  assert.match(workflow, /^      HANDRAIL_CHAT_FLUTTER_ROOT: \$\{\{ github.workspace \}\}\/\.sdk-peers\/flutter$/mu);
  const peerCheckout = stepBlock(workflow, "Check out matching Flutter SDK");
  assert.match(peerCheckout, /^          repository: c0x65o\/handrail-sdk-chat-flutter$/mu);
  assert.match(peerCheckout, /^          ref: \$\{\{ steps.flutter-revision.outputs.revision \}\}$/mu);
  assert.match(peerCheckout, /^          path: \.sdk-peers\/flutter$/mu);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./iu);
  assert.doesNotMatch(workflow, /^\s*continue-on-error:/mu);
  assert.doesNotMatch(
    workflow,
    /--update-snapshots?|--updateSnapshot|\bnpx\s+playwright\s+test\b[^\n]*\s-u(?:\s|$)/iu,
  );
  assert.doesNotMatch(
    workflow,
    /\b(?:providers?|credentials?|postgres(?:ql)?|mysql|mariadb|databases?|docker|compose|npm\s+publish|releases?|migrat(?:e|ions?)|deploy(?:ments?)?|production|staging|kubectl|helm|terraform|pulumi|serverless|flyctl|vercel|netlify|cloudformation|curl|wget)\b|uses:\s*(?:aws-actions|azure|google-github-actions|cloudflare)\//iu,
  );
});
