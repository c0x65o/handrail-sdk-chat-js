import assert from "node:assert/strict";
import test from "node:test";

import {
  AbortAttachmentCommandError,
  abortAttachment,
} from "../dist/server/abort-attachment-command.js";

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["trusted-host-role"]),
});

const request = Object.freeze({
  operation: "abort_attachment",
  attachmentId: "attachment-a",
  idempotencyKey: "abort-attachment-a",
});

const pendingRow = Object.freeze({
  id: "attachment-a",
  storage_key: "private/tenant-a/attachment-a?provider-secret=hidden",
  file_name: "attachment-a.pdf",
  content_type: "application/pdf",
  size_bytes: "42",
  checksum: null,
  state: "pending",
  attached_message_id: null,
  created_at: "2026-09-04T12:00:00.000Z",
  updated_at: "2026-09-04T12:00:00.000Z",
  expires_at: "2026-09-04T13:00:00.000Z",
  abandoned_at: null,
});

const abandonedRow = Object.freeze({
  ...pendingRow,
  state: "abandoned",
  updated_at: "2026-09-04T12:01:00.000Z",
  abandoned_at: "2026-09-04T12:01:00.000Z",
});

const expectedApplied = Object.freeze({
  operation: "abort_attachment",
  reconciliationStatus: "applied",
  idempotencyKey: request.idempotencyKey,
  attachmentId: request.attachmentId,
  attachment: Object.freeze({
    status: "abandoned",
    attachmentId: request.attachmentId,
    metadata: Object.freeze({
      fileName: "attachment-a.pdf",
      contentType: "application/pdf",
      sizeBytes: 42,
    }),
    createdAt: "2026-09-04T12:00:00.000Z",
    expiresAt: "2026-09-04T13:00:00.000Z",
    abandonedAt: "2026-09-04T12:01:00.000Z",
  }),
});

const queryKind = (sql) => {
  if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return sql;
  if (sql.includes("claim_chat_idempotency_key")) return "claim";
  if (sql.includes("UPDATE") && sql.includes("SET state = 'abandoned'")) {
    return "abandon";
  }
  if (sql.includes("FROM \"chat\".chat_attachments") && sql.includes("state = 'pending'")) {
    return "select-pending";
  }
  if (sql.includes("INSERT INTO") && sql.includes("chat_attachment_cleanup_deliveries")) {
    return sql.includes("SELECT tenant_id") ? "replay-enqueue" : "enqueue";
  }
  if (sql.includes("INSERT INTO") && sql.includes("chat_audit_events")) {
    return "audit";
  }
  if (sql.includes("INSERT INTO") && sql.includes("chat_outbox_events")) {
    return "outbox";
  }
  if (sql.includes("UPDATE") && sql.includes("chat_attachment_cleanup_deliveries")) {
    return sql.includes("state = 'delivered'") ? "deliver" : "lease";
  }
  if (sql.includes("UPDATE") && sql.includes("chat_idempotency_keys")) {
    return "complete-idempotency";
  }
  throw new Error("Unexpected query in abort-attachment fake");
};

const createDatabase = ({ completed = false } = {}) => {
  const events = [];
  let connections = 0;
  const database = {
    async connect() {
      connections += 1;
      return {
        async query(sql, values) {
          const kind = queryKind(sql);
          events.push({ type: "query", kind, sql, values });
          switch (kind) {
            case "claim":
              return completed
                ? {
                    rows: [{
                      idempotency_state: "completed",
                      stored_response_body: expectedApplied,
                    }],
                    rowCount: 1,
                  }
                : {
                    rows: [{
                      idempotency_state: "pending",
                      stored_response_body: null,
                    }],
                    rowCount: 1,
                  };
            case "select-pending":
              return { rows: [pendingRow], rowCount: 1 };
            case "abandon":
              return { rows: [abandonedRow], rowCount: 1 };
            case "complete-idempotency":
              return { rows: [], rowCount: 1 };
            default:
              return { rows: [], rowCount: 1 };
          }
        },
        release() {
          events.push({ type: "release" });
        },
      };
    },
  };
  return { database, events, connectionCount: () => connections };
};

