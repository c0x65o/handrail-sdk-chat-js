import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createChatTestHarness, createPostgresTestBackend } from "../dist/testing/index.js";
import { createChatLabDatabaseHarness, selectChatLabDatabase } from "../examples/drop-in-react/scripts/chat-lab-database.mjs";

// Only the container service boundary is intercepted. The actual lower-layer
// recovery code must construct its own errors; no database or Docker is touched.
test("container startup recovery retains both failures and the lab redacts them", async t => {
  const startup = new Error("postgresql://private-user:private-password@private-host/lab");
  const cleanup = new Error("private-container-stop-secret");
  let starts = 0;
  let stops = 0;
  t.mock.method(PostgreSqlContainer.prototype, "start", async () => {
    starts++;
    return {
      getConnectionUri() { throw startup; },
      async stop() { stops++; throw cleanup; },
    };
  });
  await assert.rejects(createPostgresTestBackend({ testDatabaseUrl: "" }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0].cause, startup);
    assert.equal(error.errors[1], cleanup);
    return true;
  });
  await assert.rejects(createChatLabDatabaseHarness(createChatTestHarness,
    selectChatLabDatabase({}, {}), { testDatabaseUrl: "" }), error => {
    assert.match(error.message, /selection=container-default.*cleanup also failed/);
    assert.ok(!inspect(error).includes("private-"));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(starts, 2);
  assert.equal(stops, 2);
});

test("successful startup recovery preserves the original cause without a false cleanup failure", async t => {
  const startup = new Error("fixture startup failure");
  let stops = 0;
  t.mock.method(PostgreSqlContainer.prototype, "start", async () => ({
    getConnectionUri() { throw startup; },
    async stop() { stops++; },
  }));
  await assert.rejects(createPostgresTestBackend({ testDatabaseUrl: "" }), error => {
    assert.equal(error.cause, startup);
    assert.ok(!(error instanceof AggregateError));
    return true;
  });
  assert.equal(stops, 1);
});

test("failure before acquisition never stops an unrelated container", async t => {
  const startup = new Error("fixture acquisition failure");
  t.mock.method(PostgreSqlContainer.prototype, "start", async () => { throw startup; });
  await assert.rejects(createPostgresTestBackend({ testDatabaseUrl: "" }), error => {
    assert.equal(error.cause, startup);
    assert.ok(!(error instanceof AggregateError));
    return true;
  });
});
