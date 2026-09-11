import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import net from "node:net";
import test, { mock } from "node:test";
import { startChatLabBackend } from "../scripts/chat-lab-backend.mjs";

const { Pool } = createRequire(import.meta.url)("pg");
const databaseUrl = process.env.CHAT_LAB_DATABASE_CHECK_URL;
assert.ok(databaseUrl, "Run with the private unprivileged PG16 verification runner");
let ownedBackend;
let listenFailure;
let closeCalls;
let host;
const closeFailure = new Error("fixture Vite close failure");
mock.module("../scripts/chat-lab-backend.mjs", { namedExports: {
  startChatLabBackend: async options => ownedBackend = await startChatLabBackend(options),
} });
mock.module("vite", { namedExports: {
  createServer: async () => {
    host = new EventEmitter();
    host.address = () => ({ port: 12345 });
    return {
      httpServer: host,
      async listen() { if (listenFailure) throw listenFailure; },
      async close() { closeCalls++; throw closeFailure; },
    };
  },
} });
const { startChatLab } = await import("../scripts/chat-lab.mjs");

for (const duringStartup of [false, true]) {
  test(`Vite close failure releases real owned schema and backend listener (${duringStartup ? "startup failure" : "normal close"})`, async () => {
    const admin = new Pool({ connectionString: databaseUrl });
    ownedBackend = undefined;
    closeCalls = 0;
    listenFailure = duringStartup ? new Error("fixture Vite listen failure") : undefined;
    try {
      await admin.query("CREATE SCHEMA cleanup_unowned_sentinel");
      await admin.query("CREATE TABLE cleanup_unowned_sentinel.marker (value text)");
      await admin.query("INSERT INTO cleanup_unowned_sentinel.marker VALUES ('preserve')");
      const before = (await admin.query("SELECT nspname FROM pg_namespace ORDER BY nspname")).rows;
      // Exercise real pg parsing, schema creation/migration and fixture startup
      // with a database-only URI and the runner's explicit private PG defaults.
      const options = { databaseUrl: "postgresql:///postgres", seedProfile: "reply-styles", port: 0 };
      if (duringStartup) {
        await assert.rejects(startChatLab(options), error => {
          assert.ok(error instanceof AggregateError);
          assert.deepEqual(error.errors, [listenFailure, closeFailure]);
          return true;
        });
      } else {
        const lab = await startChatLab(options);
        assert.equal(lab.harness.connectionString, options.databaseUrl);
        assert.equal((await lab.harness.pool.query("SELECT current_database() AS name")).rows[0].name, "postgres");
        const first = lab.close();
        assert.equal(lab.close(), first);
        await assert.rejects(first, error => error === closeFailure);
        await assert.rejects(lab.close(), error => error === closeFailure);
      }
      assert.equal(closeCalls, 1);
      assert.equal(host.listenerCount("upgrade"), 0, "owned media handler detached");
      assert.deepEqual((await admin.query("SELECT nspname FROM pg_namespace ORDER BY nspname")).rows, before);
      assert.deepEqual((await admin.query("SELECT value FROM cleanup_unowned_sentinel.marker")).rows, [{ value: "preserve" }]);
      // Rebinding the acquired backend's port proves its real listener closed.
      // No browser or HTTP probe, and no listener is created for mocked Vite.
      const rebound = net.createServer();
      try {
        await new Promise((resolve, reject) => {
          rebound.once("error", reject);
          rebound.listen(Number(new URL(ownedBackend.harness.endpoint).port), "127.0.0.1", resolve);
        });
      } finally {
        if (rebound.listening) await new Promise((resolve, reject) => rebound.close(error => error ? reject(error) : resolve()));
      }
    } finally {
      // Rescue only the harness acquired by this test if a regression leaks it.
      try { await ownedBackend?.harness.teardown(); }
      finally {
        try { await admin.query("DROP SCHEMA IF EXISTS cleanup_unowned_sentinel CASCADE"); }
        finally { await admin.end(); }
      }
    }
  });
}
