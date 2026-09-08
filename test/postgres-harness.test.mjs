import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresTestBackend } from "@handrail/chat/testing";

test("PostgreSQL harness isolates and removes suite schemas", async () => {
  const backend = await createPostgresTestBackend();
  const backendLabel =
    backend.kind === "url-backed" ? "URL-backed" : "container-backed";
  console.info(`PostgreSQL harness backend: ${backendLabel} PostgreSQL`);

  let first;
  let second;

  try {
    [first, second] = await Promise.all([
      backend.createHarness({ schemaPrefix: "handrail_selftest" }),
      backend.createHarness({ schemaPrefix: "handrail_selftest" }),
    ]);

    assert.notEqual(first.schema, second.schema);
    assert.equal(await backend.schemaExists(first.schema), true);
    assert.equal(await backend.schemaExists(second.schema), true);

    await Promise.all([
      first.pool.query(
        "CREATE TABLE harness_items (id integer PRIMARY KEY, label text NOT NULL)",
      ),
      second.pool.query(
        "CREATE TABLE harness_items (id integer PRIMARY KEY, label text NOT NULL)",
      ),
    ]);
    await Promise.all([
      first.pool.query(
        "INSERT INTO harness_items (id, label) VALUES ($1, $2)",
        [1, "first-schema"],
      ),
      second.pool.query(
        "INSERT INTO harness_items (id, label) VALUES ($1, $2)",
        [1, "second-schema"],
      ),
    ]);

    const [firstRows, secondRows] = await Promise.all([
      first.pool.query("SELECT id, label FROM harness_items ORDER BY id"),
      second.pool.query("SELECT id, label FROM harness_items ORDER BY id"),
    ]);
    assert.deepEqual(firstRows.rows, [{ id: 1, label: "first-schema" }]);
    assert.deepEqual(secondRows.rows, [{ id: 1, label: "second-schema" }]);

    await first.pool.query("CREATE TABLE first_schema_only (id integer)");
    const [firstObject, leakedObject] = await Promise.all([
      first.pool.query(
        "SELECT to_regclass('first_schema_only')::text AS table_name",
      ),
      second.pool.query(
        "SELECT to_regclass('first_schema_only')::text AS table_name",
      ),
    ]);
    assert.equal(firstObject.rows[0]?.table_name, "first_schema_only");
    assert.equal(leakedObject.rows[0]?.table_name, null);

    const firstSchema = first.schema;
    const secondSchema = second.schema;
    await Promise.all([first.teardown(), second.teardown()]);
    await Promise.all([first.teardown(), second.teardown()]);

    assert.equal(await backend.schemaExists(firstSchema), false);
    assert.equal(await backend.schemaExists(secondSchema), false);
  } finally {
    await Promise.allSettled([first?.teardown(), second?.teardown()]);
    await backend.teardown();
  }
});
