import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { createRequire } from "node:module";
import { startChatLab } from "../scripts/chat-lab.mjs";

const { Pool } = createRequire(import.meta.url)("pg");
const databaseUrl = process.env.CHAT_LAB_DATABASE_CHECK_URL;
assert.ok(databaseUrl, "Use scripts/verify-chat-lab-database.mjs with its private PostgreSQL 16 cluster");

const listen = server => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

test("installed lab starts on the selected private database and releases its schema and listener", async () => {
  const admin = new Pool({ connectionString: databaseUrl });
  let lab;
  try {
    await admin.query("CREATE SCHEMA unowned_sentinel");
    const before = (await admin.query("SELECT count(*)::int AS count FROM pg_namespace")).rows[0].count;
    // A database-only URL must retain its database and inherit private PG*.
    const selected = "postgresql:///postgres";
    lab = await startChatLab({ databaseUrl: selected, seedProfile: "reply-styles", port: 0 });
    assert.equal(lab.harness.connectionString, selected);
    assert.equal((await lab.harness.pool.query("SELECT current_database() AS name")).rows[0].name, "postgres");
    assert.equal(lab.seedProfile, "reply-styles");
    const schema = lab.harness.schema;
    const port = new URL(lab.origin).port;
    await Promise.all([lab.close(), lab.close()]);
    lab = undefined;
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM pg_namespace")).rows[0].count, before);
    assert.equal((await admin.query("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS found", [schema])).rows[0].found, false);
    // Rebinding proves the disposable listener was released; no HTTP/browser probe.
    const rebound = net.createServer();
    await new Promise((resolve, reject) => { rebound.once("error", reject); rebound.listen(Number(port), "127.0.0.1", resolve); });
    await close(rebound);
    assert.equal((await admin.query("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='unowned_sentinel') AS found")).rows[0].found, true);
  } finally {
    await lab?.close();
    await admin.query("DROP SCHEMA IF EXISTS unowned_sentinel");
    await admin.end();
  }
});

test("a refused explicit endpoint fails visibly despite a working lower-priority test database", async () => {
  const reservation = net.createServer();
  await listen(reservation);
  const port = reservation.address().port;
  await close(reservation);
  await assert.rejects(startChatLab({
    databaseUrl: `postgresql://handrail_test@127.0.0.1:${port}/postgres`, port: 0,
  }), /selection=options.databaseUrl, code=ECONNREFUSED.*no fallback attempted/);
});

test("missing selected database is diagnosed without redirecting to the existing database", async () => {
  const missing = new URL(databaseUrl);
  missing.pathname = "/missing_lab_database";
  await assert.rejects(startChatLab({ databaseUrl: missing.href, port: 0 }),
    /selection=options.databaseUrl, code=3D000.*no fallback attempted/);
});

test("failure after database initialization drops only the owned lab schema", async () => {
  const blocker = net.createServer();
  const admin = new Pool({ connectionString: databaseUrl });
  try {
    await listen(blocker);
    const before = (await admin.query("SELECT nspname FROM pg_namespace ORDER BY nspname")).rows;
    await assert.rejects(startChatLab({ databaseUrl, port: blocker.address().port }), /already in use/);
    assert.deepEqual((await admin.query("SELECT nspname FROM pg_namespace ORDER BY nspname")).rows, before);
    assert.equal(blocker.listening, true);
  } finally {
    await close(blocker);
    await admin.end();
  }
});
