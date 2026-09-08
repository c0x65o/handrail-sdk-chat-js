import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_REQUEST_CONTEXT,
  ChatAuthenticationError,
  ChatAuthorizationError,
  createChatServer,
  getChatRequestContext,
  hasChatRequestContext,
} from "@handrail/chat/server";

const database = {
  query() {
    throw new Error("request-context tests do not query the database");
  },
  async connect() {
    throw new Error("request-context tests do not connect to the database");
  },
};

const createRuntime = ({ resolveActor, getCapabilities }) =>
  createChatServer({
    database: { pool: database },
    auth: { resolveActor },
    directory: {
      async getUser() {
        return null;
      },
      async searchUsers() {
        return [];
      },
    },
    permissions: {
      getCapabilities,
      async authorizeEntity() {
        return true;
      },
    },
  });

const runMiddleware = (runtime, request) =>
  new Promise((resolve) => {
    runtime.router(request, {}, (error) => resolve(error));
  });

test("trusted adapters resolve once and attach one deeply immutable context", async () => {
  let authCalls = 0;
  let permissionCalls = 0;
  const sourceRoles = ["employee"];
  const sourceCapabilities = ["message.send"];
  const request = {
    headers: {
      "x-tenant-id": "spoof-tenant",
      "x-user-id": "spoof-user",
      "x-roles": "owner",
      "x-capabilities": "admin",
    },
    url: "/messages?tenantId=spoof-tenant&userId=spoof-user",
    body: {
      tenantId: "spoof-tenant",
      userId: "spoof-user",
      roles: ["owner"],
      actor: { tenantId: "spoof-tenant", userId: "spoof-user" },
      capabilities: ["admin"],
    },
  };
  const runtime = createRuntime({
    async resolveActor(receivedRequest) {
      authCalls += 1;
      assert.equal(receivedRequest, request);
      return {
        tenantId: "trusted-tenant",
        userId: "trusted-user",
        roles: sourceRoles,
      };
    },
    async getCapabilities({ actor }) {
      permissionCalls += 1;
      assert.deepEqual(actor, {
        tenantId: "trusted-tenant",
        userId: "trusted-user",
        roles: ["employee"],
      });
      return sourceCapabilities;
    },
  });

  assert.equal(await runMiddleware(runtime, request), undefined);
  const first = getChatRequestContext(request);
  const second = getChatRequestContext(request);

  assert.equal(first, second);
  assert.equal(request[CHAT_REQUEST_CONTEXT], first);
  assert.equal(hasChatRequestContext(request), true);
  assert.equal(authCalls, 1);
  assert.equal(permissionCalls, 1);
  assert.deepEqual(first, {
    actor: {
      tenantId: "trusted-tenant",
      userId: "trusted-user",
      roles: ["employee"],
    },
    capabilities: ["message.send"],
  });

  sourceRoles.push("owner");
  sourceCapabilities.push("admin");
  assert.deepEqual(first.actor.roles, ["employee"]);
  assert.deepEqual(first.capabilities, ["message.send"]);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.actor), true);
  assert.equal(Object.isFrozen(first.actor.roles), true);
  assert.equal(Object.isFrozen(first.capabilities), true);
  assert.throws(() => first.actor.roles.push("owner"), TypeError);
  assert.throws(() => first.capabilities.push("admin"), TypeError);
  assert.throws(() => {
    first.actor.userId = "changed";
  }, TypeError);
  assert.deepEqual(Object.getOwnPropertyDescriptor(request, CHAT_REQUEST_CONTEXT), {
    configurable: false,
    enumerable: false,
    value: first,
    writable: false,
  });

  assert.equal(await runMiddleware(runtime, request), undefined);
  assert.equal(authCalls, 1);
  assert.equal(permissionCalls, 1);
});

test("null, missing, empty, and malformed actors fail closed", async () => {
  const invalidActors = [
    null,
    undefined,
    {},
    Object.assign([], { tenantId: "tenant", userId: "user", roles: [] }),
    { tenantId: "", userId: "user", roles: [] },
    { tenantId: "   ", userId: "user", roles: [] },
    { tenantId: "tenant", userId: "", roles: [] },
    { tenantId: "tenant", userId: "user" },
    { tenantId: "tenant", userId: "user", roles: "employee" },
    { tenantId: "tenant", userId: "user", roles: [""] },
    { tenantId: "tenant", userId: "user", roles: Array(1) },
    { tenantId: "tenant", userId: "user", roles: ["employee", 1] },
  ];

  for (const invalidActor of invalidActors) {
    let permissionCalls = 0;
    const request = {};
    const runtime = createRuntime({
      async resolveActor() {
        return invalidActor;
      },
      async getCapabilities() {
        permissionCalls += 1;
        return [];
      },
    });

    const error = await runMiddleware(runtime, request);
    assert.equal(error instanceof ChatAuthenticationError, true);
    assert.equal(error.code, CHAT_AUTHENTICATION_ERROR_CODE);
    assert.equal(error.statusCode, 401);
    assert.equal(error.message, "Chat authentication failed");
    assert.equal(permissionCalls, 0);
    assert.equal(hasChatRequestContext(request), false);
  }
});

