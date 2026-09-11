import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import { createRequire } from "node:module";
import { createChatLabDatabaseHarness, selectChatLabDatabase } from "../scripts/chat-lab-database.mjs";
import { startChatLabWithFlutter } from "../scripts/chat-lab-startup.mjs";

test("database precedence preserves the exact explicit URL, including database-only PG settings", () => {
  const env = { CHAT_LAB_DATABASE_URL: "postgresql:///lab", TEST_DATABASE_URL: "postgresql:///test", DATABASE_URL: "postgresql:///app" };
  assert.deepEqual(selectChatLabDatabase({ databaseUrl: "postgresql:///option" }, env),
    { source: "options.databaseUrl", databaseUrl: "postgresql:///option" });
  for (const source of Object.keys(env)) {
    assert.deepEqual(selectChatLabDatabase({}, env), { source, databaseUrl: env[source] });
    delete env[source];
  }
  assert.deepEqual(selectChatLabDatabase({}, env), { source: "container-default", databaseUrl: undefined });
});

test("invalid explicit selections fail without using a lower-priority URL or container", () => {
  for (const invalid of ["", "  ", 42, "password-bearing-invalid-url", "https://example.test/db",
    "postgres:garbage", "postgres:", "postgresql:garbage", "postgresql:", "postgres:/lab"]) {
    for (const source of ["options.databaseUrl", "CHAT_LAB_DATABASE_URL", "TEST_DATABASE_URL", "DATABASE_URL"]) {
      const env = { DATABASE_URL: "postgresql:///lower" };
      const options = source === "options.databaseUrl" ? { databaseUrl: invalid } : {};
      if (source !== "options.databaseUrl") env[source] = invalid;
      assert.throws(() => selectChatLabDatabase(options, env), error => {
        assert.ok(error.message.includes(source));
        assert.match(error.message, /no fallback attempted/);
        assert.ok(!error.message.includes("password-bearing"));
        return true;
      });
    }
  }
});

test("opaque selections never invoke the harness, even with a valid fallback", async () => {
  let calls = 0;
  for (const databaseUrl of ["postgres:garbage", "postgres:"]) {
    await assert.rejects(async () => createChatLabDatabaseHarness(async () => {
      calls++;
    }, selectChatLabDatabase({ databaseUrl }, { TEST_DATABASE_URL: "postgresql:///lower" }), {}),
    /valid PostgreSQL URL.*no fallback attempted/);
  }
  assert.equal(calls, 0);
});

test("accepted PostgreSQL URI forms retain downstream pg connection parameters", () => {
  // Use the lab's installed driver parser, without connecting or reading its env.
  const { Client } = createRequire(import.meta.url)("pg");
  const defaults = {
    PGHOST: "/private/disposable-socket", PGPORT: "5437", PGUSER: "fixture_user",
    PGPASSWORD: "fixture_password", PGDATABASE: "fixture_default", PGSSLMODE: "disable",
  };
  const saved = new Map(Object.keys(defaults).map(key => [key, process.env[key]]));
  Object.assign(process.env, defaults);
  try {
    for (const [url, expected] of [
      ["postgresql:///lab", [defaults.PGHOST, 5437, "fixture_user", "fixture_password", "lab"]],
      ["postgres://", [defaults.PGHOST, 5437, "fixture_user", "fixture_password", "fixture_default"]],
      ["postgresql://localhost", ["localhost", 5437, "fixture_user", "fixture_password", "fixture_default"]],
      ["postgres://user:password@localhost:5433/lab", ["localhost", 5433, "user", "password", "lab"]],
      ["postgresql://user:pa%40ss@[::1]:5434/lab", ["[::1]", 5434, "user", "pa@ss", "lab"]],
      ["postgresql://%2Fprivate%2Fsocket/lab", ["/private/socket", 5437, "fixture_user", "fixture_password", "lab"]],
      ["postgresql:///lab?host=%2Fprivate%2Fsocket&port=5438&user=query_user", ["/private/socket", 5438, "query_user", "fixture_password", "lab"]],
    ]) {
      const selection = selectChatLabDatabase({ databaseUrl: url }, {});
      assert.equal(selection.databaseUrl, url);
      const parsed = new Client({ connectionString: selection.databaseUrl }).connectionParameters;
      assert.deepEqual([parsed.host, parsed.port, parsed.user, parsed.password, parsed.database], expected);
    }
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("failed initialization calls one selected harness and redacts driver errors and causes", async () => {
  const url = "postgresql://private-user:private-password@localhost:1234/lab?password=query-secret";
  const selection = selectChatLabDatabase({ databaseUrl: url }, {});
  for (const code of ["ECONNREFUSED", "28P01", "3D000", "42501", "private-code"]) {
    let calls = 0;
    await assert.rejects(createChatLabDatabaseHarness(async options => {
      calls++;
      assert.equal(options.testDatabaseUrl, url);
      throw Object.assign(new Error(url, { cause: new Error("private-cause") }), { code });
    }, selection, { schemaPrefix: "handrail_chat_lab" }), error => {
      assert.match(error.message, /selection=options.databaseUrl/);
      assert.match(error.message, /no fallback attempted/);
      assert.ok(!inspect(error).includes("private-"));
      assert.ok(!inspect(error).includes("query-secret"));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("cleanup failures remain visible without exposing nested driver details", async () => {
  await assert.rejects(createChatLabDatabaseHarness(async () => {
    throw new AggregateError([new Error("private-password")], "private-url");
  }, selectChatLabDatabase({}, {}), {}), error => {
    assert.match(error.message, /selection=container-default/);
    assert.match(error.message, /cleanup also failed/);
    assert.ok(!inspect(error).includes("private-"));
    return true;
  });
});

test("successful harness and teardown ownership pass through unchanged", async () => {
  const harness = { teardown() {} };
  assert.equal(await createChatLabDatabaseHarness(async options => {
    assert.deepEqual(options, { schemaPrefix: "handrail_chat_lab" });
    return harness;
  }, selectChatLabDatabase({}, {}), { schemaPrefix: "handrail_chat_lab" }), harness);
});

test("failed lab startup never launches the Flutter build child", async () => {
  let builds = 0;
  await assert.rejects(startChatLabWithFlutter(async () => {
    throw new Error("database unavailable");
  }, async () => { builds++; }), /database unavailable/);
  assert.equal(builds, 0);
});

test("Flutter readiness follows successful lab startup and preserves build failure", async () => {
  for (const fail of [false, true]) {
    const order = [];
    let hostReady;
    const lab = { close() {} };
    const started = await startChatLabWithFlutter(async ({ flutterReady }) => {
      hostReady = flutterReady;
      order.push("lab");
      return lab;
    }, async () => {
      order.push("flutter");
      if (fail) throw new Error("build failed");
      return "build provenance";
    });
    assert.equal(started.lab, lab);
    assert.equal(started.flutterReady, hostReady);
    if (fail) await assert.rejects(hostReady, /build failed/);
    else assert.equal(await hostReady, "build provenance");
    assert.deepEqual(order, ["lab", "flutter"]);
  }
});
