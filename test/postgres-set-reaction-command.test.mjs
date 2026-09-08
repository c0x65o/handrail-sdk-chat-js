import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CHAT_PROTOCOL_VERSION,
  ReactionMutationParseError,
  parseKnownDurableEvent,
} from "@handrail/chat";
import {
  ChatAuthorizationError,
  SET_REACTION_AUDIT_ACTION,
  SET_REACTION_CAPABILITY,
  SET_REACTION_ENTITY_POLICY_ACTION,
  SET_REACTION_IDEMPOTENCY_OPERATION,
  SET_REACTION_OUTBOX_EVENT_TYPE,
  SetReactionCommandError,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
  setReaction,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const actorA = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["employee"]),
});
const actorB = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-b",
  roles: Object.freeze(["employee"]),
});

const reactionInput = (
  operation,
  messageId,
  suffix,
  reactionKey = "👍",
) => ({
  operation,
  messageId,
  reactionKey,
  idempotencyKey: `reaction-idempotency-${suffix}`,
});

test("set-reaction command is explicit, authorized, idempotent, and atomic", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_set_reaction" });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    conversations: `${schema}.chat_conversations`,
    members: `${schema}.chat_conversation_members`,
    messages: `${schema}.chat_messages`,
    reactions: `${schema}.chat_reactions`,
    audit: `${schema}.chat_audit_events`,
    outbox: `${schema}.chat_outbox_events`,
    idempotency: `${schema}.chat_idempotency_keys`,
  };
  let capabilities = [SET_REACTION_CAPABILITY];
  let entityAllowed = true;
  const entityCalls = [];
  const permissions = {
    async getCapabilities() {
      return capabilities;
    },
    async authorizeEntity(input) {
      entityCalls.push(input);
      return entityAllowed;
    },
  };
  let nextId = 0;
  const createId = () => `reaction-command-${++nextId}`;
  const command = (input, overrides = {}) =>
    setReaction({
      database: harness.pool,
      schema: harness.schema,
      actor: actorA,
      permissions,
      input,
      createId,
      ...overrides,
    });

  const seedMessage = async ({
    tenantId = "tenant-a",
    conversationId,
    messageId,
    visibility = "private",
    memberUserId = "actor-a",
    memberState = "active",
    archived = false,
    deleted = false,
    entity,
  }) => {
    const createdAt = "2026-01-01T00:00:00.000Z";
    await harness.pool.query(
      `INSERT INTO ${tables.conversations} (
         tenant_id, id, type, visibility, name, entity_type, entity_id,
         current_message_sequence, archived_at, archived_by_user_id,
         created_at, updated_at
       )
       VALUES ($1, $2, 'channel', $3, $2, $4, $5, 1, $6, $7, $8, $8)`,
      [
        tenantId,
        conversationId,
        visibility,
        entity?.type ?? null,
        entity?.id ?? null,
        archived ? "2026-01-02T00:00:00.000Z" : null,
        archived ? "archiver-a" : null,
        createdAt,
      ],
    );
    if (memberUserId !== null) {
      await harness.pool.query(
        `INSERT INTO ${tables.members}
           (tenant_id, conversation_id, user_id, role, state, joined_at, updated_at)
         VALUES ($1, $2, $3, 'member', $4, $5, $5)`,
        [tenantId, conversationId, memberUserId, memberState, createdAt],
      );
    }
    await harness.pool.query(
      `INSERT INTO ${tables.messages} (
         tenant_id, id, conversation_id, sequence, author_user_id,
         client_message_id, content, created_at, updated_at,
         deleted_at, deleted_by_user_id
       )
       VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10)`,
      [
        tenantId,
        messageId,
        conversationId,
        `author-${messageId}`,
        `client-${messageId}`,
        { format: "plain", text: `Message ${messageId}` },
        createdAt,
        deleted ? "2026-01-02T00:00:00.000Z" : createdAt,
        deleted ? "2026-01-02T00:00:00.000Z" : null,
        deleted ? "deleter-a" : null,
      ],
    );
  };

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    await t.test("add/add and remove/remove converge with canonical multi-user aggregates", async () => {
      const messageId = "message-convergence";
      await seedMessage({
        conversationId: "conversation-convergence",
        messageId,
        visibility: "public",
        memberUserId: null,
      });

      const concurrentAdds = await Promise.all([
        command(reactionInput("add_reaction", messageId, "concurrent-a")),
        command(reactionInput("add_reaction", messageId, "concurrent-b"), {
          actor: actorB,
        }),
      ]);
      assert.deepEqual(
        concurrentAdds.map(({ count }) => count).sort((a, b) => a - b),
        [1, 2],
      );
      assert.ok(concurrentAdds.every((result) => result.reactedByCurrentUser));

      const repeatedAdd = await command(
        reactionInput("add_reaction", messageId, "repeated-add"),
      );
      assert.deepEqual(repeatedAdd, {
        operation: "add_reaction",
        reconciliationStatus: "applied",
        messageId,
        reactionKey: "👍",
        count: 2,
        reactedByCurrentUser: true,
      });

      const removed = await command(
        reactionInput("remove_reaction", messageId, "remove"),
      );
      const repeatedRemove = await command(
        reactionInput("remove_reaction", messageId, "repeated-remove"),
      );
      assert.deepEqual(removed, {
        operation: "remove_reaction",
        reconciliationStatus: "applied",
        messageId,
        reactionKey: "👍",
        count: 1,
        reactedByCurrentUser: false,
      });
      assert.deepEqual(repeatedRemove, removed);
      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT user_id, reaction_key
             FROM ${tables.reactions}
             WHERE tenant_id = 'tenant-a' AND message_id = $1`,
            [messageId],
          )
        ).rows,
        [{ user_id: actorB.userId, reaction_key: "👍" }],
      );
    });

    await t.test("enforces capability, visibility, membership, entity, tenant, archive, and deletion access", async () => {
      await seedMessage({
        conversationId: "conversation-private-member",
        messageId: "message-private-member",
      });
      const privateResult = await command(
        reactionInput(
          "add_reaction",
          "message-private-member",
          "private-member",
        ),
      );
      assert.equal(privateResult.count, 1);

      const deniedFixtures = [
        {
          conversationId: "conversation-private-missing",
          messageId: "message-private-missing",
          memberUserId: null,
        },
        {
          conversationId: "conversation-private-left",
          messageId: "message-private-left",
          memberState: "left",
        },
        {
          tenantId: "tenant-b",
          conversationId: "conversation-cross-tenant",
          messageId: "message-cross-tenant",
          visibility: "public",
          memberUserId: null,
        },
        {
          conversationId: "conversation-archived",
          messageId: "message-archived",
          visibility: "public",
          memberUserId: null,
          archived: true,
        },
        {
          conversationId: "conversation-deleted",
          messageId: "message-deleted",
          visibility: "public",
          memberUserId: null,
          deleted: true,
        },
      ];
      for (const fixture of deniedFixtures) {
        await seedMessage(fixture);
        await assert.rejects(
          command(
            reactionInput(
              "add_reaction",
              fixture.messageId,
              fixture.messageId,
            ),
          ),
          (error) =>
            error instanceof ChatAuthorizationError &&
            error.statusCode === 403 &&
            error.message === "Chat authorization failed",
        );
      }
      await assert.rejects(
        command(
          reactionInput(
            "add_reaction",
            "message-unavailable",
            "message-unavailable",
          ),
        ),
        (error) => error instanceof ChatAuthorizationError,
      );

      await seedMessage({
        conversationId: "conversation-entity-denied",
        messageId: "message-entity-denied",
        visibility: "public",
        memberUserId: null,
        entity: { type: "invoice", id: "invoice-denied" },
      });
      entityAllowed = false;
      await assert.rejects(
        command(
          reactionInput(
            "add_reaction",
            "message-entity-denied",
            "entity-denied",
          ),
        ),
        (error) => error instanceof ChatAuthorizationError,
      );
      entityAllowed = true;
      assert.deepEqual(entityCalls.at(-1), {
        actor: actorA,
        entity: { type: "invoice", id: "invoice-denied" },
        action: SET_REACTION_ENTITY_POLICY_ACTION,
      });

      await seedMessage({
        conversationId: "conversation-no-capability",
        messageId: "message-no-capability",
        visibility: "public",
        memberUserId: null,
      });
      capabilities = [];
      await assert.rejects(
        command(
          reactionInput(
            "add_reaction",
            "message-no-capability",
            "no-capability",
          ),
        ),
        (error) => error instanceof ChatAuthorizationError,
      );
      capabilities = [SET_REACTION_CAPABILITY];

      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count
             FROM ${tables.reactions}
             WHERE message_id <> 'message-private-member'
               AND message_id LIKE 'message-%'`,
          )
        ).rows[0].count,
        1,
        "only the earlier convergence fixture remains outside the authorized private message",
      );
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count
             FROM ${tables.idempotency}
             WHERE client_key IN (
               'reaction-idempotency-message-private-missing',
               'reaction-idempotency-message-private-left',
               'reaction-idempotency-message-cross-tenant',
               'reaction-idempotency-message-archived',
               'reaction-idempotency-message-deleted',
               'reaction-idempotency-message-unavailable',
               'reaction-idempotency-entity-denied',
               'reaction-idempotency-no-capability'
             )`,
          )
        ).rows[0].count,
        0,
      );

      await assert.rejects(
        command({
          ...reactionInput(
            "add_reaction",
            "message-private-member",
            "spoofed",
          ),
          tenantId: "tenant-b",
        }),
        (error) =>
          error instanceof ReactionMutationParseError &&
          error.code === "trusted_identity_field",
      );
    });

    await t.test("replays the stored canonical outcome and rejects conflicting key reuse", async () => {
      const messageId = "message-idempotent";
      const conversationId = "conversation-idempotent";
      const input = {
        ...reactionInput(
          "add_reaction",
          messageId,
          "super-secret-idempotency-value",
          "🔥",
        ),
        idempotencyKey: "super-secret-idempotency-value",
      };
      await seedMessage({
        conversationId,
        messageId,
        visibility: "public",
        memberUserId: null,
      });

      const applied = await command(input);
      const replayed = await command(input);
      assert.deepEqual(replayed, {
        ...applied,
        reconciliationStatus: "replayed",
      });
      await assert.rejects(
        command({ ...input, operation: "remove_reaction" }),
        (error) =>
          error instanceof SetReactionCommandError &&
          error.code === "idempotency_conflict" &&
          error.statusCode === 409,
      );

      const state = (
        await harness.pool.query(
          `SELECT
             reaction.user_id,
             reaction.reaction_key,
             audit.action AS audit_action,
             audit.metadata AS audit_metadata,
             audit.metadata::text AS audit_text,
             event.protocol_version::integer AS protocol_version,
             event.type AS event_type,
             event.stream_id,
             event.payload AS event_payload,
             outcome.operation_name,
             outcome.state AS outcome_state,
             outcome.response_status,
             outcome.response_body,
             (SELECT count(*)::integer FROM ${tables.audit}
              WHERE target_id = $2) AS audit_count,
             (SELECT count(*)::integer FROM ${tables.outbox}
              WHERE stream_id = $1 AND type = $3) AS outbox_count
           FROM ${tables.reactions} AS reaction
           JOIN ${tables.audit} AS audit
             ON audit.tenant_id = reaction.tenant_id
            AND audit.target_type = 'message'
            AND audit.target_id = reaction.message_id
            AND audit.action = $4
           JOIN ${tables.outbox} AS event
             ON event.tenant_id = reaction.tenant_id
            AND event.stream_id = $1
            AND event.type = $3
           JOIN ${tables.idempotency} AS outcome
             ON outcome.tenant_id = reaction.tenant_id
            AND outcome.user_id = reaction.user_id
            AND outcome.operation_name = $5
            AND outcome.client_key = $6
           WHERE reaction.tenant_id = 'tenant-a'
             AND reaction.message_id = $2
             AND reaction.reaction_key = '🔥'`,
          [
            conversationId,
            messageId,
            SET_REACTION_OUTBOX_EVENT_TYPE,
            SET_REACTION_AUDIT_ACTION,
            SET_REACTION_IDEMPOTENCY_OPERATION,
            input.idempotencyKey,
          ],
        )
      ).rows[0];
      const expectedAuditMetadata = {
        conversationId,
        operation: "add_reaction",
        messageId,
        reactionKey: "🔥",
        count: 1,
        reactedByCurrentUser: true,
      };
      assert.equal(state.user_id, actorA.userId);
      assert.equal(state.reaction_key, "🔥");
      assert.equal(state.audit_action, SET_REACTION_AUDIT_ACTION);
      assert.deepEqual(state.audit_metadata, expectedAuditMetadata);
      assert.equal(state.audit_text.includes(input.idempotencyKey), false);
      assert.equal(state.audit_text.includes(actorA.roles[0]), false);
      assert.equal(state.protocol_version, CHAT_PROTOCOL_VERSION);
      assert.equal(state.event_type, SET_REACTION_OUTBOX_EVENT_TYPE);
      assert.equal(state.stream_id, conversationId);
      assert.deepEqual(state.event_payload, {
        ...expectedAuditMetadata,
        reconciliationStatus: "applied",
      });
      assert.equal(state.operation_name, SET_REACTION_IDEMPOTENCY_OPERATION);
      assert.equal(state.outcome_state, "completed");
      assert.equal(state.response_status, 200);
      assert.deepEqual(state.response_body, applied);
      assert.equal(state.audit_count, 1);
      assert.equal(state.outbox_count, 1);
    });

    await t.test("stored add/remove events satisfy the wire contract and retain their identities on replay", async () => {
      const conversationId = "conversation-wire-contract";
      const messageId = "message-wire-contract";
      const reactionKey = "👍";
      const observer = { tenantId: "tenant-a", userId: "conversation-observer" };
      assert.notEqual(observer.userId, actorA.userId);
      await seedMessage({ conversationId, messageId });

      const readEvents = async () => (
        await harness.pool.query(
          `SELECT event_id, protocol_version, tenant_id, stream_id, type,
                  occurred_at, payload
           FROM ${tables.outbox}
           WHERE tenant_id = $1 AND stream_id = $2
           ORDER BY event_id`,
          [observer.tenantId, conversationId],
        )
      ).rows;
      let storedEvents = await readEvents();
      assert.deepEqual(storedEvents, []);
      const eventIds = new Set();
      for (const [operation, count, reactedByCurrentUser] of [
        ["add_reaction", 1, true],
        ["remove_reaction", 0, false],
      ]) {
        const input = reactionInput(operation, messageId, `wire-${operation}`, reactionKey);
        const applied = await command(input);
        const events = await readEvents();
        assert.equal(events.length, storedEvents.length + 1);
        assert.deepEqual(
          events.filter((event) => eventIds.has(event.event_id)),
          storedEvents,
        );
        const newEvents = events.filter((event) => !eventIds.has(event.event_id));
        assert.equal(newEvents.length, 1);
        const stored = newEvents[0];
        // pg returns bigint as text; convert the stored version and check it before parsing.
        const protocolVersion = Number(stored.protocol_version);
        assert.ok(Number.isSafeInteger(protocolVersion) && protocolVersion > 0);
        // Adapt SQL envelope representations only; parse the payload as stored.
        const envelope = {
          eventId: stored.event_id,
          protocolVersion,
          tenantId: stored.tenant_id,
          streamId: stored.stream_id,
          type: stored.type,
          occurredAt: stored.occurred_at.toISOString(),
          payload: stored.payload,
        };
        const parsed = parseKnownDurableEvent(envelope, observer);
        assert.deepEqual(parsed, envelope);
        assert.equal(parsed.eventId, stored.event_id);
        assert.equal(parsed.protocolVersion, CHAT_PROTOCOL_VERSION);
        assert.equal(parsed.tenantId, observer.tenantId);
        assert.equal(parsed.streamId, conversationId);
        assert.equal(parsed.type, SET_REACTION_OUTBOX_EVENT_TYPE);
        assert.equal(parsed.occurredAt, stored.occurred_at.toISOString());
        assert.deepEqual(parsed.payload, {
          conversationId,
          operation,
          reconciliationStatus: "applied",
          messageId,
          reactionKey,
          count,
          reactedByCurrentUser,
        });
        eventIds.add(parsed.eventId);
        storedEvents = events;

        assert.deepEqual(await command(input), {
          ...applied,
          reconciliationStatus: "replayed",
        });
        assert.deepEqual(await readEvents(), storedEvents);
      }
      assert.equal(eventIds.size, 2);
    });

    await t.test("completes reaction mutation when the serialized clock precedes the claim by microseconds", async () => {
      const messageId = "message-submillisecond-claim";
      const conversationId = "conversation-submillisecond-claim";
      await seedMessage({ conversationId, messageId });
      const input = reactionInput("add_reaction", messageId, "submillisecond-claim");
      // Match setReaction's insertion order and exclude the idempotency key.
      const requestHash = `sha256:${createHash("sha256").update(JSON.stringify({
        operation: input.operation,
        messageId: input.messageId,
        reactionKey: input.reactionKey,
      })).digest("hex")}`;
      const claim = (await harness.pool.query(
        `INSERT INTO ${tables.idempotency} (
           tenant_id, user_id, operation_name, client_key, request_hash,
           created_at, updated_at, expires_at
         )
         SELECT $1, $2, $3, $4, $5, claimed_at, claimed_at,
                claimed_at + interval '2 minutes'
         FROM (SELECT date_trunc('milliseconds', clock_timestamp())
                      + interval '456 microseconds' AS claimed_at) AS clock
         RETURNING created_at`,
        [actorA.tenantId, actorA.userId, SET_REACTION_IDEMPOTENCY_OPERATION,
          input.idempotencyKey, requestHash],
      )).rows[0];
      assert.ok(claim.created_at instanceof Date);
      // Delegate every query, including the message SELECT, to PostgreSQL;
      // only its returned clock sample loses the claim's microseconds.
      let clockSamples = 0;
      const clockDatabase = {
        query: harness.pool.query.bind(harness.pool),
        async connect() {
          const connection = await harness.pool.connect();
          return {
            async query(sql, values) {
              const result = await connection.query(sql, values);
              if (sql.includes("clock_timestamp() AS observed_at")) {
                result.rows[0].observed_at = claim.created_at;
                clockSamples += 1;
              }
              return result;
            },
            release: () => connection.release(),
          };
        },
      };

      const result = await command(input, { database: clockDatabase });
      assert.equal(clockSamples, 1);
      assert.deepEqual(result, {
        operation: "add_reaction",
        reconciliationStatus: "applied",
        messageId,
        reactionKey: input.reactionKey,
        count: 1,
        reactedByCurrentUser: true,
      });
      const storedReactions = async () => (await harness.pool.query(
        `SELECT * FROM ${tables.reactions}
         WHERE tenant_id = $1 AND message_id = $2`,
        [actorA.tenantId, messageId],
      )).rows;
      const persisted = await storedReactions();
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0].user_id, actorA.userId);
      assert.equal(persisted[0].reaction_key, input.reactionKey);
      const effectCounts = async () => (await harness.pool.query(
        `SELECT
           (SELECT count(*)::integer FROM ${tables.audit}
            WHERE tenant_id = $1 AND target_type = 'message'
              AND target_id = $2) AS audit,
           (SELECT count(*)::integer FROM ${tables.outbox}
            WHERE tenant_id = $1 AND stream_id = $3) AS outbox`,
        [actorA.tenantId, messageId, conversationId],
      )).rows[0];
      const storedOutcome = async () => (await harness.pool.query(
        `SELECT completed_at = created_at AS completion_preserves_precision,
                updated_at = completed_at AS update_matches_completion,
                created_at - $5::timestamptz = interval '456 microseconds' AS precision_gap,
                expires_at = created_at + interval '2 minutes' AS ttl_unchanged,
                state, response_status, response_body, request_hash
         FROM ${tables.idempotency}
         WHERE tenant_id = $1 AND user_id = $2
           AND operation_name = $3 AND client_key = $4`,
        [actorA.tenantId, actorA.userId, SET_REACTION_IDEMPOTENCY_OPERATION,
          input.idempotencyKey, claim.created_at],
      )).rows;
      const expectedOutcome = [{
        completion_preserves_precision: true,
        update_matches_completion: true,
        precision_gap: true,
        ttl_unchanged: true,
        state: "completed",
        response_status: 200,
        response_body: result,
        request_hash: requestHash,
      }];
      // SQL comparisons retain the microseconds that JavaScript Date loses.
      assert.deepEqual(await storedOutcome(), expectedOutcome);
      assert.deepEqual(await effectCounts(), { audit: 1, outbox: 1 });
      assert.deepEqual(await command(input), {
        ...result,
        reconciliationStatus: "replayed",
      });
      assert.deepEqual(await storedReactions(), persisted);
      assert.deepEqual(await effectCounts(), { audit: 1, outbox: 1 });
      assert.deepEqual(await storedOutcome(), expectedOutcome);
    });

    await t.test("a late completion failure rolls reaction, audit, outbox, and idempotency back", async () => {
      const messageId = "message-rollback";
      const conversationId = "conversation-rollback";
      const input = reactionInput(
        "add_reaction",
        messageId,
        "rollback",
        "✅",
      );
      await seedMessage({
        conversationId,
        messageId,
        visibility: "public",
        memberUserId: null,
      });
      const lateFailureDatabase = {
        query: harness.pool.query.bind(harness.pool),
        async connect() {
          const connection = await harness.pool.connect();
          return {
            async query(text, values) {
              if (
                typeof text === "string" &&
                text.includes("UPDATE") &&
                text.includes("chat_idempotency_keys")
              ) {
                await connection.query(text, values);
                throw new Error("injected post-completion failure");
              }
              return connection.query(text, values);
            },
            release: () => connection.release(),
          };
        },
      };

      await assert.rejects(
        command(input, { database: lateFailureDatabase }),
        /injected post-completion failure/,
      );
      const state = (
        await harness.pool.query(
          `SELECT
             (SELECT count(*)::integer FROM ${tables.reactions}
              WHERE message_id = $1) AS reactions,
             (SELECT count(*)::integer FROM ${tables.audit}
              WHERE target_id = $1) AS audits,
             (SELECT count(*)::integer FROM ${tables.outbox}
              WHERE stream_id = $2) AS outbox,
             (SELECT count(*)::integer FROM ${tables.idempotency}
              WHERE client_key = $3) AS idempotency`,
          [messageId, conversationId, input.idempotencyKey],
        )
      ).rows[0];
      assert.deepEqual(state, {
        reactions: 0,
        audits: 0,
        outbox: 0,
        idempotency: 0,
      });
    });
  } finally {
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});
