import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  ATTACHMENT_DOWNLOAD_ROUTE,
  CHAT_ATTACHMENT_DOWNLOAD_ATTACHMENT_UNAVAILABLE_CODE,
  CHAT_ATTACHMENT_DOWNLOAD_INVALID_REQUEST_CODE,
  CHAT_ATTACHMENT_DOWNLOAD_UNAVAILABLE_CODE,
  MAX_ATTACHMENT_DOWNLOAD_RESPONSE_BYTES,
  createChatServer,
} from "@handrail/chat/server";

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  roles: Object.freeze(["employee"]),
});
const checksum = `sha256:${"a".repeat(64)}`;
const expiresAt = () => new Date(Date.now() + 60_000).toISOString();
const pathFor = (attachmentId, messageId) =>
  `${ATTACHMENT_DOWNLOAD_ROUTE.replace(
    ":attachmentId",
    encodeURIComponent(attachmentId),
  )}?messageId=${encodeURIComponent(messageId)}`;

const forbiddenFragments = [
  "private/tenant-a",
  "signature=provider-secret",
  "Bearer provider-credential",
  "provider-secret-diagnostic",
  "storage_key",
  "storageKey",
  "objectKey",
  "authorization",
];

const authorizedRow = (attachmentId, messageId) => ({
  id: attachmentId,
  storage_key: `private/tenant-a/${attachmentId}`,
  file_name: "Résumé 東京 report.txt",
  content_type: "text/plain",
  size_bytes: "42",
  checksum,
  attached_message_id: messageId,
  created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
  expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  attached_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  entity_type: "order",
  entity_id: "42",
});

const createFixture = () => {
  const calls = { database: [], storage: [], entity: [] };
  const deniedIds = new Set([
    "missing",
    "pending",
    "rejected",
    "unattached",
    "invisible",
    "cross-tenant",
  ]);
  const database = {
    async query(sql, values = []) {
      if (!sql.includes("chat_attachments AS attachment")) {
        return { rows: [], rowCount: 0 };
      }
      calls.database.push({ sql, values });
      const [, attachmentId, messageId] = values;
      if (deniedIds.has(attachmentId)) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          ...authorizedRow(attachmentId, messageId),
          ...(attachmentId === "entity-forbidden" ? { entity_id: "denied" } : {}),
        }],
        rowCount: 1,
      };
    },
    async connect() {
      throw new Error("download HTTP must not reserve a database connection");
    },
  };
  const storage = {
    failure: null,
    async createDownloadUrl(input) {
      calls.storage.push(input);
      if (this.failure) throw this.failure;
      return {
        url: "https://downloads.test.invalid/file?signature=provider-secret",
        expiresAt: expiresAt(),
        headers: { authorization: "Bearer provider-credential" },
      };
    },
    async createUploadUrl() { throw new Error("unexpected upload call"); },
    async verifyObject() { throw new Error("unexpected verification call"); },
    async deleteObject() { throw new Error("unexpected delete call"); },
  };
  const runtime = createChatServer({
    database: { pool: database },
    auth: {
      async resolveActor(request) {
        if (request.headers.authorization === "Bearer valid") return actor;
        throw new Error("authentication-secret-diagnostic");
      },
    },
    directory: {
      async getUser() { return null; },
      async searchUsers() { return { users: [] }; },
    },
    permissions: {
      async getCapabilities() { return []; },
      async authorizeEntity(input) {
        calls.entity.push(input);
        return input.entity.id !== "denied";
      },
    },
    storage,
    features: { attachments: true },
  });
  return { calls, runtime, storage };
};

