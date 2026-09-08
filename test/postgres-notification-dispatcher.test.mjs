import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatNotificationDeliveryError,
  createChatNotificationDeliveryId,
  createChatNotificationDispatcher,
  createChatServer,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
  MAX_CHAT_NOTIFICATION_TARGETS,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

test("durable notification dispatch selects, leases, retries, and isolates real PostgreSQL rows", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "notification_dispatcher",
  });
  const prefix = quoteIdentifier(harness.schema);
  const conversations = `${prefix}.chat_conversations`;
  const members = `${prefix}.chat_conversation_members`;
  const preferences = `${prefix}.chat_conversation_preferences`;
  const outbox = `${prefix}.chat_outbox_events`;
  const deliveries = `${prefix}.chat_notification_deliveries`;
  const offsets = `${prefix}.chat_notification_materializer_offsets`;
  const pushTokens = `${prefix}.chat_device_push_tokens`;
  const messages = `${prefix}.chat_messages`;
  const follows = `${prefix}.chat_thread_follows`;
  const workers = new Set();
  let ordinal = 0;

  const reset = async () => {
    await harness.pool.query(`DELETE FROM ${deliveries}`);
    await harness.pool.query(`DELETE FROM ${outbox}`);
    await harness.pool.query(`DELETE FROM ${offsets}`);
    await harness.pool.query(`DELETE FROM ${preferences}`);
    await harness.pool.query(`DELETE FROM ${follows}`);
    await harness.pool.query(`DELETE FROM ${members}`);
    await harness.pool.query(`DELETE FROM ${messages} WHERE conversation_id IN (
      SELECT id FROM ${conversations} WHERE type = 'thread'
    )`);
    await harness.pool.query(`DELETE FROM ${conversations} WHERE type = 'thread'`);
    await harness.pool.query(`DELETE FROM ${messages}`);
    await harness.pool.query(`DELETE FROM ${conversations}`);
  };

  const pushTokenProtector = {
    async protect() {
      throw new Error("unused test protection path");
    },
    async unprotect({ protectedToken }) {
      return protectedToken.ciphertext.slice("protected:".length);
    },
  };

  const worker = (adapter, options = {}) => {
    const dispatcher = createChatNotificationDispatcher({
      database: harness.pool,
      schema: harness.schema,
      adapter,
      pushTokenProtector,
      directory: {
        async getUser({ actor, userId }) {
          assert.deepEqual(actor.roles, []);
          return { tenantId: actor.tenantId, userId, displayName: userId };
        },
      },
      permissions: { async authorizeEntity() { return true; } },
      batchSize: 50,
      pollIntervalMs: 60_000,
      leaseDurationMs: 90,
      initialRetryDelayMs: 0,
      maxRetryDelayMs: 0,
      createLeaseToken: () => `lease-${++ordinal}`,
      ...options,
    });
    workers.add(dispatcher);
    return dispatcher;
  };

  const seed = async ({
    tenantId = "tenant-a",
    conversationId,
    eventId,
    actorUserId = "actor",
    recipients,
    mentions = [],
    replyTo,
    secretText = "raw-message-content-must-not-escape",
  }) => {
    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name, current_message_sequence)
       VALUES ($1, $2, 'channel', 'private', $2, 1)`,
      [tenantId, conversationId],
    );
    await harness.pool.query(
      `INSERT INTO ${members}
         (tenant_id, conversation_id, user_id, role, state)
       SELECT $1, $2, candidate.user_id, 'member', 'active'
       FROM unnest($3::text[]) AS candidate(user_id)`,
      [tenantId, conversationId, [actorUserId, ...recipients.map(({ userId }) => userId)]],
    );
    for (const recipient of recipients) {
      await harness.pool.query(
        `INSERT INTO ${pushTokens} (
           tenant_id, user_id, device_id, platform, provider, environment,
           opaque_token, token_protection_scheme, token_protection_key_id,
           token_revision
         ) VALUES (
           $1, $2, $3, 'ios', 'apns', 'production', $4,
           'host_encrypted', 'test-key', 1
         )`,
        [
          tenantId,
          recipient.userId,
          `device-${recipient.userId}`,
          `protected:token-${tenantId}-${recipient.userId}`,
        ],
      );
      if (recipient.preference === undefined) continue;
      await harness.pool.query(
        `INSERT INTO ${preferences}
           (tenant_id, conversation_id, user_id, notification_level,
            muted, muted_until)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          tenantId,
          conversationId,
          recipient.userId,
          recipient.preference.level,
          recipient.preference.muted ?? false,
          recipient.preference.mutedUntil ?? null,
        ],
      );
    }
    await harness.pool.query(
      `INSERT INTO ${outbox}
         (event_id, protocol_version, tenant_id, stream_id, type,
          occurred_at, payload, expires_at)
       VALUES ($1, 4, $2, $3, 'message.created', clock_timestamp(), $4,
               clock_timestamp() + interval '1 day')`,
      [
        eventId,
        tenantId,
        conversationId,
        {
          clientMessageId: `client-${eventId}`,
          message: {
            id: `message-${eventId}`,
            tenantId,
            conversationId,
            author: { type: "user", userId: actorUserId },
            sequence: 1,
            createdAt: "2030-01-01T00:00:00.000Z",
            updatedAt: "2030-01-01T00:00:00.000Z",
            revision: { revision: 1 },
            ...(replyTo === undefined ? {} : { replyTo }),
            content: {
              format: "plain",
              text: secretText,
              mentions: mentions.map((userId) => ({ type: "user", userId })),
            },
          },
        },
      ],
    );
  };

  const seedSource = async ({
    tenantId = "tenant-a",
    conversationId,
    messageId = "reply-source",
    authorUserId = "source-author",
    deleted = false,
  }) => {
    await harness.pool.query(
      `INSERT INTO ${messages} (
         tenant_id, id, conversation_id, sequence, author_user_id,
         client_message_id, content, created_at, updated_at,
         deleted_at, deleted_by_user_id
       ) VALUES ($1, $2, $3, 1, $4, $2,
         '{"format":"plain","text":"persisted source"}',
         '2030-01-01', '2030-01-01',
         CASE WHEN $5 THEN '2030-01-01'::timestamptz END,
         CASE WHEN $5 THEN $4 END)`,
      [tenantId, messageId, conversationId, authorUserId, deleted],
    );
  };

  const seedThread = async ({ recipients, mentions = [], replyTo, publicParent = false }) => {
    await seed({ conversationId: "thread-parent", eventId: "root-event", recipients: [] });
    await seedSource({ conversationId: "thread-parent", messageId: "root" });
    await harness.pool.query(`DELETE FROM ${outbox} WHERE event_id = 'root-event'`);
    await seed({ conversationId: "policy-thread", eventId: "policy-event", recipients, mentions, replyTo });
    await harness.pool.query(
      `UPDATE ${conversations} SET type = 'thread', name = NULL,
         parent_conversation_id = 'thread-parent', root_message_id = 'root'
       WHERE id = 'policy-thread'`,
    );
    await harness.pool.query(
      `INSERT INTO ${members} (tenant_id, conversation_id, user_id, role, state)
       SELECT tenant_id, 'thread-parent', user_id, role, state FROM ${members}
       WHERE conversation_id = 'policy-thread' ON CONFLICT DO NOTHING`,
    );
    if (publicParent) await harness.pool.query(
      `UPDATE ${conversations} SET visibility = 'public' WHERE id = 'thread-parent'`,
    );
    for (const recipient of recipients) {
      if (recipient.follow !== undefined) await setFollow(recipient.userId, recipient.follow);
      if (recipient.participant === false) await harness.pool.query(
        recipient.preference === undefined
          ? `DELETE FROM ${members} WHERE conversation_id = 'policy-thread' AND user_id = $1`
          : `UPDATE ${members} SET state = 'left' WHERE conversation_id = 'policy-thread' AND user_id = $1`,
        [recipient.userId],
      );
    }
  };
  const setFollow = (userId, following) => harness.pool.query(
    `INSERT INTO ${follows} (tenant_id, conversation_id, user_id, is_following, follow_revision)
     VALUES ('tenant-a', 'policy-thread', $1, $2, 1)
     ON CONFLICT (tenant_id, conversation_id, user_id) DO UPDATE
       SET is_following = EXCLUDED.is_following, follow_revision = ${follows}.follow_revision + 1,
           updated_at = clock_timestamp()`, [userId, following],
  );
  const threadState = async () => {
    const results = [];
    for (const table of [members, follows, preferences, `${prefix}.chat_read_cursors`]) {
      results.push((await harness.pool.query(`SELECT * FROM ${table} ORDER BY tenant_id, conversation_id, user_id`)).rows);
    }
    return results;
  };

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    t.beforeEach(reset);

    for (const scenario of [
      { name: "ping on", expected: 1 },
      { name: "ping off", notifyAuthor: false, expected: 0 },
      { name: "missing ping flag", notifyAuthor: undefined, expected: 0 },
      { name: "non-boolean ping flag", notifyAuthor: "true", expected: 0 },
      { name: "explicit mention deduplicates ping", mention: true, expected: 1 },
      { name: "explicit mention survives ping off", notifyAuthor: false, mention: true, expected: 1 },
      { name: "all-message delivery survives ping off", notifyAuthor: false, level: "all", expected: 1 },
      { name: "none suppresses ping", level: "none", expected: 0 },
      { name: "mute suppresses ping", muted: true, expected: 0 },
      { name: "future mute suppresses ping", muted: true, mutedUntil: "2099-01-01", expected: 0 },
      { name: "expired mute permits ping", muted: true, mutedUntil: "2020-01-01", expected: 1 },
      { name: "self reply suppresses ping", self: true, expected: 0 },
      { name: "missing source", source: "missing", expected: 0 },
      { name: "deleted source", source: "deleted", expected: 0 },
      { name: "other tenant source", source: "other-tenant", expected: 0 },
      { name: "other conversation source", source: "other-conversation", expected: 0 },
      { name: "absent recipient access", access: "missing", expected: 0 },
      { name: "removed recipient access", access: "removed", expected: 0 },
      { name: "left recipient access", access: "left", expected: 0 },
    ]) {
      await t.test(`reply recipient materialization: ${scenario.name}`, async () => {
        const conversationId = "reply-channel";
        const eventId = "reply-event";
        const authorUserId = scenario.self ? "actor" : `source-author-${scenario.name}`;
        const forgedAuthorUserId = `forged-author-${scenario.name}`;
        const replyTo = {
          messageId: "reply-source",
          notifyAuthor: Object.hasOwn(scenario, "notifyAuthor") ? scenario.notifyAuthor : true,
          // Untrusted extra metadata must never select this other member.
          author: { type: "user", userId: forgedAuthorUserId },
        };
        const mentions = scenario.mention ? [authorUserId] : [];
        await seed({
          conversationId, eventId, replyTo, mentions,
          recipients: [
            ...(!scenario.self ? [{
              userId: authorUserId,
              preference: {
                level: scenario.level ?? "mentions",
                muted: scenario.muted,
                mutedUntil: scenario.mutedUntil,
              },
            }] : []),
            { userId: forgedAuthorUserId, preference: { level: "mentions" } },
          ],
        });
        let sourceTenantId = "tenant-a";
        let sourceConversationId = conversationId;
        if (scenario.source === "other-tenant" || scenario.source === "other-conversation") {
          sourceTenantId = scenario.source === "other-tenant" ? "tenant-b" : "tenant-a";
          sourceConversationId = scenario.source === "other-conversation" ? "other-channel" : conversationId;
          await harness.pool.query(
            `INSERT INTO ${conversations} (tenant_id, id, type, visibility, name)
             VALUES ($1, $2, 'channel', 'private', $2)`,
            [sourceTenantId, sourceConversationId],
          );
        }
        if (scenario.source !== "missing") {
          await seedSource({
            tenantId: sourceTenantId, conversationId: sourceConversationId,
            authorUserId, deleted: scenario.source === "deleted",
          });
        }
        if (scenario.access === "missing") {
          await harness.pool.query(
            `DELETE FROM ${preferences} WHERE tenant_id = 'tenant-a'
             AND conversation_id = $1 AND user_id = $2`,
            [conversationId, authorUserId],
          );
          await harness.pool.query(
            `DELETE FROM ${members} WHERE tenant_id = 'tenant-a'
             AND conversation_id = $1 AND user_id = $2`,
            [conversationId, authorUserId],
          );
        } else if (scenario.access) {
          await harness.pool.query(
            `UPDATE ${members} SET state = $3 WHERE tenant_id = 'tenant-a'
             AND conversation_id = $1 AND user_id = $2`,
            [conversationId, authorUserId, scenario.access],
          );
        }
        const calls = [];
        const dispatcher = worker({ async send(input) { calls.push(input); } });
        assert.deepEqual(await dispatcher.runOnce(), {
          materialized: scenario.expected, claimed: scenario.expected,
          delivered: scenario.expected, suppressed: 0, failed: 0,
        });
        assert.deepEqual(calls.map(({ recipientUserId }) => recipientUserId),
          scenario.expected ? [authorUserId] : []);
        // Replay does not duplicate an explicit + synthetic mention delivery.
        await harness.pool.query(`DELETE FROM ${offsets}`);
        assert.equal((await dispatcher.runOnce()).materialized, 0);
        assert.equal(calls.length, scenario.expected);
        assert.equal((await harness.pool.query(`SELECT * FROM ${deliveries}`)).rowCount, scenario.expected);
        const stored = await harness.pool.query(
          `SELECT payload #> '{message,content,mentions}' AS mentions FROM ${outbox}
           WHERE event_id = $1`, [eventId],
        );
        assert.deepEqual(stored.rows[0].mentions, mentions.map((userId) => ({ type: "user", userId })));
      });
    }

    await t.test("reply metadata does not create thread participation or follows", async () => {
      await seed({ conversationId: "parent", eventId: "parent-event", recipients: [] });
      await seedSource({ conversationId: "parent", messageId: "thread-root" });
      await harness.pool.query(`DELETE FROM ${outbox} WHERE event_id = 'parent-event'`);
      await seed({
        conversationId: "reply-thread", eventId: "thread-reply-event",
        recipients: [{ userId: "source-author", preference: { level: "mentions" } }],
        replyTo: { messageId: "reply-source", notifyAuthor: true },
      });
      await harness.pool.query(
        `UPDATE ${conversations} SET type = 'thread', name = NULL,
           parent_conversation_id = 'parent', root_message_id = 'thread-root'
         WHERE id = 'reply-thread'`,
      );
      await seedSource({ conversationId: "reply-thread" });
      await harness.pool.query(`DELETE FROM ${preferences} WHERE conversation_id = 'reply-thread'`);
      await harness.pool.query(
        `UPDATE ${members} SET conversation_id = 'parent'
         WHERE conversation_id = 'reply-thread' AND user_id = 'source-author'`,
      );
      const calls = [];
      const dispatcher = worker({ async send(input) { calls.push(input); } });
      assert.equal((await dispatcher.runOnce()).delivered, 1);
      assert.equal(calls.length, 1);
      assert.equal((await harness.pool.query(`SELECT * FROM ${follows}`)).rowCount, 0);
      assert.equal((await harness.pool.query(
        `SELECT * FROM ${members} WHERE conversation_id = 'reply-thread'
         AND user_id = 'source-author'`,
      )).rowCount, 0);
    });

    for (const scenario of [
      { name: "followed all", follow: true, expected: 1 },
      { name: "legacy active child", expected: 1 },
      { name: "explicit false", follow: false, expected: 0 },
      { name: "parent reader only", participant: false, expected: 0 },
      { name: "public reader only", participant: false, publicParent: true, expected: 0 },
      { name: "follow without child", follow: true, participant: false, expected: 1 },
      { name: "mentions preference excludes general", follow: true, level: "mentions", expected: 0 },
      ...["all", "mentions"].flatMap((level) => [
        { name: `unfollowed explicit ${level}`, follow: false, mention: true, level, expected: 1 },
        { name: `unfollowed synthetic ${level}`, follow: false, reply: true, level, expected: 1 },
        { name: `nonparticipant explicit ${level}`, participant: false, mention: true, level, expected: 1 },
        { name: `nonparticipant synthetic ${level}`, participant: false, reply: true, level, expected: 1 },
      ]),
      { name: "none suppresses both mentions", follow: true, mention: true, reply: true, level: "none", expected: 0 },
      { name: "mute suppresses both mentions", follow: true, mention: true, reply: true, muted: true, expected: 0 },
      { name: "timed mute suppresses mention", mention: true, muted: true, mutedUntil: "2099-01-01", expected: 0 },
      { name: "expired mute permits mention", follow: false, mention: true, muted: true, mutedUntil: "2020-01-01", expected: 1 },
      { name: "explicit and synthetic deduplicated", follow: false, mention: true, reply: true, expected: 1 },
    ]) {
      await t.test(`thread selection: ${scenario.name}`, async () => {
        const userId = `thread-${++ordinal}`;
        await seedThread({
          recipients: [{ userId, follow: scenario.follow, participant: scenario.participant,
            preference: scenario.participant === false && (scenario.level ?? "all") === "all" ? undefined
              : { level: scenario.level ?? "all", muted: scenario.muted, mutedUntil: scenario.mutedUntil } }],
          mentions: scenario.mention ? [userId] : [],
          replyTo: scenario.reply ? { messageId: "reply-source", notifyAuthor: true, authorUserId: "forged" } : undefined,
          publicParent: scenario.publicParent,
        });
        if (scenario.reply) await seedSource({ conversationId: "policy-thread", authorUserId: userId });
        const before = await threadState();
        const calls = [];
        const dispatcher = worker({ async send(input) { calls.push(input); } });
        assert.deepEqual(await dispatcher.runOnce(), {
          materialized: scenario.expected, claimed: scenario.expected, delivered: scenario.expected, suppressed: 0, failed: 0,
        });
        assert.deepEqual(calls.map((input) => input.recipientUserId), scenario.expected ? [userId] : []);
        await harness.pool.query(`DELETE FROM ${offsets}`);
        assert.equal((await dispatcher.runOnce()).materialized, 0);
        assert.equal(calls.length, scenario.expected);
        assert.deepEqual(await threadState(), before, "selection must not mutate private participation state");
      });
    }

    await t.test("public-parent concrete mention needs no membership; readers are not enumerated", async () => {
      const mentioned = `public-mention-${++ordinal}`;
      const reader = `public-reader-${ordinal}`;
      await seedThread({ publicParent: true, mentions: [mentioned],
        recipients: [{ userId: mentioned, participant: false }, { userId: reader, participant: false }] });
      await harness.pool.query(`DELETE FROM ${members} WHERE conversation_id = 'thread-parent' AND user_id <> 'actor'`);
      const before = await threadState();
      const lookups = [];
      const calls = [];
      const dispatcher = worker({ async send(input) { calls.push(input); } }, {
        directory: { async getUser({ actor, userId }) {
          lookups.push(userId);
          return { tenantId: actor.tenantId, userId, displayName: userId };
        } },
      });
      assert.equal((await dispatcher.runOnce()).delivered, 1);
      assert.deepEqual(calls.map((input) => input.recipientUserId), [mentioned]);
      assert.deepEqual(lookups, [mentioned, mentioned]);
      assert.deepEqual(await threadState(), before);
    });

    for (const missing of ["directory", "permissions"]) {
      await t.test(`thread notifications fail closed without ${missing}`, async () => {
        await seedThread({ recipients: [{ userId: `missing-adapter-${++ordinal}`, follow: true }] });
        const calls = [];
        const dispatcher = worker({ async send(input) { calls.push(input); } }, { [missing]: undefined });
        assert.equal((await dispatcher.runOnce()).materialized, 0);
        assert.deepEqual(calls, []);
      });
    }

    const revocations = [
      "unfollow", "child leave", "mute", "mentions level", "none level",
      "parent leave", "parent removed", "entity", "child archive", "parent archive",
      "directory missing", "directory redacted", "directory unavailable", "directory wrong tenant", "directory wrong user",
    ];
    for (const timing of ["before materialization", "after materialization", "on retry"]) {
      for (const { change, traffic } of [
        ...revocations.map((change) => ({ change, traffic: "general" })),
        ...["mute", "none level", "parent leave", "entity", "child archive", "parent archive", "directory redacted"]
          .flatMap((change) => ["explicit", "synthetic"].map((traffic) => ({ change, traffic }))),
        { change: "source deleted", traffic: "synthetic" },
      ]) {
        await t.test(`thread ${traffic}: ${change} ${timing}`, async () => {
          const userId = `revocation-${++ordinal}`;
          // No follow row for the legacy-child leave case; all others explicitly follow.
          await seedThread({
            recipients: [{ userId, follow: change === "child leave" ? undefined : traffic === "general" }],
            mentions: traffic === "explicit" ? [userId] : [],
            replyTo: traffic === "synthetic" ? { messageId: "reply-source", notifyAuthor: true } : undefined,
          });
          if (traffic === "synthetic") await seedSource({ conversationId: "policy-thread", authorUserId: userId });
          await harness.pool.query(
            `UPDATE ${conversations} SET entity_type = 'project', entity_id = 'entity-1' WHERE id = 'thread-parent'`,
          );
          let revoked = false;
          const revoke = async () => {
            revoked = true;
            if (change === "unfollow") await setFollow(userId, false);
            if (change === "source deleted") await harness.pool.query(
              `UPDATE ${messages} SET deleted_at = created_at, deleted_by_user_id = 'actor'
               WHERE conversation_id = 'policy-thread' AND id = 'reply-source'`,
            );
            if (["child leave", "parent leave", "parent removed"].includes(change)) {
              await harness.pool.query(
                `UPDATE ${members} SET state = $3 WHERE conversation_id = $1 AND user_id = $2`,
                [change === "child leave" ? "policy-thread" : "thread-parent", userId, change === "parent removed" ? "removed" : "left"],
              );
            }
            if (["mute", "mentions level", "none level"].includes(change)) await harness.pool.query(
              `INSERT INTO ${preferences} (tenant_id, conversation_id, user_id, notification_level, muted)
               VALUES ('tenant-a', 'policy-thread', $1, $2, $3)`,
              [userId, change === "mentions level" ? "mentions" : change === "none level" ? "none" : "all", change === "mute"],
            );
            if (change.endsWith("archive")) await harness.pool.query(
              `UPDATE ${conversations} SET archived_at = clock_timestamp(), archived_by_user_id = 'actor' WHERE id = $1`,
              [change === "child archive" ? "policy-thread" : "thread-parent"],
            );
          };
          const calls = [];
          const dispatcher = worker({ async send(input) {
            calls.push(input);
            if (timing === "on retry" && !revoked) throw new ChatNotificationDeliveryError("transient");
          } }, {
            directory: { async getUser({ actor, userId }) {
              if (revoked && change === "directory missing") return null;
              if (revoked && change === "directory redacted") return { ...actor, kind: "redacted" };
              if (revoked && change === "directory unavailable") return { ...actor, kind: "unavailable", reason: "missing" };
              return { tenantId: revoked && change === "directory wrong tenant" ? "tenant-b" : actor.tenantId,
                userId: revoked && change === "directory wrong user" ? "wrong" : userId, displayName: userId };
            } },
            permissions: { async authorizeEntity({ actor, entity, action }) {
              assert.equal(actor.userId, userId);
              assert.deepEqual(actor.roles, []);
              assert.deepEqual(entity, { type: "project", id: "entity-1" });
              assert.equal(action, "conversation.subscribe");
              return !(revoked && change === "entity");
            } },
            // The host token boundary runs after materialization and claiming.
            pushTokenProtector: { ...pushTokenProtector, async unprotect(input) {
              if (timing === "after materialization" && !revoked) {
                assert.equal((await harness.pool.query(`SELECT * FROM ${deliveries}`)).rowCount, 1);
                await revoke();
              }
              return pushTokenProtector.unprotect(input);
            } },
          });
          if (timing === "before materialization") await revoke();
          const first = await dispatcher.runOnce();
          if (timing === "on retry") {
            assert.equal(first.failed, 1);
            assert.equal(calls.length, 1);
            await revoke();
            assert.deepEqual(await dispatcher.runOnce(), { materialized: 0, claimed: 1, delivered: 0, suppressed: 1, failed: 0 });
            assert.equal(calls.length, 1, "revoked retry must not reach send");
          } else {
            assert.deepEqual(first, { materialized: timing === "before materialization" ? 0 : 1,
              claimed: timing === "before materialization" ? 0 : 1, delivered: 0,
              suppressed: timing === "before materialization" ? 0 : 1, failed: 0 });
            assert.equal(calls.length, 0, "suppressed recipient must not reach send");
          }
        });
      }
    }

    for (const synthetic of [false, true]) {
      await t.test(`queued ${synthetic ? "synthetic" : "explicit"} mention survives leave`, async () => {
        const userId = `leave-mention-${++ordinal}`;
        await seedThread({ recipients: [{ userId, follow: true, preference: { level: "mentions" } }],
          mentions: synthetic ? [] : [userId], replyTo: synthetic ? { messageId: "reply-source", notifyAuthor: true } : undefined });
        if (synthetic) await seedSource({ conversationId: "policy-thread", authorUserId: userId });
        const calls = [];
        const dispatcher = worker({ async send(input) { calls.push(input); } }, {
          pushTokenProtector: { ...pushTokenProtector, async unprotect(input) {
            await setFollow(userId, false);
            await harness.pool.query(`UPDATE ${members} SET state = 'left' WHERE conversation_id = 'policy-thread' AND user_id = $1`, [userId]);
            return pushTokenProtector.unprotect(input);
          } },
        });
        assert.equal((await dispatcher.runOnce()).delivered, 1);
        assert.equal(calls.length, 1);
      });
    }

    await t.test("applies levels, mute, self, active-session, tenant, and minimization rules", async () => {
      await seed({
        conversationId: "selection-a",
        eventId: "selection-event-a",
        recipients: [
          { userId: "default-all" },
          { userId: "mentioned", preference: { level: "mentions" } },
          { userId: "unmentioned", preference: { level: "mentions" } },
          { userId: "none", preference: { level: "none" } },
          { userId: "muted", preference: { level: "all", muted: true } },
          {
            userId: "timed-muted",
            preference: {
              level: "all",
              muted: true,
              mutedUntil: "2099-01-01T00:00:00Z",
            },
          },
          {
            userId: "expired-mute",
            preference: {
              level: "all",
              muted: true,
              mutedUntil: "2020-01-01T00:00:00Z",
            },
          },
          { userId: "active", preference: { level: "all" } },
        ],
        mentions: ["mentioned"],
      });
      await seed({
        tenantId: "tenant-b",
        conversationId: "selection-b",
        eventId: "selection-event-b",
        actorUserId: "actor-b",
        recipients: [{ userId: "tenant-b-recipient" }],
        secretText: "tenant-b-private-body",
      });

      const calls = [];
      const dispatcher = worker(
        { async send(input) { calls.push(input); } },
        {
          isRecipientActive: ({ tenantId, recipientUserId }) =>
            tenantId === "tenant-a" && recipientUserId === "active",
        },
      );
      const result = await dispatcher.runOnce();
      assert.deepEqual(result, {
        materialized: 5,
        claimed: 5,
        delivered: 4,
        suppressed: 1,
        failed: 0,
      });
      assert.deepEqual(
        calls.map(({ tenantId, recipientUserId }) => [tenantId, recipientUserId]).sort(),
        [
          ["tenant-a", "default-all"],
          ["tenant-a", "expired-mute"],
          ["tenant-a", "mentioned"],
          ["tenant-b", "tenant-b-recipient"],
        ],
      );
      for (const input of calls) {
        assert.equal(input.deliveryId, createChatNotificationDeliveryId({
          tenantId: input.tenantId,
          sourceEventId: input.sourceEventId,
          recipientUserId: input.recipientUserId,
          type: input.type,
        }));
        assert.equal(input.type, "message.created");
        assert.equal(input.sequence, 1);
        assert.equal(Object.hasOwn(input, "payload"), false);
        assert.equal(Object.hasOwn(input, "content"), false);
        assert.doesNotMatch(JSON.stringify(input), /private-body|raw-message-content/u);
      }

      const stored = await harness.pool.query(
        `SELECT tenant_id, recipient_host_user_id, notification_metadata
         FROM ${deliveries}
         WHERE source_event_id IN ('selection-event-a', 'selection-event-b')
         ORDER BY tenant_id, recipient_host_user_id`,
      );
      assert.equal(stored.rows.length, 5);
      assert.doesNotMatch(JSON.stringify(stored.rows), /private-body|raw-message-content/u);
      assert.deepEqual(
        stored.rows.filter(({ tenant_id }) => tenant_id === "tenant-b")
          .map(({ recipient_host_user_id }) => recipient_host_user_id),
        ["tenant-b-recipient"],
      );
    });

    await t.test("resolves only bounded active protected targets in stable device order", async () => {
      const tenantId = "target-tenant";
      const recipientUserId = "target-recipient";
      await seed({
        tenantId,
        conversationId: "target-conversation",
        eventId: "target-event",
        recipients: [{ userId: recipientUserId }],
      });
      await harness.pool.query(
        `INSERT INTO ${pushTokens} (
           tenant_id, user_id, device_id, platform, provider, environment,
           opaque_token, token_protection_scheme, token_protection_key_id,
           token_revision
         )
         SELECT $1, $2, 'device-' || lpad(candidate::text, 3, '0'),
                CASE WHEN candidate % 2 = 0 THEN 'ios' ELSE 'android' END,
                CASE WHEN candidate % 2 = 0 THEN 'apns' ELSE 'fcm' END,
                'production', 'ciphertext-device-' || lpad(candidate::text, 3, '0'),
                'host_encrypted', 'bounded-key', 1
         FROM generate_series(0, $3::integer + 2) AS candidate`,
        [tenantId, recipientUserId, MAX_CHAT_NOTIFICATION_TARGETS],
      );
      await harness.pool.query(
        `INSERT INTO ${pushTokens} (
           tenant_id, user_id, device_id, platform, provider, environment,
           opaque_token, token_protection_scheme, token_protection_key_id,
           token_revision
         ) VALUES
           ('other-tenant', $1, 'device-000', 'ios', 'apns', 'production',
            'wrong-tenant-secret', 'host_encrypted', 'wrong-tenant-key', 1),
           ($2, 'other-user', 'device-000', 'ios', 'apns', 'production',
            'wrong-user-secret', 'host_encrypted', 'wrong-user-key', 1),
           ($2, $1, 'device-revoked', 'ios', 'apns', 'production',
            'revoked-ciphertext-secret', 'host_encrypted', 'revoked-key', 1)`,
        [recipientUserId, tenantId],
      );
      await harness.pool.query(
        `WITH moment AS (SELECT clock_timestamp() AS at)
         UPDATE ${pushTokens}
         SET opaque_token = NULL, token_protection_key_id = NULL,
             revoked_at = moment.at, token_revision = token_revision + 1,
             updated_at = moment.at
         FROM moment
         WHERE tenant_id = $1 AND user_id = $2 AND device_id = 'device-revoked'`,
        [tenantId, recipientUserId],
      );

      const unprotectCalls = [];
      const adapterCalls = [];
      let failFirstSend = true;
      const dispatcher = worker(
        {
          async send(input) {
            adapterCalls.push(input);
            if (failFirstSend) {
              failFirstSend = false;
              throw new ChatNotificationDeliveryError("transient");
            }
          },
        },
        {
          pushTokenProtector: {
            async protect() { throw new Error("unused test protection path"); },
            async unprotect(input) {
              unprotectCalls.push(input);
              return `raw-${input.deviceId}`;
            },
          },
        },
      );

      assert.equal((await dispatcher.runOnce()).failed, 1);
      assert.equal((await dispatcher.runOnce()).delivered, 1);
      const expectedDeviceIds = Array.from(
        { length: MAX_CHAT_NOTIFICATION_TARGETS },
        (_, index) => `device-${String(index).padStart(3, "0")}`,
      );
      assert.equal(adapterCalls.length, 2);
      for (const input of adapterCalls) {
        assert.equal(Object.isFrozen(input.targets), true);
        assert.deepEqual(
          input.targets.map(({ deviceId }) => deviceId),
          expectedDeviceIds,
        );
        assert.equal(input.targets.length, MAX_CHAT_NOTIFICATION_TARGETS);
        assert.equal(input.targets.every(Object.isFrozen), true);
        assert.equal(input.targets[0].token, "raw-device-000");
        assert.doesNotMatch(JSON.stringify(input), /raw-device-/u);
      }
      assert.equal(adapterCalls[0].deliveryId, adapterCalls[1].deliveryId);
      assert.equal(unprotectCalls.length, MAX_CHAT_NOTIFICATION_TARGETS * 2);
      assert.equal(
        unprotectCalls.every(({ tenantId: actualTenant, userId }) =>
          actualTenant === tenantId && userId === recipientUserId),
        true,
      );
      assert.deepEqual(
        unprotectCalls.slice(0, MAX_CHAT_NOTIFICATION_TARGETS)
          .map(({ deviceId }) => deviceId),
        expectedDeviceIds,
      );
      assert.deepEqual(
        unprotectCalls.slice(0, MAX_CHAT_NOTIFICATION_TARGETS)
          .map(({ deviceId, protectedToken }) => ({ deviceId, protectedToken })),
        expectedDeviceIds.map((deviceId) => ({
          deviceId,
          protectedToken: {
            ciphertext: `ciphertext-${deviceId}`,
            keyId: "bounded-key",
          },
        })),
      );
      assert.doesNotMatch(
        JSON.stringify(unprotectCalls),
        /wrong-tenant|wrong-user|revoked-ciphertext/u,
      );
    });

    await t.test("suppresses delivery when no active protected target exists", async () => {
      await seed({
        conversationId: "no-target-conversation",
        eventId: "no-target-event",
        recipients: [{ userId: "no-target-recipient" }],
      });
      await harness.pool.query(
        `WITH moment AS (SELECT clock_timestamp() AS at)
         UPDATE ${pushTokens}
         SET opaque_token = NULL, token_protection_key_id = NULL,
             revoked_at = moment.at, token_revision = token_revision + 1,
             updated_at = moment.at
         FROM moment
         WHERE tenant_id = 'tenant-a' AND user_id = 'no-target-recipient'`,
      );
      let adapterCalls = 0;
      const dispatcher = worker({ async send() { adapterCalls += 1; } });
      assert.deepEqual(await dispatcher.runOnce(), {
        materialized: 1,
        claimed: 1,
        delivered: 0,
        suppressed: 1,
        failed: 0,
      });
      assert.equal(adapterCalls, 0);
    });

    await t.test("rejects a malformed target before any decryption or send", async () => {
      await seed({
        conversationId: "malformed-target-conversation",
        eventId: "malformed-target-event",
        recipients: [{ userId: "malformed-target-recipient" }],
      });
      await harness.pool.query(
        `INSERT INTO ${pushTokens} (
           tenant_id, user_id, device_id, platform, provider, environment,
           opaque_token, token_protection_scheme, token_protection_key_id,
           token_revision
         ) VALUES (
           'tenant-a', 'malformed-target-recipient', 'device-z',
           'android', 'fcm', 'production', 'protected:second-token',
           'host_encrypted', 'second-key', 1
         )`,
      );
      const database = {
        connect: harness.pool.connect.bind(harness.pool),
        async query(sql, parameters) {
          const result = await harness.pool.query(sql, parameters);
          if (sql.includes(`FROM ${pushTokens}`)) {
            return {
              ...result,
              rows: result.rows.map((row, index) =>
                index === 1
                  ? { ...row, provider: "malformed-provider-secret" }
                  : row),
            };
          }
          return result;
        },
      };
      let unprotectCalls = 0;
      let adapterCalls = 0;
      const dispatcher = worker(
        { async send() { adapterCalls += 1; } },
        {
          database,
          pushTokenProtector: {
            async protect() { throw new Error("unused test protection path"); },
            async unprotect() { unprotectCalls += 1; return "raw-secret"; },
          },
        },
      );
      const malformedResult = await dispatcher.runOnce();
      assert.equal(malformedResult.failed, 1);
      assert.equal(unprotectCalls, 0);
      assert.equal(adapterCalls, 0);
      const malformedStored = (await harness.pool.query(
          `SELECT status, last_error_class FROM ${deliveries}
           WHERE source_event_id = 'malformed-target-event'`,
        )).rows[0];
      assert.deepEqual(
        malformedStored,
        { status: "failed", last_error_class: "unknown" },
      );
      assert.doesNotMatch(
        JSON.stringify({ malformedResult, malformedStored }),
        /malformed-provider-secret|raw-secret/u,
      );
    });

    await t.test("keeps decryption failures retryable and secret-free", async () => {
      const ciphertextSecret = "ciphertext-secret-sentinel";
      const keySecret = "key-secret-sentinel";
      const rawSecret = "raw-token-secret-sentinel";
      const providerErrorSecret = "provider-error-secret-sentinel";
      await seed({
        conversationId: "decrypt-failure-conversation",
        eventId: "decrypt-failure-event",
        recipients: [{ userId: "decrypt-failure-recipient" }],
      });
      await harness.pool.query(
        `INSERT INTO ${pushTokens} (
           tenant_id, user_id, device_id, platform, provider, environment,
           opaque_token, token_protection_scheme, token_protection_key_id,
           token_revision
         ) VALUES (
           'tenant-a', 'decrypt-failure-recipient', 'device-rejecting',
           'android', 'fcm', 'production', $1, 'host_encrypted', $2, 1
         )`,
        [ciphertextSecret, keySecret],
      );
      let rejectDecryption = true;
      let adapterInput;
      const onErrorCalls = [];
      const dispatcher = worker(
        { async send(input) { adapterInput = input; } },
        {
          onError(error) { onErrorCalls.push(error); },
          pushTokenProtector: {
            async protect() { throw new Error("unused test protection path"); },
            async unprotect({ deviceId }) {
              if (rejectDecryption && deviceId === "device-rejecting") {
                throw new ChatNotificationDeliveryError(
                  "configuration",
                  `${ciphertextSecret}:${keySecret}:${rawSecret}:${providerErrorSecret}`,
                );
              }
              return deviceId === "device-rejecting" ? rawSecret : `raw-${deviceId}`;
            },
          },
        },
      );
      const logs = [];
      const originalConsoleError = console.error;
      const originalConsoleWarn = console.warn;
      console.error = (...values) => { logs.push(values); };
      console.warn = (...values) => { logs.push(values); };
      let failedResult;
      try {
        failedResult = await dispatcher.runOnce();
      } finally {
        console.error = originalConsoleError;
        console.warn = originalConsoleWarn;
      }
      assert.deepEqual(failedResult, {
        materialized: 1,
        claimed: 1,
        delivered: 0,
        suppressed: 0,
        failed: 1,
      });
      assert.equal(adapterInput, undefined);
      const storedFailure = (await harness.pool.query(
        `SELECT status, last_error_class, notification_metadata,
                source_event_id, recipient_host_user_id, notification_kind,
                next_attempt_at <= clock_timestamp() AS retryable
         FROM ${deliveries}
         WHERE source_event_id = 'decrypt-failure-event'`,
      )).rows[0];
      assert.equal(storedFailure.status, "failed");
      assert.equal(storedFailure.last_error_class, "unknown");
      assert.equal(storedFailure.retryable, true);
      const deliveryId = createChatNotificationDeliveryId({
        tenantId: "tenant-a",
        sourceEventId: "decrypt-failure-event",
        recipientUserId: "decrypt-failure-recipient",
        type: "message.created",
      });
      const observable = JSON.stringify({
        failedResult,
        storedFailure,
        deliveryId,
        onErrorCalls,
        logs,
      });
      assert.doesNotMatch(
        observable,
        /ciphertext-secret|key-secret|raw-token-secret|provider-error-secret/u,
      );
      rejectDecryption = false;
      assert.equal((await dispatcher.runOnce()).delivered, 1);
      assert.equal(adapterInput.deliveryId, deliveryId);
      assert.equal(
        adapterInput.targets.find(({ deviceId }) =>
          deviceId === "device-rejecting").token,
        rawSecret,
      );
      assert.doesNotMatch(JSON.stringify(adapterInput), /raw-token-secret/u);
    });

    await t.test("two workers make exactly one concurrent adapter call", async () => {
      await seed({
        conversationId: "concurrent",
        eventId: "concurrent-event",
        recipients: [{ userId: "concurrent-recipient" }],
      });
      const calls = [];
      const adapter = {
        async send(input) {
          calls.push(input.deliveryId);
          await new Promise((resolve) => setTimeout(resolve, 20));
        },
      };
      const first = worker(adapter);
      const second = worker(adapter);
      await Promise.all([first.runOnce(), second.runOnce()]);
      assert.equal(calls.length, 1);
      assert.equal(
        (await harness.pool.query(
          `SELECT status, attempt_count::integer AS attempt_count
           FROM ${deliveries} WHERE source_event_id = 'concurrent-event'`,
        )).rows[0].status,
        "delivered",
      );
    });

    await t.test("transient and rate-limited failures retry with stable ids", async () => {
      for (const failureClass of ["transient", "rate_limited"]) {
        const eventId = `retry-${failureClass}`;
        await seed({
          conversationId: eventId,
          eventId,
          recipients: [{ userId: `recipient-${failureClass}` }],
        });
        const ids = [];
        let first = true;
        const dispatcher = worker({
          async send(input) {
            ids.push(input.deliveryId);
            if (first) {
              first = false;
              throw new ChatNotificationDeliveryError(failureClass);
            }
          },
        });
        assert.equal((await dispatcher.runOnce()).failed, 1);
        assert.equal((await dispatcher.runOnce()).delivered, 1);
        assert.equal(ids.length, 2);
        assert.equal(ids[0], ids[1]);
      }
    });

    for (const eligibility of [
      "removed", "left", "missing-member", "archived", "missing-conversation", "active",
    ]) {
      await t.test(`message retry rechecks current eligibility: ${eligibility}`, async () => {
        const conversationId = `eligibility-${eligibility}`;
        const eventId = `${conversationId}-event`;
        const userId = `${conversationId}-recipient`;
        await seed({ conversationId, eventId, recipients: [{ userId }] });
        const ids = [];
        let decryptions = 0;
        const dispatcher = worker({
          async send(input) {
            ids.push(input.deliveryId);
            if (ids.length === 1) {
              throw new ChatNotificationDeliveryError("transient");
            }
          },
        }, {
          pushTokenProtector: {
            ...pushTokenProtector,
            async unprotect(input) {
              decryptions += 1;
              return pushTokenProtector.unprotect(input);
            },
          },
        });
        assert.deepEqual(await dispatcher.runOnce(), {
          materialized: 1, claimed: 1, delivered: 0, suppressed: 0, failed: 1,
        });
        assert.equal(decryptions, 1);
        const readDelivery = async () => (await harness.pool.query(
          `SELECT tenant_id, source_event_id, recipient_host_user_id,
                  notification_kind, notification_metadata, status,
                  attempt_count::integer AS attempt_count,
                  lease_token, lease_acquired_at, lease_expires_at,
                  delivered_at, last_error_class
           FROM ${deliveries}
           WHERE tenant_id = 'tenant-a' AND source_event_id = $1
             AND recipient_host_user_id = $2`,
          [eventId, userId],
        )).rows[0];
        const failed = await readDelivery();
        assert.equal(failed.status, "failed");
        assert.equal(failed.last_error_class, "transient");
        assert.equal(failed.attempt_count, 1);

        if (eligibility === "removed" || eligibility === "left") {
          await harness.pool.query(
            `UPDATE ${members} SET state = $3
             WHERE tenant_id = 'tenant-a' AND conversation_id = $1 AND user_id = $2`,
            [conversationId, userId, eligibility],
          );
        } else if (eligibility === "missing-member" || eligibility === "missing-conversation") {
          await harness.pool.query(
            `DELETE FROM ${members}
             WHERE tenant_id = 'tenant-a' AND conversation_id = $1
               AND ($3::boolean OR user_id = $2)`,
            [conversationId, userId, eligibility === "missing-conversation"],
          );
          if (eligibility === "missing-conversation") {
            // Outbox events and deliveries survive deletion; membership has a FK.
            await harness.pool.query(
              `DELETE FROM ${conversations} WHERE tenant_id = 'tenant-a' AND id = $1`,
              [conversationId],
            );
          }
        } else if (eligibility === "archived") {
          await harness.pool.query(
            `UPDATE ${conversations}
             SET archived_at = clock_timestamp(), archived_by_user_id = 'actor'
             WHERE tenant_id = 'tenant-a' AND id = $1`,
            [conversationId],
          );
        }

        const active = eligibility === "active";
        assert.deepEqual(await dispatcher.runOnce(), {
          materialized: 0, claimed: 1, delivered: active ? 1 : 0,
          suppressed: active ? 0 : 1, failed: 0,
        });
        assert.equal(ids.length, active ? 2 : 1);
        assert.equal(decryptions, active ? 2 : 1);
        const expectedId = createChatNotificationDeliveryId({
          tenantId: "tenant-a", sourceEventId: eventId,
          recipientUserId: userId, type: "message.created",
        });
        assert.deepEqual(ids, active ? [expectedId, expectedId] : [expectedId]);
        const completed = await readDelivery();
        assert.ok(completed.delivered_at instanceof Date);
        assert.deepEqual(completed, {
          ...failed, status: "delivered", attempt_count: 2,
          lease_token: null, lease_acquired_at: null, lease_expires_at: null,
          delivered_at: completed.delivered_at, last_error_class: null,
        });
        assert.deepEqual(await dispatcher.runOnce(), {
          materialized: 0, claimed: 0, delivered: 0, suppressed: 0, failed: 0,
        });
        assert.deepEqual(await readDelivery(), completed);
        assert.equal(ids.length, active ? 2 : 1);
        assert.equal(decryptions, active ? 2 : 1);
      });
    }

    await t.test("an expired lease is recovered", async () => {
      await seed({
        conversationId: "expired-lease",
        eventId: "expired-lease-event",
        recipients: [{ userId: "expired-recipient" }],
      });
      await harness.pool.query(
        `WITH moment AS (
           SELECT clock_timestamp() - interval '10 minutes' AS at
         )
         INSERT INTO ${deliveries} (
           tenant_id, source_event_id, recipient_host_user_id,
           notification_kind, notification_metadata, next_attempt_at,
           created_at, updated_at
         ) SELECT
           'tenant-a', 'expired-lease-event', 'expired-recipient',
           'message.created',
           '{"conversationId":"expired-lease","messageId":"message-expired-lease-event","actorUserId":"actor","sequence":1,"protocolVersion":4}',
           moment.at, moment.at, moment.at
         FROM moment`,
      );
      await harness.pool.query(
        `WITH moment AS (SELECT clock_timestamp() - interval '9 minutes' AS at)
         UPDATE ${deliveries}
         SET status = 'leased', attempt_count = 1, lease_token = 'dead-worker',
             lease_acquired_at = moment.at,
             lease_expires_at = moment.at + interval '1 minute',
             updated_at = moment.at
         FROM moment
         WHERE source_event_id = 'expired-lease-event'`,
      );
      const calls = [];
      const dispatcher = worker({ async send(input) { calls.push(input.deliveryId); } });
      assert.equal((await dispatcher.runOnce()).delivered, 1);
      assert.equal(calls.length, 1);
      assert.equal(
        (await harness.pool.query(
          `SELECT attempt_count::integer AS attempts FROM ${deliveries}
           WHERE source_event_id = 'expired-lease-event'`,
        )).rows[0].attempts,
        2,
      );
    });

    await t.test("retry exhaustion is bounded and terminal failures are isolated", async () => {
      await seed({
        conversationId: "exhausted",
        eventId: "exhausted-event",
        recipients: [{ userId: "exhausted-recipient" }],
      });
      let exhaustedCalls = 0;
      const exhausted = worker(
        { async send() { exhaustedCalls += 1; throw new Error("opaque transient"); } },
        { maxAttempts: 2 },
      );
      await exhausted.runOnce();
      await exhausted.runOnce();
      assert.equal((await exhausted.runOnce()).claimed, 0);
      assert.equal(exhaustedCalls, 2);
      await harness.pool.query(
        `WITH moment AS (SELECT clock_timestamp() AS at)
         UPDATE ${deliveries}
         SET last_error_class = 'configuration', last_error_at = moment.at,
             next_attempt_at = moment.at, updated_at = moment.at
         FROM moment
         WHERE source_event_id = 'exhausted-event'`,
      );

      await seed({
        conversationId: "permanent-isolation",
        eventId: "permanent-event",
        recipients: [
          { userId: "permanent-failure" },
          { userId: "rejected-recipient" },
          { userId: "bad-configuration" },
          { userId: "healthy-recipient" },
        ],
      });
      const delivered = [];
      const isolated = worker({
        async send(input) {
          const terminalClass = {
            "permanent-failure": "permanent",
            "rejected-recipient": "rejected",
            "bad-configuration": "configuration",
          }[input.recipientUserId];
          if (terminalClass !== undefined) {
            throw new ChatNotificationDeliveryError(terminalClass);
          }
          delivered.push(input.recipientUserId);
        },
      });
      assert.deepEqual(await isolated.runOnce(), {
        materialized: 4,
        claimed: 4,
        delivered: 1,
        suppressed: 0,
        failed: 3,
      });
      assert.deepEqual(delivered, ["healthy-recipient"]);
      assert.equal((await isolated.runOnce()).claimed, 0);
      assert.deepEqual(
        (await harness.pool.query(
          `SELECT recipient_host_user_id, status, last_error_class
           FROM ${deliveries} WHERE source_event_id = 'permanent-event'
           ORDER BY recipient_host_user_id`,
        )).rows,
        [
          {
            recipient_host_user_id: "bad-configuration",
            status: "failed",
            last_error_class: "configuration",
          },
          {
            recipient_host_user_id: "healthy-recipient",
            status: "delivered",
            last_error_class: null,
          },
          {
            recipient_host_user_id: "permanent-failure",
            status: "failed",
            last_error_class: "rejected",
          },
          {
            recipient_host_user_id: "rejected-recipient",
            status: "failed",
            last_error_class: "rejected",
          },
        ],
      );
    });

    await t.test("emits sanitized aggregate telemetry for PostgreSQL outcomes and failures", async () => {
      const telemetryTenant = "telemetry-tenant-secret";
      const telemetryEvent = "telemetry-event-secret";
      const telemetryConversation = "telemetry-conversation-secret";
      const dueAt = Date.parse("2030-01-01T00:00:00.000Z");
      let now = dueAt + 1_000;
      await seed({
        tenantId: telemetryTenant,
        conversationId: telemetryConversation,
        eventId: telemetryEvent,
        actorUserId: "telemetry-actor-secret",
        recipients: [
          { userId: "telemetry-delivered-secret" },
          { userId: "telemetry-suppressed-secret" },
          { userId: "telemetry-retryable-secret" },
          { userId: "telemetry-terminal-secret" },
        ],
        secretText: "telemetry-metadata-secret",
      });
      await harness.pool.query(
        `INSERT INTO ${deliveries} (
           tenant_id, source_event_id, recipient_host_user_id,
           notification_kind, notification_metadata, next_attempt_at
         )
         SELECT $1, $2, candidate.user_id, 'message.created',
                jsonb_build_object(
                  'conversationId', $3::text,
                  'messageId', 'telemetry-message-secret',
                  'actorUserId', 'telemetry-actor-secret',
                  'sequence', 1,
                  'private', 'telemetry-notification-metadata-secret'
                ),
                $4::timestamptz
         FROM unnest($5::text[]) AS candidate(user_id)`,
        [
          telemetryTenant,
          telemetryEvent,
          telemetryConversation,
          new Date(dueAt),
          [
            "telemetry-delivered-secret",
            "telemetry-suppressed-secret",
            "telemetry-retryable-secret",
            "telemetry-terminal-secret",
          ],
        ],
      );

      const outcomes = [];
      const providerError = "telemetry-adapter-error-secret";
      const dispatcher = worker(
        {
          async send(input) {
            now += 5;
            if (input.recipientUserId === "telemetry-retryable-secret") {
              throw new ChatNotificationDeliveryError("transient", providerError);
            }
            if (input.recipientUserId === "telemetry-terminal-secret") {
              throw new ChatNotificationDeliveryError("configuration", providerError);
            }
          },
        },
        {
          maxAttempts: 1,
          now: () => new Date(now),
          isRecipientActive: ({ recipientUserId }) =>
            recipientUserId === "telemetry-suppressed-secret",
          onBatch(outcome) { outcomes.push(outcome); },
        },
      );
      assert.deepEqual(await dispatcher.runOnce(), {
        materialized: 0,
        claimed: 4,
        delivered: 1,
        suppressed: 1,
        failed: 2,
      });
      assert.deepEqual(await dispatcher.runOnce(), {
        materialized: 0,
        claimed: 0,
        delivered: 0,
        suppressed: 0,
        failed: 0,
      });
      assert.deepEqual(outcomes, [
        {
          materialized: 0,
          claimed: 4,
          delivered: 1,
          suppressed: 1,
          failed: 2,
          durationMs: 15,
          oldestDueDeliveryAgeMs: 1_015,
          outcome: "partially_failed",
          failureClassCounts: {
            none: 2,
            transient: 1,
            rate_limited: 0,
            permanent: 0,
            rejected: 0,
            configuration: 1,
            unknown: 0,
            database: 0,
          },
        },
        {
          materialized: 0,
          claimed: 0,
          delivered: 0,
          suppressed: 0,
          failed: 0,
          durationMs: 0,
          oldestDueDeliveryAgeMs: null,
          outcome: "empty",
          failureClassCounts: {
            none: 0,
            transient: 0,
            rate_limited: 0,
            permanent: 0,
            rejected: 0,
            configuration: 0,
            unknown: 0,
            database: 0,
          },
        },
      ]);
      assert.equal(Object.isFrozen(outcomes[0]), true);
      assert.equal(Object.isFrozen(outcomes[0].failureClassCounts), true);
      const observable = JSON.stringify(outcomes);
      for (const sentinel of [
        telemetryTenant,
        telemetryEvent,
        telemetryConversation,
        "telemetry-actor-secret",
        "telemetry-delivered-secret",
        "telemetry-suppressed-secret",
        "telemetry-retryable-secret",
        "telemetry-terminal-secret",
        "telemetry-message-secret",
        "telemetry-metadata-secret",
        "telemetry-notification-metadata-secret",
        "device-telemetry",
        "protected:token-telemetry",
        "test-key",
        providerError,
      ]) {
        assert.equal(observable.includes(sentinel), false);
      }

      const databaseError = new Error("telemetry-database-error-secret");
      const databaseOutcomes = [];
      const failingDatabase = {
        connect: harness.pool.connect.bind(harness.pool),
        async query(sql, parameters) {
          if (sql.includes("claimable AS MATERIALIZED")) {
            now += 7;
            throw databaseError;
          }
          return harness.pool.query(sql, parameters);
        },
      };
      const failing = worker(
        { async send() { throw new Error("must not send"); } },
        {
          database: failingDatabase,
          now: () => new Date(now),
          onBatch(outcome) { databaseOutcomes.push(outcome); },
        },
      );
      await assert.rejects(failing.runOnce(), (error) => error === databaseError);
      assert.equal(databaseOutcomes.length, 1);
      assert.deepEqual(databaseOutcomes[0], {
        materialized: 0,
        claimed: 0,
        delivered: 0,
        suppressed: 0,
        failed: 0,
        durationMs: 7,
        oldestDueDeliveryAgeMs: null,
        outcome: "failed",
        failureClassCounts: {
          none: 0,
          transient: 0,
          rate_limited: 0,
          permanent: 0,
          rejected: 0,
          configuration: 0,
          unknown: 0,
          database: 1,
        },
      });
      assert.equal(
        JSON.stringify(databaseOutcomes[0]).includes(databaseError.message),
        false,
      );
    });

    await t.test("disabled or missing notification support is a clean no-op", async () => {
      const required = {
        auth: { async resolveActor() { throw new Error("unused"); } },
        directory: {
          async getUser() { throw new Error("unused"); },
          async searchUsers() { throw new Error("unused"); },
        },
        permissions: {
          async getCapabilities() { throw new Error("unused"); },
          async authorizeEntity() { throw new Error("unused"); },
        },
      };
      let calls = 0;
      const disabled = createChatServer({
        database: { pool: harness.pool, schema: harness.schema },
        ...required,
        notifications: { async send() { calls += 1; } },
        features: { notifications: false },
      });
      const missing = createChatServer({
        database: { pool: harness.pool, schema: harness.schema },
        ...required,
      });
      assert.equal(disabled.notificationDispatcher, undefined);
      assert.equal(missing.notificationDispatcher, undefined);
      await Promise.all([disabled.close(), missing.close()]);
      assert.equal(calls, 0);
    });
  } finally {
    await Promise.all([...workers].map((dispatcher) => dispatcher.stop().catch(() => undefined)));
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});

