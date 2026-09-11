import assert from "node:assert/strict";
import test, { mock } from "node:test";

// Resource-boundary failure injection exercises startChatLab itself without
// starting listeners, Docker, Flutter or a database. Real schema cleanup is
// checked separately in ChatLabCleanupPostgres.test.mjs.
let fixture;
mock.module("vite", { namedExports: {
  createServer: async () => {
    if (fixture.failCreate) throw fixture.startupError;
    return {
      httpServer: { address: () => fixture.badAddress ? null : { port: 12345 } },
      async listen() { if (fixture.failListen) throw fixture.startupError; },
      async close() {
        fixture.calls.push("vite");
        if (fixture.viteError) throw fixture.viteError;
      },
    };
  },
} });
mock.module("../scripts/chat-lab-webrtc-server.mjs", { namedExports: {
  createChatLabWebRtcServer: () => ({
    adapter: {},
    attach() { if (fixture.failAttach) throw fixture.startupError; },
    async close() {
      fixture.calls.push("media");
      if (fixture.mediaError) throw fixture.mediaError;
    },
  }),
} });
mock.module("../scripts/chat-lab-backend.mjs", { namedExports: {
  startChatLabBackend: async ({ storage }) => {
    fixture.storage = storage;
    if (fixture.failBackend) throw fixture.startupError;
    return { harness: {
      endpoint: "http://127.0.0.1:12346",
      async teardown() {
        fixture.calls.push("database");
        if (fixture.databaseError) throw fixture.databaseError;
      },
    } };
  },
} });
const { startChatLab } = await import("../scripts/chat-lab.mjs");

const setup = overrides => fixture = {
  calls: [], startupError: new Error("fixture startup failed"), ...overrides,
};
const flatten = error => error instanceof AggregateError ? error.errors.flatMap(flatten) : [error];
const storageClosed = () => assert.throws(() => fixture.storage.setOrigin("http://127.0.0.1:12345"), /closed/);

test("normal close attempts every resource once and shares success or failure", async () => {
  for (const failures of [[], ["vite"], ["media"], ["database"], ["media", "vite", "database"]]) {
    setup(Object.fromEntries(failures.map(name => [`${name}Error`, new Error(`${name} close failed`)])));
    const lab = await startChatLab({ port: 0 });
    const first = lab.close();
    assert.equal(lab.close(), first);
    if (failures.length) {
      await assert.rejects(first, error => {
        assert.deepEqual(flatten(error), failures.map(name => fixture[`${name}Error`]));
        return true;
      });
    } else await first;
    assert.equal(lab.close(), first);
    assert.deepEqual(fixture.calls, ["media", "vite", "database"]);
    storageClosed();
  }
});

test("startup failures retain their cause and all cleanup failures at every acquisition stage", async () => {
  for (const stage of ["failBackend", "failCreate", "failAttach", "failListen", "badAddress", "badOrigin"]) {
    setup({ [stage]: true, mediaError: new Error("media close failed"),
      viteError: new Error("vite close failed"), databaseError: new Error("database close failed") });
    await assert.rejects(startChatLab({ port: 0, ...(stage === "badOrigin" ? { host: "example.test" } : {}) }), error => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /startup failed and cleanup also failed/);
      const errors = flatten(error);
      if (stage === "badAddress") assert.match(errors[0].message, /TCP address/);
      else if (stage === "badOrigin") assert.match(errors[0].message, /loopback origin/);
      else assert.equal(errors[0], fixture.startupError);
      const acquired = stage === "failBackend" ? ["media"]
        : stage === "failCreate" ? ["media", "database"] : ["media", "vite", "database"];
      assert.deepEqual(fixture.calls, acquired);
      assert.deepEqual(errors.slice(1), acquired.map(name => fixture[`${name}Error`]));
      return true;
    });
    storageClosed();
  }
});

test("startup failure is unchanged when cleanup succeeds", async () => {
  setup({ failListen: true });
  await assert.rejects(startChatLab({ port: 0 }), error => error === fixture.startupError);
  assert.deepEqual(fixture.calls, ["media", "vite", "database"]);
  storageClosed();
});