const withServer = async (runtime, callback, nextErrors = null) => {
  const server = createServer((request, response) => {
    runtime.router(request, response, nextErrors === null
      ? undefined
      : (error) => {
          nextErrors.push(error);
          response.statusCode = error.statusCode;
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ error: { code: error.code, message: error.message } }));
        });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${address.port}`;
    return await callback(async (path, options = {}) => {
      const response = await fetch(`${origin}${path}`, {
        method: "GET",
        headers: { authorization: options.authorization ?? "Bearer valid" },
      });
      const text = await response.text();
      assert.ok(Buffer.byteLength(text) <= MAX_ATTACHMENT_DOWNLOAD_RESPONSE_BYTES);
      return {
        status: response.status,
        headers: response.headers,
        text,
        json: text.length === 0 ? null : JSON.parse(text),
      };
    });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime.close();
  }
};

const assertHardened = (response) => {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("expires"), "0");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
};

const assertStableError = (response, status, code, message) => {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assertHardened(response);
  assert.deepEqual(response.json, { error: { code, message } });
};

test("attachment download HTTP returns one authorized opaque descriptor with safe metadata", async () => {
  const fixture = createFixture();
  await withServer(fixture.runtime, async (request) => {
    const response = await request(pathFor("report", "message-a"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(response.text)));
    assertHardened(response);
    assert.equal(response.json.operation, "get_attachment_download");
    assert.equal(response.json.attachmentId, "report");
    assert.equal(response.json.messageId, "message-a");
    assert.equal(response.json.download.kind, "opaque_attachment_download");
    assert.equal(fixture.calls.database.length, 1);
    assert.deepEqual(fixture.calls.database[0].values, [
      "tenant-a", "report", "message-a", "user-a",
    ]);
    assert.equal(fixture.calls.entity.length, 1);
    assert.equal(fixture.calls.storage.length, 1);

    const descriptor = JSON.parse(Buffer.from(
      response.json.download.descriptor,
      "base64url",
    ).toString("utf8"));
    assert.equal(
      descriptor.headers["content-disposition"],
      "attachment; filename=\"R_sum_ __ report.txt\"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%E6%9D%B1%E4%BA%AC%20report.txt",
    );
    for (const fragment of forbiddenFragments) {
      assert.equal(response.text.includes(fragment), false, fragment);
    }
  });
});

test("attachment download HTTP conceals unavailable authorization outcomes", async () => {
  const fixture = createFixture();
  await withServer(fixture.runtime, async (request) => {
    for (const attachmentId of [
      "missing", "pending", "rejected", "unattached", "invisible", "cross-tenant",
      "entity-forbidden",
    ]) {
      const response = await request(pathFor(attachmentId, "message-a"));
      assertStableError(
        response,
        404,
        CHAT_ATTACHMENT_DOWNLOAD_ATTACHMENT_UNAVAILABLE_CODE,
        "Attachment is unavailable",
      );
    }
  });
  assert.equal(fixture.calls.storage.length, 0);
});

test("attachment download HTTP rejects malformed and spoofed query input before querying", async () => {
  const fixture = createFixture();
  await withServer(fixture.runtime, async (request) => {
    for (const path of [
      "/attachments/report/download",
      "/attachments/report/download?messageId=one&messageId=two",
      "/attachments/report/download?messageId=one&tenantId=tenant-b",
      "/attachments/report/download?messageId=one&storageKey=private",
      "/attachments/report/download?messageId=one&token=secret",
      "/attachments/report/download?messageId=%ZZ",
      "/attachments/report%2Fspoof/download?messageId=one",
      "/attachments/report/download/extra?messageId=one",
    ]) {
      assertStableError(
        await request(path),
        400,
        CHAT_ATTACHMENT_DOWNLOAD_INVALID_REQUEST_CODE,
        "Invalid attachment download request",
      );
    }
  });
  assert.equal(fixture.calls.database.length, 0);
  assert.equal(fixture.calls.storage.length, 0);
});

test("attachment download HTTP sanitizes provider response and next errors", async () => {
  const direct = createFixture();
  direct.storage.failure = new Error(
    "provider-secret-diagnostic private/tenant-a signature=provider-secret",
  );
  await withServer(direct.runtime, async (request) => {
    const response = await request(pathFor("provider-failure", "message-a"));
    assertStableError(
      response,
      503,
      CHAT_ATTACHMENT_DOWNLOAD_UNAVAILABLE_CODE,
      "Attachment download temporarily unavailable",
    );
    for (const fragment of forbiddenFragments) {
      assert.equal(response.text.includes(fragment), false, fragment);
    }
  });

  const forwarded = createFixture();
  forwarded.storage.failure = new Error(
    "provider-secret-diagnostic private/tenant-a signature=provider-secret",
  );
  const nextErrors = [];
  await withServer(forwarded.runtime, async (request) => {
    const response = await request(pathFor("forwarded-failure", "message-a"));
    assertStableError(
      response,
      503,
      CHAT_ATTACHMENT_DOWNLOAD_UNAVAILABLE_CODE,
      "Attachment download temporarily unavailable",
    );
  }, nextErrors);
  assert.equal(nextErrors.length, 1);
  const serializedError = JSON.stringify({
    name: nextErrors[0].name,
    code: nextErrors[0].code,
    statusCode: nextErrors[0].statusCode,
    message: nextErrors[0].message,
    stack: nextErrors[0].stack,
  });
  for (const fragment of forbiddenFragments) {
    assert.equal(serializedError.includes(fragment), false, fragment);
  }
});
