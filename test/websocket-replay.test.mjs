import assert from "node:assert/strict";
import test from "node:test";

import {
  readChatWebSocketReplay,
} from "@handrail/chat/server";

const actor = {
  tenantId: "tenant-a",
  userId: "user-a",
  roles: ["employee"],
};

const permissions = {
  async getCapabilities() {
    return [];
  },
  async authorizeEntity() {
    return true;
  },
};

const cursorRow = {
  replay_position: 10,
  protocol_version: 4,
  expires_at: "2099-01-01T00:00:00.000Z",
  type: "message.created",
};

const eventRow = (position, eventId, streamId = "conversation-a") => ({
  replay_position: position,
  event_id: eventId,
  protocol_version: 4,
  tenant_id: "tenant-a",
  stream_id: streamId,
  type: "message.created",
  occurred_at: `2026-08-25T20:00:${String(position).padStart(2, "0")}.000Z`,
  payload: { position },
  expires_at: "2099-01-01T00:00:00.000Z",
});

const conversationAuthorization = {
  type: "channel",
  visibility: "private",
  entity_type: null,
  entity_id: null,
  archived_at: null,
  member_state: "active",
};

test("reads strictly after a tenant cursor in durable order", async () => {
  const observedSql = [];
  const database = {
    async query(sql, values) {
      observedSql.push({ sql, values });
      if (sql.includes("WHERE tenant_id = $1") && sql.includes("event_id = $2")) {
        return { rows: [cursorRow] };
      }
      if (sql.includes("SELECT DISTINCT stream_id")) {
        return { rows: [{ stream_id: "conversation-a" }, { stream_id: "user:user-a" }] };
      }
      if (sql.includes("current_member.state AS member_state")) {
        return { rows: [conversationAuthorization] };
      }
      if (sql.includes("LIMIT $5")) {
        return {
          rows: [
            eventRow(11, "event-11"),
            eventRow(13, "event-13", "user:user-a"),
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const result = await readChatWebSocketReplay({
    database,
    permissions,
    actor,
    cursor: { eventId: "event-10" },
    protocolVersion: 4,
    limit: 5,
  });

  assert.equal(result.state, "accepted");
  assert.deepEqual(
    result.events.map(({ event }) => event.eventId),
    ["event-11", "event-13"],
  );
  assert.deepEqual(result.streamIds, ["conversation-a", "user:user-a"]);
  assert.deepEqual(observedSql[0].values, ["tenant-a", "event-10"]);
  assert.match(observedSql.at(-1).sql, /replay_position > \$2/);
  assert.match(observedSql.at(-1).sql, /ORDER BY replay_position/);
});

test("fails closed for unavailable, incompatible, and overflowing replay", async (t) => {
  const run = (responses, options = {}) =>
    readChatWebSocketReplay({
      database: {
        async query(sql) {
          if (sql.includes("current_member.state AS member_state")) {
            return { rows: [conversationAuthorization] };
          }
          return responses.shift() ?? { rows: [] };
        },
      },
      permissions,
      actor,
      cursor: { eventId: "opaque-cursor" },
      protocolVersion: 4,
      limit: options.limit ?? 2,
    });

  await t.test("unknown and cross-tenant-equivalent lookup", async () => {
    assert.deepEqual(await run([{ rows: [] }]), {
      state: "snapshot_required",
      reason: "replay_unavailable",
    });
  });

  await t.test("cursor protocol mismatch", async () => {
    assert.deepEqual(
      await run([{ rows: [{ ...cursorRow, protocol_version: 3 }] }]),
      { state: "snapshot_required", reason: "replay_incompatible" },
    );
  });

  await t.test("page overflow", async () => {
    assert.deepEqual(
      await run([
        { rows: [cursorRow] },
        { rows: [{ stream_id: "conversation-a" }] },
        {
          rows: [
            eventRow(11, "event-11"),
            eventRow(12, "event-12"),
            eventRow(13, "event-13"),
          ],
        },
      ]),
      { state: "snapshot_required", reason: "replay_overflow" },
    );
  });
});