test("notification materialization pages replay positions transactionally", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "notif_materializer",
  });
  const prefix = quoteIdentifier(harness.schema);
  const conversations = `${prefix}.chat_conversations`;
  const members = `${prefix}.chat_conversation_members`;
  const preferences = `${prefix}.chat_conversation_preferences`;
  const outbox = `${prefix}.chat_outbox_events`;
  const deliveries = `${prefix}.chat_notification_deliveries`;
  const offsets = `${prefix}.chat_notification_materializer_offsets`;
  const pushTokens = `${prefix}.chat_device_push_tokens`;
  const workers = new Set();
  let leaseOrdinal = 0;

  const reset = async () => {
    await harness.pool.query(`DELETE FROM ${deliveries}`);
    await harness.pool.query(`DELETE FROM ${outbox}`);
    await harness.pool.query(`DELETE FROM ${offsets}`);
    await harness.pool.query(`DELETE FROM ${preferences}`);
    await harness.pool.query(`DELETE FROM ${members}`);
    await harness.pool.query(`DELETE FROM ${conversations}`);
  };

  const seedConversation = async ({
    conversationId,
    recipientUserId,
    notificationLevel,
  }) => {
    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name, current_message_sequence)
       VALUES ('materializer-tenant', $1, 'channel', 'private', $1, 1)`,
      [conversationId],
    );
    const users = recipientUserId === undefined
      ? ["materializer-actor"]
      : ["materializer-actor", recipientUserId];
    await harness.pool.query(
      `INSERT INTO ${members}
         (tenant_id, conversation_id, user_id, role, state)
       SELECT 'materializer-tenant', $1, candidate.user_id, 'member', 'active'
       FROM unnest($2::text[]) AS candidate(user_id)`,
      [conversationId, users],
    );
    if (recipientUserId !== undefined) {
      await harness.pool.query(
        `INSERT INTO ${pushTokens} (
           tenant_id, user_id, device_id, platform, provider, environment,
           opaque_token, token_protection_scheme, token_protection_key_id,
           token_revision
         ) VALUES (
           'materializer-tenant', $1, $2, 'ios', 'apns', 'production',
           $3, 'host_encrypted', 'materializer-key', 1
         )`,
        [
          recipientUserId,
          `device-${recipientUserId}`,
          `protected:token-${recipientUserId}`,
        ],
      );
    }
    if (recipientUserId !== undefined && notificationLevel !== undefined) {
      await harness.pool.query(
        `INSERT INTO ${preferences}
           (tenant_id, conversation_id, user_id, notification_level)
         VALUES ('materializer-tenant', $1, $2, $3)`,
        [conversationId, recipientUserId, notificationLevel],
      );
    }
  };

  const validPayload = (eventId, conversationId) => ({
    message: {
      id: `message-${eventId}`,
      author: { userId: "materializer-actor" },
      sequence: 1,
      content: { mentions: [] },
      conversationId,
    },
  });

  const insertEvent = async ({
    eventId,
    conversationId,
    type = "message.created",
    payload = validPayload(eventId, conversationId),
    occurredAt = "2030-01-01T00:00:00Z",
    expiresAt = "2099-01-01T00:00:00Z",
    database = harness.pool,
  }) => {
    const result = await database.query(
      `INSERT INTO ${outbox}
         (event_id, protocol_version, tenant_id, stream_id, type,
          occurred_at, payload, expires_at)
       VALUES ($1, 4, 'materializer-tenant', $2, $3, $4, $5, $6)
       RETURNING replay_position`,
      [eventId, conversationId, type, occurredAt, payload, expiresAt],
    );
    return result.rows[0].replay_position;
  };

  const inspectableDatabase = ({ failAdvance = false, inspectedPages = [] } = {}) => ({
    query: harness.pool.query.bind(harness.pool),
    async connect() {
      const client = await harness.pool.connect();
      return {
        async query(sql, parameters) {
          if (failAdvance && sql.includes(`UPDATE ${offsets}`)) {
            throw new Error("forced materializer offset failure");
          }
          const result = await client.query(sql, parameters);
          if (sql.includes("SELECT event.replay_position")) {
            inspectedPages.push(result.rows.map(({ replay_position }) => replay_position));
          }
          return result;
        },
        release(error) {
          client.release(error);
        },
      };
    },
  });

  const worker = ({ database = harness.pool, batchSize, calls = [] } = {}) => {
    const dispatcher = createChatNotificationDispatcher({
      database,
      schema: harness.schema,
      adapter: {
        async send(input) {
          calls.push(input.sourceEventId);
        },
      },
      pushTokenProtector: {
        async protect() { throw new Error("unused test protection path"); },
        async unprotect({ protectedToken }) {
          return protectedToken.ciphertext.slice("protected:".length);
        },
      },
      batchSize,
      pollIntervalMs: 60_000,
      createLeaseToken: () => `materializer-lease-${++leaseOrdinal}`,
    });
    workers.add(dispatcher);
    return dispatcher;
  };

  const readOffset = async () => {
    const result = await harness.pool.query(
      `SELECT materializer_name, last_replay_position
       FROM ${offsets}`,
    );
    assert.equal(result.rows.length, 1);
    return result.rows[0];
  };

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    await t.test("bounds each page and resumes strictly after a gapped offset", async () => {
      await reset();
      await seedConversation({
        conversationId: "paged-conversation",
        recipientUserId: "paged-recipient",
      });
      const firstPosition = await insertEvent({
        eventId: "paged-event-a",
        conversationId: "paged-conversation",
      });
      const gapConnection = await harness.pool.connect();
      try {
        await gapConnection.query("BEGIN");
        try {
          await insertEvent({
            eventId: "rolled-back-gap",
            conversationId: "paged-conversation",
            database: gapConnection,
          });
        } finally {
          await gapConnection.query("ROLLBACK");
        }
      } finally {
        gapConnection.release();
      }
      const secondPosition = await insertEvent({
        eventId: "paged-event-b",
        conversationId: "paged-conversation",
      });
      const thirdPosition = await insertEvent({
        eventId: "paged-event-c",
        conversationId: "paged-conversation",
      });
      assert.ok(Number(secondPosition) > Number(firstPosition) + 1);

      const calls = [];
      const inspectedPages = [];
      const dispatcher = worker({
        database: inspectableDatabase({ inspectedPages }),
        batchSize: 2,
        calls,
      });
      assert.deepEqual(await dispatcher.runOnce(), {
        materialized: 2,
        claimed: 2,
        delivered: 2,
        suppressed: 0,
        failed: 0,
      });
      assert.deepEqual(inspectedPages, [[firstPosition, secondPosition]]);
      const firstOffset = await readOffset();
      assert.equal(
        firstOffset.materializer_name,
        "message-created-notifications:v1",
      );
      assert.equal(firstOffset.last_replay_position, secondPosition);
      assert.deepEqual(calls.sort(), ["paged-event-a", "paged-event-b"]);
      assert.equal(
        (await harness.pool.query(
          `SELECT count(*)::integer AS count
           FROM ${deliveries}
           WHERE source_event_id = 'paged-event-c'`,
        )).rows[0].count,
        0,
      );

      assert.deepEqual(await dispatcher.runOnce(), {
        materialized: 1,
        claimed: 1,
        delivered: 1,
        suppressed: 0,
        failed: 0,
      });
      assert.deepEqual(inspectedPages, [
        [firstPosition, secondPosition],
        [thirdPosition],
      ]);
      assert.equal((await readOffset()).last_replay_position, thirdPosition);
      assert.deepEqual(calls.sort(), [
        "paged-event-a",
        "paged-event-b",
        "paged-event-c",
      ]);
    });

    await t.test("ineligible inspected events advance progress without recipients", async () => {
      await reset();
      await seedConversation({ conversationId: "ineligible-empty" });
      await seedConversation({
        conversationId: "ineligible-none",
        recipientUserId: "none-recipient",
        notificationLevel: "none",
      });
      await seedConversation({
        conversationId: "ineligible-next",
        recipientUserId: "eligible-recipient",
      });
      await insertEvent({
        eventId: "ineligible-non-message",
        conversationId: "ineligible-empty",
        type: "conversation.updated",
        payload: {},
      });
      await insertEvent({
        eventId: "ineligible-expired",
        conversationId: "ineligible-empty",
        occurredAt: "2020-01-01T00:00:00Z",
        expiresAt: "2021-01-01T00:00:00Z",
      });
      await insertEvent({
        eventId: "ineligible-malformed",
        conversationId: "ineligible-empty",
        payload: { message: "invalid" },
      });
      await insertEvent({
        eventId: "ineligible-zero-recipient",
        conversationId: "ineligible-empty",
      });
      const lastIneligiblePosition = await insertEvent({
        eventId: "ineligible-preference-none",
        conversationId: "ineligible-none",
      });
      const eligiblePosition = await insertEvent({
        eventId: "eligible-after-ineligible-page",
        conversationId: "ineligible-next",
      });

      const calls = [];
      const dispatcher = worker({ batchSize: 5, calls });
      assert.deepEqual(await dispatcher.runOnce(), {
        materialized: 0,
        claimed: 0,
        delivered: 0,
        suppressed: 0,
        failed: 0,
      });
      assert.equal(
        (await readOffset()).last_replay_position,
        lastIneligiblePosition,
      );
      assert.deepEqual(calls, []);

      assert.equal((await dispatcher.runOnce()).delivered, 1);
      assert.equal((await readOffset()).last_replay_position, eligiblePosition);
      assert.deepEqual(calls, ["eligible-after-ineligible-page"]);
    });

    await t.test("a failed transaction leaves no progress and replays its page", async () => {
      await reset();
      await seedConversation({
        conversationId: "rollback-conversation",
        recipientUserId: "rollback-recipient",
      });
      await insertEvent({
        eventId: "rollback-event-a",
        conversationId: "rollback-conversation",
      });
      await insertEvent({
        eventId: "rollback-event-b",
        conversationId: "rollback-conversation",
      });

      const failedPages = [];
      const failed = worker({
        database: inspectableDatabase({
          failAdvance: true,
          inspectedPages: failedPages,
        }),
        batchSize: 2,
      });
      await assert.rejects(
        failed.runOnce(),
        /forced materializer offset failure/u,
      );
      assert.equal(
        (await harness.pool.query(`SELECT count(*)::integer AS count FROM ${offsets}`))
          .rows[0].count,
        0,
      );
      assert.equal(
        (await harness.pool.query(`SELECT count(*)::integer AS count FROM ${deliveries}`))
          .rows[0].count,
        0,
      );

      const replayedPages = [];
      const calls = [];
      const replayed = worker({
        database: inspectableDatabase({ inspectedPages: replayedPages }),
        batchSize: 2,
        calls,
      });
      assert.equal((await replayed.runOnce()).delivered, 2);
      assert.deepEqual(replayedPages, failedPages);
      assert.deepEqual(calls.sort(), ["rollback-event-a", "rollback-event-b"]);
    });

    await t.test("concurrent dispatchers serialize pages without gaps or duplicates", async () => {
      await reset();
      await seedConversation({
        conversationId: "concurrent-pages",
        recipientUserId: "concurrent-page-recipient",
      });
      const eventIds = Array.from(
        { length: 6 },
        (_, index) => `concurrent-page-event-${index + 1}`,
      );
      let finalPosition;
      for (const eventId of eventIds) {
        finalPosition = await insertEvent({
          eventId,
          conversationId: "concurrent-pages",
        });
      }

      const calls = [];
      const first = worker({ batchSize: 3, calls });
      const second = worker({ batchSize: 3, calls });
      const results = await Promise.all([first.runOnce(), second.runOnce()]);
      assert.equal(
        results.reduce((total, result) => total + result.materialized, 0),
        eventIds.length,
      );
      assert.equal(
        results.reduce((total, result) => total + result.delivered, 0),
        eventIds.length,
      );
      assert.deepEqual([...new Set(calls)].sort(), eventIds);
      assert.equal(calls.length, eventIds.length);
      assert.equal((await readOffset()).last_replay_position, finalPosition);
      assert.deepEqual(
        (await harness.pool.query(
          `SELECT source_event_id
           FROM ${deliveries}
           WHERE status = 'delivered'
           ORDER BY source_event_id`,
        )).rows.map(({ source_event_id }) => source_event_id),
        eventIds,
      );
    });
  } finally {
    await Promise.all(
      [...workers].map((dispatcher) => dispatcher.stop().catch(() => undefined)),
    );
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});

test("dispatcher claims the deterministic global candidate boundary", async () => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "notification_claim_order",
  });
  const prefix = quoteIdentifier(harness.schema);
  const outbox = `${prefix}.chat_outbox_events`;
  const deliveries = `${prefix}.chat_notification_deliveries`;
  const pushTokens = `${prefix}.chat_device_push_tokens`;
  const deliveredMessageIds = [];
  const dispatcher = createChatNotificationDispatcher({
    database: harness.pool,
    schema: harness.schema,
    adapter: {
      async send(input) {
        deliveredMessageIds.push(input.messageId);
      },
    },
    pushTokenProtector: {
      async protect() { throw new Error("unused test protection path"); },
      async unprotect({ protectedToken }) {
        return protectedToken.ciphertext.slice("protected:".length);
      },
    },
    batchSize: 2,
    pollIntervalMs: 60_000,
    leaseDurationMs: 60_000,
    maxAttempts: 5,
    createLeaseToken: () => "deterministic-claim-lease",
  });

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();
    await harness.pool.query(
      `INSERT INTO ${pushTokens} (
         tenant_id, user_id, device_id, platform, provider, environment,
         opaque_token, token_protection_scheme, token_protection_key_id,
         token_revision
       ) VALUES
         ('tenant-a', 'claim-recipient', 'claim-device', 'ios', 'apns',
          'production', 'protected:claim-a', 'host_encrypted', 'claim-key', 1),
         ('tenant-b', 'claim-recipient', 'claim-device', 'android', 'fcm',
          'production', 'protected:claim-b', 'host_encrypted', 'claim-key', 1)`,
    );
    await harness.pool.query(
      `INSERT INTO ${prefix}.chat_conversations
         (tenant_id, id, type, visibility, name)
       SELECT tenant_id, 'claim-order-conversation', 'channel', 'private', 'Claim order'
       FROM (VALUES ('tenant-a'), ('tenant-b')) AS candidate(tenant_id)`,
    );
    await harness.pool.query(
      `INSERT INTO ${prefix}.chat_conversation_members
         (tenant_id, conversation_id, user_id, role, state)
       SELECT tenant_id, 'claim-order-conversation', 'claim-recipient', 'member', 'active'
       FROM (VALUES ('tenant-a'), ('tenant-b')) AS candidate(tenant_id)`,
    );
    await harness.pool.query(
      `INSERT INTO ${outbox}
         (event_id, protocol_version, tenant_id, stream_id, type,
          occurred_at, payload, expires_at)
       SELECT candidate.event_id, 4, candidate.tenant_id,
              'claim-order-conversation', 'message.created',
              TIMESTAMPTZ '2020-01-01T00:00:00Z',
              jsonb_build_object(
                'message', jsonb_build_object(
                  'id', 'message-' || candidate.event_id,
                  'author', jsonb_build_object('userId', 'claim-order-actor'),
                  'sequence', 1
                )
              ),
              TIMESTAMPTZ '2099-01-01T00:00:00Z'
       FROM (VALUES
         ('tenant-a', 'claim-order-a'),
         ('tenant-a', 'claim-order-b'),
         ('tenant-b', 'claim-order-c'),
         ('tenant-a', 'claim-terminal'),
         ('tenant-a', 'claim-active'),
         ('tenant-a', 'claim-future')
       ) AS candidate(tenant_id, event_id)`,
    );
    await harness.pool.query(
      `INSERT INTO ${deliveries}
         (tenant_id, source_event_id, recipient_host_user_id,
          notification_kind, notification_metadata, next_attempt_at,
          created_at, updated_at)
       SELECT event.tenant_id, event.event_id, 'claim-recipient',
              'message.created',
              jsonb_build_object(
                'conversationId', event.stream_id,
                'messageId', event.payload #>> '{message,id}',
                'actorUserId', event.payload #>> '{message,author,userId}',
                'sequence', 1,
                'protocolVersion', event.protocol_version
              ),
              CASE
                WHEN event.event_id IN ('claim-order-a', 'claim-order-b')
                  THEN TIMESTAMPTZ '2023-01-01T00:00:00Z'
                WHEN event.event_id = 'claim-terminal'
                  THEN TIMESTAMPTZ '2022-01-01T00:00:00Z'
                WHEN event.event_id = 'claim-future'
                  THEN TIMESTAMPTZ '2099-01-01T00:00:00Z'
                ELSE TIMESTAMPTZ '2020-01-01T00:00:00Z'
              END,
              TIMESTAMPTZ '2020-01-01T00:00:00Z',
              TIMESTAMPTZ '2020-01-01T00:00:00Z'
       FROM ${outbox} AS event
       WHERE event.event_id LIKE 'claim-%'`,
    );
    await harness.pool.query(
      `UPDATE ${deliveries}
       SET status = 'leased', attempt_count = 1,
           lease_token = 'seeded-claim-lease',
           lease_acquired_at = TIMESTAMPTZ '2021-01-01T00:00:00Z',
           lease_expires_at = CASE
             WHEN source_event_id = 'claim-order-c'
               THEN TIMESTAMPTZ '2023-01-01T00:00:00Z'
             WHEN source_event_id = 'claim-active'
               THEN TIMESTAMPTZ '2099-01-01T00:00:00Z'
             ELSE TIMESTAMPTZ '2021-02-01T00:00:00Z'
           END,
           updated_at = TIMESTAMPTZ '2021-01-01T00:00:00Z'
       WHERE source_event_id IN (
         'claim-order-a', 'claim-order-c', 'claim-terminal', 'claim-active'
       )`,
    );
    await harness.pool.query(
      `UPDATE ${deliveries}
       SET status = 'failed', lease_token = NULL,
           lease_acquired_at = NULL, lease_expires_at = NULL,
           last_error_class = CASE
             WHEN source_event_id = 'claim-terminal' THEN 'rejected'
             ELSE 'transient'
           END,
           last_error_at = TIMESTAMPTZ '2022-01-01T00:00:00Z',
           next_attempt_at = CASE
             WHEN source_event_id = 'claim-order-a'
               THEN TIMESTAMPTZ '2023-01-01T00:00:00Z'
             ELSE TIMESTAMPTZ '2022-01-01T00:00:00Z'
           END,
           updated_at = TIMESTAMPTZ '2022-01-01T00:00:00Z'
       WHERE source_event_id IN ('claim-order-a', 'claim-terminal')`,
    );

    assert.deepEqual(await dispatcher.runOnce(), {
      materialized: 0,
      claimed: 2,
      delivered: 2,
      suppressed: 0,
      failed: 0,
    });
    assert.deepEqual(deliveredMessageIds.sort(), [
      "message-claim-order-a",
      "message-claim-order-b",
    ]);
    assert.deepEqual(
      (
        await harness.pool.query(
          `SELECT source_event_id, status, attempt_count::integer AS attempts
           FROM ${deliveries}
           WHERE source_event_id IN (
             'claim-order-a', 'claim-order-b', 'claim-order-c'
           )
           ORDER BY source_event_id`,
        )
      ).rows,
      [
        { source_event_id: "claim-order-a", status: "delivered", attempts: 2 },
        { source_event_id: "claim-order-b", status: "delivered", attempts: 1 },
        { source_event_id: "claim-order-c", status: "leased", attempts: 1 },
      ],
    );

    assert.deepEqual(await dispatcher.runOnce(), {
      materialized: 0,
      claimed: 1,
      delivered: 1,
      suppressed: 0,
      failed: 0,
    });
    assert.equal(deliveredMessageIds.includes("message-claim-order-c"), true);
    assert.deepEqual(
      (
        await harness.pool.query(
          `SELECT status, attempt_count::integer AS attempts
           FROM ${deliveries}
           WHERE source_event_id = 'claim-order-c'`,
        )
      ).rows[0],
      { status: "delivered", attempts: 2 },
    );
  } finally {
    await dispatcher.stop().catch(() => undefined);
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});
