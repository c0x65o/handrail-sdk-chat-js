import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const workflowPath = resolve(
  root,
  ".github/workflows/postgres-integration.yml",
);

test("PostgreSQL integration workflow preserves the disposable database contract", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /^on:\n  push:\n    branches:\n      - main\n  pull_request:\n\npermissions:/mu,
  );
  assert.match(workflow, /^permissions:\n  contents: read\n\nconcurrency:/mu);
  assert.match(
    workflow,
    /^concurrency:\n  group: postgres-integration-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true\n\njobs:/mu,
  );

  assert.match(workflow, /^    runs-on: ubuntu-latest$/mu);
  const timeout = workflow.match(/^    timeout-minutes: (\d+)$/mu);
  assert.ok(timeout, "the PostgreSQL job must declare a timeout");
  assert.ok(
    Number(timeout[1]) > 0 && Number(timeout[1]) <= 30,
    "the PostgreSQL job timeout must be bounded to 30 minutes",
  );

  assert.match(
    workflow,
    /^    services:\n      postgres:\n        image: postgres:16-alpine$/mu,
  );
  assert.deepEqual(
    [...workflow.matchAll(/^      ([a-z][a-z0-9_-]*):$/gmu)].map(
      (match) => match[1],
    ),
    ["postgres"],
  );
  assert.doesNotMatch(workflow, /^\s+volumes:$/mu);
  assert.match(workflow, /^          POSTGRES_DB: handrail_test$/mu);
  assert.match(workflow, /^          POSTGRES_USER: handrail_test$/mu);
  assert.match(workflow, /^          POSTGRES_PASSWORD: handrail_test$/mu);
  assert.match(workflow, /^          - 5432:5432$/mu);
  assert.match(
    workflow,
    /^          --health-cmd "pg_isready -U handrail_test -d handrail_test"$/mu,
  );
  assert.match(workflow, /^          --health-interval \d+s$/mu);
  assert.match(workflow, /^          --health-timeout \d+s$/mu);
  assert.match(workflow, /^          --health-retries \d+$/mu);

  const testDatabaseUrl = workflow.match(
    /^      TEST_DATABASE_URL: (\S+)$/mu,
  )?.[1];
  assert.equal(
    testDatabaseUrl,
    "postgresql://handrail_test:handrail_test@127.0.0.1:5432/handrail_test",
  );
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./iu);

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
  assert.deepEqual(commands, [
    'pg_isready --dbname "$TEST_DATABASE_URL"',
    "npm ci",
    "npm run test:postgres",
  ]);

  assert.doesNotMatch(
    workflow,
    /\b(?:npm\s+publish|docker\s+(?:build|login|push)|kubectl|helm|terraform|pulumi|migrate|migration|deploy(?:ment)?|production|staging|(?:operator|shared)[\s_-]?(?:database|postgres)|aws\s|az\s|gcloud\s)\b|uses:\s*(?:aws-actions|azure|google-github-actions|cloudflare)\//iu,
  );
});
