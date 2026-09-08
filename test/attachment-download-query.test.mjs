import assert from "node:assert/strict";
import test from "node:test";

import { AttachmentTransportError } from "@handrail/chat";
import {
  ATTACHMENT_DOWNLOAD_ENTITY_POLICY_ACTION,
  AttachmentDownloadQueryError,
  ChatAuthorizationError,
  queryAttachmentDownload,
} from "@handrail/chat/server";

const now = new Date("2026-08-26T10:00:00.000Z");
const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  roles: Object.freeze(["employee"]),
});
const input = Object.freeze({
  operation: "get_attachment_download",
  attachmentId: "attachment-a",
  messageId: "message-a",
});
const authorizedRow = Object.freeze({
  id: "attachment-a",
  storage_key: "private/tenant-a/attachment-a",
  file_name: "Résumé 2026.txt",
  content_type: "text/plain",
  size_bytes: "42",
  checksum: `sha256:${"a".repeat(64)}`,
  attached_message_id: "message-a",
  created_at: "2026-08-26T09:50:00.000Z",
  expires_at: "2026-08-26T11:00:00.000Z",
  attached_at: "2026-08-26T09:55:00.000Z",
  conversation_id: "channel-a",
  conversation_type: "channel",
  entity_type: "order",
  entity_id: "42",
});

const options = ({ rows = [authorizedRow], storageResponse, storageFailure } = {}) => {
  const calls = { database: [], permissions: [], storage: [] };
  return {
    calls,
    value: {
      database: {
        async query(statement, values) {
          calls.database.push({ statement, values });
          return { rows, rowCount: rows.length };
        },
        async connect() {
          throw new Error("query must not reserve a connection");
        },
      },
      permissions: {
        async authorizeEntity(request) {
          calls.permissions.push(request);
          return true;
        },
      },
      storage: {
        async createDownloadUrl(request) {
          calls.storage.push(request);
          if (storageFailure) throw storageFailure;
          return storageResponse ?? {
            url: "https://downloads.test.invalid/file?signature=provider-secret",
            expiresAt: "2026-08-26T10:01:00.000Z",
            headers: { authorization: "Bearer provider-credential" },
          };
        },
      },
      actor,
      input,
      now: () => new Date(now),
    },
  };
};

test("attachment download query creates one opaque authorized descriptor", async () => {
  const fixture = options();
  const result = await queryAttachmentDownload(fixture.value);
  assert.equal(fixture.calls.database.length, 1);
  assert.deepEqual(fixture.calls.database[0].values, [
    "tenant-a",
    "attachment-a",
    "message-a",
    "user-a",
  ]);
  assert.deepEqual(fixture.calls.permissions, [{
    actor,
    entity: { type: "order", id: "42" },
    action: ATTACHMENT_DOWNLOAD_ENTITY_POLICY_ACTION,
  }]);
  assert.deepEqual(fixture.calls.storage, [{
    actor,
    attachmentId: "attachment-a",
    objectKey: "private/tenant-a/attachment-a",
    fileName: "Résumé 2026.txt",
    contentDisposition: "attachment",
  }]);

  const decoded = JSON.parse(
    Buffer.from(result.download.descriptor, "base64url").toString("utf8"),
  );
  assert.equal(
    decoded.headers["content-disposition"],
    "attachment; filename=\"R_sum_ 2026.txt\"; filename*=UTF-8''R%C3%A9sum%C3%A9%202026.txt",
  );
  assert.equal(decoded.headers.authorization, "Bearer provider-credential");
  const publicJson = JSON.stringify(result);
  for (const secret of [
    "provider-secret",
    "provider-credential",
    "private/tenant-a/attachment-a",
    "storageKey",
    "storage_key",
    "authorization",
    "signature",
  ]) {
    assert.equal(publicJson.includes(secret), false, secret);
  }
});

test("attachment download query denies unavailable and malformed requests before storage", async () => {
  const unavailable = options({ rows: [] });
  await assert.rejects(
    queryAttachmentDownload(unavailable.value),
    ChatAuthorizationError,
  );
  assert.equal(unavailable.calls.storage.length, 0);

  const malformed = options();
  await assert.rejects(
    queryAttachmentDownload({
      ...malformed.value,
      input: { ...input, userId: "spoofed-user" },
    }),
    (error) =>
      error instanceof AttachmentTransportError &&
      error.code === "trusted_context_field",
  );
  assert.equal(malformed.calls.database.length, 0);
  assert.equal(malformed.calls.storage.length, 0);
});

test("attachment download query sanitizes provider response failures", async () => {
  for (const fixture of [
    options({
      storageResponse: {
        url: "https://downloads.test.invalid/expired",
        expiresAt: "2026-08-26T09:59:59.999Z",
      },
    }),
    options({
      storageResponse: {
        url: "https://user:password@downloads.test.invalid/file",
        expiresAt: "2026-08-26T10:01:00.000Z",
      },
    }),
    options({
      storageResponse: {
        url: `https://downloads.test.invalid/${"a".repeat(2_100)}`,
        expiresAt: "2026-08-26T10:01:00.000Z",
      },
    }),
    options({
      storageResponse: {
        url: "https://downloads.test.invalid/file",
        expiresAt: "2026-08-26T10:01:00.000Z",
        headers: { "x-provider": "safe\r\nset-cookie: stolen" },
      },
    }),
    options({
      storageFailure: new Error("provider-secret-internal-diagnostic"),
    }),
  ]) {
    await assert.rejects(
      queryAttachmentDownload(fixture.value),
      (error) =>
        error instanceof AttachmentDownloadQueryError &&
        error.code === "storage_unavailable" &&
        error.statusCode === 503 &&
        !error.message.includes("provider-secret"),
    );
    assert.equal(fixture.calls.storage.length, 1);
  }
});