const kinds = (events) =>
  events.map((event) => event.type === "query" ? event.kind : event.type);

test("abortAttachment commits cleanup work before deletion and settles it afterward", async () => {
  const fake = createDatabase();
  const storage = {
    calls: [],
    async deleteObject(input) {
      this.calls.push(input);
      fake.events.push({ type: "deleteObject" });
    },
  };

  const result = await abortAttachment({
    database: fake.database,
    schema: "chat",
    storage,
    actor,
    input: request,
    createId: () => "event-a",
  });

  assert.deepEqual(result, expectedApplied);
  assert.deepEqual(kinds(fake.events), [
    "BEGIN",
    "claim",
    "select-pending",
    "abandon",
    "enqueue",
    "audit",
    "outbox",
    "COMMIT",
    "release",
    "deleteObject",
    "BEGIN",
    "lease",
    "deliver",
    "complete-idempotency",
    "COMMIT",
    "release",
  ]);
  assert.equal(fake.connectionCount(), 2);
  assert.deepEqual(storage.calls, [{
    actor,
    attachmentId: request.attachmentId,
    objectKey: pendingRow.storage_key,
  }]);
  assert.deepEqual(
    fake.events.find((event) => event.kind === "enqueue").values,
    [actor.tenantId, request.attachmentId, pendingRow.storage_key],
  );
  for (const kind of ["enqueue", "lease", "deliver"]) {
    const sqlEvent = fake.events.find((event) => event.kind === kind);
    assert.ok(sqlEvent);
  }
  assert.equal(JSON.stringify(result).includes(pendingRow.storage_key), false);
});

test("abortAttachment leaves committed pending cleanup ready when deletion fails", async () => {
  const fake = createDatabase();
  const storage = {
    async deleteObject() {
      fake.events.push({ type: "deleteObject" });
      throw new Error(`provider-secret ${pendingRow.storage_key}`);
    },
  };

  await assert.rejects(
    abortAttachment({
      database: fake.database,
      schema: "chat",
      storage,
      actor,
      input: request,
      createId: () => "event-a",
    }),
    (error) =>
      error instanceof AbortAttachmentCommandError &&
      error.code === "storage_unavailable" &&
      error.statusCode === 503 &&
      error.message === "Attachment storage cleanup is temporarily unavailable" &&
      !error.message.includes("provider-secret") &&
      !error.message.includes("private/"),
  );

  assert.deepEqual(kinds(fake.events), [
    "BEGIN",
    "claim",
    "select-pending",
    "abandon",
    "enqueue",
    "audit",
    "outbox",
    "COMMIT",
    "release",
    "deleteObject",
  ]);
  assert.equal(fake.connectionCount(), 1);
});

test("abortAttachment replay only materializes cleanup with conflict-safe insertion", async () => {
  const fake = createDatabase({ completed: true });
  const storage = {
    async deleteObject() {
      throw new Error("completed replay must not call storage");
    },
  };

  const result = await abortAttachment({
    database: fake.database,
    schema: "chat",
    storage,
    actor,
    input: request,
  });

  assert.deepEqual(result, {
    ...expectedApplied,
    reconciliationStatus: "replayed",
  });
  assert.deepEqual(kinds(fake.events), [
    "BEGIN",
    "claim",
    "replay-enqueue",
    "COMMIT",
    "release",
  ]);
  const replayEnqueue = fake.events.find((event) => event.kind === "replay-enqueue");
  assert.match(
    replayEnqueue.sql,
    /ON CONFLICT \(tenant_id, attachment_id\) DO NOTHING/,
  );
  assert.deepEqual(replayEnqueue.values, [
    actor.tenantId,
    request.attachmentId,
    actor.userId,
  ]);
});