test("adapter failures and malformed capabilities become sanitized typed errors", async () => {
  const secretAuthDetail = "session provider token abc123 expired";
  const authRuntime = createRuntime({
    async resolveActor() {
      throw new Error(secretAuthDetail);
    },
    async getCapabilities() {
      return [];
    },
  });
  const authError = await runMiddleware(authRuntime, {});

  assert.equal(authError instanceof ChatAuthenticationError, true);
  assert.equal(authError.code, CHAT_AUTHENTICATION_ERROR_CODE);
  assert.equal(authError.statusCode, 401);
  assert.doesNotMatch(`${authError.message}\n${authError.stack}`, /abc123|expired/);
  assert.equal("cause" in authError, false);

  const secretPermissionDetail = "role mapping query select-secret failed";
  for (const capabilityResult of [
    new Error(secretPermissionDetail),
    null,
    Array(1),
    ["message.send", ""],
    ["message.send", 7],
  ]) {
    const runtime = createRuntime({
      async resolveActor() {
        return { tenantId: "tenant", userId: "user", roles: [] };
      },
      async getCapabilities() {
        if (capabilityResult instanceof Error) {
          throw capabilityResult;
        }
        return capabilityResult;
      },
    });
    const request = {};
    const error = await runMiddleware(runtime, request);

    assert.equal(error instanceof ChatAuthorizationError, true);
    assert.equal(error.code, CHAT_AUTHORIZATION_ERROR_CODE);
    assert.equal(error.statusCode, 403);
    assert.equal(error.message, "Chat authorization failed");
    assert.doesNotMatch(
      `${error.message}\n${error.stack}`,
      /select-secret|role mapping query/,
    );
    assert.equal("cause" in error, false);
    assert.equal(hasChatRequestContext(request), false);
  }
});

test("standalone router responses expose only stable sanitized failures", async () => {
  const runtime = createRuntime({
    async resolveActor() {
      throw new Error("private adapter exception");
    },
    async getCapabilities() {
      return [];
    },
  });
  const response = await new Promise((resolve) => {
    const state = {
      headers: {},
      headersSent: false,
      statusCode: 200,
      setHeader(name, value) {
        this.headers[name] = value;
      },
      end(body = "") {
        this.body = body;
        resolve(this);
      },
    };
    runtime.router({}, state);
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(response.body), {
    error: {
      code: CHAT_AUTHENTICATION_ERROR_CODE,
      message: "Chat authentication failed",
    },
  });
  assert.doesNotMatch(response.body, /private adapter exception/);
});

test("interleaved requests retain distinct trusted contexts", async () => {
  const releases = new Map();
  const runtime = createRuntime({
    resolveActor(request) {
      return new Promise((resolve) => {
        releases.set(request.requestId, resolve);
      });
    },
    async getCapabilities({ actor }) {
      return [`capability:${actor.userId}`];
    },
  });
  const firstRequest = { requestId: "first" };
  const secondRequest = { requestId: "second" };
  const firstRun = runMiddleware(runtime, firstRequest);
  const secondRun = runMiddleware(runtime, secondRequest);

  releases.get("second")({
    tenantId: "tenant-b",
    userId: "user-b",
    roles: ["role-b"],
  });
  assert.equal(await secondRun, undefined);
  releases.get("first")({
    tenantId: "tenant-a",
    userId: "user-a",
    roles: ["role-a"],
  });
  assert.equal(await firstRun, undefined);

  const firstContext = getChatRequestContext(firstRequest);
  const secondContext = getChatRequestContext(secondRequest);
  assert.notEqual(firstContext, secondContext);
  assert.deepEqual(firstContext.actor, {
    tenantId: "tenant-a",
    userId: "user-a",
    roles: ["role-a"],
  });
  assert.deepEqual(firstContext.capabilities, ["capability:user-a"]);
  assert.deepEqual(secondContext.actor, {
    tenantId: "tenant-b",
    userId: "user-b",
    roles: ["role-b"],
  });
  assert.deepEqual(secondContext.capabilities, ["capability:user-b"]);
});
